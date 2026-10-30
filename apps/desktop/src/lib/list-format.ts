import { MODEL_COLORS, ymdShift, ymdToParts } from "@maxprice/shared";

// Shared formatting helpers for the Part 4 list views.

// A project with no activity in this many days renders dimmed with a "stale Nd"
// pill. Informational only — stale rows are never hidden or reordered.
export const STALE_DAYS = 90;

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

// The CSS color (a glass-token var() ref) for a normalized model family —
// for inline badges.
export function familyColor(family: string): string {
  return MODEL_COLORS[family as keyof typeof MODEL_COLORS] ?? MODEL_COLORS.Unknown;
}
