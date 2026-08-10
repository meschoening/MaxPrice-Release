import {
  formatWallClock,
  formatWallDateTime,
  type BucketRow,
  type DailyRow,
  type HubMachine,
  type IntradayResponse,
  type TimeDisplay,
} from "@maxprice/shared";
import { foldMachineEntries, type MachineSeriesEntry } from "@/lib/machines";

// Part 5 — T5.4b: the intraday → chart adapter.
//
// The cost chart (`components/cost-chart.tsx`) and its compose step
// (`lib/composed-series.ts`) are written against `DailyRow[]`, treating
// `DailyRow.date` as an OPAQUE label string — never parsed as a calendar date.
// The pipeline uses it two ways: the chart model uses it POSITIONALLY —
// categories are built by index and `date` is only the x-axis display string
// surfaced as each bucket's label. The compose step's project axis
// (`composeSeries`'s `alignBuckets`) additionally uses it as the JOIN KEY
// matching each (sparse) per-project row to a densified x-axis bucket.
//
// `/api/intraday` returns `BucketRow[]`: per-row fields IDENTICAL to `DailyRow`
// except the time key is `bucketStart` (an ISO-8601 instant) instead of `date`
// (a `YYYY-MM-DD` string). So rather than refactoring the chart to accept a
// second row type, T5.4b adapts `BucketRow` → `DailyRow` by projecting
// `bucketStart` onto the `date` slot AS A FORMATTED CLOCK-TIME LABEL — the
// tz-local clock in the user's `timeFormat` (`14:05` or `2:05 PM`, ADR-0060).
// The chart's x-axis then shows readable bucket times.
//
// This is a deliberate, contained renderer-side projection, sanctioned by
// ADR-0013. `DailyRow` is the chart's row INTERFACE; for intraday its `date`
// field carries a clock-time label rather than a calendar date. The wire types
// (`BucketRow`, `IntradayResponse`) stay clean — nothing about the sidecar or
// `packages/shared` changes. Because the by-project join keys on `date`, the
// labels MUST be unique within a window. For the ≤24h spans a bare `HH:mm` is
// unique (buckets are ≥1 min apart and a window is ≤24h). For the ADR-0018 line
// spans `7d` / `30d`, 15-min buckets span MULTIPLE days, so the same `HH:mm`
// recurs each day — those callers pass `withDate`, which prefixes `MM/DD` so
// every bucket across the window keeps a distinct label. NOTE: `MM/DD HH:mm`
// is NOT collision-proof across a DST fall-back — the repeated wall-clock hour
// yields two identical labels for two physically distinct 15-min buckets, which
// the by-project join then merges. This is a known edge (the deep fix — keying
// the join on a monotonic instant rather than the display label — is deferred);
// it only affects the one duplicated wall-clock hour on the autumn DST night.
// ADR-0060's 12h rendering neither creates nor worsens it: within a day
// `h:mm AM/PM` is bijective with `HH:mm`, so the collision COUNT is identical in
// both formats — the deferred debt stays exactly as deferred as it was.
//
// The corollary ADR-0060 does add: because the label is the join key, the two
// sides of that join must be formatted with the SAME `TimeDisplay`. They are —
// both come from `resolveChartSource`'s single `display`, whose `timeFormat`
// rides `use-chart-source`'s memo dep array.

// Format a bucket's ISO-8601 `bucketStart` as a clock label — `"14:05"` /
// `"2:05 PM"`, or `"05/21 14:05"` / `"05/21 2:05 PM"` when `withDate` is set,
// for multi-day line windows. `display` carries BOTH halves of the rendering
// (ADR-0060): the zone — the engine anchors each `bucketStart` to the configured
// Settings tz (ADR-0020), so the label must too or it drifts into the host zone
// — and the 24h/AM-PM shape.
//
// The two hand-rolled tz-keyed `Intl.DateTimeFormat` caches this module used to
// own are gone: `formatWallClock`/`formatWallDateTime` render through the
// equivalent per-zone caches `time-format.ts` owns, shared with every other
// clock surface. That also removes a live hazard — a formatter cache keyed by tz
// ALONE would have handed back a stale-hour-cycle formatter after a `timeFormat`
// flip, so the chart would keep drawing `14:05` until relaunch. Nothing there is
// keyed by format because no formatter there varies by format (both are pinned
// to `hourCycle: "h23"`); only our arithmetic does.
//
// The dated path also dropped a pass: it was two `formatToParts` calls (one
// time, one date) and is now one 4-field call — which costs about what the old
// pair did rather than half (`formatToParts` scales with the field count, not
// the pass count), so the win is one less cache and one less code path, not
// measurably fewer microseconds.
export function bucketTimeLabel(
  bucketStartIso: string,
  withDate: boolean,
  display: TimeDisplay,
): string {
  return withDate
    ? formatWallDateTime(bucketStartIso, display)
    : formatWallClock(bucketStartIso, display);
}

// Adapt one `BucketRow` to the `DailyRow` shape the chart consumes. Every
// per-row field is copied verbatim; only the time key is remapped — `date`
// receives the clock label projected from `bucketStart` (date-bearing when
// `withDate`).
export function bucketRowToDailyRow(
  bucket: BucketRow,
  withDate: boolean,
  display: TimeDisplay,
): DailyRow {
  return {
    date: bucketTimeLabel(bucket.bucketStart, withDate, display),
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheCreationTokens: bucket.cacheCreationTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    totalTokens: bucket.totalTokens,
    totalCost: bucket.totalCost,
    cacheCreationCost: bucket.cacheCreationCost,
    cacheReadCost: bucket.cacheReadCost,
    outputCost: bucket.outputCost,
    modelsUsed: bucket.modelsUsed,
    modelBreakdowns: bucket.modelBreakdowns,
  };
}

// Adapt a `BucketRow[]` (a densified intraday window) to `DailyRow[]`. Zero
// buckets pass straight through — their all-zero counts and empty breakdowns
// are already a valid zero `DailyRow`. `withDate` propagates to every label.
export function bucketRowsToDailyRows(
  buckets: BucketRow[],
  withDate: boolean,
  display: TimeDisplay,
): DailyRow[] {
  return buckets.map((b) => bucketRowToDailyRow(b, withDate, display));
}

// Adapt `IntradayResponse.byProject` (`Record<slug, { path, buckets,
// previousBuckets }>`) to the `Record<slug, { path, rows }>` map
// `composeSeries` accepts for the project axis. Slug keys and `path` are
// carried through unchanged; `withDate` propagates so multi-day project rows
// keep unique join labels. `which` selects the window: the current `buckets`
// (default) or the ADR-0034 per-project ghost `previousBuckets`.
export function intradayByProjectToProjectData(
  byProject: IntradayResponse["byProject"],
  withDate: boolean,
  display: TimeDisplay,
  which: "buckets" | "previousBuckets" = "buckets",
): Record<string, { path: string; rows: DailyRow[] }> {
  const out: Record<string, { path: string; rows: DailyRow[] }> = {};
  for (const [slug, entry] of Object.entries(byProject)) {
    out[slug] = { path: entry.path, rows: bucketRowsToDailyRows(entry[which], withDate, display) };
  }
  return out;
}

// Adapt `IntradayResponse.byMachine` to the alias-folded, named machineData map
// `composeSeries` consumes (ADR-0041 M6). Each entry's BucketRow[] (and its
// nested per-project sub-map, when the project axis is on) is adapted exactly
// like the top-level window; alias ids then fold into their directory targets
// (lib/machines.ts). `which` selects the current window (default) or the
// per-machine ghost grids ("previousBuckets").
export function intradayByMachineToMachineData(
  byMachine: NonNullable<IntradayResponse["byMachine"]>,
  directory: HubMachine[],
  selfId: string,
  withDate: boolean,
  display: TimeDisplay,
  which: "buckets" | "previousBuckets" = "buckets",
): Record<string, MachineSeriesEntry> {
  const raw: Record<
    string,
    { rows: DailyRow[]; projects?: Record<string, { path: string; rows: DailyRow[] }> }
  > = {};
  for (const [machineId, entry] of Object.entries(byMachine)) {
    const adapted: (typeof raw)[string] = {
      rows: bucketRowsToDailyRows(entry[which], withDate, display),
    };
    if (entry.byProject) {
      adapted.projects = {};
      for (const [slug, p] of Object.entries(entry.byProject)) {
        adapted.projects[slug] = {
          path: p.path,
          rows: bucketRowsToDailyRows(p[which], withDate, display),
        };
      }
    }
    raw[machineId] = adapted;
  }
  return foldMachineEntries(raw, directory, selfId);
}
