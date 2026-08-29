// The monotonic, suspend-EXCLUDING clock every saturation measurement rides
// (issue #186; ADR-0056 amended).
//
// A wall clock cannot tell a suspended machine from a blocked event loop —
// both present as one enormous timer overshoot — and magnitude cannot
// discriminate them either, so the clock is the whole fix. `performance.now()`
// was chosen for that job and verified on the reference Mac across a real
// 120 s suspend: `dWall=120635ms` against `dMono=326ms`.
//
// It does not hold on Windows. Measured on the Windows primary across a real
// 705 s S3 suspend (#186):
//
//   Sleep 2026-08-27T02:02:19.945Z -> Wake 02:14:04.898Z   (704.953 s)
//   bracketing samples: dWall=781809ms  dMono=785753ms
//
// Only 76.9 s of that window was spent awake. `performance.now()` advanced by
// the whole wall span — 10.2x the running time — so on Windows the two clocks
// AGREE across a suspend, and the agreement is the defect: every wake reports
// ~705 s of apparent loop lag, trips the verdict instantly, and shows "engine
// catching up" for a stall that never happened.
//
// Windows' own primitives split the difference explicitly, which is why this
// is a clock swap and not a heuristic:
//
//   QueryUnbiasedInterruptTime[Precise]  excludes suspended time
//   GetTickCount64 / QueryPerformanceCounter   include it
//
// We take the `Precise` variant deliberately. Plain `QueryUnbiasedInterruptTime`
// advances only at the system tick (~15.6 ms by default), which would quantize
// every lag sample to multiples of a tick and destroy the very margins the
// detector was calibrated against — a healthy p50 of ~4 ms would read as 0 or
// 15.6. The `Precise` variant reports the same unbiased time interpolated to
// high resolution. It lives in kernelbase.dll and needs Windows 10, which is
// already the floor (WebView2).
//
// Linux is deliberately unresolved: `performance.now()` there is untested
// against a suspend, there is no machine in the fleet to test on, and the
// exposure is nil — the Linux hub runs headless with no sampler at all (#186).

import { dlopen, FFIType, ptr } from "bun:ffi";

export type MonotonicClockSource =
  // Windows: QueryUnbiasedInterruptTimePrecise, suspend-excluding by definition.
  | "unbiased-interrupt-time"
  // Everywhere else: performance.now(), verified suspend-excluding on macOS.
  // Also the Windows FALLBACK, in which case `warning` is set — a fallback is
  // the pre-#186 behaviour, not a fresh bug, so it degrades rather than throws.
  | "performance-now";

export type MonotonicClock = {
  // Milliseconds, fractional, monotonic, and not counting suspended time.
  // The epoch is arbitrary: only differences mean anything.
  now: () => number;
  source: MonotonicClockSource;
  // Set only when the platform's preferred clock could not be obtained, so a
  // caller can put one line in the durable log rather than measuring the
  // calendar in silence.
  warning?: string;
};

// 100-nanosecond units per millisecond — the unit every Windows
// FILETIME-shaped counter reports in.
const HUNDRED_NS_PER_MS = 10_000;

export type ResolveMonotonicClockDeps = {
  platform?: string;
  // Injectable so the RESOLUTION can be tested off Windows, where the real
  // dlopen has no kernelbase.dll to find.
  dlopenImpl?: typeof dlopen;
  performanceNowImpl?: () => number;
};

const PERFORMANCE_NOW: MonotonicClockSource = "performance-now";

export function resolveMonotonicClock(deps: ResolveMonotonicClockDeps = {}): MonotonicClock {
  const platform = deps.platform ?? process.platform;
  const performanceNow = deps.performanceNowImpl ?? (() => performance.now());
  if (platform !== "win32") {
    return { now: performanceNow, source: PERFORMANCE_NOW };
  }
  try {
    return {
      now: queryUnbiasedInterruptTimePrecise(deps.dlopenImpl ?? dlopen),
      source: "unbiased-interrupt-time",
    };
  } catch (err) {
    return {
      now: performanceNow,
      source: PERFORMANCE_NOW,
      warning:
        `QueryUnbiasedInterruptTimePrecise unavailable (${String(err)}) — ` +
        "saturation falls back to performance.now(), which counts suspended time on Windows (#186)",
    };
  }
}

// The FFI half. `QueryUnbiasedInterruptTimePrecise` returns void and writes
// through an out-pointer, so the buffer is allocated ONCE and its pointer
// reused: the clock is read four times a second for the process lifetime, and
// a fresh allocation per read would hand the GC work the sampler exists to
// notice.
function queryUnbiasedInterruptTimePrecise(dlopenFn: typeof dlopen): () => number {
  const lib = dlopenFn("kernelbase.dll", {
    QueryUnbiasedInterruptTimePrecise: { args: [FFIType.ptr], returns: FFIType.void },
  });
  const out = new BigUint64Array(1);
  const outPtr = ptr(out);
  const read = (): number => {
    lib.symbols.QueryUnbiasedInterruptTimePrecise(outPtr);
    return Number(out[0]) / HUNDRED_NS_PER_MS;
  };
  // Prove the symbol actually writes before anyone measures with it. A dlopen
  // that resolves a symbol which then no-ops would leave a clock frozen at 0 —
  // every lag sample would read as a negative overshoot and the detector would
  // go permanently quiet, which is worse than the bug being fixed.
  const first = read();
  if (!Number.isFinite(first) || first <= 0) {
    throw new Error(`QueryUnbiasedInterruptTimePrecise returned ${first}`);
  }
  return read;
}

// Resolved once per process. The sampler's default reads this, so a caller
// that never touches `monoImpl` still measures the loop rather than the
// calendar; `resolveMonotonicClock` stays exported for tests and for a boot
// path that wants to log which clock it got.
let cached: MonotonicClock | undefined;

export function monotonicClock(): MonotonicClock {
  cached ??= resolveMonotonicClock();
  return cached;
}
