// Shared YYYYMMDD / ISO date math. Date-range params are YYYYMMDD while daily
// rows carry YYYY-MM-DD; the renderer constantly converts between the
// two and shifts dates relative to today. All of that lives here so the date
// arithmetic can't drift between call sites — an off-by-one near midnight for
// non-UTC users is the failure mode this module exists to prevent.

import { msSinceMidnightOf, tzClockParts } from "@maxprice/shared";

export type YmdParts = { year: number; month: number; day: number };

// `ymdShift`'s tz branch runs on the chart hot path (~4x/render with a
// Timezone setting configured); a fresh `Intl.DateTimeFormat` per call is a
// hot-path waste. Cache one formatter per tz — options are constant literals,
// so a tz-keyed cache is output-preserving. Mirrors `timeFormatters` /
// `dateFormatters` in `intraday-adapter.ts`.
const todayInTzFormatters = new Map<string, Intl.DateTimeFormat>();

function todayInTzFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = todayInTzFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    todayInTzFormatters.set(tz, fmt);
  }
  return fmt;
}

// Parse a YYYYMMDD string into numeric components. `month` is 0-indexed to
// match the JS Date constructor.
export function ymdToParts(ymd: string): YmdParts {
  return {
    year: Number(ymd.slice(0, 4)),
    month: Number(ymd.slice(4, 6)) - 1,
    day: Number(ymd.slice(6, 8)),
  };
}

// YYYYMMDD shifted by N days from today. With no `tz`, "today" is the host
// machine's local calendar date — the original behavior, kept byte-identical so
// existing callers/tests are unaffected. With an explicit IANA `tz`, "today" is
// the calendar date in that zone, so the window edges line up with the engine's
// tz-aware day bucketing (`localDate(event, tz)`): when the configured Timezone
// setting differs from the host zone, host-local window edges would otherwise
// exclude the most-recent tz-day's events or admit an extra host-day (f8). The
// N-day shift goes through `Date.UTC(...)` arithmetic — UTC days are exactly
// 86_400_000 ms — so the result is DST-safe regardless of zone.
export function ymdShift(days: number, tz?: string): string {
  if (tz === undefined) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}${m}${day}`;
  }
  // "Today" in the configured zone — en-CA renders as YYYY-MM-DD, mirroring the
  // engine's `localDate` formatter. Slice to numeric Y/M/D, then shift via UTC
  // math and reformat to dashless YYYYMMDD. Formatter is cached per tz above.
  const todayInTz = todayInTzFormatter(tz).format(Date.now());
  const year = Number(todayInTz.slice(0, 4));
  const month = Number(todayInTz.slice(5, 7));
  const day = Number(todayInTz.slice(8, 10));
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

// "20260518" -> "2026-05-18". Pure string reshaping, no Date involved.
export function isoFromYmd(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

// The `all` date-range preset resolves to NO bounds at all (ADR-0068), so the
// rail's readout has no window to render. This derives a display-only range
// from the data itself, so that preset reads in the same shape as every other.
//
// The start is the earliest `firstActivity` — the one field a ProjectRow scopes
// to all history rather than to the window (ADR-0068), and so exactly the
// "since when has any of this existed" the unbounded preset is asking.
//
// The end is today, EXCEPT where a row records activity later than that. `all`
// deliberately admits future-dated events — a clock-skewed fleet peer produces
// them, which is why `resolveDateRange` stopped pinning `until` to today — and
// a readout ending at today would misstate a window that contains them.
//
// Returns undefined when no row carries a `firstActivity` (none fetched yet, or
// every row omits the optional field), leaving the caller to fall back to a
// plain label rather than invent a date. Row columns are dashed YYYY-MM-DD and
// `today` is dashless YYYYMMDD (`ymdShift`); both bounds come back dashless,
// matching what a bounded preset would have produced. Zero-padding makes both
// forms lexicographically ordered, so string compare IS date compare.
export function corpusExtent(
  rows: Array<{ firstActivity?: string; lastActivity: string }>,
  today: string,
): { since: string; until: string } | undefined {
  let since: string | undefined;
  let until = today;
  for (const row of rows) {
    // Guards the empty string as well as absence: the engine seeds a fresh
    // bucket's date columns with "" before the first event folds in.
    const first = row.firstActivity?.replaceAll("-", "");
    if (first && (since === undefined || first < since)) since = first;
    const last = row.lastActivity.replaceAll("-", "");
    if (last && last > until) until = last;
  }
  return since === undefined ? undefined : { since, until };
}

// "20260518" -> a local-time Date at midnight.
export function ymdToDate(ymd: string): Date {
  const { year, month, day } = ymdToParts(ymd);
  return new Date(year, month, day);
}

// Date -> "YYYY-MM-DD" using local components (matches the date strings on
// daily rows).
export function isoFromDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Milliseconds elapsed since local midnight at instant `now` (epoch-ms) in the
// IANA `tz`, or the host zone when `tz` is omitted (mirroring `ymdShift`). This
// is the renderer's tz-local "how far into the day are we" — the same quantity
// the engine derives server-side as `nowClock.msSinceMidnight` — and it drives
// the adaptive `today`-line granularity (ADR-0022): `todayLineBucketMs` reads it
// to pick a finer bucket just after midnight. Resolution is whole seconds (the
// wall-clock H:M:S from `Intl`), which is ample for choosing a 1-to-15-minute
// bucket; the rung only matters, and a sub-second remainder never changes it.
//
// Delegates to the shared tz-local wall-clock primitive (`tzClockParts` +
// `msSinceMidnightOf`, `packages/shared/src/tz-clock.ts`) — the same formatter
// the engine's `localClock` uses — so the two sides can't drift, and the
// per-zone formatter is cached rather than rebuilt every render. `hourCycle:
// "h23"` there already yields a 0–23 hour, so the old `% 24` midnight fold is a
// no-op and is dropped.
export function msSinceLocalMidnight(now: number, tz?: string): number {
  return msSinceMidnightOf(tzClockParts(now, tz));
}
