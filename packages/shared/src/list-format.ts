import type { DateRangePreset } from "./dates";
import { normalizeModelName, type ModelBreakdown } from "./models";

// The Desktop's list formatters, shared with the Headless client (ADR-0118 §7)
// so a table in the terminal reads exactly as the same table in the app.
// `formatCost` is the one money format: `$8.72`, two decimals, no thousands
// separator.

export function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

// Human label for each date-range preset — "Sessions · all time", the
// aggregate strip's "296 sessions · all time", etc. Moved out of Topbar.tsx
// (ADR-0016) so the strip and the topbar share one copy.
export const RANGE_LABEL: Record<DateRangePreset, string> = {
  "24h": "last 24 hours",
  // Not "last 7 days": the week follows the Week setting (ADR-0083), so an
  // anchored week is not seven days back from today. "this week" is true in
  // every mode.
  week: "this week",
  "30d": "last 30 days",
  "90d": "last 90 days",
  all: "all time",
};

// The model family carrying the most cost in a row's breakdowns, or null when
// the row has no spend.
export function topModelFamily(breakdowns: ModelBreakdown[]): string | null {
  const totals: Record<string, number> = {};
  for (const bd of breakdowns) {
    const fam = normalizeModelName(bd.modelName);
    totals[fam] = (totals[fam] ?? 0) + bd.cost;
  }
  let best: string | null = null;
  let bestCost = 0;
  for (const [fam, cost] of Object.entries(totals)) {
    if (cost > bestCost) {
      best = fam;
      bestCost = cost;
    }
  }
  return best;
}
