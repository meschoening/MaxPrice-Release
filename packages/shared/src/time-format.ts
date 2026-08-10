import { z } from "zod";
import { tzClockParts, type TzClockParts } from "./tz-clock";

// Single source of truth for rendering a WALL CLOCK to the user (ADR-0060).
//
// Read this next to `tz-clock.ts`, which is the source of truth for READING a
// wall clock. The two are deliberately separate vocabularies:
//
//   tz-clock.ts  ARITHMETIC — an instant's tz-local Y/M/D H:M:S as NUMBERS.
//                `hourCycle: "h23"` is PINNED and load-bearing: the engine's
//                `localDate`/`localClock` bucket every daily total through that
//                same formatter. It must NEVER follow the user's `timeFormat`.
//   time-format  PRESENTATION — those numbers rendered to a STRING a human
//                reads. This is the only module in the app that knows the words
//                "AM" and "PM".
//
// Every formatter here reads its numbers from an `Intl` parts pass, so a clock
// time cannot be rendered without naming its zone, and the 12/24 conversion is
// pure arithmetic on the 0–23 hour. The two hottest entry points
// (`formatWallClock`, `formatWallDateTime` — the chart's bucket labels) read
// theirs from NARROW per-zone formatters owned by this module rather than from
// `tzClockParts`, because `formatToParts` cost scales with the number of
// REQUESTED FIELDS; see `clockFormatterFor` below. The composite formatters
// (`formatWallClockSeconds`, `formatAbsoluteTimestamp`, `formatWallDayMonth`)
// genuinely need month/second/year and stay on `tzClockParts`.
//
// WHY THE DAY PERIOD IS NOT TAKEN FROM `Intl`
// -------------------------------------------
// `Intl` will happily produce "2:05 PM" via `hourCycle: "h12"`. We don't use it,
// because the separator before the marker is ICU-version-dependent: Bun's ICU
// emits U+0020 (verified), while Chromium >= 110 — i.e. the WebView2 / WKWebView
// the renderer actually ships in — emits U+202F NARROW NO-BREAK SPACE for en-US.
// Tests run under Bun and the app runs in the WebView, so an Intl-derived marker
// makes those two environments disagree over an invisible character: an
// assertion passes in CI-equivalent local runs while the shipped app renders a
// string that isn't equal to it. Deriving the marker ourselves makes the output
// a pure function of the numbers, identical everywhere.

export const timeFormatSchema = z.enum(["24h", "12h"]);
export type TimeFormat = z.infer<typeof timeFormatSchema>;

// How a clock time is rendered: WHICH ZONE (`tz`, the Settings timezone —
// `undefined` means the host zone, mirroring `tzClockParts`) and IN WHAT SHAPE
// (`timeFormat`).
//
// Deliberately NOT named `*Clock`: `chart-source.ts` already exports
// `TodayClock = { tz?, now? }`, which is the ARITHMETIC clock (window math, the
// midnight anchor, the adaptive line bucket) and must never learn about
// `TimeFormat`. Two names, two vocabularies, no overlap.
//
// `timeFormat` is REQUIRED, with no default anywhere in this module. A clock
// site that forgets to thread the setting is then a type error rather than a
// surface that silently renders 24h forever — `tsc --noEmit` is what proves
// every clock in the app is wired.
export type TimeDisplay = {
  tz?: string;
  timeFormat: TimeFormat;
};

// The time-format option table — the single source of truth for the Settings
// seg control, mirroring `COST_MODE_OPTIONS`. The hints double as the format's
// own worked example, which is why they carry a literal time rather than prose.
export const TIME_FORMAT_OPTIONS: ReadonlyArray<{
  value: TimeFormat;
  label: string;
  hint: string;
}> = [
  { value: "24h", label: "24h", hint: "Times read 14:05." },
  { value: "12h", label: "AM/PM", hint: "Times read 2:05 PM." },
];

// The host's preferred hour cycle, as a TimeFormat. Seeds `settings.timeFormat`,
// following the `settings.timezone` precedent — but NOT as exactly as that
// phrasing suggests: `fetchSettings` persists a seeded default only when
// `settings.json` is absent or empty, so on a file written before ADR-0060 this
// is re-derived on EVERY launch until some setting is written. Only a
// `settings.json` written after that ADR carries an explicit `timeFormat`.
// Accepted rather than fixed — see ADR-0060 decision 6.
//
// GOTCHA: `resolvedOptions().hourCycle` is only populated when an hour field was
// requested. A bare `new Intl.DateTimeFormat().resolvedOptions().hourCycle` is
// `undefined` on every runtime — the `{ hour: "numeric" }` below is load-bearing,
// not decorative.
//
// `h11`/`h12` are the two 12-hour cycles (they differ only in whether midnight
// is 0 or 12, which our own arithmetic decides anyway); `h23`/`h24` are the
// 24-hour pair. Anything unrecognized falls back to 24h.
export function hostTimeFormat(): TimeFormat {
  try {
    const cycle = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions()
      .hourCycle;
    return cycle === "h11" || cycle === "h12" ? "12h" : "24h";
  } catch {
    return "24h";
  }
}

// ---------------------------------------------------------------------------
// Narrow per-zone formatter caches
// ---------------------------------------------------------------------------
//
// `Intl.DateTimeFormat.formatToParts` costs roughly in proportion to the number
// of fields REQUESTED, not to the number of passes: measured on one cached
// instance, a 2-field format is ~3.1µs, 4-field ~4.9µs, 6-field ~6.5µs. So
// routing the chart's bucket labels through the six-field `tzClockParts` made
// them SLOWER (undated ~2.5µs -> ~7.5µs), even though it removed a second pass
// from the dated path. The chart re-labels every bucket on every SSE-driven
// recompute, and the worst realistic window (a 30d line span with the project
// axis and the ghost on, ~35k labels) turns that into ~90ms of extra
// synchronous main-thread work per recompute.
//
// So the two hot entry points get their own formatters, requesting exactly the
// fields they render: 2 fields for `formatWallClock`, 4 for
// `formatWallDateTime`. Cache shape mirrors `tz-clock.ts`'s `clockFormatterCache`
// — keyed by ZONE only, so it can only ever hold the finite set of valid IANA
// zones plus the one `undefined` host entry (a fixed ceiling, no cap needed).
//
// A tz-keyed cache carries NONE of the stale-hour-cycle hazard ADR-0060 warns
// about (decision 2, and the consequence bullet on `intraday-adapter`'s deleted
// caches): no formatter in this module varies by `timeFormat`. Both are pinned
// to `hourCycle: "h23"` and hand us a 0–23 hour; the 12-hour face and the AM/PM
// marker are produced by our own arithmetic downstream (`to12`). A format flip
// therefore re-renders through the SAME cached formatter and cannot serve a
// stale hour cycle.
//
// `"en-GB"` is explicit rather than `undefined` for the same reason `tz-clock.ts`
// pins it: an undefined locale follows the host, and a non-Gregorian /
// non-Latin-digit host locale would hand back digits our `Number(...)`
// arithmetic cannot read. We need the 0–23 hour as a NUMBER, not as prose.
const clockFormatterCache = new Map<string | undefined, Intl.DateTimeFormat>();
const dateTimeFormatterCache = new Map<string | undefined, Intl.DateTimeFormat>();

function clockFormatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  let f = clockFormatterCache.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    clockFormatterCache.set(timeZone, f);
  }
  return f;
}

function dateTimeFormatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  let f = dateTimeFormatterCache.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    dateTimeFormatterCache.set(timeZone, f);
  }
  return f;
}

type PartLookup = Partial<Record<Intl.DateTimeFormatPartTypes, string>>;

function lookupOf(formatter: Intl.DateTimeFormat, at: Date): PartLookup {
  const lookup: PartLookup = {};
  for (const p of formatter.formatToParts(at)) lookup[p.type] = p.value;
  return lookup;
}

// ---------------------------------------------------------------------------
// Malformed instants
// ---------------------------------------------------------------------------
//
// `Intl.DateTimeFormat.formatToParts` THROWS (`RangeError: date value is not
// finite`) for anything `Date` can't parse — `NaN`, `Infinity`, "not-a-date".
// No call site can reach that today (the sidecar drops unparseable events before
// they reach a report), but this module is documented as the single source of
// truth for five user-facing clock surfaces and `apps/desktop` has no React
// error boundary, so one throw during render blanks the window. Every exported
// formatter therefore goes through this guard and answers with an em dash.
//
// The guard lives HERE and not in `tz-clock.ts`: that module's `tzClockParts` is
// the engine's per-event hot path, where a NaN branch would be dead weight on
// every record parsed.
//
// (`usage-connection-section.tsx` hand-rolls its own check because it falls back
// to the RAW STRING rather than an em dash — an intentional difference.)
const NO_TIME = "—";

function validInstant(instant: number | string | Date): Date | null {
  const d = new Date(instant);
  return Number.isNaN(d.getTime()) ? null : d;
}

function partsOrNull(instant: number | string | Date, tz: string | undefined): TzClockParts | null {
  const d = validInstant(instant);
  return d === null ? null : tzClockParts(d, tz);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// A 0–23 hour split into its 12-hour face and marker. `hour % 12 || 12` is the
// whole trick, and the two values it gets right that a naive `hour % 12` does
// not are midnight (0 -> 12 AM) and noon (12 -> 12 PM, not 0 PM).
function to12(hour: number): { h: number; marker: "AM" | "PM" } {
  return { h: hour % 12 || 12, marker: hour < 12 ? "AM" : "PM" };
}

// Render tz-local wall-clock numbers as a clock string. THE one place the
// 24h/12h shape is decided — every clock this module emits routes through here,
// so "no leading zero on the 12-hour face, seconds on the numeric face, marker
// last, joined with a plain ASCII space" is stated exactly once.
//   24h -> "14:05" / "09:07" / "00:00"   (zero-padded, the existing app-wide look)
//   12h -> "2:05 PM" / "9:07 AM" / "12:00 AM"  (no leading zero; "09:07 AM" reads wrong)
// `second` is optional: omitted for a bare clock, supplied by the per-message
// surfaces that need "14:05:33" / "2:05:33 PM" (never "2:05 PM:33").
// The marker is joined with a plain ASCII space — see the module header.
function clockOf(hour: number, minute: number, fmt: TimeFormat, second?: number): string {
  const secs = second === undefined ? "" : `:${pad2(second)}`;
  if (fmt === "24h") return `${pad2(hour)}:${pad2(minute)}${secs}`;
  const { h, marker } = to12(hour);
  return `${h}:${pad2(minute)}${secs} ${marker}`;
}

// An instant as a clock time — "14:05" / "2:05 PM". The app's default clock
// rendering; every bare time-of-day goes through here. Reads the 2-field narrow
// formatter (this is the chart's per-bucket label path).
export function formatWallClock(instant: number | string | Date, display: TimeDisplay): string {
  const at = validInstant(instant);
  if (at === null) return NO_TIME;
  const lookup = lookupOf(clockFormatterFor(display.tz), at);
  return clockOf(Number(lookup.hour), Number(lookup.minute), display.timeFormat);
}

// An instant as a dated clock label — "05/21 14:05" / "05/21 2:05 PM". The
// multi-day chart windows use this so buckets from different days keep distinct
// labels (the label doubles as the series join key — see intraday-adapter).
// `MM/DD` is numeric and zero-padded in both formats: this is a compact axis
// prefix, not prose. Reads the 4-field narrow formatter.
export function formatWallDateTime(instant: number | string | Date, display: TimeDisplay): string {
  const at = validInstant(instant);
  if (at === null) return NO_TIME;
  const lookup = lookupOf(dateTimeFormatterFor(display.tz), at);
  const clock = clockOf(Number(lookup.hour), Number(lookup.minute), display.timeFormat);
  return `${pad2(Number(lookup.month))}/${pad2(Number(lookup.day))} ${clock}`;
}

// An instant as a clock time carrying seconds — "14:05:33" / "2:05:33 PM".
// Only the per-message surfaces want this: the session timeline orders events
// within a minute, so dropping seconds there loses real information. Stays on
// `tzClockParts` — it needs a field the narrow formatters don't request.
export function formatWallClockSeconds(
  instant: number | string | Date,
  display: TimeDisplay,
): string {
  const parts = partsOrNull(instant, display.tz);
  if (parts === null) return NO_TIME;
  return clockOf(parts.hour, parts.minute, display.timeFormat, parts.second);
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

// A calendar day as "May 21" — the day half of a block's window label. No clock
// time at all, so `display.timeFormat` is deliberately unread; it still takes a
// whole `TimeDisplay` so every date/clock site in the app threads ONE value
// rather than choosing between two near-identical parameter shapes.
//
// This exists so `Blocks.tsx` doesn't reach for `toLocaleDateString`, which is
// wrong twice over: its month name follows the HOST locale (a de-DE host would
// render "14. Mai" beside English tooltips — the app's chrome is English-only,
// per ADR-0060 decision 2), and an options-bearing call constructs a FRESH
// `Intl.DateTimeFormat` every time (~60µs vs ~1µs cached) on a path that runs
// per rendered row against a 60s now-tick.
export function formatWallDayMonth(instant: number | string | Date, display: TimeDisplay): string {
  const parts = partsOrNull(instant, display.tz);
  if (parts === null) return NO_TIME;
  return `${MONTHS[parts.month - 1] ?? "?"} ${parts.day}`;
}

// A human absolute timestamp — "May 21 2026, 2:05:33 PM" / "May 21 2026, 14:05:33".
// This is what the hover tooltips show beside a relative label ("3h ago"): the
// tooltip is the ONLY absolute reading those surfaces offer, so it answers in
// the user's zone and format rather than in raw UTC ISO.
//
// The YEAR is always present, never elided for the current year. It replaced a
// raw UTC ISO title that carried one, the surfaces that show it label the row
// RELATIVELY ("412d ago"), and the all-time range reaches years-old sessions —
// so this string is the only place the year can be read. Always-on also keeps
// the function pure: a "this year" elision would need a `now` seam.
//
// The month name is a literal table rather than an `Intl` month part, for the
// same reason the day period is: the string must not vary between the test
// runtime and the WebView. The app's chrome is English-only throughout.
export function formatAbsoluteTimestamp(
  instant: number | string | Date,
  display: TimeDisplay,
): string {
  const parts = partsOrNull(instant, display.tz);
  if (parts === null) return NO_TIME;
  const month = MONTHS[parts.month - 1] ?? "?";
  const clock = clockOf(parts.hour, parts.minute, display.timeFormat, parts.second);
  return `${month} ${parts.day} ${parts.year}, ${clock}`;
}
