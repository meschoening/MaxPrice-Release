import { useMemo } from "react";
import { CostChart, CostChartLegend } from "@/components/cost-chart";
import { GlassToggle } from "@/components/glass-toggle";
import { WindowSourceNote } from "@/components/window-source";
import type { Composed } from "@/lib/composed-series";
import { logScaleApplies, type GroupByAxis } from "@/lib/group-by";
import { applyMute, type MutedComposed } from "@/lib/mute";
import {
  useFilters,
  type ChartStyle,
  type Metric,
  type MutedState,
  type Span,
} from "@/state/filters";
import type { BlockSpanWindow } from "@maxprice/shared";

// The cost-chart render tail — the <CostChart> plus its <ChartFoot> (legend +
// summary). `CostChartCard` (components/cost-chart-card.tsx) resolves the
// active span × axes combo's data through `useChartSource` and hands the
// finished inputs here — the one place the chart + foot are wired. It is not
// purely presentational: beyond those props it reads the chart-local mute
// state (muted / toggleMute) from the filters store and applies applyMute HERE
// — the single shared application point (ADR-0042), so the Live chart gets
// muting and nothing else (the compact strip charts call CostChart directly)
// ever does.
export type ChartCardBodyProps = {
  composed: Composed;
  // X-axis labels for the current window (the compose input's `rows[i].date`).
  labels: string[];
  span: Span;
  metric: Metric;
  axes: GroupByAxis[];
  chartStyle: ChartStyle;
  ghostOverlay: boolean;
  onToggleGhost: () => void;
  // Log scale (ADR-0032/0033) — the legend gates the toggle on the model axis.
  logScale: boolean;
  onToggleLogScale: () => void;
  // Query state — scoped to the ONE query whose rows this combo draws, never the
  // OR of the five span-independent useLiveData queries (the daily flat path
  // passes its chart-window-scoped status, ADR-0033 review f1).
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  prevRangeLabel: string;
  // ADR-0031 — the block span's resolved frame (intraday paths only); the foot
  // shows a provenance note for non-observed windows.
  blockWindow?: BlockSpanWindow | null;
};

export function ChartCardBody({
  composed,
  labels,
  span,
  metric,
  axes,
  chartStyle,
  ghostOverlay,
  onToggleGhost,
  logScale,
  onToggleLogScale,
  isLoading,
  isError,
  errorMessage,
  prevRangeLabel,
  blockWindow,
}: ChartCardBodyProps): React.ReactElement {
  // Mute (ADR-0042) — applied HERE, the one shared render tail, so every Live
  // data-source component gets it and nothing else (the compact strip charts
  // call CostChart directly) ever does. A pure post-compose pass: muted series
  // drop from the draw, the summary/tooltip totals subtract them, and the
  // legend below stays on the FULL entry set so a muted value can be unmuted.
  const muted = useFilters((s) => s.muted);
  const toggleMute = useFilters((s) => s.toggleMute);
  const applied = useMemo(() => applyMute(composed, muted), [composed, muted]);
  return (
    <>
      <CostChart
        composed={applied}
        labels={labels}
        span={span}
        metric={metric}
        axes={axes}
        chartStyle={chartStyle}
        ghostOverlay={ghostOverlay}
        logScale={logScale}
        isLoading={isLoading}
        allMuted={applied.allMuted}
        isError={isError}
        errorMessage={errorMessage}
        prevRangeLabel={prevRangeLabel}
      />
      <ChartFoot
        composed={applied}
        metric={metric}
        axes={axes}
        ghostOverlay={ghostOverlay}
        onToggleGhost={onToggleGhost}
        prevRangeLabel={prevRangeLabel}
        logScale={logScale}
        onToggleLogScale={onToggleLogScale}
        blockWindow={blockWindow}
        muted={muted}
        onToggleMute={toggleMute}
      />
    </>
  );
}

// The legend row (glass chips + the dashed ghost-key pill, which IS the
// ghost toggle) and the chart-foot — a hairline-topped strip with the
// Total/Peak/Avg summary on the left and the Log scale glass switch on the
// right (the foot's Ghost switch was replaced by the legend pill). The one
// shared foot rendered for every span × group-by combo, so it is identical
// regardless of span kind / group-by. The legend renders for EVERY selection
// (ADR-0034), the ghost pill with it; Log scale is disabled — dimmed, tooltip
// explains — unless a model/token-type axis is selected (ADR-0040,
// INTERACTIONS.md). The summary computes over `composed.totals` — exactly
// what is drawn.
function ChartFoot({
  composed,
  metric,
  axes,
  ghostOverlay,
  onToggleGhost,
  prevRangeLabel,
  logScale,
  onToggleLogScale,
  blockWindow,
  muted,
  onToggleMute,
}: {
  composed: MutedComposed;
  metric: Metric;
  axes: GroupByAxis[];
  ghostOverlay: boolean;
  onToggleGhost: () => void;
  prevRangeLabel: string;
  logScale: boolean;
  onToggleLogScale: () => void;
  // ADR-0031 — the block span's resolved frame; the foot shows a provenance
  // note for non-observed windows (estimated start / annulled), mirroring the
  // Blocks view's dot language.
  blockWindow?: BlockSpanWindow | null;
  // Mute (ADR-0042) — every legend entry toggles its value's series.
  muted: MutedState;
  onToggleMute: (axis: GroupByAxis, value: string) => void;
}): React.ReactElement {
  const logApplies = logScaleApplies(axes);
  return (
    <>
      <CostChartLegend
        legendGroups={composed.legendGroups}
        axes={axes}
        ghostOverlay={ghostOverlay}
        onToggleGhost={onToggleGhost}
        prevRangeLabel={prevRangeLabel}
        muted={muted}
        onToggleMute={onToggleMute}
      />
      <div className="chart-foot">
        <span className="inline-flex items-center gap-3 flex-wrap">
          <ChartSummary values={composed.totals} metric={metric} />
          {blockWindow != null && blockWindow.source !== "observed" ? (
            <WindowSourceNote source={blockWindow.source} />
          ) : null}
        </span>
        <div className="foot-toggles">
          <GlassToggle
            label="Log scale"
            checked={logScale && logApplies}
            onToggle={onToggleLogScale}
            disabled={!logApplies}
            title={
              logApplies
                ? "Log scale — y-axis in decades so small series stay legible (draws lines)"
                : "Log scale needs a model or token-type axis in the group-by"
            }
          />
        </div>
      </div>
    </>
  );
}

// The Total/Peak/Avg chart summary. Takes the metric-resolved per-bucket
// totals (`composed.totals` — already in the active metric's unit), so it
// computes over exactly what the chart draws.
function ChartSummary({
  values,
  metric,
}: {
  values: number[];
  metric: Metric;
}): React.ReactElement {
  if (values.length === 0) return <span className="summary">—</span>;
  const total = values.reduce((s, v) => s + v, 0);
  const peak = Math.max(...values);
  const avg = total / values.length;
  const fmt = (n: number) =>
    metric === "cost"
      ? `$${n.toFixed(2)}`
      : n >= 1_000_000
        ? `${(n / 1_000_000).toFixed(1)}M`
        : n >= 1_000
          ? `${(n / 1_000).toFixed(0)}K`
          : String(Math.round(n));
  return (
    <span className="summary">
      Total <b className="num">{fmt(total)}</b> · Peak <b className="num">{fmt(peak)}</b> · Avg{" "}
      <b className="num">{fmt(avg)}</b>
    </span>
  );
}
