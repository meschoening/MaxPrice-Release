import { useMemo } from "react";
import { GlassChart } from "@/components/glass-chart";
import { buildChartModel, type ChartBrand } from "@/lib/chart-model";
import type { LabelMode } from "@/lib/chart-layout";
import type { Composed, LegendGroup } from "@/lib/composed-series";
import { AXIS_LABELS, logScaleApplies, selectionLabel, type GroupByAxis } from "@/lib/group-by";
import type { ChartStyle, Metric, MutedState, Span } from "@/state/filters";
import { cn } from "@/lib/utils";

// The model's only theme input: the brand color, the empty selection's
// single-series fallback. A literal var() — the SVG renderer paints through
// the DOM, where CSS custom properties resolve, so theme flips restyle the
// chart with no re-render (the old getComputedStyle indirection existed only
// for ECharts' canvas, deleted in M3).
const CHART_BRAND: ChartBrand = { brand: "var(--accent)" };

export type CostChartProps = {
  // The precomposed series set (ADR-0033): the data-source component runs
  // `composeSeries` (it also needs the legend groups for the chart foot) and
  // hands the chart the finished cross-product. The chart only routes it to a
  // builder — it never recomposes.
  composed: Composed;
  // X-axis labels for the current window (the compose input's `rows[i].date`).
  labels: string[];
  // The active span tab. Drives the x-axis label mode — the daily spans
  // (7d / 30d) and the span-less compact strips label days, the intraday spans
  // label times — and is forwarded to the chart, whose layout puts it in the
  // shapeKey (a span switch rebuilds; a growing span's bucket count doesn't).
  // Compact strip callers omit it (a fixed 30-day strip).
  span?: Span;
  metric: Metric;
  // The normalized group-by selection — only consulted for the log-scale gate
  // (the series split itself is already baked into `composed`).
  axes: GroupByAxis[];
  // Bars (per-bucket, today's view) / Cumulative (running-total line) / Trend
  // (moving-average line). Cumulative and Trend are pure client-side transforms
  // of the same per-bucket data.
  chartStyle: ChartStyle;
  ghostOverlay: boolean;
  // Log scale (ADR-0040, amending ADR-0032/0033): honoured for every model- or
  // token-type-bearing selection, never in compact. Draws each series as a line
  // on one shared symlog y-axis so series whose magnitudes span several orders
  // stay legible at once.
  logScale?: boolean;
  isLoading?: boolean;
  // Mute (ADR-0042): every drawn series is muted away. Nulls the model (the
  // svg keeps its bare frame) and shows the "All series muted" note — the
  // legend below stays live to unmute. Distinct from isEmpty, the genuine
  // no-data state.
  allMuted?: boolean;
  // A failed data fetch (engine 5xx, the intraday bucket-count 400, or a
  // schema-parse reject). Surfaces a bad-tone error overlay that takes
  // precedence over the empty overlay, so a failed request reads distinctly
  // from a genuinely empty window instead of a silent "No usage" chart.
  isError?: boolean;
  errorMessage?: string;
  prevRangeLabel?: string;
  className?: string;
  // Strip-sized rendering (ADR-0016): ~64px tall, no axis labels, edge-to-edge
  // grid. The layout builds against COMPACT_VIEW; the container height drops
  // to h-16 and the svg stretches to fill it (preserveAspectRatio "none").
  compact?: boolean;
};

export function CostChart(props: CostChartProps): React.ReactElement {
  const {
    composed,
    labels,
    span,
    metric,
    axes,
    chartStyle,
    ghostOverlay,
    logScale = false,
    isLoading,
    allMuted = false,
    isError = false,
    errorMessage,
    prevRangeLabel,
    className,
    compact = false,
  } = props;

  // Drives the "No usage in this range" overlay. Compose distinguishes the two
  // emptiness flavors (`isEmpty` is "no projects matched" when the project axis
  // is on — the densified rows never hit length 0 — and "no rows" otherwise);
  // the labels guard covers the degenerate empty-window case the model memo
  // also nulls on.
  const isEmpty = composed.isEmpty || labels.length === 0;

  const model = useMemo(() => {
    if (isLoading) return null;
    if (allMuted) return null;
    if (composed.isEmpty || labels.length === 0) return null;
    // The "now" line marks the rightmost bucket — the in-progress "now" bucket.
    // True for every span: the daily-resolution tabs (7d / 30d) and, as of
    // Part 5's T5.4b, the intraday tabs (then 15m / 1h / 6h / 24h; since
    // ADR-0031 / ADR-0020: 15m / 1h / block / today), whose rightmost bucket
    // ends at "now" too.
    const showNowLine = true;
    return buildChartModel({
      composed,
      labels,
      metric,
      chartStyle,
      // Log scale (ADR-0040, amending ADR-0032/0033): every model- or
      // token-type-bearing selection, never compact.
      logScale: logScale && logScaleApplies(axes) && !compact,
      showGhost: ghostOverlay,
      showNowLine,
      prevRangeLabel,
      theme: CHART_BRAND,
    });
  }, [
    composed,
    labels,
    metric,
    axes,
    chartStyle,
    ghostOverlay,
    logScale,
    compact,
    prevRangeLabel,
    isLoading,
    allMuted,
  ]);

  // The x-axis label mode: daily spans (7d / 30d) and the span-less compact
  // strips label days; the intraday spans (15m / 1h / block / today) label
  // times. Rides the layout's shapeKey, so a mode flip is a rebuild.
  const labelMode: LabelMode =
    span === "7d" || span === "30d" || span === undefined ? "day" : "time";

  // The svg always renders — with a null model it's the bare 3:1 frame, a
  // stable layout box the loading/error/muted/empty overlays cover. Non-compact
  // height comes from the svg's intrinsic 720×240 ratio; compact fills h-16.
  return (
    <div className={cn("relative w-full", compact ? "h-16" : "", className)}>
      <div className={compact ? "h-full" : undefined} role="img" aria-label="Cost over time">
        <GlassChart model={model} compact={compact} labelMode={labelMode} span={span} />
      </div>
      {isLoading ? (
        <div
          className={cn(
            "absolute inset-0 flex items-end gap-2 pointer-events-none",
            compact ? "px-0 py-1" : "px-10 pt-4 pb-8",
          )}
        >
          {Array.from({ length: 7 }).map((_, i) => (
            <div
              key={i}
              className="chart-skel-bar"
              style={{ height: `${30 + ((i * 37) % 50)}%` }}
            />
          ))}
        </div>
      ) : isError ? (
        compact ? (
          // The 64px strip has no room for the inset box — a bare tinted line.
          <div className="absolute inset-0 flex items-center justify-center text-xs text-bad">
            Couldn’t load this chart.
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-6">
            <div className="inset danger" role="alert">
              <p className="lead">Couldn’t load this chart.</p>
              {errorMessage ? <p className="num break-words">{errorMessage}</p> : null}
            </div>
          </div>
        )
      ) : allMuted ? (
        // The all-muted note (ADR-0042). Backdrop keeps the Card tone
        // (bg-panel) so the note reads as part of the panel over the bare
        // chart frame the nulled model leaves behind.
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 rounded bg-panel text-center">
          <span className="text-sm font-medium text-text">All series muted.</span>
          <span className="text-xs text-soft">Click a legend entry below to unmute.</span>
        </div>
      ) : isEmpty ? (
        compact ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-soft">
            No usage in this range.
          </div>
        ) : (
          // The T6 dashed inset — dashing marks absence, never a status tint.
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="inset dashed">
              <p>No usage in this range.</p>
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}

// The legend row under the chart — glass chips (glass.html .legend-row).
// Lives here so the visual contract (swatch color + label) ships with the
// chart. The compose step emits one legend group per selected axis
// (ADR-0033): the hue axis shows its own palette, the ramp axis dark→light
// neutral shades, a third axis labels only (stack order + tooltip). With
// more than one group, each carries its axis name as an eyebrow (the
// prototype's per-axis legend labels). The dashed ghost key is always in the
// row and IS the overlay's toggle — clicking it flips the persisted
// ghostOverlay boolean (it replaced the chart-foot's Ghost switch); while off
// it wears the mute chips' treatment (dim + struck), though the ghost is not
// a mute — it is its own boolean, not an (axis, value). Its aria-pressed marks
// the overlay drawn (pressed = shown) — deliberately the opposite polarity of
// the visually-identical mute chips, whose pressed = the series is hidden. Only
// Log scale remains in the chart-foot (ChartFoot in chart-card-body.tsx).
export type CostChartLegendProps = {
  legendGroups: LegendGroup[];
  // The normalized group-by selection — names the legend for screen readers.
  axes: GroupByAxis[];
  // Whether the overlay draws — the ghost-key pill renders either way and
  // toggles this.
  ghostOverlay: boolean;
  onToggleGhost: () => void;
  prevRangeLabel: string;
  // Mute (ADR-0042): every legend entry toggles its (axis, value)'s series in
  // and out of the draw.
  muted: MutedState;
  onToggleMute: (axis: GroupByAxis, value: string) => void;
};

export function CostChartLegend({
  legendGroups,
  axes,
  ghostOverlay,
  onToggleGhost,
  prevRangeLabel,
  muted,
  onToggleMute,
}: CostChartLegendProps): React.ReactElement {
  const isMuted = (axis: GroupByAxis, value: string): boolean => muted[axis].includes(value);
  const showAxisLabels = legendGroups.length > 1;
  return (
    <div
      className="legend-row"
      // The × group separators are aria-hidden, so name the legend by its
      // selection — screen readers otherwise hear the cross-product as one
      // undifferentiated run of labels.
      aria-label={`Legend: ${selectionLabel(axes)}`}
    >
      {legendGroups.map((group, gi) => (
        <span key={gi} className="inline-flex items-center gap-1.5 flex-wrap">
          {gi > 0 ? (
            <span aria-hidden className="text-soft">
              ×
            </span>
          ) : null}
          {showAxisLabels ? (
            <span className="eyebrow legend-axis">{AXIS_LABELS[group.axis]}</span>
          ) : null}
          {group.kind === "stack"
            ? group.entries.map((e) => (
                <LegendMuteButton
                  key={e.value}
                  axis={group.axis}
                  value={e.value}
                  label={e.label}
                  muted={isMuted(group.axis, e.value)}
                  onToggleMute={onToggleMute}
                />
              ))
            : group.entries.map((e) => (
                <LegendMuteButton
                  key={e.value}
                  axis={group.axis}
                  value={e.value}
                  label={e.label}
                  swatch={{ color: e.color }}
                  muted={isMuted(group.axis, e.value)}
                  onToggleMute={onToggleMute}
                />
              ))}
        </span>
      ))}
      <button
        type="button"
        onClick={onToggleGhost}
        aria-pressed={ghostOverlay}
        title={`${prevRangeLabel} — toggle the previous-period ghost overlay`}
        className={cn("chip", "ghost-key", !ghostOverlay && "muted")}
      >
        <span className="swatch" aria-hidden />
        <span className="label">{prevRangeLabel}</span>
      </button>
    </div>
  );
}

// One legend entry as a glass-chip mute toggle (ADR-0042). Muted: half-opacity
// chip, hollow swatch (the series color survives as a ring, so the entry stays
// findable by color), struck label; unmuted: the classic filled swatch.
// Stack-group entries have no swatch — the dim alone carries the muted state.
function LegendMuteButton({
  axis,
  value,
  label,
  swatch,
  muted,
  onToggleMute,
}: {
  axis: GroupByAxis;
  value: string;
  label: string;
  swatch?: { color: string };
  muted: boolean;
  onToggleMute: (axis: GroupByAxis, value: string) => void;
}): React.ReactElement {
  const swatchEl = swatch ? (
    <span
      aria-hidden
      className="swatch"
      style={
        muted
          ? { background: "transparent", boxShadow: `inset 0 0 0 1.5px ${swatch.color}` }
          : { background: swatch.color }
      }
    />
  ) : null;
  return (
    <button
      type="button"
      onClick={() => onToggleMute(axis, value)}
      aria-pressed={muted}
      title={muted ? `Unmute ${label} — draw it again` : `Mute ${label} — hide it from this chart`}
      className={cn("chip", muted && "muted")}
    >
      {swatchEl}
      <span className="label">{label}</span>
    </button>
  );
}
