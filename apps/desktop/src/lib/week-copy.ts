import {
  formatWallClock,
  formatWallDayMonth,
  tzClockParts,
  type TimeDisplay,
  type WeekWindow,
} from "@maxprice/shared";

// The This-week tile's and the rail's copy for the resolved Week (ADR-0083).
// Pure: the window, the rolling start date, and the TimeDisplay are the whole
// input, so these are the tested half of Task 7 — `use-live-data` and the tile
// have no test rig. Every clock reads through the ADR-0060 formatters; the
// weekday and month names are literal English tables like the formatters'
// own (the chrome is English-only — never `toLocale*`).

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The tile's window tag.
//   rolling  ⇒ "Sat Aug 22 → now"        (`rollingStart`: the window's first
//               local date, YYYY-MM-DD — the WINDOW's, never the first row's:
//               the engine omits zero-spend days, so a quiet weekend made the
//               tile read "Mon Aug 24 → now" for a week that began Saturday)
//   anchored ⇒ "Thu Aug 27 08:30 → now"  (the anchor instant; the MODE word
//               rides the eyebrow instead — see `weekEyebrowTag`)
export function weekTag(
  w: WeekWindow,
  rollingStart: string | undefined,
  display: TimeDisplay,
): string {
  if (w.kind === "anchored") {
    return `${weekdayOf(w.startMs, display.tz)} ${formatWallDayMonth(w.startMs, display)} ${formatWallClock(w.startMs, display)} → now`;
  }
  if (!rollingStart) return "";
  const [y, m, d] = rollingStart.split("-").map(Number);
  if (!y || !m || !d) return "";
  // A calendar date, not an instant: UTC arithmetic on the civil triple keeps
  // the weekday zone-free (the date is already the Timezone setting's day).
  const day = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[day.getUTCDay()]} ${MONTHS[m - 1]} ${d} → now`;
}

// The eyebrow's suffix: the Week MODE beside "This week", so the sub-line can
// stay a bare range where it sits (next to the weekly limit meter in the wide
// row). Rolling weeks carry no suffix.
//   limitReset ⇒ "since reset"   custom ⇒ "custom"   rolling ⇒ null
export function weekEyebrowTag(w: WeekWindow): string | null {
  if (w.kind !== "anchored") return null;
  return w.mode === "limitReset" ? "since reset" : "custom";
}

// The delta chip's reference label.
export function weekRefLabel(w: WeekWindow): string {
  return w.kind === "anchored" ? "prior week to date" : "prior 7d";
}

// The rail's date-range readout for the `week` preset: a rolling week keeps the
// rail's own "Aug 22, 2026 – Aug 28, 2026"; an anchored one reads
// "Aug 27, 08:30 → now".
export function weekReadout(w: WeekWindow, display: TimeDisplay, rollingReadout: string): string {
  if (w.kind !== "anchored") return rollingReadout;
  return `${formatWallDayMonth(w.startMs, display)}, ${formatWallClock(w.startMs, display)} → now`;
}

// Settings › Data › Week's hint line: the RESOLVED start, so the control is
// self-verifying — the seg names the rule, this states what it currently means.
//   rolling            ⇒ "This week is the last 7 days."
//   rolling + fallback ⇒ "No weekly reset reading yet — showing the last 7 days."
//   anchored           ⇒ "This week started Thu Aug 27, 08:30."
export function weekStartHint(w: WeekWindow, display: TimeDisplay): string {
  if (w.kind !== "anchored") {
    return w.fallback
      ? "No weekly reset reading yet — showing the last 7 days."
      : "This week is the last 7 days.";
  }
  return `This week started ${weekdayOf(w.startMs, display.tz)} ${formatWallDayMonth(w.startMs, display)}, ${formatWallClock(w.startMs, display)}.`;
}

// The tz-local weekday of an instant. `tzClockParts` carries no weekday, so it
// is derived from the local civil date the same way `resolveWeekWindow`'s
// `lastOccurrence` does — Date.UTC on the triple, then `getUTCDay`.
function weekdayOf(instant: number, tz: string | undefined): string {
  const p = tzClockParts(instant, tz);
  return WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()] ?? "?";
}
