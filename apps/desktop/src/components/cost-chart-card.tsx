import { useMemo } from "react";
import { ChartCardBody } from "@/components/chart-card-body";
import { composeSeries } from "@/lib/composed-series";
import type { GroupByAxis } from "@/lib/group-by";
import { useChartSource } from "@/state/use-chart-source";
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
// is the prior calendar day (ADR-0020); `block`'s is the previous block,
// aligned by time-into-block (ADR-0031); every other span's previous period is
// the immediately-prior window of the same length.
function prevRangeLabelFor(span: Span): string {
  if (span === "today") return "Yesterday";
  if (span === "block") return "Previous block";
  return `Previous ${span}`;
}

// The block span's no-active-block empty state (ADR-0031): replaces the chart
// + foot at the chart's height. The tab stays selectable — there is simply
// nothing current to frame until a new 5-hour window starts.
function BlockEmptyState(): React.ReactElement {
  return (
    <div className="h-[260px] flex flex-col items-center justify-center">
      <div className="inset dashed">
        <p className="lead">No active block</p>
        <p>Usage will appear when a new 5-hour window starts.</p>
      </div>
    </div>
  );
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
  const source = useChartSource({ span, chartStyle, axes, ghostOverlay });
  // The boot gate's chart publisher (ADR-0066), and the reason the gate needs
  // TWO: this card's query lives behind `useChartSource`, scoped away from the
  // five `useLiveData` queries, and on the intraday spans it is `/api/intraday`
  // — which `useLiveData().isPending` never observes. All three terminal
  // branches below count as settled: drawn content, `isError`, and `isEmpty`
  // (no active block). Holding the splash over a correct empty state would make
  // it look broken; holding it over an error would hide the error behind a timer.
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
  // ADR-0031: a null blockWindow on a block-span response means no active
  // block — render the empty state in place of the chart + foot.
  if (source.isEmpty) return <BlockEmptyState />;
  return (
    <ChartCardBody
      composed={composed}
      labels={source.labels}
      span={span}
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
      blockWindow={source.blockWindow}
    />
  );
}
