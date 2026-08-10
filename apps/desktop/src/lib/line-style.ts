import { DAY_MS, lineGranularityFor, SPAN_WINDOW_MS, todayLineBucketMs } from "@maxprice/shared";
import type { ChartStyle, Span } from "@/state/filters";
import { msSinceLocalMidnight } from "./dates";

// ADR-0018: the line chart styles (`cumulative` / `trend`) draw a fine 15-min
// bucket on every span, so they always read from the `/api/intraday` data
// source — even for `7d` / `30d` — at the size `lineBucketMsFor` picks (the
// 15-min floor, or the adaptive `today` size; ADR-0022). Bars are unchanged:
// they keep the ADR-0013 routing (native per-span bucket).
export function isLineStyle(style: ChartStyle): boolean {
  return style !== "bars";
}

// 15-min line buckets only need a date-bearing axis label past a 24h window
// (a bare HH:mm recurs each day on `7d` / `30d` and would collide as a join
// key). Deliberately excludes `today` (`SPAN_WINDOW_MS["today"] === DAY_MS`, its
// maximum — a single calendar day stays a bare HH:mm axis; ADR-0020).
export function lineLabelsNeedDate(span: Span): boolean {
  return SPAN_WINDOW_MS[span] > DAY_MS;
}

// The line-style bucket size for a span. Every span uses the ADR-0018 15-min
// floor EXCEPT `today`, whose window grows from local midnight (ADR-0020): there
// the bucket is adaptive (ADR-0022) — finer just after midnight, converging to
// the 15-min floor as the day fills out. The wall clock (default `Date.now()`,
// read in the Settings `tz`) tells us how far into the local day we are. No
// timer drives this: the bucket is recomputed on each render, so the resolution
// steps to a coarser rung on the next refetch after a threshold (the
// inherit-refetch cadence ADR-0020 established for the whole `today` span).
function lineBucketMsFor(span: Span, opts?: TodayClock): number {
  if (span === "today") {
    return todayLineBucketMs(msSinceLocalMidnight(opts?.now ?? Date.now(), opts?.tz));
  }
  return lineGranularityFor(span);
}

// The Settings `tz` and an optional pinned `now` (epoch-ms) the `today` adaptive
// bucket reads. `now` defaults to `Date.now()`; tests pass a fixed instant.
export type TodayClock = { tz?: string; now?: number };

// The consolidated intraday line-request derivation shared by the model and
// by-project intraday charts: for a line style, request the line bucket for the
// span (`bucketMs` — the 15-min floor, or the adaptive `today` size; ADR-0022)
// and a date-bearing label past 24h (`withDate`); bars keep the native per-span
// bucket (`bucketMs` omitted) and bare HH:mm labels.
//
// For the `today` span the `clock` arg is LOAD-BEARING — it carries the request
// `tz` and pins `now` for tests; omitting it falls back to host-zone
// `Date.now()` (and an undefined `tz`), a silent behavior change from the
// pre-ADR-0022 deterministic 15-min bucket. Every other span ignores `clock`.
export function lineRequestFor(
  span: Span,
  chartStyle: ChartStyle,
  clock?: TodayClock,
): { bucketMs: number | undefined; withDate: boolean } {
  const line = isLineStyle(chartStyle);
  return {
    // `block` never sends a bucketMs — the sidecar supplies the constant
    // `BLOCK_BUCKET_MS` for BOTH styles (ADR-0046, pinning ADR-0031's adaptive
    // rung — the one exception to renderer-owned policy).
    bucketMs: line && span !== "block" ? lineBucketMsFor(span, clock) : undefined,
    withDate: line && lineLabelsNeedDate(span),
  };
}
