import type { UsageConnection, UsageCredential, UsageSample } from "@maxprice/shared";
import { fetchUsage, type FetchUsageResult } from "./usage-client";
import type { SampleStore } from "./sample-store";

// Drives the 1/min usage poll (ADR-0023/0024). Holds the credential in memory
// only (renderer pushes it). The interval is a standalone setInterval — NOT
// ref-counted on SSE subscribers — so history accrues on any page. Best-effort:
// a failed poll updates connection status, never throws.

// The hub methods the poller needs. emitUsageSample is added to LiveHub in Task 7; patchStatus already exists.
export type PollerHub = {
  // A successful poll can authoritatively report that no account window is in
  // flight. Broadcast that null just like a sample so live consumers can clear
  // stale current state without touching the append-only history.
  emitUsageSample: (sample: UsageSample | null) => void;
  patchStatus: (partial: {
    usageConnection: UsageConnection;
    usageLastSampleAt: string | null;
  }) => void;
};

// The poller's full internal current-state. Distinct from the wire
// `UsageCurrent` ({ sample } only, ADR-0023/review f10): connection +
// lastSampleAt feed the status snapshot (zustand) separately, so they live on
// the poller's internal state, not the narrowed /api/usage/current response.
export type UsagePollerCurrent = {
  connection: UsageConnection;
  sample: UsageSample | null;
  lastSampleAt: string | null;
};

export type UsagePoller = {
  setCredential: (cred: UsageCredential | null) => void;
  // The auto-heal read seam (ADR-0035): the hub-client reads this machine's
  // key to push it to a hub whose own credential died. In-memory only, same
  // lifecycle as the rest of the credential.
  getCredential: () => UsageCredential | null;
  pollOnce: () => Promise<void>;
  getCurrent: () => UsagePollerCurrent;
  // While a remote Hub owns polling, mirror its authoritative current value
  // into the loopback /api/usage/current endpoint. This never mutates history.
  setCurrentSample: (sample: UsageSample | null) => void;
  start: (intervalMs?: number) => void;
  stop: () => Promise<void>;
};

export type CreateUsagePollerOptions = {
  store: SampleStore;
  liveHub: PollerHub;
  // Injected in tests; defaults to the real client. The `signal` is the
  // per-poll abort seam (F8) — stop() aborts it to cancel an in-flight fetch.
  fetchUsageImpl?: (
    opts: { sessionKey: string; orgId: string },
    signal: AbortSignal,
  ) => Promise<FetchUsageResult>;
  // Claude API base override — threaded to fetchUsage; the fake-claude rig sets it.
  baseUrl?: string;
  // Injected in tests to drive the poll cadence deterministically — Bun's
  // setSystemTime does not fake setInterval, so this DI seam is the only way to
  // step ticks without real-time waits. Defaults to the global timers.
  setIntervalImpl?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalImpl?: (handle: ReturnType<typeof setInterval>) => void;
};

export function createUsagePoller(opts: CreateUsagePollerOptions): UsagePoller {
  const fetchUsageImpl =
    opts.fetchUsageImpl ??
    ((c, signal) =>
      fetchUsage({ sessionKey: c.sessionKey, orgId: c.orgId, baseUrl: opts.baseUrl, signal }));
  const setIntervalImpl =
    opts.setIntervalImpl ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
  const clearIntervalImpl =
    opts.clearIntervalImpl ?? ((handle: ReturnType<typeof setInterval>) => clearInterval(handle));
  let credential: UsageCredential | null = null;
  let connection: UsageConnection = "disconnected";
  // undefined means no poll (local or Hub-owned) has established live state in
  // this process yet, so first paint may fall back to persisted history. Once a
  // successful poll says sample OR null, that authoritative value wins.
  let currentSample: UsageSample | null | undefined;
  let timer: ReturnType<typeof setInterval> | null = null;
  // Monotonic credential epoch: bumped on EVERY setCredential() call (set or clear).
  // runPoll() captures it before the await and bails after, so a Disconnect or a
  // credential swap mid-flight discards the now-stale resolved sample (f1).
  let epoch = 0;
  // Epoch-aware shared single-flight (f19): one in-flight poll backs BOTH the
  // interval ticks and the public pollOnce(). A caller coalesces onto it only
  // while the epoch is unchanged; a credential swap bumps the epoch, so the next
  // pollOnce() starts a FRESH fetch instead of returning a poll of the previous
  // credential (the credential endpoint must observe the NEW credential). The
  // superseded poll's post-await epoch check discards its own result.
  let inFlight: Promise<void> | null = null;
  let inFlightEpoch = -1;
  // Per-poll abort controller (F8): threaded into the fetch so stop() can cancel
  // an in-flight poll. A black-holed claude.ai would otherwise keep the fetch
  // parked until its 10s timeout, and the parent-death watchdog awaits stop()
  // inside shutdown() — that stall would blow the "orphan dies within ~1s"
  // guarantee (CLAUDE.md). Mirrors hub-client's connectAbort.
  let pollAbort: AbortController | null = null;

  function setStatus(next: UsageConnection): void {
    connection = next;
    opts.liveHub.patchStatus({
      usageConnection: next,
      usageLastSampleAt: opts.store.latest()?.capturedAt ?? null,
    });
  }

  async function runPoll(): Promise<void> {
    if (credential === null) return;
    const myEpoch = epoch;
    const abort = new AbortController();
    pollAbort = abort;
    let result: FetchUsageResult;
    try {
      result = await fetchUsageImpl(credential, abort.signal);
    } finally {
      // Release our slot once the fetch settles, unless a newer poll claimed it.
      if (pollAbort === abort) pollAbort = null;
    }
    // The credential was cleared (Disconnect) or swapped while this fetch was in
    // flight — drop the now-stale sample without any side effects (f1). A
    // stop()-driven abort surfaces as a fetch error here (real fetchUsage
    // catches it), so the result simply flows through as an "error" status — a
    // no-op patch on the way down; a fetch that completed normally before the
    // abort still lands (f17 store-flush ordering preserved).
    if (credential === null || epoch !== myEpoch) return;
    if (result.ok) {
      // `sample: null` = successful poll, no window in flight (ADR-0029).
      // Preserve history, but replace and broadcast the separate live-current
      // state so a prior reset cannot survive as a phantom active window.
      currentSample = result.sample;
      if (result.sample !== null) {
        opts.store.append(result.sample);
      }
      opts.liveHub.emitUsageSample(result.sample);
      setStatus("connected");
    } else {
      setStatus(result.kind === "expired" ? "expired" : "error");
    }
  }

  function pollOnce(): Promise<void> {
    // Coalesce onto the in-flight poll only when it started under the current
    // epoch; otherwise (a credential swap) start a fresh fetch (f19).
    if (inFlight !== null && inFlightEpoch === epoch) return inFlight;
    const startedEpoch = epoch;
    const p = runPoll()
      .catch((e) => console.warn("[usage-core] usage poll failed:", e))
      .finally(() => {
        // Release the slot only if a newer poll has not already claimed it.
        if (inFlight === p) {
          inFlight = null;
          inFlightEpoch = -1;
        }
      });
    inFlight = p;
    inFlightEpoch = startedEpoch;
    return p;
  }

  return {
    setCredential: (cred) => {
      credential = cred;
      // Bump on EVERY call (set or clear) so any in-flight poll captured under
      // the previous epoch discards its resolved sample (f1) and the next
      // pollOnce() refuses to coalesce onto it (f19).
      epoch++;
      if (cred === null) setStatus("disconnected");
      // No immediate poll here — callers (Task 7 wiring) call pollOnce() explicitly
      // right after setCredential() for immediate feedback. Firing it here creates an
      // unresolvable async race with any subsequent explicit pollOnce() call in tests
      // and production alike (double-append, double-broadcast). The interval set by
      // start() handles all subsequent periodic polls.
    },
    getCredential: () => credential,
    pollOnce,
    setCurrentSample: (sample) => {
      currentSample = sample;
    },
    getCurrent: () => {
      const sample = currentSample === undefined ? opts.store.latest() : currentSample;
      return { connection, sample, lastSampleAt: opts.store.latest()?.capturedAt ?? null };
    },
    start: (intervalMs = 60_000) => {
      // pollOnce() owns the single-flight coalescing, so a tick that lands while
      // a poll is still running fires no second fetch (f7/f19).
      timer ??= setIntervalImpl(() => {
        void pollOnce();
      }, intervalMs);
    },
    stop: () => {
      if (timer !== null) {
        clearIntervalImpl(timer);
        timer = null;
      }
      // Abort any in-flight fetch (F8) so a black-holed claude.ai can't park
      // the poll on its 10s timeout — shutdown() awaits this drain before
      // process.exit, and the parent-death watchdog's "orphan dies within ~1s"
      // can't survive a 10s stall. The aborted fetch rejects → runPoll resolves
      // at once. A fetch already completing normally is unaffected (f17).
      pollAbort?.abort();
      // Resolve once any in-flight poll has settled so shutdown can drain the
      // poller before flushing the sample store (f17). Safe to call repeatedly.
      return inFlight ?? Promise.resolve();
    },
  };
}
