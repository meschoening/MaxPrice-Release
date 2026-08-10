import type { Composed } from "@/lib/composed-series";
import type { GroupByAxis } from "@/lib/group-by";
import type { MutedState } from "@/state/filters";

// ADR-0042 — the mute pass. A pure post-compose transform: composeSeries runs
// exactly as if nothing were muted (top-N, Other, folds, hue/ramp assignment
// all from the full set), then this drops the muted series from the draw.
// Chart-local by construction: only ChartCardBody applies it, so the compact
// detail-strip charts and everything outside the Live chart card never see it.

export type MutedComposed = Composed & {
  // True when muting alone emptied a chart that had series to draw — drives
  // the "All series muted" note (distinct from composed.isEmpty, the genuine
  // no-data state).
  allMuted: boolean;
};

// Whether a series is muted under the ACTIVE axes. Only axes in the drawn
// selection participate (dormancy): a muted set whose axis is off never
// matches, because a series' `parts` only carries keys for selected axes.
function isMutedSeries(parts: Partial<Record<GroupByAxis, string>>, muted: MutedState): boolean {
  for (const [axis, value] of Object.entries(parts) as Array<[GroupByAxis, string]>) {
    if (value !== undefined && muted[axis].includes(value)) return true;
  }
  return false;
}

export function applyMute(composed: Composed, muted: MutedState): MutedComposed {
  const dropped = composed.series.filter((s) => isMutedSeries(s.parts, muted));
  if (dropped.length === 0) return { ...composed, allMuted: false };

  const kept = composed.series.filter((s) => !isMutedSeries(s.parts, muted));

  // Drawn-only totals by SUBTRACTION (ADR-0042): totals − Σ(muted series)
  // rather than Σ(kept series), so uncharted spend that was never in any
  // series (Unknown families, ADR-0021) stays in the totals exactly as it
  // always has. Clamped at 0 against float dust.
  const totals = composed.totals.map((t, i) =>
    Math.max(
      0,
      dropped.reduce((acc, s) => acc - (s.values[i] ?? 0), t),
    ),
  );
  const prevTotals = composed.prevTotals
    ? composed.prevTotals.map((t, i) =>
        Math.max(
          0,
          dropped.reduce((acc, s) => acc - (s.prevValues?.[i] ?? 0), t),
        ),
      )
    : null;

  return {
    ...composed,
    series: kept,
    totals,
    prevTotals,
    // allMuted keys off the DRAWN-series count, while `totals` above keep any
    // uncharted Unknown-family residual (ADR-0021 convention, preserved by
    // ADR-0042's subtract-don't-sum design). So a nonzero foot total can
    // legitimately coexist with the "All series muted." note — by design, not a bug.
    allMuted: kept.length === 0,
  };
}
