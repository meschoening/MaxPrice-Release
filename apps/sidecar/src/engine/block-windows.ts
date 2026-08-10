import type { BlockRow, UsageSample } from "@maxprice/shared";

// Observed-window derivation + sample queries for the blocks aggregator
// (ADR-0028). An OBSERVED WINDOW is a real 5-hour usage-limit window recovered
// from the usage history: a distinct minute-rounded `fiveHour.resetAt` carried
// by at least one sample with utilization > 0, spanning [reset − 5h, reset).
// Conservative by construction: speculative resets reported while idle
// (utilization 0) are discarded, and unobserved windows are never inferred —
// no grid snapping, no backward chaining. The SampleView/peak machinery is
// ported from the retired two-pass enrichment module (ADR-0025 → ADR-0028):
// samples are parsed ONCE per request into a capturedAt-sorted axis so each
// row's peak query is a binary search + in-window scan.

// PRECONDITION — sorted sample store. The `samples` arrays consumed here are
// the sample store's `all()` (packages/usage-core/src/sample-store.ts), kept capturedAt-ascending
// by contract: loadHistory sorts the persisted history and append pushes in
// capturedAt order. The latest-sample reads (`latestSampleWindow` and
// precomputeSamples' `latestUtil`, both `samples[samples.length - 1]`) depend
// on it.

// The 5-hour session-block / usage-window span.
export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

// One observed real window: [start, end) = [reset − 5h, reset), epoch ms.
export type ObservedWindow = { start: number; end: number };

// A bare [start, end) span in epoch-ms — the exclusion-window currency the
// intraday block regime consumes (ADR-0031). (Distinct from ObservedWindow's
// `start`/`end` naming deliberately: this is the intraday wire-side currency.)
export type WindowSpan = { startMs: number; endMs: number };

// The block-span frame (ADR-0031): the active block's window + provenance, the
// previous block (the ghost's source), and — for HEURISTIC windows only — the
// resolved windows overlapping the hour-floored span. Events inside an
// exclusion belong to that neighboring window, not this block (the ADR-0028
// seam overlap), so the intraday regime must skip them or the chart would leak
// a neighbor's events into the block's bars and break tile parity. Resolved by
// `resolveBlockSpanWindow` (blocks.ts), consumed by the intraday block span.
export type ResolvedBlockSpan = {
  startMs: number;
  endMs: number;
  source: BlockRow["windowSource"];
  exclusions: WindowSpan[];
  previous: { startMs: number; endMs: number; exclusions: WindowSpan[] } | null;
};

// The sample history parsed once per request: a capturedMs-sorted axis with
// its aligned utilizations, plus the newest sample's utilization (the active
// block's live %).
export type SampleView = {
  capturedMs: number[]; // ascending; capturedMs[i] ↔ utils[i]
  utils: number[];
  latestUtil: number | null;
};

// Round an epoch instant to the nearest whole minute. Anthropic's reset_at
// jitters ±1–2 s between polls for the SAME window — observed straddling a
// minute boundary (02:09:59.876 vs 02:10:00.063) — so nearest-minute ROUNDING
// (not flooring) is what merges identical windows.
function roundToMinute(ms: number): number {
  return Math.round(ms / MINUTE_MS) * MINUTE_MS;
}

// The util>0-gated, minute-rounded, deduped observed windows, ascending by
// `end`. Unparseable resetAt instants are skipped.
export function deriveObservedWindows(samples: UsageSample[]): ObservedWindow[] {
  const ends = new Set<number>();
  for (const s of samples) {
    if (s.fiveHour.utilizationPct <= 0) continue; // speculative while idle — never a window
    const r = Date.parse(s.fiveHour.resetAt);
    if (!Number.isNaN(r)) ends.add(roundToMinute(r));
  }
  return [...ends].sort((a, b) => a - b).map((end) => ({ start: end - FIVE_HOURS_MS, end }));
}

// The most-recent sample's rounded window, REGARDLESS of utilization — the
// live-window-grace candidate (ADR-0028): a freshly-started real window's
// integer utilization can read 0 for its first minutes, and local events
// inside it (checked by the caller) prove it is real rather than speculative.
export function latestSampleWindow(samples: UsageSample[]): ObservedWindow | null {
  const last = samples[samples.length - 1];
  if (last === undefined) return null;
  const r = Date.parse(last.fiveHour.resetAt);
  if (Number.isNaN(r)) return null;
  const end = roundToMinute(r);
  return { start: end - FIVE_HOURS_MS, end };
}

// One window after ADR-0029 resolution: real boundaries plus how they were
// settled — "observed" = whole, both bounds from resets; "annulled" = cut
// short by an out-of-band reset, end at its successor's start.
export type ResolvedWindow = {
  start: number;
  end: number;
  source: "observed" | "annulled";
};

// The full ADR-0029 window policy in one pass: derive the util>0 windows,
// truncate annulled ones, and admit the live-window grace candidate.
//
// TRUNCATION (geometry-only). Two util>0 windows can only overlap when an
// OUT-OF-BAND RESET annulled the earlier one: the user's next message starts
// the successor at `R2 − 5h`, so the stretch clipped off the earlier window is
// idle by definition — truncating its end to the successor's start is
// membership-exact, not approximate. Capture times are deliberately never
// consulted: a window may be first observed mid-flight (the block started on
// another computer, or before the app connected), so only reset instants may
// shape extents. Each window clips against its immediate successor — starts
// ascend with resets, so that is the binding bound even in a chain.
//
// GRACE YIELDS. The latest sample's window (any utilization — a fresh real
// window's integer utilization reads 0 for its first minutes) participates
// only in its UNCOVERED extent: its start clips to the last util>0 window's
// end, and it is admitted only when a local event falls inside that clipped
// extent. It can never truncate a util>0 window — under truncation, the old
// any-event-in-span evidence test would let a speculative idle phantom
// mutilate a real window (pre-ADR-0029 a wrongly-admitted phantom merely
// emitted no row).
//
// The result is pairwise disjoint and ascending — sorted by end IS sorted by
// start — which is what makes the blocks partition walk containment-unique.
export function resolveWindows(samples: UsageSample[], eventTimes: number[]): ResolvedWindow[] {
  const base = deriveObservedWindows(samples);
  const windows: ResolvedWindow[] = base.map((w, i) => {
    const next = base[i + 1];
    return next !== undefined && next.start < w.end
      ? { start: w.start, end: next.start, source: "annulled" }
      : { start: w.start, end: w.end, source: "observed" };
  });

  const live = latestSampleWindow(samples);
  if (live === null) return windows;
  const lastReal = base[base.length - 1];
  if (lastReal !== undefined && live.end <= lastReal.end) return windows; // covered or stale
  const start = lastReal !== undefined ? Math.max(live.start, lastReal.end) : live.start;
  if (eventTimes.some((t) => t >= start && t < live.end)) {
    windows.push({ start, end: live.end, source: "observed" });
  }
  return windows;
}

// Parse the (capturedAt-sorted) history into the per-request view. The axis is
// verified ascending and only re-sorted if that regresses — the store keeps it
// sorted, but the binary search below must not silently break (only a
// hand-built input falls through to the sort). Unparseable capturedAt instants
// are skipped.
export function precomputeSamples(samples: UsageSample[]): SampleView {
  const points: Array<{ c: number; u: number }> = [];
  for (const s of samples) {
    const c = Date.parse(s.capturedAt);
    if (!Number.isNaN(c)) points.push({ c, u: s.fiveHour.utilizationPct });
  }
  let ascending = true;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    if (prev !== undefined && curr !== undefined && prev.c > curr.c) {
      ascending = false;
      break;
    }
  }
  if (!ascending) points.sort((a, b) => a.c - b.c);
  // `samples` is capturedAt-sorted upstream, so the last element is the newest.
  const last = samples[samples.length - 1] ?? null;
  return {
    capturedMs: points.map((p) => p.c),
    utils: points.map((p) => p.u),
    latestUtil: last !== null ? last.fiveHour.utilizationPct : null,
  };
}

// First index i with arr[i] >= target (lower bound) over an ascending array.
function lowerBound(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arr[mid] as number) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Peak utilization sampled in [start, end], or null if no sample falls there —
// a limit % is never fabricated.
export function peakInWindow(view: SampleView, start: number, end: number): number | null {
  let peak: number | null = null;
  for (let i = lowerBound(view.capturedMs, start); i < view.capturedMs.length; i++) {
    if ((view.capturedMs[i] as number) > end) break;
    const u = view.utils[i] as number;
    if (peak === null || u > peak) peak = u;
  }
  return peak;
}
