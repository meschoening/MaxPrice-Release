import {
  MODEL_COLORS,
  MODEL_FAMILIES,
  normalizeModelName,
  type ModelBreakdown,
  type ModelFamily,
} from "@maxprice/shared";
import { cn } from "@/lib/utils";

// Whether the bar's segment widths are proportional to cost or to token
// volume. Part 5's session detail page lets the user toggle this; every other
// call site wants the default, `"cost"`.
export type ModelSplitMetric = "cost" | "tokens";

export type ModelSplitBarProps = {
  breakdowns: ModelBreakdown[];
  size: "sm" | "md" | "lg";
  showLegend?: boolean;
  // Drives whether segments are sized by cost (default) or by total tokens.
  metric?: ModelSplitMetric;
  className?: string;
};

// The per-breakdown magnitude for the chosen metric. `"tokens"` sums the four
// token counts; `"cost"` is the plain `cost` float.
function breakdownValue(bd: ModelBreakdown, metric: ModelSplitMetric): number {
  if (metric === "tokens") {
    return bd.inputTokens + bd.outputTokens + bd.cacheCreationTokens + bd.cacheReadTokens;
  }
  return bd.cost;
}

// Rolls a row's modelBreakdowns into per-family totals + percentages for the
// chosen metric. The `value` field carries cost-or-tokens; segments with a
// zero value are dropped.
function summarize(
  breakdowns: ModelBreakdown[],
  metric: ModelSplitMetric,
): { family: ModelFamily; value: number; pct: number }[] {
  const totals = Object.fromEntries(MODEL_FAMILIES.map((f) => [f, 0])) as Record<
    ModelFamily,
    number
  >;
  for (const bd of breakdowns) {
    totals[normalizeModelName(bd.modelName)] += breakdownValue(bd, metric);
  }
  const sum = MODEL_FAMILIES.reduce((acc, f) => acc + totals[f], 0);
  return MODEL_FAMILIES.map((family) => ({
    family,
    value: totals[family],
    pct: sum === 0 ? 0 : (totals[family] / sum) * 100,
  })).filter((seg) => seg.value > 0);
}

// The .splitbar recipe is the strip's 6px bar (md); sm/lg call sites keep
// their heights via an inline override (the M4 CSS pins the default).
const HEIGHT: Record<ModelSplitBarProps["size"], number> = {
  sm: 4,
  md: 6,
  lg: 8,
};

export function ModelSplitBar({
  breakdowns,
  size,
  showLegend = false,
  metric = "cost",
  className,
}: ModelSplitBarProps): React.ReactElement {
  const segments = summarize(breakdowns, metric);

  return (
    <div className={cn("flex flex-col gap-1.5 min-w-0", className)}>
      <div
        role="img"
        aria-label="Model split"
        className="splitbar"
        style={size === "md" ? undefined : { height: HEIGHT[size] }}
      >
        {segments.map((seg) => (
          <i
            key={seg.family}
            style={{ width: `${seg.pct}%`, background: MODEL_COLORS[seg.family] }}
            aria-hidden
          />
        ))}
      </div>
      {showLegend && segments.length > 0 ? (
        // .split-legend wraps: in a narrow strip section the legend folds to a
        // second line instead of overflowing the section's right edge.
        <div className="split-legend">
          {segments.map((seg) => (
            <span key={seg.family}>
              <i className="sw" style={{ background: MODEL_COLORS[seg.family] }} aria-hidden />
              {seg.family} <b>{Math.round(seg.pct)}%</b>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
