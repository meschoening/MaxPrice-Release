import {
  MODEL_COLORS,
  MODEL_FAMILIES,
  MODEL_LEGEND_ORDER,
  normalizeModelName,
  type ModelBreakdown,
  type ModelFamily,
} from "@maxprice/shared";

export type ListRowProps = {
  // Feeds the per-row model split bar (92×4px, legend-ordered segments) and
  // its tooltip.
  breakdowns: ModelBreakdown[];
  title: string;
  meta?: string;
  cost: number;
  onClick?: () => void;
  // FLIP slot (use-flip-list): the keyed node the 350ms overtake glide moves.
  flipRef?: (el: HTMLElement | null) => void;
};

// One rail row (glass.html): title + 800-weight cost on the first line,
// meta + model split bar on the second; hairline dividers between rows.
export function ListRow({
  breakdowns,
  title,
  meta,
  cost,
  onClick,
  flipRef,
}: ListRowProps): React.ReactElement {
  const segments = splitSegments(breakdowns);
  const splitTitle = segments.map((s) => `${s.family} ${Math.round(s.pct)}%`).join(" · ");
  return (
    <button type="button" onClick={onClick} ref={flipRef} className="rail-row">
      <span className="row-title num">{title}</span>
      <span className="row-cost num">{`$${cost.toFixed(2)}`}</span>
      <span className="row-meta num">{meta}</span>
      <span className="split" title={splitTitle}>
        {segments.map((seg) => (
          <i
            key={seg.family}
            style={{ width: `${seg.pct}%`, background: MODEL_COLORS[seg.family] }}
            aria-hidden
          />
        ))}
      </span>
    </button>
  );
}

// Per-family cost shares in legend order; zero-cost families drop out.
function splitSegments(breakdowns: ModelBreakdown[]): { family: ModelFamily; pct: number }[] {
  const totals = Object.fromEntries(MODEL_FAMILIES.map((f) => [f, 0])) as Record<
    ModelFamily,
    number
  >;
  for (const bd of breakdowns) totals[normalizeModelName(bd.modelName)] += bd.cost;
  const sum = MODEL_FAMILIES.reduce((acc, f) => acc + totals[f], 0);
  if (sum === 0) return [];
  return MODEL_LEGEND_ORDER.filter((f) => totals[f] > 0).map((family) => ({
    family,
    pct: (totals[family] / sum) * 100,
  }));
}
