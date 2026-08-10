import type { TokenCategory } from "@maxprice/shared";
import { isCacheCategory } from "@maxprice/shared";
import type { Composed } from "@/lib/composed-series";
import type { ChartStyle, Metric } from "@/state/filters";

// The pure, renderer-agnostic chart model (T2 decision 1 / M0). Everything the
// cost chart *means* — which series are drawn with which plotted values, the
// y-scale and its ticks, the structured tooltip content, the "now" bucket, the
// peak label — computed here from (data + filters + brand color), with zero
// knowledge of how it gets painted. chart-layout.ts turns the model into pixel
// geometry and glass-chart.tsx paints that as SVG (M3, #61 — the ECharts
// adapter the model was extracted under is gone; this suite of semantics is
// what survived the swap).

// The model consumes only the series + per-bucket totals of the compose step's
// output (lib/composed-series.ts); a full `Composed` satisfies this
// structurally (it's what cost-chart.tsx passes). Deriving the alias from the
// real type — rather than re-declaring the shape — keeps the two from drifting
// while the chart-bucket extraction keeps the import direction one-way
// (composed-series → chart-bucket ← chart-model; chart-model → composed-series
// for this input type, never the reverse).
export type ComposedChartInput = Pick<Composed, "series" | "totals" | "prevTotals">;

// The model's entire theme surface: the brand color, consumed only as the
// empty selection's single-series fallback (the compose step's `color: null`).
// The glass renderer paints through the DOM, where CSS var() strings resolve,
// so the app passes a literal `var(--accent)` — the old resolved-token
// indirection (getComputedStyle in chart-theme.ts) existed only because
// ECharts' canvas couldn't parse var(), and died with it (M3, #61).
export type ChartBrand = { brand: string };

export type ChartModelInput = {
  composed: ComposedChartInput;
  // X-axis labels for the current window (the compose input's `rows[i].date`).
  labels: string[];
  metric: Metric;
  // Bars (per-bucket) / Cumulative (running total) / Trend (moving average).
  chartStyle: ChartStyle;
  // Log scale ACTIVE (ADR-0032/0040): the caller has already resolved the gate
  // (toggle && logScaleApplies(axes) && !compact). Every series draws as a line
  // on one shared symlog y-axis; falls back to the linear scale on an all-zero
  // window (nothing to log).
  logScale: boolean;
  showGhost: boolean;
  showNowLine: boolean;
  prevRangeLabel?: string;
  // The brand color (the empty selection's single-series color rides
  // `color: null` from the compose step).
  theme: ChartBrand;
};

export type ChartSeriesModel = {
  id: string;
  label: string;
  // Resolved — never null (the compose step's `color: null` becomes theme.brand).
  color: string;
  // REAL plotted values: style-transformed (running total / moving average),
  // never scale-mapped — the scale owns the position mapping, so tooltips and
  // renderers alike read true numbers (a symlog position is never a value).
  values: number[];
  // The ghost window's values, style-transformed the same way; null ⇔ the
  // ghost overlay is off (`ChartModel.ghost` false), uniformly across series.
  prevValues: number[] | null;
  // The series' token-type band, when the token-type axis is on — drives the
  // tooltip's "cache N% of total" row.
  tokenType?: TokenCategory;
};

export type ChartTick = { position: number; value: number; label: string };

// The y-scale (ADR-0032). `position` maps a real plotted value to axis space:
// the identity for the linear scale, the piecewise symlog transform for log —
// linear 0→C mapped onto 0→1, one unit per decade above (C→1, 10C→2, …).
// `tickLabel` labels an axis position (which for the linear scale IS the value;
// the renderer picks the tick values there, so none are pinned here).
export type ChartScaleModel =
  | {
      kind: "linear";
      position: (v: number) => number;
      tickLabel: (v: number) => string;
    }
  | {
      kind: "symlog";
      // The linear threshold C — decade-snapped to the smallest nonzero plotted
      // value (ghosts included), capped 6 decades below the peak (ADR-0032).
      c: number;
      // Top of the axis in transformed space: the drawn peak's position ceiled
      // to the next decade boundary, clamped to ≥1 so the C tick survives.
      maxPosition: number;
      position: (v: number) => number;
      inverse: (t: number) => number;
      // One tick per decade boundary: integer positions 0..maxPosition.
      ticks: ChartTick[];
      tickLabel: (t: number) => string;
    };

export type ChartTooltipRow = { color: string; label: string; value: string };

// The previous-period delta block, when a ghost is drawn: the raw signed delta
// plus the pre-formatted pieces the renderer assembles (pct null — no
// percentage — when the previous total is 0).
export type ChartTooltipDelta = {
  label: string;
  prev: string;
  delta: number;
  deltaAbs: string;
  pct: number | null;
};

// One bucket's structured tooltip content: the nonzero series rows
// top-of-stack first (reverse of draw order, matching the legend read), the
// bordered total row, the cache share when the token-type axis is on, and the
// previous-period delta when a ghost is drawn. Values arrive pre-formatted
// ($X.XX / abbreviated) so every renderer reports identical numbers.
export type ChartTooltipModel = {
  header: string;
  rows: ChartTooltipRow[];
  total: { label: string; value: string };
  // Rounded integer percentage, or null (token-type axis off, or a zero total).
  cachePct: number | null;
  prevDelta: ChartTooltipDelta | null;
};

export type ChartModel = {
  // What to draw: stacked bars, or overlaid lines (the two line styles and
  // every log-scale chart — log draws lines even for chartStyle "bars").
  mark: "bars" | "lines";
  // The log variant was requested (even when an all-zero window dropped the
  // scale back to linear) — log charts never carry the cumulative area fill.
  logMode: boolean;
  chartStyle: ChartStyle;
  metric: Metric;
  // Per-bucket x-axis labels (position-aligned with every series' values).
  buckets: string[];
  // Draw order bottom→top; ghosts render beneath the current series.
  series: ChartSeriesModel[];
  // The ghost overlay resolves ON only when EVERY series carries a prev array —
  // a partial ghost stack would misrepresent the previous period's total.
  ghost: boolean;
  // Per-bucket totals (style-transformed like the series) for the tooltip's
  // total row and the peak; prevTotals null unless the ghost is on.
  totals: number[];
  prevTotals: number[] | null;
  scale: ChartScaleModel;
  // The rightmost, in-progress bucket — where the "now" marker draws — or null
  // when hidden.
  nowIndex: number | null;
  // The tallest bucket by plotted total, with its display label — the glass
  // renderer floats this above the peak bar. Null when nothing is positive.
  peak: { index: number; value: number; label: string } | null;
  // The bordered-total label: "Total" for bars, else the line style's name.
  totalLabel: string;
  // Structured tooltip content for one bucket; null out of range. Lazy — the
  // renderer calls it on hover, so building the model never walks every bucket.
  tooltip: (index: number) => ChartTooltipModel | null;
};

// --- cumulative / moving-average transforms (Chart style: cumulative / trend)
//
// The line chart styles are pure client-side transforms of the per-bucket
// values the chart already receives — the sidecar engine ships only per-bucket
// sums. `cumulative` reads as a burn-up curve; `trend` smooths spiky buckets.

// Running total. cumulativeSum([1, 2, 3]) -> [1, 3, 6]; [] -> [].
export function cumulativeSum(values: number[]): number[] {
  const out: number[] = [];
  let sum = 0;
  for (const v of values) {
    sum += v;
    out.push(sum);
  }
  return out;
}

// Trailing moving average. out[i] is the mean of values[i-window+1 .. i],
// clamped at the leading edge so the window grows 1..window — out[0] is
// always defined (= values[0]). movingAverage([2, 4, 6], 2) -> [2, 3, 5].
//
// O(n) sliding sum (not O(n·window)): the ADR-0018 15-min `trend` line runs up
// to ~2,880 buckets with a ~960-bucket window on every live refetch, where the
// naive nested loop would be ~2.7M ops per series.
export function movingAverage(values: number[], window: number): number[] {
  const w = Math.max(1, Math.floor(window));
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] ?? 0;
    if (i >= w) sum -= values[i - w] ?? 0;
    const count = Math.min(i + 1, w);
    out.push(sum / count);
  }
  return out;
}

// The moving-average window for a `trend` chart, auto-derived from the bucket
// count — ~1/3 of the buckets, floored at 3. The min-3 floor can exceed the
// bucket count on tiny spans; `movingAverage` clamps each slice to what's
// available, so the effective window is still never larger than the data.
export function trendWindow(n: number): number {
  return Math.max(3, Math.min(n, Math.round(n / 3)));
}

// The per-bucket → plotted transform for a chart style: raw (bars), running
// total (cumulative), or trailing moving average (trend). Applied uniformly to
// every series AND the totals so all see identical values.
function styleTransform(chartStyle: ChartStyle, n: number): (raw: number[]) => number[] {
  if (chartStyle === "cumulative") return cumulativeSum;
  if (chartStyle === "trend") {
    const w = trendWindow(n);
    return (raw) => movingAverage(raw, w);
  }
  return (raw) => raw;
}

function abbreviateTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

// The per-metric value formatter: `$X.XX` for cost, abbreviated for tokens.
// Formats every tooltip number and the peak label.
function metricFormatter(metric: Metric): (n: number) => string {
  return (n: number) => (metric === "cost" ? `$${n.toFixed(2)}` : abbreviateTokens(n));
}

// The linear y-axis tick label: a bare `$0` at the origin (the glass mock's
// axis, matching the symlog origin label), `$X` above $10, two decimals below
// (cost), abbreviated counts for tokens. The renderer picks the linear tick
// values, so this labels whatever it asks for.
function linearTickLabel(metric: Metric): (v: number) => string {
  return metric === "cost"
    ? (value: number) => (value === 0 ? "$0" : `$${value.toFixed(value < 10 ? 2 : 0)}`)
    : (value: number) => abbreviateTokens(value);
}

// --- log scale: single symlog y-axis (ADR-0032) ----------------------------

// How far the log region may reach below the tallest peak's decade. Bounds the
// axis when one stray micro-value bucket would otherwise stretch the bottom of
// the scale and compress every decade above it (ADR-0032).
const LOG_MAX_DECADES_BELOW_PEAK = 6;

// Pick the symlog linear threshold C — the value where the linear zero band
// hands off to log decades, i.e. the first tick above 0 (ADR-0032). C is the
// power of ten at-or-below the smallest nonzero plotted value across every
// drawn series (ghosts included), capped at LOG_MAX_DECADES_BELOW_PEAK below
// the tallest peak's decade. Returns null when nothing is positive — there is
// nothing to log and the model falls back to the plain linear scale.
function pickLinearThreshold(seriesList: number[][]): number | null {
  let minPositive = Infinity;
  let peak = 0;
  for (const series of seriesList) {
    for (const v of series) {
      if (v <= 0) continue;
      if (v < minPositive) minPositive = v;
      if (v > peak) peak = v;
    }
  }
  if (peak === 0) return null;
  // The +1e-9 absorbs log10's float error on exact powers of ten, which would
  // otherwise floor one decade low.
  const floorDecade = Math.floor(Math.log10(minPositive) + 1e-9);
  const peakDecade = Math.floor(Math.log10(peak) + 1e-9);
  return Math.pow(10, Math.max(floorDecade, peakDecade - LOG_MAX_DECADES_BELOW_PEAK));
}

// The piecewise symlog transform (ADR-0032): linear 0→C mapped onto 0→1, log
// decades above (C→1, 10C→2, 100C→3, …). Integer positions in transformed
// space land exactly on 0, C, 10C, … — which is what makes one tick per unit
// interval yield clean decade ticks. Plotted values are never negative here
// (costs / token counts).
function symlogTransform(c: number): (v: number) => number {
  return (v) => (v <= c ? v / c : 1 + Math.log10(v / c));
}

// Inverse of symlogTransform — transformed axis position → real value. Labels
// the integer ticks.
function symlogInverse(c: number): (t: number) => number {
  return (t) => (t <= 1 ? t * c : c * Math.pow(10, t - 1));
}

// Decade tick label: `$0` / `$0.01` / `$0.10` / `$1` / `$10` for cost (enough
// decimals for sub-cent thresholds, never fewer than 2 below $1), abbreviated
// counts for tokens. `v` is always 0 or C·10ᵏ, so rounding the log is exact.
function formatDecadeLabel(v: number, metric: Metric): string {
  if (metric === "tokens") return abbreviateTokens(v);
  if (v === 0) return "$0";
  if (v >= 1) return `$${v.toFixed(0)}`;
  return `$${v.toFixed(Math.max(2, -Math.round(Math.log10(v))))}`;
}

// --- the model builder ------------------------------------------------------

export function buildChartModel(input: ChartModelInput): ChartModel {
  const {
    composed,
    labels,
    metric,
    chartStyle,
    logScale,
    showGhost,
    showNowLine,
    prevRangeLabel,
    theme,
  } = input;
  const n = labels.length;
  // Bars only when the bars style is on WITHOUT log — the log variant draws
  // every style as lines on the shared symlog axis (ADR-0032), never a
  // re-bucket; the symlog mapping applies AFTER the style transform, to
  // plotted positions only. styleTransform("bars") is the identity, so the
  // transform applies uniformly.
  const mark: ChartModel["mark"] = logScale || chartStyle !== "bars" ? "lines" : "bars";
  const transform = styleTransform(chartStyle, n);

  const resolved = composed.series.map((s) => ({
    ...s,
    color: s.color ?? theme.brand,
    values: transform(s.values),
    prevValues: s.prevValues ? transform(s.prevValues) : null,
  }));
  // The ghost draws only when EVERY series carries a prev array — a partial
  // ghost stack would misrepresent the previous period's total.
  const ghost = showGhost && resolved.every((s) => s.prevValues !== null);

  const series: ChartSeriesModel[] = resolved.map((s) => ({
    id: s.id,
    label: s.label,
    color: s.color,
    values: s.values,
    prevValues: ghost ? s.prevValues : null,
    ...(s.tokenType !== undefined ? { tokenType: s.tokenType } : {}),
  }));

  const totals = transform(composed.totals);
  const prevTotals = ghost && composed.prevTotals ? transform(composed.prevTotals) : null;

  // --- scale -----------------------------------------------------------------
  let scale: ChartScaleModel = {
    kind: "linear",
    position: (v) => v,
    tickLabel: linearTickLabel(metric),
  };
  if (logScale) {
    // Threshold from every DRAWN series — the current lines and their ghosts.
    const drawnSeries: number[][] = series.map((s) => s.values);
    if (ghost) for (const s of series) drawnSeries.push(s.prevValues ?? []);
    const c = pickLinearThreshold(drawnSeries);
    // `c === null` means an all-zero window — nothing to log, so the plain
    // linear scale above stands and the real values plot untransformed.
    if (c !== null) {
      const position = symlogTransform(c);
      const inverse = symlogInverse(c);
      // Top of the axis: the drawn peak's transformed position, ceiled to the
      // next decade boundary so the top tick is labelable. The -1e-9 absorbs
      // log10 float error on exact powers of ten (which would otherwise ceil a
      // whole decade high); the result is clamped to ≥1 so the C tick survives.
      let peakRaw = 0;
      for (const s of drawnSeries) for (const v of s) if (v > peakRaw) peakRaw = v;
      const maxPosition = Math.max(1, Math.ceil(position(peakRaw) - 1e-9));
      const ticks: ChartTick[] = [];
      for (let t = 0; t <= maxPosition; t++) {
        const value = inverse(t);
        ticks.push({ position: t, value, label: formatDecadeLabel(value, metric) });
      }
      scale = {
        kind: "symlog",
        c,
        maxPosition,
        position,
        inverse,
        ticks,
        tickLabel: (t) => formatDecadeLabel(inverse(t), metric),
      };
    }
  }

  // --- now marker + peak -----------------------------------------------------
  // The "now" marker sits at the rightmost bucket — the in-progress bucket.
  const nowIndex = showNowLine ? n - 1 : null;

  const fmt = metricFormatter(metric);
  let peak: ChartModel["peak"] = null;
  for (let i = 0; i < totals.length; i++) {
    const v = totals[i] ?? 0;
    if (v > 0 && (peak === null || v > peak.value)) peak = { index: i, value: v, label: fmt(v) };
  }

  // The bordered-total label: bars report a plain Total; the line styles name
  // their transform so the tooltip never claims a raw sum it isn't showing.
  const totalLabel =
    chartStyle === "bars" ? "Total" : chartStyle === "cumulative" ? "Cumulative" : "Trend (avg)";

  // --- structured tooltip ----------------------------------------------------
  // Reads the REAL (style-transformed, never scale-mapped) values — every
  // reported number is true, and on a log chart a $0 bucket reports $0.00 from
  // its position on the bottom tick.
  const hasTokenTypeAxis = series.some((i) => i.tokenType !== undefined);
  const tooltip = (index: number): ChartTooltipModel | null => {
    const header = labels[index];
    if (header === undefined) return null;

    // Top of the stack first — reverse of declaration order.
    const rows: ChartTooltipRow[] = [];
    for (const item of [...series].reverse()) {
      const v = item.values[index] ?? 0;
      if (v === 0) continue;
      rows.push({ color: item.color, label: item.label, value: fmt(v) });
    }
    const total = totals[index] ?? 0;

    // Cache share — only meaningful when the token-type axis splits the series.
    let cachePct: number | null = null;
    if (hasTokenTypeAxis && total > 0) {
      // cache share = create + read; input/output are both non-cache — ADR-0040.
      const cachePart = series.reduce(
        (s, i) =>
          i.tokenType !== undefined && isCacheCategory(i.tokenType)
            ? s + (i.values[index] ?? 0)
            : s,
        0,
      );
      cachePct = Math.round((cachePart / total) * 100);
    }

    let prevDelta: ChartTooltipDelta | null = null;
    if (prevTotals) {
      const prevTotal = prevTotals[index];
      if (prevTotal !== undefined) {
        const delta = total - prevTotal;
        prevDelta = {
          label: prevRangeLabel ?? "Previous",
          prev: fmt(prevTotal),
          delta,
          deltaAbs: fmt(Math.abs(delta)),
          pct: prevTotal === 0 ? null : (delta / prevTotal) * 100,
        };
      }
    }

    return {
      header,
      rows,
      total: { label: totalLabel, value: fmt(total) },
      cachePct,
      prevDelta,
    };
  };

  return {
    mark,
    logMode: logScale,
    chartStyle,
    metric,
    buckets: labels,
    series,
    ghost,
    totals,
    prevTotals,
    scale,
    nowIndex,
    peak,
    totalLabel,
    tooltip,
  };
}

// Pure helpers exported for tests. App code goes through buildChartModel.
export const _internals = {
  abbreviateTokens,
  metricFormatter,
  linearTickLabel,
  formatDecadeLabel,
  pickLinearThreshold,
  symlogTransform,
  symlogInverse,
};
