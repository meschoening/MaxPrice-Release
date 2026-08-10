import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { output, ZodType } from "zod";
import {
  BLOCKS_KEY_ROOT,
  DATA_QUERY_KEYS,
  isBlockSpanIntradayKey,
  SESSION_KEY_ROOT,
  sessionKey,
  SSE_EVENT,
  statusSnapshotSchema,
  usageEventSchema,
  usageSampleEventSchema,
} from "@maxprice/shared";
import { queryClient } from "@/lib/query";
import { getSidecarUrl, resetSidecarUrl, SidecarStartupError } from "@/lib/sidecar";
import { useLiveStatus } from "@/state/use-live-status";
import { usageCurrentQueryKey } from "@/state/use-usage-current";
import { machinesQueryKey } from "@/state/use-machines";
import { projectIdentityQueryKey } from "@/state/use-project-identity";

// The renderer end of the Part 3 live data pipeline (ADR-0007): one EventSource
// against the sidecar's `/api/stream`, dispatching events into TanStack Query
// and the live-status store. The four-piece query-key contract (ADR-0004) lets
// this module invalidate caches without pulling in React.

// --- Reconnect backoff -------------------------------------------------------

// Exponential backoff: 1s, 2s, 4s, 8s, 16s, then capped at 30s. The renderer
// owns reconnection — native EventSource auto-reconnect is a fixed interval
// that would hammer a downed sidecar.
export function nextReconnectDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

// Once this many reconnects have failed the backoff has saturated at the 30s
// cap (~31s of accumulated downtime) and the sidecar looks genuinely gone — the
// status UI flips from "reconnecting…" to "offline". Retrying continues either
// way; the threshold only changes the label.
const DISCONNECTED_AFTER_ATTEMPTS = 5;

// --- Event dispatch ----------------------------------------------------------

// Returns the schema's OUTPUT type (what `safeParse().data` actually is), not
// the generic's input-flavored collapse — so a field with a `.default()`
// (statusSnapshotSchema.ready) is `boolean`, not `boolean | undefined`.
function parseEvent<S extends ZodType>(schema: S, dataText: string): output<S> | null {
  try {
    const parsed = schema.safeParse(JSON.parse(dataText));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Wholesale invalidation: one predicate call marks every report family stale.
// The Live view mounts ~one query per family, so this costs no more than
// precise per-key matching — and needs no query-key introspection. Reuses the
// DATA_QUERY_KEYS set the cost-mode dropdown already invalidates through.
// Internal-only: every caller — the debounced usage:new flush, the reconnect
// catch-up, the manual rescan (via requestInvalidationRound) — goes through
// the completion gate below; the returned promise is what the gate awaits.
function invalidateDataFamilies(client: QueryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: (query) => DATA_QUERY_KEYS.has(String(query.queryKey[0])),
  });
}

// usage:new invalidation is debounced. The sidecar debounces file writes at
// 500ms per file, so a multi-file write burst still lands several frames within
// a second; each invalidation refetches every report family and each refetch
// re-runs the engine's aggregators across the whole event store. Coalescing a
// burst into one pass avoids that fan-out. markEvent stays immediate (see handleUsageEvent) so the
// refresh pill still pulses on every frame.
const USAGE_INVALIDATE_DEBOUNCE_MS = 300;
// Upper bound on how long the trailing debounce may keep deferring. Two+ files
// written concurrently can interleave usage:new events <300ms apart indefinitely,
// continuously re-arming the trailing timer so it never fires — reports go stale
// while the pill still reads "live". Once the oldest pending event is this old,
// flush regardless of fresh arrivals.
const USAGE_INVALIDATE_MAX_WAIT_MS = 1000;
let usageInvalidateTimer: ReturnType<typeof setTimeout> | null = null;
// When the current pending batch's first event landed — the maxWait clock. Null
// when no batch is pending.
let usageInvalidateFirstPendingAt: number | null = null;
const pendingSessionIds = new Set<string>();

// ── The completion gate (#114) ──
// The debounce above bounds how often a round is REQUESTED; this gate bounds
// how often one STARTS — by completion, not by timer. A round is one wholesale
// families invalidation plus the per-key invalidations flushed with it, in
// flight until every refetch it triggered settles. At most one round runs at a
// time; arrivals during flight coalesce into a single follow-up round started
// the moment the current one settles (the fleet.ts do/while shape, applied
// renderer-side). Without it the maxWait floor makes round *starts* a timer
// floor while a round's cost is completion-bound — the queue grows without
// bound under a steady peer-push stream.
let roundInFlight = false;
let roundPending = false;
// Whether the next round must also sweep the whole per-session detail family
// (["session"]) — set by a rescan, which doesn't know which sessions changed.
// Sticky across the pending window: if the round it was requested for is owed
// rather than started, the sweep rides the follow-up.
let pendingSessionSweep = false;
// Generation stamp for rounds, bumped on teardown — a round left in flight
// when the stream is torn down is orphaned: its settle must neither release
// the gate (which a reconnect may have handed to a NEW round) nor start a
// follow-up. Mirrors connectGeneration for the EventSource lifecycle below.
let roundGeneration = 0;

// Start a round: every report family plus each distinct per-session detail key
// accumulated so far. The gate releases when ALL its refetches settle —
// allSettled, so a rejected refetch releases it rather than wedging it.
function startRound(client: QueryClient): void {
  roundInFlight = true;
  const gen = roundGeneration;
  const invalidations: Array<Promise<unknown>> = [invalidateDataFamilies(client)];
  for (const id of pendingSessionIds) {
    invalidations.push(client.invalidateQueries({ queryKey: sessionKey(id) }));
  }
  pendingSessionIds.clear();
  if (pendingSessionSweep) {
    pendingSessionSweep = false;
    invalidations.push(client.invalidateQueries({ queryKey: SESSION_KEY_ROOT }));
  }
  void Promise.allSettled(invalidations).then(() => {
    if (gen !== roundGeneration) return; // orphaned by teardown — state was reset
    roundInFlight = false;
    if (roundPending) {
      roundPending = false;
      startRound(client);
    }
  });
}

// Request a round now: clear any armed debounce state, then start — or, if a
// round is already in flight, mark it owed; the settle handler starts the one
// follow-up. Shared by the trailing-debounce timer and the maxWait force-flush
// so neither path duplicates the work.
function flushUsageInvalidation(client: QueryClient): void {
  if (usageInvalidateTimer !== null) {
    clearTimeout(usageInvalidateTimer);
    usageInvalidateTimer = null;
  }
  usageInvalidateFirstPendingAt = null;
  if (roundInFlight) {
    roundPending = true;
    return;
  }
  startRound(client);
}

// The immediate entry to the gate: request a round NOW, skipping the debounce
// timers (any debounce-pending batch is absorbed into the round). For repair
// gestures — the reconnect catch-up (`open`) and the manual rescan (ADR-0019) —
// whose staleness signal is not a data event, so they must not sit out the
// debounce; both still respect the one-round-in-flight invariant, coalescing
// into the follow-up if a round is running. `sweepSessionRoot` additionally
// invalidates the whole per-session detail family in the requested round.
export function requestInvalidationRound(
  client: QueryClient,
  opts?: { sweepSessionRoot?: boolean },
): void {
  if (opts?.sweepSessionRoot === true) pendingSessionSweep = true;
  flushUsageInvalidation(client);
}

function scheduleUsageInvalidation(client: QueryClient, sessionId: string): void {
  pendingSessionIds.add(sessionId);
  // While a round is in flight no timers run — the arrival is owed to the
  // follow-up round the settle handler starts.
  if (roundInFlight) {
    roundPending = true;
    return;
  }
  usageInvalidateFirstPendingAt ??= Date.now();
  // Cap the trailing debounce: once the batch has been deferred for the maxWait,
  // flush now instead of letting a fresh event re-arm the timer indefinitely.
  if (Date.now() - usageInvalidateFirstPendingAt >= USAGE_INVALIDATE_MAX_WAIT_MS) {
    flushUsageInvalidation(client);
    return;
  }
  if (usageInvalidateTimer !== null) clearTimeout(usageInvalidateTimer);
  usageInvalidateTimer = setTimeout(() => {
    flushUsageInvalidation(client);
  }, USAGE_INVALIDATE_DEBOUNCE_MS);
}

// Drop a pending usage:new invalidation — called on teardown so a debounce
// timer can't fire after the stream is gone (matters for HMR and tests).
function cancelUsageInvalidation(): void {
  if (usageInvalidateTimer !== null) {
    clearTimeout(usageInvalidateTimer);
    usageInvalidateTimer = null;
  }
  usageInvalidateFirstPendingAt = null;
  pendingSessionIds.clear();
  roundInFlight = false;
  roundPending = false;
  pendingSessionSweep = false;
  roundGeneration++;
}

// `usage:new` — a JSONL write landed. Pulse the refresh pill immediately, then
// schedule a debounced refetch of every report family plus the per-session
// detail key (a Part 5 stub today).
export function handleUsageEvent(client: QueryClient, dataText: string): void {
  const event = parseEvent(usageEventSchema, dataText);
  if (event === null) return;
  useLiveStatus.getState().markEvent(Date.now());
  scheduleUsageInvalidation(client, event.sessionId);
}

// `block:tick` — 30s cadence; refresh the blocks family so burn rate /
// projection stay current even with no file activity.
//
// Also invalidates the block-span intraday query (span=block). The block frame
// is block-shaped data: when the active block ends (idle reset, out-of-band
// reset via usage samples) with no concurrent JSONL write, usage:new never
// fires — the chart would stay frozen on the dead frame until the next file
// event. block:tick runs on the same 30s cadence as the Active block tile, so
// invalidating the span=block intraday key here keeps the chart and tile in
// sync (rolling to the new frame, or the empty state) within tick cadence even
// with no file activity. Only span=block is targeted — block:tick fires every
// 30s and must not trigger a refetch of every span's chart (ADR-0031).
export function handleBlockTick(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: BLOCKS_KEY_ROOT });
  void client.invalidateQueries({
    predicate: (q) => isBlockSpanIntradayKey(q.queryKey),
  });
}

// `status:changed` — watched paths / pricing freshness / engine version.
// Receiving a status frame is also proof the channel is live, so confirm the
// connection (idempotent — the EventSource `open` handler sets it too).
export function handleStatusEvent(dataText: string): void {
  const snapshot = parseEvent(statusSnapshotSchema, dataText);
  if (snapshot === null) return;
  useLiveStatus.getState().applyStatusSnapshot(snapshot);
  useLiveStatus.getState().setConnectionState("connected");
}

// A valid null is an authoritative "no window in flight" result, so this
// cannot use parseEvent's null-as-failure sentinel.
export function handleUsageSampleEvent(client: QueryClient, dataText: string): void {
  try {
    const parsed = usageSampleEventSchema.safeParse(JSON.parse(dataText));
    if (!parsed.success) return;
    client.setQueryData(usageCurrentQueryKey(), () => ({ sample: parsed.data }));
  } catch {
    // Malformed SSE payloads leave the prior cache untouched.
  }
}

// --- EventSource lifecycle ---------------------------------------------------

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let active = false;
// Monotonic generation stamped on each openConnection attempt. The `active`
// flag alone can't supersede an in-flight connect: under StrictMode's
// mount→cleanup→remount, connect#1 suspends at `await getSidecarUrl()`, cleanup
// flips `active=false`, the remount restarts (the connectLiveStream `if(active)`
// guard doesn't short-circuit since active is now false) and connect#2 suspends;
// when both awaits resolve, both see `active===true` again and each opens an
// EventSource — orphaning the first. Bumping this on every attempt lets the
// post-await check bail any run that is no longer the latest.
let connectGeneration = 0;

// Open the SSE channel and keep it open for the app's lifetime, reconnecting
// with exponential backoff. Idempotent — a second call while active is a no-op.
export function connectLiveStream(): void {
  if (active) return;
  active = true;
  reconnectAttempt = 0;
  void openConnection();
}

export function disconnectLiveStream(): void {
  active = false;
  // Supersede any connect attempt currently suspended on its URL await so it
  // can't open a stale EventSource after teardown (belt-and-suspenders with the
  // `active` flag).
  connectGeneration++;
  cancelUsageInvalidation();
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (eventSource !== null) {
    eventSource.close();
    eventSource = null;
  }
}

// Force an immediate reconnect, bypassing the exponential backoff. The manual
// refresh gesture (ADR-0019) calls this when the channel is down, so ⇧R doesn't
// have to wait out a backoff that may be sitting at its 30s cap. No-op if the
// stream was never started (`active === false`) or a healthy connection is
// already open — only a down/connecting channel is torn down and reopened now.
export function reconnectNow(): void {
  if (!active) return;
  if (eventSource !== null && eventSource.readyState === EventSource.OPEN) return;
  // Reset the backoff so the label flips out of "offline" and the next failure
  // (if any) starts counting from zero again.
  reconnectAttempt = 0;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (eventSource !== null) {
    eventSource.close();
    eventSource = null;
  }
  // Bumps connectGeneration, superseding any attempt suspended on its URL await.
  void openConnection();
}

// Mount-once hook — opens the live stream when the app shell mounts and tears
// it down on unmount. Belongs in Layout, which lives for the whole session.
export function useLiveStream(): void {
  useEffect(() => {
    connectLiveStream();
    return () => disconnectLiveStream();
  }, []);
}

async function openConnection(): Promise<void> {
  if (!active) return;
  // Stamp this attempt so a later connect (or disconnect) can supersede it
  // while it's suspended on the URL await — see `connectGeneration` above.
  const gen = ++connectGeneration;
  // Re-resolve the URL each attempt in case the sidecar restarted on a new port.
  resetSidecarUrl();
  let baseUrl: string;
  try {
    baseUrl = await getSidecarUrl();
  } catch (err) {
    // A terminal URL failure (SidecarStatus::Failed — the process is gone)
    // before `ready` ever arrived is the boot splash's error card (T4). The
    // backoff loop keeps running regardless: it can't respawn the sidecar,
    // but a heal (dev-mode restarts) flows back through the `open` handler.
    const status = useLiveStatus.getState();
    if (err instanceof SidecarStartupError && err.terminal && status.ready !== true) {
      status.setBootFailure(err.message);
    }
    scheduleReconnect();
    return;
  }
  // Bail if torn down (active) or superseded by a newer attempt (gen) while the
  // URL was resolving — without this an orphaned EventSource would leak.
  if (!active || gen !== connectGeneration) return;

  const es = new EventSource(`${baseUrl}/api/stream`);
  eventSource = es;

  es.addEventListener("open", () => {
    reconnectAttempt = 0;
    useLiveStatus.getState().setConnectionState("connected");
    // A live channel refutes any recorded pre-ready failure — let the splash
    // fall back from its error card to the loading arc.
    useLiveStatus.getState().setBootFailure(null);
    // Catch any file events missed while the stream was down — a repair, not a
    // data event: it skips the debounce but respects the completion gate, so it
    // can never run a wholesale invalidation beside an in-flight round (#114).
    // Status itself arrives as the stream's first `status:changed` frame.
    requestInvalidationRound(queryClient);
    // The round covers the report families only, so the two directory pokes
    // below — whose events (`identity:changed`, `machines:changed`) are simply
    // LOST while the stream is down — would otherwise stay stale until app
    // restart: both queries keep a permanently-mounted observer (the sidebar's
    // filter rail never unmounts) and the client has `refetchOnWindowFocus:
    // false`, so nothing else ever refetches them. Deliberately OUTSIDE the
    // gate, exactly as their live listeners are: these are tiny loopback reads,
    // not report refetches, and ADR-0058's round has a specific contract — the
    // report families plus the per-session detail keys — that narrow pokes have
    // never belonged to. (Nor does this reverse ADR-0062 §4: that exclusion is
    // about reports never invalidating FOR an identity change, and says nothing
    // about the identity directory catching up after an outage.)
    void queryClient.invalidateQueries({ queryKey: projectIdentityQueryKey });
    void queryClient.invalidateQueries({ queryKey: machinesQueryKey });
  });
  es.addEventListener(SSE_EVENT.usageNew, (e) => {
    handleUsageEvent(queryClient, (e as MessageEvent).data);
  });
  es.addEventListener(SSE_EVENT.blockTick, () => {
    handleBlockTick(queryClient);
  });
  es.addEventListener(SSE_EVENT.statusChanged, (e) => {
    handleStatusEvent((e as MessageEvent).data);
  });
  es.addEventListener(SSE_EVENT.usageSample, (e) => {
    handleUsageSampleEvent(queryClient, (e as MessageEvent).data);
  });
  es.addEventListener(SSE_EVENT.machinesChanged, () => {
    // The machine directory changed hub-side (rename, registration, merge) or
    // the sidecar refreshed its cache — refetch the loopback directory. A poke,
    // never data (ADR-0041).
    void queryClient.invalidateQueries({ queryKey: machinesQueryKey });
  });
  es.addEventListener(SSE_EVENT.identityChanged, () => {
    // The Identity directory changed — a local probe wrote a fresh repoId, or a
    // hub pull brought another machine's rows in. Refetch the loopback
    // directory; a poke, never data (ADR-0062).
    //
    // Deliberately the ONLY key invalidated: the reports are not stale, their
    // FOLD is. The refetched index changes each report's filter expansion, and
    // that surfaces as a new query key on its own (ADR-0062 §4) — sweeping the
    // report families here would refetch the whole corpus for nothing.
    void queryClient.invalidateQueries({ queryKey: projectIdentityQueryKey });
  });
  es.addEventListener("error", () => {
    // Take over reconnection ourselves rather than letting EventSource's
    // fixed-interval retry hammer a downed sidecar. scheduleReconnect owns the
    // connection-state transition (reconnecting vs disconnected).
    es.close();
    if (eventSource === es) eventSource = null;
    if (!active) return;
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (!active || reconnectTimer !== null) return;
  // The first few failures read as a transient blip; once the backoff has
  // saturated, the sidecar looks genuinely gone. Either way, keep retrying.
  useLiveStatus
    .getState()
    .setConnectionState(
      reconnectAttempt >= DISCONNECTED_AFTER_ATTEMPTS ? "disconnected" : "reconnecting",
    );
  const delay = nextReconnectDelay(reconnectAttempt);
  // Clamp so the stored attempt count stays bounded across a long outage — the
  // delay is already capped and the disconnected threshold only needs `>=`.
  reconnectAttempt = Math.min(reconnectAttempt + 1, DISCONNECTED_AFTER_ATTEMPTS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void openConnection();
  }, delay);
}

// Vite HMR: tear the connection down on hot-replace so dev reloads don't leak
// EventSource connections.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disconnectLiveStream();
  });
}
