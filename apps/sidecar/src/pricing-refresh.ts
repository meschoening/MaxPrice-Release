// Pricing refresh — the startup fetch, the ~24h loop, and the one site that
// wires both into the live status.
//
// The vendored LiteLLM price snapshot (`packages/shared/src/pricing/`) is the
// offline floor — it ships in the binary and is always available. But a
// long-lived install would drift on stale prices, so on sidecar startup we kick
// a *best-effort* fetch of the live upstream LiteLLM price JSON; on success we
// swap in the fresher snapshot via `setActivePricingSnapshot`.
//
// What lives here:
//   - `refreshPricing` — one best-effort fetch + swap. Never rejects.
//   - `schedulePricingRefresh` — the ~24h re-fetch loop (ADR-0041 T14).
//   - `wirePricingRefresh` — the SINGLE wiring site. `main()` calls it once and
//     gets the loop handle back; the startup arm and the loop arm used to be two
//     hand-written blocks in `index.ts` patching identical status, with a
//     comment asking a future editor to keep them (and the test's
//     reconstruction of them) in sync.
//   - `buildPricingStatus` — the single CONSTRUCTION site for the wire's
//     `pricing` object (ADR-0053), so `source` / `capturedAt` / `modelCount` can
//     never disagree with each other or with the snapshot actually pricing.
//
// Load-bearing constraints:
//   - Cadence: once at startup (after the LISTENING handshake), then every ~24h.
//     The startup attempt deliberately does NOT participate in the loop's
//     `inFlight` guard — it is kicked before any tick can exist.
//   - Best-effort. ANY failure — offline, non-200, timeout, parse error, an
//     upstream shape change — falls back to the vendored snapshot. SILENT in the
//     sense that matters: nothing throws, nothing is gated, `refreshPricing`
//     never rejects, and the vendored snapshot stands. But no longer INVISIBLE —
//     every settled attempt is reported on the wire as `pricing.lastAttempt`
//     (ADR-0053), which is what lets a never-reached-upstream install be told
//     apart from a successful fetch of the same age.
//   - A COMPLETENESS FLOOR guards the swap: a transformed snapshot carrying
//     under half the vendored model count is refused. `transformUpstreamPricing`
//     rejects only the ZERO-model case, so an upstream restructure that renamed
//     most keys past its `/claude/i` filter would otherwise swap a handful of
//     models in over the vendored floor — every missing model then resolving
//     `null` and pricing at $0 across every report, silently, while the App info
//     row reads a perfectly healthy `fetched just now`.
//   - The body is read through a byte-counting reader with a hard ceiling rather
//     than `response.json()`. A `Content-Length` check is NOT a substitute:
//     upstream serves this file gzip-encoded and the runtime decompresses it
//     transparently, so `Content-Length` bounds only the COMPRESSED size (a
//     decompression bomb sails straight past it), and a chunked response carries
//     no `Content-Length` at all.
//   - The fetch uses an `AbortSignal` timeout so a hung request can't leak.
//   - It must never gate the `LISTENING` handshake, the engine scan, or any
//     endpoint — `main()` calls `wirePricingRefresh` after the handshake and the
//     startup attempt is `void`ed inside it.

import {
  transformUpstreamPricing,
  setActivePricingSnapshot,
  activePricingSnapshot,
  pricingSnapshot,
  UPSTREAM_PRICING_URL,
  type PricingFailureKind,
  type PricingStatus,
} from "@maxprice/shared";

// The fetch signature we depend on — a structural subset of the global
// `fetch`. Injected in tests so they stay deterministic and offline.
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export type RefreshPricingOptions = {
  // Injected for tests; defaults to the global `fetch`.
  fetchImpl?: FetchLike;
  // Abort the fetch after this many ms. Defaults to 10s — generous for a
  // ~1.4 MB JSON file, tight enough that a hung connection can't linger.
  timeoutMs?: number;
};

// The outcome of a refresh attempt. Either the fetch time of a successful swap,
// or a CLASSIFIED failure (ADR-0053) — the failure arm used to be an opaque
// `reason` string that every call site discarded; now it reaches the live status
// so the App info row can say something true about why prices are stale.
export type RefreshPricingResult =
  | { ok: true; fetchedAt: string }
  | { ok: false; kind: PricingFailureKind; detail: string };

const DEFAULT_TIMEOUT_MS = 10_000;

// Hard ceiling on the upstream body, in bytes — enforced by counting DECODED
// bytes as they arrive (see `readCappedBody`). The real file is ~1.4 MB, so
// 32 MB is ~23x headroom: legitimate upstream growth can never trip it, while a
// hostile or corrupt response can't buffer the sidecar out of memory.
const MAX_BODY_BYTES = 32 * 1024 * 1024;

// The minimum share of the VENDORED model count a fetched snapshot must carry
// before it is allowed to replace it.
//
// 50% is a CATASTROPHIC-RESTRUCTURE bar, not a quality bar. It fires only when
// upstream has lost most of its Claude keys at once — a rename or restructure
// slipping past `transformUpstreamPricing`'s `/claude/i` filter — and stays
// quiet through any plausible legitimate pruning of retired models. A stricter
// bar would eventually pin the app to an ever-staler vendored floor as upstream
// genuinely drops old Claude keys, which is the failure this check exists to
// prevent, only slower.
//
// Compared against the VENDORED count, never `activePricingSnapshot()`: the
// active one ratchets upward with each successful fetch, so using it would turn
// the floor into a monotonic high-water mark that refuses legitimate prunings.
const MIN_MODEL_RATIO = 0.5;

// Best-effort fetch + swap of the upstream LiteLLM pricing. Resolves to a
// result describing the outcome — it never rejects.
//
// The nested try/catch structure exists so each `PricingFailureKind` is
// reachable at the seam that actually failed: a flat single `try` can only
// report "something threw", which is how the old opaque `reason` came about.
export async function refreshPricing(
  opts: RefreshPricingOptions = {},
): Promise<RefreshPricingResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    // Constructed OUTSIDE the fetch's own try on purpose: a `timeoutMs` the
    // platform rejects is a programmer error, and reporting it as `offline`
    // would blame the network for our own bad argument. It falls to the
    // backstop below instead.
    const signal = AbortSignal.timeout(timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(UPSTREAM_PRICING_URL, { signal });
    } catch (err) {
      return fail(classify(err, "offline"), detailOf(err));
    }

    if (!response.ok) {
      // Nothing reads an error body, and an undrained, uncancelled one holds
      // its connection open until GC gets round to it. The `.catch` is
      // mandatory rather than cosmetic: `index.ts` handles `unhandledRejection`
      // by shutting the sidecar down, so a bare `void`ed rejecting cancel would
      // turn a 404 from upstream into a dead sidecar.
      response.body?.cancel().catch(() => {});
      return fail("http", `HTTP ${response.status}`);
    }

    let fetchedAt: string;
    let snapshot: ReturnType<typeof transformUpstreamPricing>;
    try {
      // NOT `response.json()` — the body goes through a counting reader so an
      // oversized payload is refused rather than buffered (see MAX_BODY_BYTES).
      const body = await readCappedBody(response, MAX_BODY_BYTES);
      const upstream: unknown = JSON.parse(body);
      // The fetch time IS the snapshot's capture time — a runtime refresh is, by
      // definition, captured now.
      fetchedAt = new Date().toISOString();
      snapshot = transformUpstreamPricing(upstream, fetchedAt);
    } catch (err) {
      // Deliberately no `body.cancel()` on this arm: every path that reaches it
      // has already locked (and usually consumed) the stream, and `cancel()` on
      // a locked stream returns a REJECTED promise which this `catch` — already
      // unwinding — would not catch. It would reach `unhandledRejection`, i.e.
      // sidecar shutdown, which is strictly worse than the socket it saves.
      return fail(classify(err, "payload"), detailOf(err));
    }

    // The completeness floor — the last gate before the swap. See
    // MIN_MODEL_RATIO for why the bar is where it is, and why it is measured
    // against the vendored snapshot rather than the active one. It lives here
    // and not in `transformUpstreamPricing` because that function is shared with
    // `packages/shared/scripts/refresh-pricing.ts`, which regenerates the very
    // floor it would be compared against.
    const fetchedModels = Object.keys(snapshot.models).length;
    const vendoredModels = Object.keys(pricingSnapshot.models).length;
    if (fetchedModels < vendoredModels * MIN_MODEL_RATIO) {
      return fail(
        "payload",
        `fetched snapshot carries ${fetchedModels} of the vendored ${vendoredModels} models — ` +
          `under the ${Math.ceil(vendoredModels * MIN_MODEL_RATIO)}-model completeness floor`,
      );
    }

    setActivePricingSnapshot(snapshot);
    return { ok: true, fetchedAt };
  } catch (err) {
    // The backstop. Reachable via `setActivePricingSnapshot` (the swap itself)
    // and `AbortSignal.timeout` — folding those into `offline` would report a
    // swap failure as a network problem, so `unknown` keeps the catch-all
    // honest while preserving the never-throws contract belt-and-braces.
    return fail(classify(err, "unknown"), detailOf(err));
  }
}

// Read a response body to text through a running byte counter, refusing to
// buffer past `maxBytes`. Throws on an oversized body — the caller classifies
// that as `payload` — and propagates a mid-read abort untouched so `classify`
// can call it the `timeout` it actually is.
async function readCappedBody(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  // A 200 carrying no body at all is unparseable: the payload's fault, not the
  // network's. `undefined` as well as `null`, because a non-standard Response
  // may simply not carry the property.
  if (body === null || body === undefined) {
    throw new Error("upstream pricing response had no body");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      // Stop pulling and drop the connection rather than draining the rest of
      // an unbounded body. `.catch` for the same reason the non-2xx arm has
      // one — a rejecting cancel must never reach `unhandledRejection`.
      void reader.cancel().catch(() => {});
      throw new Error(`upstream pricing payload exceeded the ${maxBytes}-byte ceiling`);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

// An abort ALWAYS means our own timeout fired. `refreshPricing` passes exactly
// one signal — `AbortSignal.timeout(timeoutMs)` — so there is no other abort
// source to confuse it with. Both DOMException names denote that same
// condition: `AbortSignal.timeout()` fires `TimeoutError` in production, and
// `AbortError` is how a hand-driven abort of the same signal presents (which is
// what the timeout test injects). Checked at every seam rather than only the
// fetch one, because a body read can abort mid-flight too — reporting that as
// `payload` would blame the data for a stalled network.
function classify(err: unknown, otherwise: PricingFailureKind): PricingFailureKind {
  const aborted =
    err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
  return aborted ? "timeout" : otherwise;
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Silent failure — log at warn level (visible in the sidecar's stderr, not a
// crash) and report the classified outcome to the caller, which now records it
// on the live status rather than discarding it.
//
// `warn`, not `info`/`debug`: a refresh failure is not nothing — it means the
// install is running on the vendored snapshot's prices, which only drift
// further from upstream the longer the failure persists. A one-off offline
// boot is harmless, but a *persistently* failing refresh is a real
// staleness exposure, and `warn` is the level an operator scanning stderr
// would actually notice.
function fail(kind: PricingFailureKind, detail: string): RefreshPricingResult {
  console.warn(`[sidecar] pricing refresh skipped (${kind}: ${detail}); using vendored snapshot`);
  return { ok: false, kind, detail };
}

// The ONE construction site for the wire's pricing status (ADR-0053). Both
// `main()` call sites — the boot seed and every settled refresh — patch through
// this, so `source` / `capturedAt` / `modelCount` can never disagree with each
// other or with the snapshot actually pricing reports.
//
// `result === null` means no attempt has settled yet: that is the boot seed,
// where the active snapshot is still the vendored floor and `lastAttempt` is
// honestly unknown.
//
// `source` needs no branch on the result. `withPricingOverrides` is documented
// as identity-preserving precisely so this identity check holds (overrides.ts),
// and the refresh suite asserts `activePricingSnapshot() === pricingSnapshot` on
// every failure path — so this is a tested property, not just a documented one.
// It is also correct on the case a result-based branch would get wrong: a failed
// ~24h tick after a successful boot fetch stays `"fetched"`, because live prices
// are still active.
export function buildPricingStatus(
  result: RefreshPricingResult | null,
  nowImpl: () => string = () => new Date().toISOString(),
): PricingStatus {
  const active = activePricingSnapshot();
  return {
    source: active === pricingSnapshot ? "vendored" : "fetched",
    capturedAt: active.capturedAt,
    // Off the ACTIVE snapshot, so the count includes the ADR-0027 override
    // gap-fill — the honest answer to "how many models can this app price".
    modelCount: Object.keys(active.models).length,
    lastAttempt:
      result === null
        ? null
        : result.ok
          ? // On success the fetch time IS the attempt time and the new
            // snapshot's `capturedAt`, so the healthy row's two timestamps
            // agree by construction.
            { at: result.fetchedAt, failure: null }
          : { at: nowImpl(), failure: { kind: result.kind, detail: result.detail } },
  };
}

// The handle a scheduled refresh loop hands back — `stop()` cancels the timer.
export type PricingRefreshLoop = { stop: () => void };

// ADR-0041 (T14): the ~24h BEST-EFFORT pricing re-fetch. Startup-only refresh
// left always-on machines frozen at boot-day prices, making cross-machine cost
// convergence hollow — so the same refreshPricing re-runs on a daily interval.
// Never throws, never gates anything; a failure leaves the active snapshot
// untouched and the loop ticking. Injectable + disabled in tests (tests never
// call schedulePricingRefresh with real timers).
//
// `onResult` fires for EVERY settled attempt, success or failure (ADR-0053) —
// it used to be an `onSuccess` that only saw the happy path, which meant a
// machine that had never once reached upstream could only ever report
// `lastAttempt: null`, indistinguishable from one still awaiting its first
// attempt. One callback rather than `onSuccess` + `onFailure`: two would each
// have to rebuild the status object independently, defeating
// `buildPricingStatus`'s single-construction-site guarantee.
export function schedulePricingRefresh(opts: {
  onResult: (result: RefreshPricingResult) => void;
  intervalMs?: number;
  refreshImpl?: () => Promise<RefreshPricingResult>;
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
}): PricingRefreshLoop {
  const intervalMs = opts.intervalMs ?? 24 * 60 * 60 * 1000;
  const refreshImpl = opts.refreshImpl ?? refreshPricing;
  const setIntervalImpl = opts.setIntervalImpl ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalImpl =
    opts.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  // A slow refresh (a hung fetch inside the AbortSignal timeout) must not let
  // the next tick stack a second concurrent attempt — the guard drops when the
  // in-flight one settles. A tick dropped here is NOT an attempt: no fetch is
  // issued, so reporting one would advance `lastAttempt.at` and make a single
  // hung fetch look like healthy repeated activity.
  let inFlight = false;
  const handle = setIntervalImpl(() => {
    if (inFlight) return;
    inFlight = true;
    // Two-argument `.then` rather than a trailing `.catch`, so the rejection
    // handler covers `refreshImpl()` ONLY. The two failure modes are genuinely
    // different — a refresh that couldn't run vs. a status update that threw —
    // and a trailing `.catch` (where `onResult` used to sit, inside the `.then`)
    // labelled both as the former, blaming the fetch for a wiring bug.
    void refreshImpl()
      .then(
        (result) => {
          try {
            opts.onResult(result);
          } catch (err: unknown) {
            console.warn("[sidecar] pricing refresh status update failed:", err);
          }
        },
        // A REJECTING refreshImpl is not a result — `refreshPricing` never
        // rejects by contract, so this stays a defensive warn rather than a
        // synthesized `unknown` failure the refresh never actually returned.
        (err: unknown) => {
          console.warn("[sidecar] periodic pricing refresh failed:", err);
        },
      )
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  return { stop: () => clearIntervalImpl(handle) };
}

// The SINGLE wiring site: `main()` calls this once, after the LISTENING
// handshake, and keeps the returned handle so shutdown can `stop()` the timer.
//
// Both arms patch the same `{ pricing: buildPricingStatus(result) }`. They used
// to be two hand-written blocks in `index.ts` — plus a third reconstruction of
// them in `pricing-refresh.test.ts`, since `main()` is not exported — held
// together by a comment asking a future editor to keep all three in sync.
//
// The two arms are NOT interchangeable, and both differences are deliberate:
//   - The startup arm carries its own `.catch`. `refreshPricing` never rejects,
//     but `patch` could in principle throw, and a `void`ed rejection would reach
//     `unhandledRejection` — which `index.ts` handles by exiting the process.
//   - The startup arm does NOT participate in the loop's `inFlight` guard. It is
//     kicked before any tick can fire, and folding it in would be a semantic
//     change ADR-0053 didn't sanction.
export function wirePricingRefresh(opts: {
  patch: (partial: { pricing: PricingStatus }) => void;
  refreshImpl?: () => Promise<RefreshPricingResult>;
  intervalMs?: number;
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
}): PricingRefreshLoop {
  const refreshImpl = opts.refreshImpl ?? refreshPricing;
  const patchResult = (result: RefreshPricingResult): void => {
    opts.patch({ pricing: buildPricingStatus(result) });
  };

  void refreshImpl()
    .then(patchResult)
    .catch((err: unknown) => {
      console.warn("[sidecar] pricing refresh status update failed:", err);
    });

  return schedulePricingRefresh({
    onResult: patchResult,
    refreshImpl,
    intervalMs: opts.intervalMs,
    setIntervalImpl: opts.setIntervalImpl,
    clearIntervalImpl: opts.clearIntervalImpl,
  });
}
