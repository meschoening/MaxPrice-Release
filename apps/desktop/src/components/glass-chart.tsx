import { Fragment, memo, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Span } from "@maxprice/shared";
import {
  buildChartLayout,
  roundTopPath,
  CHART_VIEW,
  COMPACT_VIEW,
  type BandLayout,
  type ChartView,
  type ClusterLayout,
  type LabelMode,
  type LineLayout,
} from "@/lib/chart-layout";
import type { ChartModel, ChartTooltipModel } from "@/lib/chart-model";
import { GLASS_EASE, MORPH_MS } from "@/lib/chart-motion";
import { cn } from "@/lib/utils";

// The glass SVG chart renderer (M3, #61): paints a ChartLayout — the pure
// pixel geometry from chart-layout.ts — as React SVG, replacing the ECharts
// canvas. Motion follows T9's engine-portable contract:
//   - rect geometry (x/y/width/height) rides CSS style properties, so the
//     globals.css transitions morph same-shape updates natively;
//   - the ghost bar's `d` is tweened by hand via rAF setAttribute (NEVER a
//     `transition: d` CSS rule — Gecko doesn't interpolate d);
//   - polyline `points` / area `d` are plain attributes and snap;
//   - a shapeKey change remounts the marks layer, running the CSS `rise`.
// The tooltip renders the model's structured entries as JSX (auto-escaped),
// ending chart-option.ts's HTML-string formatter era.

export type GlassChartProps = {
  // null → the bare svg only: a stable layout box for cost-chart's overlays
  // (loading skeleton / error / all-muted / empty) to cover.
  model: ChartModel | null;
  compact: boolean;
  labelMode: LabelMode;
  // The active span tab, forwarded to the layout's shapeKey (absent for the
  // span-less compact strips): it decides whether a bucket-count change is a
  // growing window (morph) or a different window (rebuild).
  span?: Span;
};

type Hover = { index: number; clientX: number; clientY: number };

// SVG2 geometry properties as CSS, so the globals.css rect transitions apply.
// React.CSSProperties doesn't know x/y — the cast is the one seam.
function rectStyle(r: { x: number; y: number; w: number; h: number }): React.CSSProperties {
  return {
    x: `${r.x}px`,
    y: `${r.y}px`,
    width: `${r.w}px`,
    height: `${r.h}px`,
  } as React.CSSProperties;
}

export function GlassChart({
  model,
  compact,
  labelMode,
  span,
}: GlassChartProps): React.ReactElement {
  const [hover, setHover] = useState<Hover | null>(null);

  const layout = useMemo(
    () => (model ? buildChartLayout(model, { compact, labelMode, span }) : null),
    [model, compact, labelMode, span],
  );
  const view: ChartView = layout?.view ?? (compact ? COMPACT_VIEW : CHART_VIEW);
  // Stable per-render: seg rects key by series id (morph stability — the same
  // rect count and identity survive any same-shape data change).
  const seriesIds = useMemo(() => (model ? model.series.map((s) => s.id) : []), [model]);

  // Axis-trigger hover: the nearest bucket over the whole plot width, from the
  // cursor's viewBox x. clusterWidth is defined for bars AND lines.
  const handleMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (!layout || !model || model.buckets.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const vx = ((e.clientX - rect.left) / rect.width) * view.w;
    const raw = Math.floor((vx - view.x0) / layout.clusterWidth);
    const index = Math.min(model.buckets.length - 1, Math.max(0, raw));
    setHover({ index, clientX: e.clientX, clientY: e.clientY });
  };

  // The hover index CLAMPED against the model as it stands NOW. handleMove
  // clamps at mousemove time, but a refetch can shrink the bucket count under
  // a stationary pointer — `block` rolls over 300 → 1, local midnight takes
  // `today` 721 → 1 — leaving a stale index that would read off the end of the
  // tooltip and (via centersX) paint a NaN crosshair. Clamping rather than
  // clearing is deliberate: the pointer hasn't moved, so the chart keeps
  // reporting a bucket across the rollover instead of blanking.
  const hoverIndex =
    hover && model && model.buckets.length > 0
      ? Math.max(0, Math.min(hover.index, model.buckets.length - 1))
      : null;
  const tip = hoverIndex !== null && model ? model.tooltip(hoverIndex) : null;
  // The crosshair's x comes from the layout, never a formula restated here.
  const crosshairX = hoverIndex !== null && layout ? (layout.centersX[hoverIndex] ?? null) : null;

  return (
    <div className={cn("relative", compact && "h-full")}>
      {/* The accessible name lives on cost-chart's wrapper (role="img"
          aria-label); the svg is decoration to AT and its clusters are
          pointer-only — focusable clusters inside an aria-hidden tree were
          an axe violation, resolved at the #61 gate by dropping tabIndex. */}
      <svg
        className={cn("chart-svg", compact && "compact")}
        viewBox={`0 0 ${view.w} ${view.h}`}
        role="presentation"
        aria-hidden
        preserveAspectRatio={compact ? "none" : "xMidYMid meet"}
        onMouseMove={layout ? handleMove : undefined}
        // ALWAYS attached, unlike the move handler: cost-chart nulls the model
        // while loading / all-muted / empty, and gating the leave handler on
        // `layout` meant leaving the chart in one of those states never cleared
        // the hover — a stale tooltip then revived at the old cursor position
        // the moment data came back.
        onMouseLeave={() => setHover(null)}
      >
        {layout && model ? (
          <>
            {/* Axis chrome lives OUTSIDE the keyed layer: positions are fixed
                per shape (linear thirds / log decades — a decade change is a
                new shapeKey), only tick label text changes, so attrs snap. */}
            {layout.gridLines.map((g, i) => (
              <g key={i}>
                <line className="grid-line" x1={view.x0} x2={view.x1} y1={g.y} y2={g.y} />
                <text className="tick" x={view.x0 - 6} y={g.y + 3} textAnchor="end">
                  {g.label}
                </text>
              </g>
            ))}

            {/* The marks layer: keyed by shapeKey, so a shape change remounts
                and runs the CSS rise; a same-shape update morphs in place. */}
            <g key={layout.shapeKey} className="bars-layer">
              {layout.ghostSilhouette !== null ? (
                <path className="ghost-silhouette" d={layout.ghostSilhouette} />
              ) : null}
              {layout.bands ? <DenseBands bands={layout.bands} /> : null}
              {layout.clusters
                ? layout.clusters.map((c) => (
                    <BarCluster key={c.index} cluster={c} view={view} seriesIds={seriesIds} />
                  ))
                : null}
              {layout.lines ? <LinesMark lines={layout.lines} /> : null}
            </g>

            {/* Hover crosshair (line styles AND dense bars): the vertical mark
                for the bucket the tooltip is reporting, read straight off the
                layout's own bucket centers — the geometry layer decides WHERE a
                bucket sits, this guard only decides WHETHER to draw. Dense mode
                has no per-cluster rects, so this replaces the `.cluster:hover`
                brighten that identifies the read bucket at sparse densities
                (ADR-0046). Outside the keyed layer — pointer chrome, never part
                of morph/rise. */}
            {(layout.lines || layout.dense) && crosshairX !== null ? (
              <line
                className="hover-line"
                x1={crosshairX}
                x2={crosshairX}
                y1={view.y0}
                y2={view.y1}
              />
            ) : null}

            {layout.dayLabels.map((d, i) => (
              <text
                key={i}
                className={d.isNow ? "day day-today" : "day"}
                x={d.x}
                y={view.y1 + 16}
                textAnchor="middle"
              >
                {d.text}
              </text>
            ))}

            {layout.peak ? (
              <text className="peak-label" x={layout.peak.x} y={layout.peak.y} textAnchor="middle">
                {layout.peak.text}
              </text>
            ) : null}

            {layout.now ? (
              <g>
                <line
                  className="now-line"
                  x1={layout.now.x}
                  x2={layout.now.x}
                  y1={view.y0}
                  y2={view.y1}
                />
                <text className="now-label" x={layout.now.x} y={view.y0 - 6} textAnchor="middle">
                  now
                </text>
              </g>
            ) : null}
          </>
        ) : null}
      </svg>
      {tip && hover ? <ChartTip tip={tip} clientX={hover.clientX} clientY={hover.clientY} /> : null}
    </div>
  );
}

// Dense mode's marks (ADR-0046): ONE step-area <path> per series, replacing the
// one-rect-per-series-per-bucket clusters. Above ~121 buckets a cluster's rects,
// clip and hit rect are all sub-pixel — and ruinous in number, since `block` at
// a one-minute bucket is 300 buckets × up to 64 series ≈ 19k transitioning
// nodes. Collapsing each series to a single path makes the node count depend on
// the series set alone.
//
// Deliberately NOT transitioned: `d` is not interpolable everywhere (see
// chart-motion.ts), the alternative is 64 concurrent hand-run tweens, and at
// ~2 units per bucket a morph is invisible anyway. Dense bands snap; `n` is
// absent from the dense shapeKey so a window that grows a bucket every minute
// updates silently instead of replaying the rise.
const DenseBands = memo(function DenseBands({
  bands,
}: {
  bands: BandLayout[];
}): React.ReactElement {
  return (
    <>
      {bands.map((b) => (
        <path key={b.id} className="band" d={b.d} style={{ fill: b.color }} />
      ))}
    </>
  );
});

// One bar cluster: the full-width hover hit, the ghost twin, and the stacked
// segments under a rounded-top clip. Segment/clip geometry rides CSS style
// properties so the globals.css 0.45s transitions morph same-shape updates.
const BarCluster = memo(function BarCluster({
  cluster,
  view,
  seriesIds,
}: {
  cluster: ClusterLayout;
  view: ChartView;
  seriesIds: string[];
}): React.ReactElement {
  // React 19's useId yields «rN» — strip to the alphanumeric core so the
  // clip-path url(#…) fragment stays a plain CSS identifier.
  const clipId = `clip${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-${cluster.index}`;
  return (
    <g className="cluster">
      <rect
        className="hit"
        x={cluster.hitX}
        y={view.y0}
        width={cluster.hitW}
        height={view.y1 - view.y0}
      />
      {cluster.ghost ? (
        <GhostBar
          x={cluster.ghost.x}
          w={cluster.ghost.w}
          yTop={cluster.ghost.yTop}
          r={cluster.ghost.r}
          y1={view.y1}
        />
      ) : null}
      <clipPath id={clipId}>
        <rect className="clip-rect" rx={cluster.clip.rx} style={rectStyle(cluster.clip)} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        {cluster.segs.map((s, k) => (
          <rect
            key={seriesIds[k] ?? k}
            className="seg"
            style={{ ...rectStyle(s), fill: s.color }}
          />
        ))}
      </g>
    </g>
  );
});

// The lines mark: ghost polylines first (beneath), then the current lines,
// each over its optional cumulative area fill. Attributes snap — the T9
// parity contract (no points tween in either engine).
const LinesMark = memo(function LinesMark({ lines }: { lines: LineLayout[] }): React.ReactElement {
  return (
    <>
      {lines.map((l, k) =>
        l.ghostPoints !== null ? (
          <polyline
            key={k}
            className="line line-ghost"
            points={l.ghostPoints}
            style={{ stroke: l.color }}
          />
        ) : null,
      )}
      {lines.map((l, k) => (
        <Fragment key={k}>
          {l.areaPath !== null ? (
            <path className="line-area" d={l.areaPath} style={{ fill: l.color }} />
          ) : null}
          <polyline className="line" points={l.points} style={{ stroke: l.color }} />
        </Fragment>
      ))}
    </>
  );
});

// The ghost bar: a rounded-top <path> whose `d` is written imperatively.
// React never renders `d` here — the first layout effect sets it before
// paint, and same-shape yTop changes rAF-tween it through GLASS_EASE so the
// hand-run morph matches the CSS-run segment morphs (T9: the tween writes the
// d ATTRIBUTE; there is no `transition: d` rule anywhere).
function GhostBar({
  x,
  w,
  yTop,
  r,
  y1,
}: {
  x: number;
  w: number;
  yTop: number;
  r: number;
  y1: number;
}): React.ReactElement {
  const ref = useRef<SVGPathElement | null>(null);
  // The last-applied geometry + the in-flight tween (raf 0 = none). Tweens
  // start from yCur — the currently DISPLAYED yTop — so interrupts stay
  // continuous.
  const anim = useRef<{ x: number; w: number; r: number; y1: number; yCur: number; raf: number }>({
    x: NaN,
    w: NaN,
    r: NaN,
    y1: NaN,
    yCur: NaN,
    raf: 0,
  });
  useLayoutEffect(() => {
    const el = ref.current;
    const cancel = (): void => {
      if (anim.current.raf !== 0) {
        cancelAnimationFrame(anim.current.raf);
        anim.current.raf = 0;
      }
    };
    if (!el) return cancel;
    cancel();
    const apply = (yv: number, raf = 0): void => {
      el.setAttribute("d", roundTopPath(x, w, yv, r, y1));
      anim.current = { x, w, r, y1, yCur: yv, raf };
    };
    const prev = anim.current;
    const sameShape = prev.x === x && prev.w === w && prev.r === r && prev.y1 === y1;
    const reduced =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!sameShape || reduced || prev.yCur === yTop || Number.isNaN(prev.yCur)) {
      // First run after mount, an x/w/r reshape, or reduced motion: land
      // instantly. (x/w/r only change with the cluster count, which is a
      // shapeKey remount anyway — this branch is the mount path in practice.)
      apply(yTop);
    } else {
      const from = prev.yCur;
      const start = performance.now();
      const step = (ts: number): void => {
        const t = Math.min(1, (ts - start) / MORPH_MS);
        const yv = from + (yTop - from) * GLASS_EASE(t);
        apply(yv, t < 1 ? requestAnimationFrame(step) : 0);
      };
      apply(from, requestAnimationFrame(step));
    }
    return cancel;
  }, [x, w, yTop, r, y1]);
  return <path ref={ref} className="ghost-bar" />;
}

// The glass tooltip: the model's structured entries as JSX, mirroring the old
// ECharts HTML formatter row for row (chart-option.ts's renderTooltipHtml).
// Placed 14px right of the cursor, flipped left when it would overflow the
// container, clamped inside it; measured via ref + layout effect (styles are
// written to the node directly, before paint, so there's no position-state
// re-render loop).
function ChartTip({
  tip,
  clientX,
  clientY,
}: {
  tip: ChartTooltipModel;
  clientX: number;
  clientY: number;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const cont = parent.getBoundingClientRect();
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    const cx = clientX - cont.left;
    const cy = clientY - cont.top;
    let left = cx + 14;
    if (left + tw > cont.width) left = cx - 14 - tw;
    left = Math.max(0, Math.min(left, Math.max(0, cont.width - tw)));
    const top = Math.max(0, Math.min(cy - th / 2, Math.max(0, cont.height - th)));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [tip, clientX, clientY]);
  const delta = tip.prevDelta;
  return (
    <div ref={ref} className="chart-tip">
      <div className="mb-1.5 font-semibold">{tip.header}</div>
      {tip.rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block size-2 shrink-0 rounded-full"
            style={{ background: row.color }}
          />
          <span className="flex-1">{row.label}</span>
          <span className="num">{row.value}</span>
        </div>
      ))}
      <div className="mt-1 flex gap-2 border-t border-line pt-1">
        <span className="flex-1 font-semibold">{tip.total.label}</span>
        <span className="num font-semibold">{tip.total.value}</span>
      </div>
      {tip.cachePct !== null ? (
        <div className="mt-1 text-[11px] text-soft">cache {tip.cachePct}% of total</div>
      ) : null}
      {delta ? (
        <div className="mt-1.5 text-[11px] text-soft">
          {delta.label}: {delta.prev} · Δ {delta.delta >= 0 ? "+" : "−"}
          {delta.deltaAbs}
          {delta.pct === null ? "" : ` (${delta.pct >= 0 ? "+" : ""}${delta.pct.toFixed(0)}%)`}
        </div>
      ) : null}
    </div>
  );
}
