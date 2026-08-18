import type { Span } from "@maxprice/shared";
import type { ChartModel } from "@/lib/chart-model";

// The pure paint-geometry layer of the glass chart (M3, #61): ChartModel →
// pixel-space layout, no React, no DOM. glass-chart.tsx paints this layout
// verbatim — every number a renderer draws is computed (and tested) here.
//
// Provenance: x-geometry (cluster/bar/ghost widths and placement) generalizes
// the approved prototype renderer (plans/mocks/redesign/prototype/chart.js) —
// the mock hand-rounds its cluster positions, so its x values are NOT the
// contract. y-geometry follows the mock's authored rects
// (plans/mocks/redesign/glass.html chart section), which diverge from the
// prototype in two places:
// - the 2px carve between stacked segments comes out of each segment's own
//   TOP (topmost surviving segment kept full, so the stack cap sits exactly
//   at y(total) under the rounded clip); the prototype carved each segment's
//   own bottom. Same 2px gaps at the same boundaries.
// - the clip rect overhangs the baseline by rx, so only its TOP corners are
//   visible and bar bottoms stay square; the prototype's clip ended at y1,
//   rounding the baseline corners too.

// The full chart's view at its BASE width — the box the app drew at before the
// view went fluid (ADR-0073), and still the fallback a chart builds against
// before its own box has been measured. Every geometry test is authored here.
export const CHART_VIEW = { w: 720, h: 240, x0: 36, x1: 704, y0: 20, y1: 220 } as const;
export const COMPACT_VIEW = { w: 720, h: 64, x0: 0, x1: 720, y0: 2, y1: 62 } as const;

export type ChartView = { w: number; h: number; x0: number; x1: number; y0: number; y1: number };
export type LabelMode = "day" | "time";

// --- the fluid view (ADR-0073) ----------------------------------------------
// `k` — CSS px per view unit — is the one free parameter a fluid view needs,
// and before this it was not a constant at all but `svgPx / 720`: a zoom that
// measured 0.818 → 1.604 across the bench and 3.06 at 2560 once the frame cap
// came off, taking 8.2px axis type to 30.6px. The view is now clamped at both
// ends instead, `k ∈ [1.0, 1.60]`:
//
//   view.w = min(px, max(720, px / 1.60))     view.h = 240, always
//
// 1.60 is the rung the shipped app already topped out at against the old
// `max-w-[1500px]` frame, so nothing reachable before this change moves; only
// the width that cap forbade is new (a 2215px box → view 1384×240, plot 1332u,
// 384px tall). Above the cap the drawing stops growing and the window resolves
// more room instead — note ROOM, not buckets: every bucket size is an engine
// decision and none is derived from `view.w`.
//
// Written as `max(720, …)` rather than `px / min(px/720, 1.60)` deliberately:
// below a 1152px box `max` returns EXACTLY 720, where the division form returns
// 720 ± a float epsilon that would leak into every geometry number and into the
// layout memo's identity. "Identical to the shipped chart below the cap" is
// structural here, not an arithmetic coincidence someone has to re-derive.
//
// The outer `min` floors k at 1.0, which only bites below a 720px box — the
// narrow arrangement, where the view NARROWS instead of the drawing shrinking:
// same buckets, fewer units, the authored 10px axis type at 10px in a 240px-
// tall box rather than 8.2px in a 196px one.
//
// `view.h` stays 240 VIEW UNITS at every width. The rendered px height
// therefore stops growing above the cap (384px) and still scales below it,
// which is the chosen behaviour, not a rounding to correct.
const K_MAX = 1.6;

// Half a clamped day label, kept in view units — derived from the base view so
// the two can never drift.
const RIGHT_GUTTER = CHART_VIEW.w - CHART_VIEW.x1;

export function chartViewWidth(px: number): number {
  return Math.min(px, Math.max(CHART_VIEW.w, px / K_MAX));
}

// The full chart's gutters at any view width: 36 left (tick labels),
// RIGHT_GUTTER right, 20 top (the `now` label), 20 bottom (the day axis). At
// w = 720 this IS CHART_VIEW — pinned by test, since that identity is what
// makes the sub-cap chart byte-identical to the one that shipped.
export function chartViewAt(w: number): ChartView {
  return {
    w,
    h: CHART_VIEW.h,
    x0: CHART_VIEW.x0,
    x1: w - RIGHT_GUTTER,
    y0: CHART_VIEW.y0,
    y1: CHART_VIEW.y1,
  };
}

export type SegLayout = { x: number; y: number; w: number; h: number; color: string };
export type ClusterLayout = {
  index: number;
  // Full-cluster hover hit rect (spans y0..y1; the renderer supplies the ys).
  hitX: number;
  hitW: number;
  ghost: { x: number; w: number; yTop: number; r: number } | null;
  // One per model series, zero-height segs kept (morph stability: the same
  // rect count survives any same-shape data change).
  segs: SegLayout[];
  clip: { x: number; y: number; w: number; h: number; rx: number };
};
// One dense-mode series band (ADR-0046): the whole series as a single
// step-area `<path>`, replacing its one-rect-per-bucket cluster segments.
export type BandLayout = { id: string; color: string; d: string };
export type LineLayout = {
  color: string;
  // "x,y x,y …" polyline points.
  points: string;
  // Prev-period dashed line — same color at 0.45 (renderer's opacity).
  ghostPoints: string | null;
  // Single-series cumulative fill (non-log) else null.
  areaPath: string | null;
};
export type ChartLayout = {
  view: ChartView;
  gridLines: Array<{ y: number; label: string }>;
  // Exactly one of clusters/bands/lines is non-null: lines by model.mark, and
  // for bars, clusters when sparse / bands when dense (ADR-0046).
  clusters: ClusterLayout[] | null;
  bands: BandLayout[] | null;
  // The dense ghost: ONE step-area silhouette behind the bands, replacing the
  // per-cluster twin (which cannot fit beside a bar at this density). Null when
  // the ghost is off or the layout is not dense.
  ghostSilhouette: string | null;
  lines: LineLayout[] | null;
  // True when bars are drawn as bands rather than clusters. Drives the
  // renderer's dense-only chrome (the hover crosshair) and its motion.
  dense: boolean;
  dayLabels: Array<{ x: number; text: string; isNow: boolean }>;
  peak: { x: number; y: number; text: string } | null;
  // Dashed vline + "now" text at x.
  now: { x: number } | null;
  // Hover: index = clamp(floor((vx - x0) / clusterWidth)).
  clusterWidth: number;
  // Every bucket's center x, in bucket order (sparse bars center on the bar
  // itself, right of the ghost twin; dense bands and lines on the whole bucket
  // slot). The renderer reads this for its hover crosshair rather than
  // recomputing the rule, so the two can never disagree about where a bucket
  // is; the `now` marker sits on one of these centers exactly.
  //
  // The TEXT chrome only starts here. `dayLabels` and `peak` are placed at a
  // center and then pulled back inside the view by their own half-width, so at
  // the edges they sit inboard of the center they name (see clampLabelX), and
  // `dayLabels` is a thinned subset besides — there is no per-entry
  // correspondence with this array.
  centersX: number[];
  // Remount-to-rebuild key: same key ⇒ CSS-transition morph, new key ⇒ rise.
  shapeKey: string;
};

// The 2px surface gap carved between stacked segments (the CVD relief — gaps
// + fixed stack order are the mandatory secondary encoding, never hue alone).
const CARVE = 2;

// Snap x up to the prototype's mantissa ladder; the linear axis top is
// 3 × niceCeil(max/3) so the thirds land on clean values. niceCeil(0) = 1
// keeps an all-zero window drawing a real (empty) frame.
export function niceCeil(x: number): number {
  if (x <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) if (m * pow >= x - 1e-12) return m * pow;
  return 10 * pow;
}

// Rounded-top bar path (square baseline). rr clamps to half the bar height so
// a short bar degrades to a pill-top rather than self-intersecting; exported
// for the ghost `d` tween (Task 2), which interpolates yTop through this.
export function roundTopPath(x: number, w: number, yTop: number, r: number, y1: number): string {
  const rr = Math.min(r, Math.max(0, y1 - yTop) / 2);
  const y = Math.min(yTop, y1);
  return (
    `M${x} ${y1}V${(y + rr).toFixed(2)}Q${x} ${y.toFixed(2)} ${(x + rr).toFixed(2)} ${y.toFixed(2)}` +
    `H${(x + w - rr).toFixed(2)}Q${(x + w).toFixed(2)} ${y.toFixed(2)} ${(x + w).toFixed(2)} ${(y + rr).toFixed(2)}V${y1}Z`
  );
}

// Cluster geometry: bars cap at the mock's 22px and shrink with dense windows;
// the ghost bar is a narrower single-tone twin left of the bar. Compact strip
// charts fill more of the slot (0.42 vs 0.28) — at 64px tall the full-chart
// fraction reads as slivers; the mock's own mini chart fills ~0.69 of its
// pitch, so the thicker compact bar moves toward it (M4 gate feedback).
// The three floors below which a cluster's side-by-side content cannot shrink.
// SPARSE_MIN_CLUSTER_W is their sum, so raising any one of them moves the dense
// threshold with it rather than leaving it silently stale.
const BAR_MIN_W = 2.5;
const GHOST_MIN_W = 1.5;
const GAP_MIN_W = 1.5;

function barGeom(view: ChartView, n: number, ghost: boolean, compact: boolean) {
  // max(1, n): an empty window still needs finite numbers (nothing draws; the
  // DOM empty overlay covers the frame).
  const cw = (view.x1 - view.x0) / Math.max(1, n);
  const bw = Math.min(22, Math.max(BAR_MIN_W, cw * (compact ? 0.42 : 0.28)));
  const gw = Math.max(GHOST_MIN_W, bw * 0.55);
  const gap = Math.min(4, Math.max(GAP_MIN_W, cw * 0.05));
  const raw = ghost ? gw + gap + bw : bw;
  // Scale the whole cluster's content down proportionally when the slot cannot
  // hold the authored floors, so the marks always fit — bar, ghost and gap keep
  // their 2.5 : 1.5 : 1.5 ratio and together fill the slot exactly.
  //
  // `fit === 1` AT EVERY BOX >= 720, by construction and by test: the last
  // sparse n is 121, and against the base view's 668-unit plot that is 5.521
  // units per cluster against 5.5 of content (122 is already dense). So the base
  // view, every above-cap view, and therefore every authored geometry number in
  // this module are byte-identical to what shipped — the clamp only exists
  // BELOW the base width.
  //
  // Below it the fit does bite, because the view narrows while the dense
  // threshold does not: at a 553px box the plot is 501 units, so the floors stop
  // fitting at n = 92 while sparse mode runs to 121. That is the exact cost of
  // pinning SPARSE_MAX_N absolute (see its comment / ADR-0073 §148 — a
  // view-derived threshold would be 97 here, and would remount the marks layer
  // mid-drag). This clamp is that decision's counterpart: it accepts bars below
  // their authored 2.5-unit floor at narrow widths — at n = 121 / 553px, fit is
  // 0.753, giving a 1.88u bar — in exchange for never letting bucket i+1's
  // ~40%-alpha ghost paint on top of bucket i's bar, which is what the
  // unclamped geometry did (up to 1.36u of a 2.5u bar, at 1 unit = 1 CSS px).
  const fit = Math.min(1, cw / raw);
  return { cw, bw: bw * fit, gw: gw * fit, gap: gap * fit, contentW: raw * fit };
}

// The narrowest cluster that still fits a side-by-side bar + ghost twin, at the
// geometry floors in barGeom (summed from them, not restated). Below this the
// twin would overdraw its neighbours, so the layout switches to dense mode
// (ADR-0046). Against the 668-unit plot that lands the switch at 122 buckets,
// which ONLY the `block` span ever reaches — about two hours into its window.
// `1h` tops out at 60 one-minute buckets (~11.1 units per cluster, twice the
// threshold) and stays comfortably sparse; `today`'s bars stay on the calendar
// hour at 24, its line is a lines mark (never dense), and 7d/30d bars are daily.
//
// Deliberately GHOST-INDEPENDENT. With the ghost off, bars alone would keep
// fitting to 267 buckets, but deriving the threshold from actual fit would make
// the render mode flip when the legend's ghost pill is toggled. One fixed
// number keeps a given window's appearance stable under that toggle.
export const SPARSE_MIN_CLUSTER_W = GHOST_MIN_W + GAP_MIN_W + BAR_MIN_W;

// The last sparse bucket count — an ABSOLUTE `n`, derived once against the BASE
// view and then standing at every width (ADR-0073 amending ADR-0046's
// derivation, not its number: 121 stays, it just stops moving).
//
// SPARSE_MIN_CLUSTER_W is doing two jobs, and only one of them is fluid: a
// geometric fit, which scales with `view.w`, and ADR-0046's node budget, which
// does not. Re-derived against a fluid view the threshold moves 121 → 242 at
// wide and 121 → 97 at narrow, so a `block` between minute 122 and 242 would be
// sparse bars maximized and dense bands half-screen — and the two modes share
// no elements, so crossing the boundary REMOUNTS the marks layer and replays
// the rise animation partway through a window drag.
export const SPARSE_MAX_N = Math.floor((CHART_VIEW.x1 - CHART_VIEW.x0) / SPARSE_MIN_CLUSTER_W);

export function isDenseLayout(n: number): boolean {
  return n > SPARSE_MAX_N;
}

// A dense band as one closed step-area polygon: the top edge walked
// left→right, the bottom edge back right→left. Buckets are CONTIGUOUS — bucket
// i spans [xs[i], xs[i+1]] with no inter-bar gap — which is what lets adjacent
// minutes read as a continuous activity profile instead of 300 slivers.
//
// Emitted as H/V commands rather than L pairs: every edge segment is axis-
// aligned, so this is both the natural encoding and less than half the string
// length, which matters at 300 buckets × up to 64 series.
//
// `xs` arrives pre-formatted (n + 1 bucket edges) because every band shares the
// same edges: formatting them per invocation cost ~2n+1 redundant multiply-and-
// format operations per series.
function stepAreaPath(
  n: number,
  xs: string[],
  top: (i: number) => number,
  bottom: (i: number) => number,
): string {
  if (n <= 0) return "";
  const f = (v: number) => v.toFixed(1);
  let d = `M${xs[0] ?? ""} ${f(top(0))}H${xs[1] ?? ""}`;
  for (let i = 1; i < n; i++) d += `V${f(top(i))}H${xs[i + 1] ?? ""}`;
  d += `V${f(bottom(n - 1))}H${xs[n - 1] ?? ""}`;
  for (let i = n - 2; i >= 0; i--) d += `V${f(bottom(i))}H${xs[i] ?? ""}`;
  return `${d}Z`;
}

// --- axis label containment ------------------------------------------------
// Axis labels are middle-anchored, so half of each one hangs past the x it is
// placed at. The view gives that overhang almost nothing to work with on the
// right: the plot ends at x1 = 704 in a 720-wide view, and the last bucket's
// center lands within a unit or two of 700 on every intraday span — about 20
// units of budget. Half an ISO date is 29 and half a two-digit-hour AM/PM
// label is 22, so both overflow and the viewBox simply clips them. (Half a 24h
// `HH:MM` is 14, which is why the axis looked fine until AM/PM shipped, and why
// the 30d date axis was clipping all along.) The left edge has x0 = 36 to spend
// and only loses when a bucket-0 center sits near it — the dense/line rule
// centers bucket 0 at x0 + cw/2 ≈ 37, narrower than half a dated label.
//
// So each label is pulled back inside the frame by its own half-width. Doing
// that needs the rendered text width, which this layer cannot measure: it is
// pure geometry and its suite runs in Bun, where there is no font at all. It
// estimates instead, from a per-character table of em advances measured in the
// shipping WebView at the `.day` font (Manrope 500, 10px — globals.css). The
// estimate is deliberately an UPPER bound, verified against every label the app
// can produce (606 of them: both hour cycles, dated and undated, every ISO date
// and month name), tightest at 0.967 of the estimate. Over-estimating only
// insets a label that was going to be clamped anyway; under-estimating would
// leave it clipped, which is the whole bug.
//
// The em table is SIZE- and WEIGHT-free by construction, so the same advances
// serve every chrome text once scaled by its own font size:
// - `.day` (10px/500) is what the table was measured at — the 0.967 floor.
// - `.day-today` (10px/800, the `isNow` label) reuses it unchanged: Manrope's
//   digits are tabular and do not widen at all from 500→800, and only the
//   AM/PM letters move (~1.7%), on strings already well inside the bound.
//   Measured worst ratio 0.9792 ("06:00"), so the table still bounds it.
// - `.peak-label` (10.5px/600 + a 3.5px halo stroke) needs BOTH corrections and
//   gets them through `opts`: without them "123M" measures 1.0204 of its
//   estimate before the halo and 1.1995 with it, i.e. it still clipped after
//   the containment fix. See PEAK_LABEL_METRICS.
// A weight multiplier is neither derivable from the table nor needed at ≤1.3%;
// the size and the stroke overhang are the two real corrections.
//
// PROVENANCE — what these numbers are calibrated against, so a font or type-ramp
// bump has a documented tripwire:
//   - `@fontsource-variable/manrope`, pinned at 5.2.8 in packages/glass/package.json
//   - the `.day` / `.day-today` / `.peak-label` rules in
//     apps/desktop/src/styles/globals.css (10px/500, 10px/800, 10.5px/600 + 3.5
//     stroke)
// Change either and the drift shows up in the measured-width FLOOR fixture in
// chart-layout.test.ts, which is the signal to re-measure. Going stale is
// graceful — the worst case is an edge label a few units off-center, never a
// crash — and Manrope plus the 10px `.day` size are design-system fixtures
// (ADR-0043).
const LABEL_FONT_PX = 10;

// Per-style corrections to the base table: `px` the rendered font size, `pad`
// any ink painted OUTSIDE the glyph advances (a halo stroke's full outward
// overhang, both sides summed).
export type LabelMetrics = { px?: number; pad?: number };

// The peak label paints at 10.5px/600 under `paint-order: stroke` with
// `stroke-width: 3.5`, so its halo reaches 1.75 past each end of the text —
// 3.5 units of extra width that must clear the frame with the glyphs.
export const PEAK_LABEL_METRICS: LabelMetrics = { px: 10.5, pad: 3.5 };

export function estimateLabelWidth(text: string, opts?: LabelMetrics): number {
  const px = opts?.px ?? LABEL_FONT_PX;
  let em = 0;
  for (const c of text) {
    if (c === " ") em += 0.22;
    else if (c === ":" || c === "." || c === ",") em += 0.34;
    else if (c === "/" || c === "-") em += 0.44;
    else if (c >= "0" && c <= "9") em += 0.64;
    // Any letter or symbol. `M` is the widest glyph in the label alphabet at
    // 0.846em; this covers it with room to spare.
    else em += 0.87;
  }
  return em * px + (opts?.pad ?? 0);
}

// Pull a middle-anchored label inside [0, viewW]. Inert away from the edges —
// an unconditional inset would walk every label off the bar it names. `opts`
// carries the caller's own type metrics (see PEAK_LABEL_METRICS); omitted, the
// `.day` axis font is assumed.
function clampLabelX(x: number, text: string, viewW: number, opts?: LabelMetrics): number {
  const half = estimateLabelWidth(text, opts) / 2;
  // A label wider than the whole view cannot be contained; centering it clips
  // both ends evenly rather than letting the bounds cross and throw the label
  // somewhere arbitrary. Unreachable for real labels (the widest axis label is
  // ~81, the widest peak label ~57 including its halo).
  if (half * 2 >= viewW) return viewW / 2;
  return Math.min(Math.max(x, half), viewW - half);
}

// Which buckets get an x-axis label: every `step`th plus always the last (the
// today/now bucket). Day windows label all buckets up to 10 wide, then ~7
// labels; time windows always thin to ~6.
function labelIndices(n: number, mode: LabelMode): Set<number> {
  const step = mode === "day" ? (n <= 10 ? 1 : Math.ceil(n / 7)) : Math.ceil(n / 6);
  const set = new Set<number>();
  for (let i = 0; i < n; i += step) set.add(i);
  set.add(n - 1);
  return set;
}

// The spans whose window GROWS a bucket at a time as the clock runs: `block`
// runs from the active block's start to now (ADR-0031), `today` from local
// midnight to now (ADR-0020). Both are append-only — bucket i keeps its
// identity as the window extends — so their bucket count must NOT force a
// remount: at the one-minute bucket (ADR-0046) that would replay the `rise`
// animation every single minute for as long as the window stays sparse.
// Every other span has a fixed bucket count for its window, where a changed
// count means a genuinely different window (bucket 0 of `7d` is not bucket 0
// of `30d`) and rebuilding is right.
const GROWING_SPANS: ReadonlySet<Span> = new Set<Span>(["block", "today"]);

export function buildChartLayout(
  model: ChartModel,
  // `span` is the active chart tab, absent for the span-less compact strips.
  // It exists here only for the shapeKey: which window is drawn is not
  // recoverable from the model, yet it decides both whether a bucket-count
  // change means "the window grew" or "a different window", and whether two
  // same-shaped layouts are the same chart at all.
  // `view` is the caller's measured, width-fluid box (ADR-0073) — every number
  // this layer emits already reads it, so going fluid changed nothing below
  // this line. Absent, the module constants stand: before the first
  // measurement, and for the compact strips, which are deliberately fixed.
  opts: { compact: boolean; labelMode: LabelMode; span?: Span; view?: ChartView },
): ChartLayout {
  const view: ChartView = opts.view ?? (opts.compact ? COMPACT_VIEW : CHART_VIEW);
  const n = model.buckets.length;
  const plotH = view.y1 - view.y0;
  const geom = barGeom(view, n, model.ghost, opts.compact);
  // Dense mode is a BARS concern: lines are already one element per series at
  // any bucket count. Compact strips are daily-fed (≤30 buckets) and never
  // reach the threshold, but the check is uniform rather than mode-gated.
  const dense = model.mark === "bars" && isDenseLayout(n);

  // --- y-mapping + gridlines -----------------------------------------------
  let y: (v: number) => number;
  let scaleSig: string;
  let gridLines: ChartLayout["gridLines"] = [];
  if (model.scale.kind === "symlog") {
    const { position, maxPosition, ticks } = model.scale;
    y = (v) => view.y1 - (position(v) / maxPosition) * plotH;
    scaleSig = `log${maxPosition}`;
    if (!opts.compact) {
      // One gridline per decade tick, thinned past 6 to keep the axis
      // readable (always 0, C, and the top — the prototype's keep-set).
      const kept =
        ticks.length > 6
          ? ticks.filter(
              (_, i) => i === 0 || i === 1 || i === ticks.length - 1 || (i - 1) % 2 === 0,
            )
          : ticks;
      // tick.position is exact integer axis space; mapping the value back
      // through position() would only reintroduce log10 float error.
      gridLines = kept.map((t) => ({
        y: view.y1 - (t.position / maxPosition) * plotH,
        label: t.label,
      }));
    }
  } else {
    // The tallest DRAWN value owns the axis: bars draw stack totals (and
    // ghost totals), lines draw per-series values (and per-series ghosts).
    let max = 0;
    const consider = (v: number) => {
      if (v > max) max = v;
    };
    if (model.mark === "bars") {
      model.totals.forEach(consider);
      if (model.ghost) model.prevTotals?.forEach(consider);
    } else {
      for (const s of model.series) {
        s.values.forEach(consider);
        if (model.ghost) s.prevValues?.forEach(consider);
      }
    }
    const step = niceCeil(max / 3);
    const top = step * 3;
    const tickLabel = model.scale.tickLabel;
    y = (v) => view.y1 - (Math.max(0, v) / top) * plotH;
    scaleSig = "lin";
    if (!opts.compact)
      gridLines = [0, step, 2 * step, top].map((v) => ({ y: y(v), label: tickLabel(v) }));
  }

  // --- marks ----------------------------------------------------------------
  // Bucket centers: bars center on the bar itself (right of the ghost),
  // lines on the whole cluster.
  const barX = (i: number) =>
    view.x0 + i * geom.cw + (geom.cw - geom.contentW) / 2 + (model.ghost ? geom.gw + geom.gap : 0);
  // Dense bands fill their whole bucket slot, so their center is the slot's —
  // the same rule lines already use.
  const centerX = (i: number) =>
    model.mark === "bars" && !dense ? barX(i) + geom.bw / 2 : view.x0 + (i + 0.5) * geom.cw;

  let clusters: ClusterLayout[] | null = null;
  let bands: BandLayout[] | null = null;
  let ghostSilhouette: string | null = null;
  let lines: LineLayout[] | null = null;

  if (dense) {
    // Bucket i spans [xs[i], xs[i + 1]] — contiguous, no gap. The edges are
    // identical for every band and the ghost, so they are computed and
    // formatted exactly once here.
    const xs = Array.from({ length: n + 1 }, (_, i) => (view.x0 + i * geom.cw).toFixed(1));

    // The ghost first, so the bands paint over it: one silhouette from the
    // baseline up to each bucket's previous-period total.
    if (model.ghost) {
      const prev = model.prevTotals;
      ghostSilhouette = stepAreaPath(
        n,
        xs,
        (i) => y(prev?.[i] ?? 0),
        () => view.y1,
      );
    }

    // Per bucket, the running stack base and the topmost surviving series —
    // the same two quantities the cluster path computes, hoisted across all
    // buckets so each series can be walked as one continuous edge.
    const base: number[][] = [];
    const lastAt: number[] = [];
    for (let i = 0; i < n; i++) {
      const cums: number[] = [];
      let cum = 0;
      let last = -1;
      model.series.forEach((s, k) => {
        cums.push(cum);
        const v = s.values[i] ?? 0;
        if (v > 0) {
          cum += v;
          last = k;
        }
      });
      base.push(cums);
      lastAt.push(last);
    }

    bands = model.series.map((s, k) => {
      // A series that never fires over the window would still build a full-
      // length path — ~1,200 commands that degenerate to a zero-area polygon
      // along the baseline — and hand it to the DOM. The composable group-by
      // pushes a series per cross-product combination unconditionally, so most
      // of the up-to-64 combinations are exactly this. The `> 0` predicate
      // matches lastAt's, which is what keeps the two consistent: an all-zero
      // series can never be a bucket's topmost survivor and adds 0 to `base`,
      // so skipping its geometry cannot disturb the carve. The band still ships
      // its id/color, leaving React keying and series identity untouched.
      const any = s.values.some((v) => v > 0);
      return {
        id: s.id,
        color: s.color,
        d: any
          ? stepAreaPath(
              n,
              xs,
              (i) => {
                const below = base[i]?.[k] ?? 0;
                const v = s.values[i] ?? 0;
                const yBot = Math.min(y(below), view.y1);
                // The 2px carve comes out of each band's own top, topmost
                // survivor exempt, exactly as the sparse stack carves (the CVD
                // relief is a mandatory secondary encoding and survives dense
                // mode intact). Clamped so a zero-value bucket collapses to
                // nothing rather than inverting by the carve.
                return Math.min(y(below + v) + (k === lastAt[i] ? 0 : CARVE), yBot);
              },
              (i) => Math.min(y(base[i]?.[k] ?? 0), view.y1),
            )
          : "",
      };
    });
  } else if (model.mark === "bars") {
    clusters = [];
    for (let i = 0; i < n; i++) {
      const sx = view.x0 + i * geom.cw + (geom.cw - geom.contentW) / 2;
      const bx = barX(i);
      // The topmost surviving segment keeps its full top (the carve
      // exception): find it up front.
      let last = -1;
      model.series.forEach((s, k) => {
        if ((s.values[i] ?? 0) > 0) last = k;
      });
      let cum = 0;
      let prevTopY = view.y1;
      const segs: SegLayout[] = model.series.map((s, k) => {
        const v = s.values[i] ?? 0;
        // Zero segs park at the stack's current top so a later nonzero value
        // morphs out of place rather than teleporting from the baseline.
        if (v <= 0) return { x: bx, y: prevTopY, w: geom.bw, h: 0, color: s.color };
        const yBot = Math.min(y(cum), view.y1);
        cum += v;
        const yTop = y(cum) + (k === last ? 0 : CARVE);
        prevTopY = yTop;
        return { x: bx, y: yTop, w: geom.bw, h: Math.max(0, yBot - yTop), color: s.color };
      });
      const total = model.totals[i] ?? 0;
      const clipY = y(total);
      const rx = Math.min(6, geom.bw / 2.2);
      clusters.push({
        index: i,
        hitX: view.x0 + i * geom.cw,
        hitW: geom.cw,
        ghost: model.ghost
          ? {
              x: sx,
              w: geom.gw,
              yTop: y(model.prevTotals?.[i] ?? 0),
              r: Math.min(4, geom.gw / 2.2),
            }
          : null,
        segs,
        // The rounded top lands on the topmost surviving segment by
        // construction: the clip hugs y(total). Its height overhangs the
        // baseline by rx (the mock's authored +6) so the clip's own bottom
        // rounding falls outside the plot and bar bottoms stay square; a
        // zero-total bucket keeps a fully collapsed clip.
        clip: {
          x: bx,
          y: clipY,
          w: geom.bw,
          h: total > 0 ? Math.max(0, view.y1 - clipY) + rx : 0,
          rx,
        },
      });
    }
  } else {
    // Straight polylines — no smoothing, no decimation (the glass contract;
    // series count is capped by compose, bucket counts by the spans).
    const pt = (i: number, v: number) => `${centerX(i).toFixed(1)},${y(v).toFixed(2)}`;
    const singleCumArea =
      model.series.length === 1 && model.chartStyle === "cumulative" && !model.logMode && n > 0;
    lines = model.series.map((s) => ({
      color: s.color,
      points: s.values.map((v, i) => pt(i, v)).join(" "),
      ghostPoints:
        model.ghost && s.prevValues ? s.prevValues.map((v, i) => pt(i, v)).join(" ") : null,
      areaPath: singleCumArea
        ? `M${s.values.map((v, i) => pt(i, v)).join("L")}V${view.y1}H${centerX(0).toFixed(1)}Z`
        : null,
    }));
  }

  // Materialized from the same closure the chrome below uses, so the renderer
  // never has to restate the sparse-bar-vs-slot rule to place its crosshair.
  const centersX = Array.from({ length: n }, (_, i) => centerX(i));

  // --- chrome (none in compact) --------------------------------------------
  const dayLabels: ChartLayout["dayLabels"] = [];
  if (!opts.compact) {
    const labelSet = labelIndices(n, opts.labelMode);
    for (let i = 0; i < n; i++) {
      if (!labelSet.has(i)) continue;
      const text = model.buckets[i] ?? "";
      dayLabels.push({
        // Placed at the bucket center, then pulled inside the frame if the
        // text's own half-width would hang past an edge (edge buckets only).
        x: clampLabelX(centerX(i), text, view.w),
        text,
        isNow: i === n - 1 && model.nowIndex !== null,
      });
    }
    // Middle-anchored labels overprint as soon as two centers close to within
    // their averaged half-widths, and `labelIndices` cannot see that coming: it
    // picks a label COUNT from n alone, then forces n - 1 on top of the stepped
    // set. Sweep right to left, dropping the EARLIER label of any colliding
    // pair — right to left because the last bucket is the now/today one the
    // axis must name, so it is the one label that can never be dropped.
    //
    // Two things reach this. At the base view it fires exactly once, on the
    // 12-hour dated line axes (7d/30d at the 15-min bucket: n = 672 / 2880,
    // whose forced last label clamps ~24 units left of its center and lands
    // inside a "05/21 12:00 AM" of the stepped one) — which is why it was
    // written as a single check. The fluid view (ADR-0073) is the second: below
    // a 720px box the FRAME narrows while a label keeps its width in units, so
    // a 553-unit view asks seven dated AM/PM labels at ~81 units each to sit in
    // ~71 units of pitch, and thinning one of them is nowhere near enough.
    for (let i = dayLabels.length - 1; i > 0; i--) {
      // After a splice at i - 1 the kept label shifts down into i - 1, and the
      // loop's own `i--` lands on it — so `b` is always the last KEPT label.
      const b = dayLabels[i]!;
      const a = dayLabels[i - 1]!;
      const need = (estimateLabelWidth(a.text) + estimateLabelWidth(b.text)) / 2;
      if (b.x - a.x < need) dayLabels.splice(i - 1, 1);
    }
  }

  const peak =
    !opts.compact && model.mark === "bars" && model.peak
      ? {
          // Same containment rule as the axis labels, for the same reason: a
          // peak on the LAST bucket is placed at a center ~700, from which half
          // a four-figure cost label overruns the frame. Its own type metrics,
          // though: `.peak-label` is a size up from `.day` and paints a halo
          // stroke past both ends of the text (PEAK_LABEL_METRICS).
          x: clampLabelX(centerX(model.peak.index), model.peak.label, view.w, PEAK_LABEL_METRICS),
          // Floats 6px above the bar cap; the 12 floor is defensive (a legal
          // model's top always clears the peak).
          y: Math.max(12, y(model.peak.value) - 6),
          text: model.peak.label,
        }
      : null;

  const now = !opts.compact && model.nowIndex !== null ? { x: centerX(model.nowIndex) } : null;

  // Same key ⇒ the renderer morphs in place; any shape change remounts with
  // the rise animation. The linear top is deliberately absent — axis rescales
  // morph — while a symlog decade change rebuilds (the whole mapping warps).
  // metric and labelMode ride the key: morphing a $-scale into a token-scale
  // (or relabeling the axis) is the wrong motion — those rebuild.
  // `n` rides the key ONLY for sparse bars on a FIXED-window span, where it IS
  // the element count — one cluster group per bucket, so a changed count must
  // remount rather than morph mismatched rects, and a different count means a
  // different window. Two exemptions:
  //   - dense bands and lines are ONE element per series whose `d` / `points`
  //     simply change, so a bucket-count change never mismatches elements;
  //   - a GROWING span (`block` / `today`) appends buckets while keeping every
  //     existing bucket's identity, so its rects should morph through the
  //     0.45s transitions. At the one-minute bucket both grow every minute,
  //     and keying on `n` replayed the rise animation that often (ADR-0046).
  // The dense flag itself rides the key — the two modes share no elements.
  // The span rides it too: with `n` gone for growing spans and lines, nothing
  // else distinguishes the windows (all four intraday spans label "time",
  // 7d/30d both label "day"), so a span switch would silently snap the marks
  // instead of rebuilding them.
  const shapeKey = [
    model.mark,
    dense ? "dense" : "sparse",
    model.mark === "bars" && !dense && !(opts.span !== undefined && GROWING_SPANS.has(opts.span))
      ? n
      : "",
    model.series.map((s) => s.id).join(","),
    model.ghost ? "g" : "",
    model.chartStyle,
    scaleSig,
    model.metric,
    opts.labelMode,
    opts.compact ? "c" : "",
    opts.span ?? "",
  ].join("~");

  return {
    view,
    gridLines,
    clusters,
    bands,
    ghostSilhouette,
    lines,
    dense,
    dayLabels,
    peak,
    now,
    clusterWidth: geom.cw,
    centersX,
    shapeKey,
  };
}
