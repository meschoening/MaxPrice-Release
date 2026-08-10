import type { DailyRow } from "@maxprice/shared";
import { isoFromDate, ymdToParts } from "./dates";

// Daily-row densification — a neutral helper shared by the chart's data-source
// seam (`chart-source.ts`), `useChartWindow`'s chart window, and the list-page
// strips (`Projects.tsx`). It lives here rather than in `chart-source.ts` so
// those non-chart consumers don't import from a module whose docblock calls it
// "the ONE data-source seam" (architecture review 2026-07-18, finding #6).

// The engine omits zero-spend days. The chart's position-aligned ghost overlay
// needs both arrays at the same length — Nth bucket = Nth day from the start
// of the window — so we densify here: walk the expected date range, take the
// real row if present, else synthesize a zero row at that date.
//
// The day count is derived from a UTC diff (UTC days are always 86_400_000 ms,
// no DST) and each date is built by index, so the array length is a pure
// function of the two ymd strings — never longer or shorter across a DST
// transition, which would otherwise silently disable the ghost overlay via
// composed-series' `prevRows.length === n` guard.
export function densifyDays(rows: DailyRow[], startYmd: string, endYmd: string): DailyRow[] {
  const byDate = new Map<string, DailyRow>(rows.map((r) => [r.date, r]));
  const s = ymdToParts(startYmd);
  const e = ymdToParts(endYmd);
  const dayCount =
    Math.round((Date.UTC(e.year, e.month, e.day) - Date.UTC(s.year, s.month, s.day)) / 86_400_000) +
    1;
  const out: DailyRow[] = [];
  for (let i = 0; i < dayCount; i++) {
    // new Date(y, m, d + i) normalizes day overflow into calendar dates.
    const iso = isoFromDate(new Date(s.year, s.month, s.day + i));
    out.push(byDate.get(iso) ?? zeroRow(iso));
  }
  return out;
}

function zeroRow(date: string): DailyRow {
  return {
    date,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    modelsUsed: [],
    modelBreakdowns: [],
  };
}
