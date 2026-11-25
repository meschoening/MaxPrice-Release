import { useMemo } from "react";
import { ChartCardBody } from "@/components/chart-card-body";
import { composeSeries } from "@/lib/composed-series";
import type { GroupByAxis } from "@/lib/group-by";
import { useChartSource } from "@/state/use-chart-source";
import { useWeekWindow } from "@/state/use-week";
import { useBootPaintPublisher } from "@/lib/boot-paint";
import type { ChartStyle, Metric, Span } from "@/state/filters";

// The props the chart card receives — the full chart-card state. `axes` is the
// normalized EFFECTIVE group-by selection straight from the store (never
// re-normalized in render — the store canonicalizes on set/merge and the array
// is referentially stable, which the compose memo depends on). The log-scale
// props always ride along: the legend/chart gate the toggle on the model/token-
// type axes internally (ADR-0032/0040).
export type ChartSourceProps = {
  span: Span;
  metric: Metric;
  axes: GroupByAxis[];
  chartStyle: ChartStyle;
  ghostOverlay: boolean;
  onToggleGhost: () => void;
  logScale: boolean;
  onToggleLogScale: () => void;
};

// The ghost-overlay legend label for a span's previous period. `today`'s ghost
// is the prior calendar day (ADR-0020); every other span's previous period is
// the immediately-prior window of the same length — for `week` that is the
// previous Week, rolling or anchored alike (ADR-0083; the anchored ghost is
// `weekStart − 7d` onward, aligned by time-into-week).
function prevRangeLabelFor(span: Span): string {
  if (span === "today") return "Yesterday";
  return `Previous ${span}`;
}

// The cost-over-time chart card — the ONE query→compose→render tail
// (architecture review 2026-07-18, candidate 1; it replaced six per-combo
// data-source components). `useChartSource` resolves the active span × axes
// combo to the compose inputs (prev* already ghost-gated) plus the active
// source's own query status — scoped to the ONE query whose rows this combo
// draws, never the OR of the five span-independent useLiveData queries
// (ADR-0033 review f1). `metric` stays out of the hook: toggling it recomposes
// but never touches sourcing, and no axis toggle beyond project/machine ever
// refetches (ADR-0033's one-bit sourcing rule lives in the hook).
export function CostChartCard(props: ChartSourceProps): React.ReactElement {
  const {
    span,
    metric,
    axes,
    chartStyle,
    ghostOverlay,
    onToggleGhost,
    logScale,
    onToggleLogScale,
  } = props;
  const week = useWeekWindow();
  const source = useChartSource({ span, chartStyle, axes, ghostOverlay, week });
  // The boot gate's chart publisher (ADR-0066), and the reason the gate needs
  // TWO: this card's query lives behind `useChartSource`, scoped away from the
  // five `useLiveData` queries, and on the intraday spans it is `/api/intraday`
  // — which `useLiveData().isPending` never observes. Both terminal branches
  // count as settled: drawn content and `isError`. Holding the splash over an
  // error would hide the error behind a timer.
  useBootPaintPublisher("live:chart", !source.isLoading);
  const composed = useMemo(
    () =>
      composeSeries({
        axes,
        metric,
        rows: source.rows,
        prevRows: source.prevRows,
        projectData: source.projectData,
        prevProjectData: source.prevProjectData,
        machineData: source.machineData,
        prevMachineData: source.prevMachineData,
        machineOrder: source.machineOrder,
      }),
    [axes, metric, source],
  );
  return (
    <ChartCardBody
      composed={composed}
      labels={source.labels}
      span={span}
      weekAnchored={week.kind === "anchored"}
      metric={metric}
      axes={axes}
      chartStyle={chartStyle}
      ghostOverlay={ghostOverlay}
      onToggleGhost={onToggleGhost}
      logScale={logScale}
      onToggleLogScale={onToggleLogScale}
      isLoading={source.isLoading}
      isError={source.isError}
      errorMessage={source.errorMessage}
      prevRangeLabel={prevRangeLabelFor(span)}
    />
  );
}
