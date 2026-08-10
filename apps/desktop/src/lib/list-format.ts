import { MODEL_COLORS, normalizeModelName, type ModelBreakdown } from "@maxprice/shared";
import type { DateRangePreset } from "@/state/filters";
import { ymdShift, ymdToParts } from "@/lib/dates";

// Shared formatting helpers for the Part 4 list views.

// A project with no activity in this many days renders dimmed with a "stale Nd"
// pill. Informational only — stale rows are never hidden or reordered.
export const STALE_DAYS = 90;

export function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

// Whole calendar-day age of a YYYY-MM-DD date, measured in the configured
// Timezone. `lastActivity` is a tz-local calendar date (engine `localDate(…)`),
// so the diff anchors to that same zone's "today" (via `ymdShift(0, tz)`) — a
// plain `Date.parse` on a bare YYYY-MM-DD reads it as UTC midnight and diffs it
// against an absolute `Date.now()`, which slips by a day near the local
// boundary. Both dates are reduced to numeric Y/M/D and diffed through
// `Date.UTC(…)`, used purely as a DST-free arithmetic frame. Null for a missing
// / unparseable date.
export function daysSince(isoDate: string, tz: string | undefined): number | null {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const activity = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const { year, month, day } = ymdToParts(ymdShift(0, tz));
  const today = Date.UTC(year, month, day);
  return Math.max(0, Math.floor((today - activity) / 86_400_000));
}

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

// The CSS color (a glass-token var() ref) for a normalized model family —
// for inline badges.
export function familyColor(family: string): string {
  return MODEL_COLORS[family as keyof typeof MODEL_COLORS] ?? MODEL_COLORS.Unknown;
}

// Human label for each date-range preset — "Sessions · all time", the
// aggregate strip's "296 sessions · all time", etc. Moved here from Topbar.tsx
// (ADR-0016) so the strip and the topbar share one copy.
export const RANGE_LABEL: Record<DateRangePreset, string> = {
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
  all: "all time",
};
