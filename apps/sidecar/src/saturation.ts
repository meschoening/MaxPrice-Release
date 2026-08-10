// Saturation sampler (issue #116 / F4): measures Loop lag — timer-overshoot
// samples of this process's event loop — and owns the Saturation verdict.
//
// Mechanism: schedule a timer for `sampleIntervalMs`; when it fires, the
// overshoot past its due time is exactly how long the loop kept scheduled work
// waiting. One contiguous synchronous block of length L yields exactly ONE
// sample of lag ≈ L (no timer can fire mid-block), so the window's SUMMED lag
// approximates its total blocked wall time — `blockedPct` = sum/window is the
// verdict statistic. p50 + max still ride the wire as the spread diagnostic,
// and the process's CPU share of one core rides alongside as the calibration
// channel against an external `TotalProcessorTime` reading.
//
// The verdict trips on `blockedPct`, NOT the p50 — a lesson the 2026-07-31
// calibration bought with a live reproduction of F1 (#113): under duty-cycle
// starvation (4s aggregation folds with sub-second drain gaps) each fold
// yields one huge-lag sample while the gap yields several on-time ones, so the
// p50 read 4ms against a process externally measured at 102% of one core with
// 5-7s request queues. The sampling frequency is inversely proportional to the
// blockage — a median can NEVER see this shape; the sum sees exactly it
// (measured 40-65% blocked in the repro, ~0% healthy, with a lone 900ms GC
// pause at 1.5% — the margins the p50 was chosen for, kept, on the statistic
// that actually measures the condition).
//
// The verdict is owned here, not by consumers: trips above `tripBlockedPct`,
// clears only below half of it — hysteresis, so a process hovering at the
// boundary cannot flap the verdict (verdict EDGES emit SSE frames, so flapping
// would be user-visible).
//
// Deliberately self-contained (no engine/hub imports) so the hub daemon can
// adopt it unchanged later. `perf_hooks.monitorEventLoopDelay` is not reliably
// implemented in Bun — hence the hand-rolled timer, which also gives tests a
// seam to drive the loop's starvation by hand. The one import below does not
// weaken that: it is type-only (fully erased, so `bun build --compile` is
// untouched) and it is `@maxprice/shared`, which the hub package already
// depends on — not the engine, not the hub.
//
// `SaturationSnapshot` is NOT declared here because it is a wire shape: it
// rides `GET /api/status` and every `status:changed` frame verbatim, so the
// Zod object in `packages/shared/src/live.ts` owns it and this module infers
// from it. A second hand-written copy would drift silently in exactly one
// direction the compiler cannot catch — an ADDED field, which the non-strict
// status object strips on the way to the renderer's `safeParse`.

import type { SaturationSnapshot } from "@maxprice/shared";

export type { SaturationSnapshot };

export type SaturationSamplerDeps = {
  sampleIntervalMs?: number;
  windowMs?: number;
  tripBlockedPct?: number;
  nowImpl?: () => number;
  cpuUsageImpl?: () => { user: number; system: number }; // µs, process.cpuUsage shape
  setTimeoutImpl?: (cb: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  onVerdictChange?: (saturated: boolean, snapshot: SaturationSnapshot) => void;
};

export type SaturationSampler = {
  start: () => void;
  stop: () => void;
  snapshot: () => SaturationSnapshot;
};

export const SATURATION_SAMPLE_INTERVAL_MS = 250;
export const SATURATION_WINDOW_MS = 60_000;
// The trip threshold is CALIBRATED, not guessed: pinned 2026-07-31 against a
// live reproduction of F1's demand (#113) on the real 69.5k-event corpus —
// the repro measured 40-65% blocked (the original incident sat near 100%),
// a healthy loop ~0%, and a lone 900ms spike 1.5%. 30% splits those regimes
// with a wide margin on both sides.
export const SATURATION_TRIP_BLOCKED_PCT = 30;

type Sample = { at: number; lagMs: number; cpuUs: number };

export type SaturationReportingDeps = Omit<SaturationSamplerDeps, "onVerdictChange"> & {
  // liveHub.patchStatus, narrowed: the reporting layer only ever patches the
  // one field, and always with a WHOLE saturation object (the
  // fleetEventsStatus patch-whole rule).
  patch: (partial: { saturation: SaturationSnapshot }) => void;
  // Durable-log line sink (default console.warn → stdout pipe → the Rust tee).
  warn?: (line: string) => void;
  // Re-patch cadence while saturated, so a "catching up" UI isn't frozen on
  // the trip-edge numbers. Nothing is emitted while healthy.
  heartbeatMs?: number;
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
};

export type SaturationReporting = {
  snapshot: () => SaturationSnapshot;
  stop: () => void;
};

export const SATURATION_HEARTBEAT_MS = 10_000;

// Owns the two EFFECTS of a verdict flip (issue #116 / F4): the status patch
// that rides a status:changed frame to the renderer, and the console.warn line
// that rides the stdout pipe into the Rust shell's durable log — so a
// saturation episode that ended before anyone looked is still readable after
// the fact. Verdict EDGES are the only emitters while healthy; while saturated
// a slow heartbeat re-patches so the UI's numbers stay live. Starts sampling
// immediately.
export function startSaturationReporting(deps: SaturationReportingDeps): SaturationReporting {
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const heartbeatMs = deps.heartbeatMs ?? SATURATION_HEARTBEAT_MS;
  const nowImpl = deps.nowImpl ?? (() => Date.now());
  const setIntervalImpl =
    deps.setIntervalImpl ?? ((cb: () => void, ms: number): unknown => setInterval(cb, ms));
  const clearIntervalImpl =
    deps.clearIntervalImpl ??
    ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>));

  let heartbeat: unknown = null;
  let episodeStartedAt = 0;

  // BOTH patch sites go through here — the verdict edge and the heartbeat. A
  // status patch is REPORTING; the sampler's job is measurement, and a broken
  // consumer must stop neither. The heartbeat site is the more exposed of the
  // two: it is a bare interval callback, and the sidecar wires no
  // `uncaughtException` handler (index.ts), so an escaping throw there exits
  // the process — and the Rust shell does not respawn ("No respawn here by
  // design", lib.rs). Guarding only the edge would leave that path live while
  // reading as handled.
  const patchSaturation = (snapshot: SaturationSnapshot): void => {
    try {
      deps.patch({ saturation: snapshot });
    } catch (err: unknown) {
      warn(`[saturation] status patch failed: ${String(err)}`);
    }
  };

  const sampler = createSaturationSampler({
    ...deps,
    onVerdictChange: (saturated, snapshot) => {
      // The episode clock starts at the EDGE, before anything that can fail:
      // the recovery line's duration reads it, and a throwing patch must not
      // cost us the timestamp (an unset one would render as an epoch-long
      // episode).
      if (saturated) episodeStartedAt = nowImpl();
      // The durable `[saturation] …` log line (ADR-0056) and the heartbeat
      // install are the artifacts this layer exists to guarantee — a status
      // patch that threw must not skip them by aborting the handler.
      patchSaturation(snapshot);
      if (saturated) {
        warn(
          `[saturation] event loop saturated: blocked=${snapshot.blockedPct}% ` +
            `p50=${snapshot.p50LagMs}ms max=${snapshot.maxLagMs}ms ` +
            `cpu=${snapshot.cpuPercent}% (window ${Math.round(snapshot.windowMs / 1000)}s)`,
        );
        heartbeat = setIntervalImpl(() => patchSaturation(sampler.snapshot()), heartbeatMs);
      } else {
        if (heartbeat !== null) {
          clearIntervalImpl(heartbeat);
          heartbeat = null;
        }
        warn(
          `[saturation] event loop recovered after ${formatDuration(nowImpl() - episodeStartedAt)}: ` +
            `blocked=${snapshot.blockedPct}% max=${snapshot.maxLagMs}ms`,
        );
      }
    },
  });
  sampler.start();

  return {
    snapshot: sampler.snapshot,
    stop: () => {
      if (heartbeat !== null) {
        clearIntervalImpl(heartbeat);
        heartbeat = null;
      }
      sampler.stop();
    },
  };
}

function formatDuration(ms: number): string {
  return ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

export function createSaturationSampler(deps?: SaturationSamplerDeps): SaturationSampler {
  const sampleIntervalMs = deps?.sampleIntervalMs ?? SATURATION_SAMPLE_INTERVAL_MS;
  const windowMs = deps?.windowMs ?? SATURATION_WINDOW_MS;
  const tripBlockedPct = deps?.tripBlockedPct ?? SATURATION_TRIP_BLOCKED_PCT;
  const nowImpl = deps?.nowImpl ?? (() => Date.now());
  const cpuUsageImpl = deps?.cpuUsageImpl ?? (() => process.cpuUsage());
  const setTimeoutImpl =
    deps?.setTimeoutImpl ?? ((cb: () => void, ms: number): unknown => setTimeout(cb, ms));
  const clearTimeoutImpl =
    deps?.clearTimeoutImpl ??
    ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const samples: Sample[] = [];
  let saturated = false;
  let pending: unknown = null;
  let dueAt = 0;

  function schedule(): void {
    dueAt = nowImpl() + sampleIntervalMs;
    pending = setTimeoutImpl(onFire, sampleIntervalMs);
  }

  // Reporting is not measurement: a broken consumer must not stop the sampler
  // or take the process down. There is no `uncaughtException` handler
  // (index.ts wires only SIGINT / SIGTERM / unhandledRejection) and an uncaught
  // throw from a timer callback terminates Bun with exit 1, which the Rust
  // shell does not recover from ("No respawn here by design", lib.rs) — so an
  // unguarded callback turns a reporting bug into a dead sidecar. No production
  // callback can throw today; this is defense-in-depth for an exported,
  // dep-injected seam the hub is expected to adopt unchanged, and it matches
  // the guard the sibling `schedulePricingRefresh` puts around its `onResult`.
  function dispatchVerdict(next: boolean): void {
    try {
      deps?.onVerdictChange?.(next, snapshot());
    } catch (err: unknown) {
      console.warn("[saturation] verdict callback failed:", err);
    }
  }

  function onFire(): void {
    try {
      pending = null;
      const now = nowImpl();
      const cpu = cpuUsageImpl();
      samples.push({
        at: now,
        lagMs: Math.max(0, now - dueAt),
        cpuUs: cpu.user + cpu.system,
      });
      const cutoff = now - windowMs;
      while (samples.length > 0 && samples[0]!.at <= cutoff) samples.shift();

      const blocked = blockedPct();
      if (!saturated && blocked > tripBlockedPct) {
        saturated = true;
        dispatchVerdict(true);
      } else if (saturated && blocked < tripBlockedPct / 2) {
        saturated = false;
        dispatchVerdict(false);
      }
    } finally {
      // Always re-arm. `start()` runs exactly once (index.ts), so anything
      // escaping the body above would leave `pending === null` with nothing
      // left to schedule the next sample — measurement silently dead for the
      // life of the process.
      schedule();
    }
  }

  // The verdict statistic: the window's summed lag as a share of the window —
  // ≈ the fraction of wall time the loop spent inside synchronous blocks (each
  // block yields one sample carrying roughly its full length; see the header).
  // Clamped at 100: one block longer than the window is still just "all of it".
  function blockedPct(): number {
    let sumLagMs = 0;
    for (const s of samples) sumLagMs += s.lagMs;
    return Math.min(100, Math.round((sumLagMs / windowMs) * 1000) / 10);
  }

  // Lower median of the window's lags — deterministic; diagnostic-only on the
  // wire (the calibration proved a median cannot see duty-cycle starvation).
  function p50LagMs(): number {
    if (samples.length === 0) return 0;
    const sorted = samples.map((s) => s.lagMs).sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)]!;
  }

  function snapshot(): SaturationSnapshot {
    let maxLagMs = 0;
    for (const s of samples) maxLagMs = Math.max(maxLagMs, s.lagMs);

    // CPU share over the window needs two readings to have a delta; with fewer
    // it reports 0 rather than inventing a rate from no baseline.
    let cpuPercent = 0;
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (first !== undefined && last !== undefined && last.at > first.at) {
      cpuPercent =
        Math.round(((last.cpuUs - first.cpuUs) / ((last.at - first.at) * 1000)) * 1000) / 10;
    }

    return {
      saturated,
      blockedPct: blockedPct(),
      p50LagMs: p50LagMs(),
      maxLagMs,
      cpuPercent,
      windowMs,
    };
  }

  return {
    start: () => {
      if (pending === null) schedule();
    },
    stop: () => {
      if (pending !== null) {
        clearTimeoutImpl(pending);
        pending = null;
      }
    },
    snapshot,
  };
}
