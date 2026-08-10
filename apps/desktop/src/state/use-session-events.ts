import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  sessionEventsFrameSchema,
  sessionKey,
  type CostMode,
  type SessionEventFrame,
  type SessionEventsFrame,
  type SessionSummaryFrame,
} from "@maxprice/shared";
import { sidecarFetch } from "@/lib/sidecar";
import { queryClient } from "@/lib/query";

// Part 5 — the streaming hook behind the /sessions/:id detail page.
//
// This is a *bespoke* hook, deliberately NOT built on `makeReportHook`
// (`report-hook.ts`) — that factory does `response.json()` on a plain-JSON
// body. The session-events endpoint streams NDJSON: one JSON frame per line,
// `summary` first, then `event` frames timestamp-ascending, with an optional
// trailing `error` frame on a mid-stream failure (see the frozen contract in
// `@maxprice/shared/session-events`).
//
// The hook still honours the ADR-0004 spirit — the key builder and URL
// builder are exported as standalone pieces so Part 3's SSE invalidation and
// any future composition can reach in without going through React.
//
// Cache strategy: the `queryFn` does not merely *return* the final value — it
// progressively writes partial state into the TanStack cache via
// `queryClient.setQueryData` as frames arrive, so the page re-renders while
// the stream is still open. The `summary` frame RESETS the cached value (so a
// re-stream on SSE invalidation replaces rather than duplicates), each `event`
// frame appends, and an `error` frame records the message. The function then
// resolves with the same accumulated shape so `useQuery`'s settled `data` is
// consistent with what streaming wrote.

// ---------------------------------------------------------------------------
// Accumulated data shape
// ---------------------------------------------------------------------------

// What both the streaming writes and the resolved `queryFn` produce. `summary`
// is null until line 1 arrives; `events` grows as `event` frames stream in;
// `error` is set only if an `error` frame appears mid-stream.
export type SessionEventsData = {
  summary: SessionSummaryFrame | null;
  events: SessionEventFrame[];
  error: string | null;
};

function emptyData(): SessionEventsData {
  return { summary: null, events: [], error: null };
}

// ---------------------------------------------------------------------------
// Key + URL builders (ADR-0004 standalone pieces)
// ---------------------------------------------------------------------------

// Five-element key: `["session", id, mode, models, machines]`. Keying by `mode`
// and the (sorted) model + machine filters means a cost-mode or filter change
// auto-refetches under a fresh key. Part 3's SSE channel invalidates the
// two-element prefix `["session", id]` — TanStack matches by prefix, so the
// streamed query is still hit by that invalidation (and the machine axis riding
// as the fifth element leaves that prefix untouched). See the `sessionKey` doc
// comment in `packages/shared/src/query-keys.ts`.
export function sessionEventsQueryKey(
  id: string,
  mode: CostMode,
  models: string[] = [],
  machines: string[] = [],
): [string, string, CostMode, string[], string[]] {
  return [...sessionKey(id), mode, [...models].sort(), [...machines].sort()];
}

// The NDJSON endpoint path. `mode` and the repeated `model` / `machine` params
// map onto the query the sidecar validates (ADR-0017 / ADR-0041 M6); an unknown
// id is not an HTTP error (it streams a zero-event `summary`), so there is no
// id-encoding subtlety here beyond URL-escaping. Absent machines ⇒ the URL is
// byte-identical to the pre-M6 shape.
export function buildSessionEventsUrl(
  id: string,
  mode: CostMode,
  models: string[] = [],
  machines: string[] = [],
): string {
  const params = new URLSearchParams();
  params.set("mode", mode);
  for (const m of models) params.append("model", m);
  for (const m of machines) params.append("machine", m);
  return `/api/session/${encodeURIComponent(id)}/events?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Pure NDJSON line splitter — the testable core
// ---------------------------------------------------------------------------

// Splits a freshly-decoded text chunk into complete lines, carrying any
// partial trailing line forward. NDJSON frames can straddle chunk boundaries,
// so the caller threads `remainder` between calls: feed the previous return's
// `remainder` as the next call's `carry`.
//
// `flush=true` (used once after the stream ends) treats the carry as a final
// complete line *if* it is non-blank — this tolerates a stream that does not
// terminate its last frame with a newline, while still dropping a blank
// trailing line (the common `…}\n` shape leaves an empty carry).
export function splitNdjsonChunk(
  carry: string,
  chunk: string,
  flush = false,
): { lines: string[]; remainder: string } {
  const combined = carry + chunk;
  const parts = combined.split("\n");
  // The last part is always an incomplete line (no trailing newline seen yet)
  // unless the chunk ended exactly on a newline, in which case it is "".
  const remainder = parts.pop() ?? "";
  const lines = parts.filter((line) => line.length > 0);
  if (flush && remainder.length > 0) {
    lines.push(remainder);
    return { lines, remainder: "" };
  }
  return { lines, remainder: flush ? "" : remainder };
}

// Parses one NDJSON line into a validated frame. Returns null for a blank line
// or any line that is not valid JSON / fails the discriminated-union schema —
// a malformed frame is skipped, never thrown, so one bad line cannot abort the
// whole stream render.
export function parseSessionFrame(line: string): SessionEventsFrame | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = sessionEventsFrameSchema.safeParse(json);
  return result.success ? result.data : null;
}

// Folds one frame into the accumulator. `summary` resets the accumulator (so a
// re-stream replaces); `event` appends; `error` records the message. Returns a
// new object so callers can hand it straight to `setQueryData` without
// in-place mutation.
export function applySessionFrame(
  prev: SessionEventsData,
  frame: SessionEventsFrame,
): SessionEventsData {
  switch (frame.type) {
    case "summary":
      return { summary: frame, events: [], error: null };
    case "event":
      return { ...prev, events: [...prev.events, frame] };
    case "error":
      return { ...prev, error: frame.error };
    default: {
      const _exhaustive: never = frame;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// The streaming queryFn
// ---------------------------------------------------------------------------

// Opens the NDJSON stream and drains it, writing partial state to the cache as
// it goes. Resolves with the final accumulated value. `models` narrows both
// the streamed events and the summary totals to matching models (ADR-0017) —
// it is REQUIRED, not defaulted (unlike the key/URL builders + the hook), so
// the queryFn can never silently drop the filter and stream the wrong totals.
// `signal` is TanStack's per-query AbortSignal — a route change or a key change
// (cost mode / model filter) aborts the in-flight stream.
//
// Abort safety is load-bearing. Two distinct cases, handled differently:
//
//  - SSE re-invalidation of the SAME `["session", id, mode]` key (Part 3's
//    channel fires while a stream is still draining). TanStack DEDUPES this:
//    `invalidateQueries` with a fetch in flight reuses the in-flight fetch
//    rather than starting a second `queryFn` run, and does NOT abort the first
//    — so two `streamSessionEvents` runs for one key never overlap. Verified
//    and pinned by a test in `use-session-events.test.ts`.
//  - A route change away from the page, or a cost-mode change (which re-keys
//    the query): the old query loses its observer and is cancelled, which DOES
//    abort `signal`. For that case every cache write and the reader loop are
//    gated on `signal.aborted`, and an aborted run THROWS an `AbortError`
//    rather than resolving — so a torn-down stream can never clobber the cache
//    with stale chunks (TanStack discards a `queryFn` that throws on abort).
//
// The `finally` cancels the reader so the orphaned socket is torn down rather
// than drained in the background.
//
// `fetchImpl` defaults to `sidecarFetch`; it is a parameter purely so tests can
// drive the streaming core against a stubbed `ReadableStream`-backed response.
// `machines` (ADR-0041 M6) narrows the fetch alongside `models`; it is appended
// LAST — after the `fetchImpl` test seam — and defaulted, so the streaming-core
// tests' positional `(id, mode, models, signal, fetchImpl)` calls stay unchanged
// while the hook threads it through to both the key and the URL.
export async function streamSessionEvents(
  id: string,
  mode: CostMode,
  models: string[],
  signal: AbortSignal | undefined,
  fetchImpl: typeof sidecarFetch = sidecarFetch,
  machines: string[] = [],
): Promise<SessionEventsData> {
  const key = sessionEventsQueryKey(id, mode, models, machines);
  const res = await fetchImpl(buildSessionEventsUrl(id, mode, models, machines), { signal });
  if (!res.ok) {
    // A non-2xx carries the pinned `{ error, issues? }` envelope (e.g. an
    // invalid mode). Surface the body text in the thrown message.
    throw new Error(`session events ${res.status}: ${await res.text()}`);
  }
  if (!res.body) {
    throw new Error("session events: response has no body to stream");
  }

  // No empty seed: writing `emptyData()` here would blank a populated page for
  // a network round-trip on every SSE-triggered re-stream. The `summary` frame
  // (always line 1) resets the accumulator anyway, so the first cache write of
  // a fresh stream already replaces stale data atomically.
  let acc = emptyData();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = "";

  // Apply a batch of lines, then push the new accumulator to the cache once
  // per chunk — re-rendering per chunk rather than per line keeps a fast
  // stream from thrashing React. A superseded stream skips the write entirely
  // so it cannot overwrite the live query's data.
  //
  // Consecutive `event` frames are coalesced into ONE array copy: folding them
  // one-by-one through `applySessionFrame` (whose `event` case spreads
  // `[...prev.events, frame]`) is O(M²) over a chunk and O(N²) over a session
  // streamed in few chunks. A `summary` / `error` frame flushes the pending
  // buffer first, so the summary-resets-events semantics still hold in arrival
  // order.
  const applyLines = (lines: string[]): void => {
    if (signal?.aborted) return;
    let changed = false;
    let pending: SessionEventFrame[] = [];
    const flushPending = (): void => {
      if (pending.length === 0) return;
      acc = { ...acc, events: acc.events.concat(pending) };
      pending = [];
    };
    for (const line of lines) {
      const frame = parseSessionFrame(line);
      if (!frame) continue;
      changed = true;
      if (frame.type === "event") {
        pending.push(frame);
      } else {
        flushPending();
        acc = applySessionFrame(acc, frame);
      }
    }
    flushPending();
    if (changed) queryClient.setQueryData<SessionEventsData>(key, acc);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      // Stop draining a superseded stream — the replacement run owns the key.
      if (done || signal?.aborted) break;
      const text = decoder.decode(value, { stream: true });
      const split = splitNdjsonChunk(carry, text, false);
      carry = split.remainder;
      applyLines(split.lines);
    }
    // Flush any decoder-buffered bytes + the final carry (a last frame with no
    // trailing newline). A blank carry is dropped by the splitter.
    if (!signal?.aborted) {
      const tail = decoder.decode();
      const finalSplit = splitNdjsonChunk(carry, tail, true);
      applyLines(finalSplit.lines);
    }
  } finally {
    // cancel() (not just releaseLock()) tears down the underlying HTTP stream
    // so an aborted stream's socket is not left draining in the background.
    // Swallow its rejection: cancelling a reader on a stream that errored
    // mid-read returns a promise rejected with that stored error, which would
    // otherwise surface as a second unhandled rejection.
    reader.cancel().catch(() => {});
  }

  // A superseded stream must not RESOLVE — TanStack would otherwise be free to
  // commit this run's stale `acc` as the query's data if the abort race lands
  // unfavourably. Throwing an `AbortError` is the proper cancellation signal:
  // TanStack discards a `queryFn` that throws on abort, keeping whatever the
  // live (newer) run wrote.
  if (signal?.aborted) {
    throw new DOMException("session events stream aborted", "AbortError");
  }
  return acc;
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

// Drives the session detail page. `id` is the route param; `mode` is the cost
// mode; `models` is the filter rail's model multi-select (ADR-0017); `machines`
// is the alias-expanded machine multi-select (ADR-0041 M6). A change to any of
// the four produces a new key → an automatic re-stream.
export function useSessionEvents(
  id: string,
  mode: CostMode,
  models: string[] = [],
  machines: string[] = [],
): UseQueryResult<SessionEventsData> {
  return useQuery<SessionEventsData>({
    queryKey: sessionEventsQueryKey(id, mode, models, machines),
    queryFn: ({ signal }) => streamSessionEvents(id, mode, models, signal, sidecarFetch, machines),
  });
}
