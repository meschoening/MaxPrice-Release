import { z } from "zod";
import { windowSourceSchema } from "./blocks";
import { modelBreakdownSchema } from "./models";

// Part 5 — T5.4a: the `/api/intraday` wire contract.
//
// The Live view's cost chart has span tabs `15m / 1h / block / today / 7d / 30d`.
// The two day-granular spans (`7d`, `30d`) are served by `/api/daily` — its
// `DailyRow.date` is `YYYY-MM-DD` and its `since`/`until` are `YYYYMMDD`, so
// it can only express whole-day windows. The four intraday spans that shipped
// in Parts 2–4 (`15m`/`1h`/`6h`/`24h` — `24h` since renamed `today`, ADR-0020)
// shipped disabled because there was no sub-day data path.
//
// This module is that path's frozen contract: a NEW endpoint (`/api/intraday`)
// rather than a parameterization of `/api/daily`, with its own row shape keyed
// by an ISO-8601 `bucketStart` instead of a `YYYY-MM-DD` `date`. T5.4b (the
// renderer half) builds the span tabs + chart against exactly these schemas.
//
// WHY A SEPARATE ENDPOINT, NOT A `/api/daily` PARAMETER.
// `/api/daily` reproduces a captured golden byte-for-byte. Intraday has no
// golden equivalent: the corpus has no sub-day report. Folding minute-granular
// buckets into `/api/daily` would either break that golden or fork its
// handler. A clean new surface keeps the daily golden untouched. (Both
// endpoints filter the model axis at the store level — ADR-0017 retired
// daily's old post-aggregation quirk; intraday always filtered cleanly.)

// ---------------------------------------------------------------------------
// Span definitions — FIXED by the UI mock (`plans/mocks/index.html`'s `SPANS`)
// ---------------------------------------------------------------------------

// The intraday span identifiers — the spans whose BARS are served by
// `/api/intraday` rather than `/api/daily`. `7d` / `30d` are NOT intraday (their
// bars remain `/api/daily`). Two are `now`-relative rolling windows
// (`15m`/`1h`); `today` is the calendar-day window anchored to local
// midnight in the request `tz`, growing to `now` (ADR-0020); `block` frames the
// active 5-hour quota window, growing from the block's start to `now`
// (ADR-0031). `block` has no `INTRADAY_SPANS` entry because its WINDOW (and
// therefore its bucket count) is dynamic, not because its bucket size is
// adaptive — the sidecar supplies the constant `BLOCK_BUCKET_MS` as the
// `aggregateBlockSpan` default (ADR-0031/0046).
export type IntradaySpan = "15m" | "1h" | "block" | "today";

// Each intraday span's bucket duration, plus `bucketCount` — the number of bars
// the chart renders. For the two `now`-relative spans `bucketCount` is FIXED
// and `bucketCount * bucketMs` is the full window length. For `today` the count
// is DYNAMIC (one bar per elapsed local hour, midnight→now), so its
// `bucketCount` here is the day's MAXIMUM (24 hourly bars); the real count is
// server-computed by `aggregateIntraday` from `now` + `tz` (ADR-0020).
//
// `block` is intentionally ABSENT — its window grows from the active block's
// start (ADR-0031), so it has no fixed bucket COUNT; `INTRADAY_SPANS` can never
// express it. Its bucket SIZE, though, is not adaptive: the sidecar supplies
// the constant `BLOCK_BUCKET_MS` as the `aggregateBlockSpan` default
// (ADR-0046). The Record key type is narrowed to
// `Exclude<IntradaySpan, "block">` to enforce this at compile time.
//
//   span   buckets    bucket duration   window
//   15m    15         1 minute          15 minutes  (now-relative)
//   1h     60         1 minute          1 hour      (now-relative)
//   today  ≤24        1 hour            local midnight → now (calendar day)
//
// `bucketMs` is the bucket duration in milliseconds. ADR-0046 took `1h` from
// 5-minute to 1-minute buckets (12 → 60 bars): every span whose window is at
// most 5 hours now resolves to the minute. `today`'s BARS deliberately stay on
// the calendar hour — one bar per elapsed local hour IS the meaning of the tab
// (ADR-0020), and its LINES carry the fine detail instead (`todayLineBucketMs`).
//
// The rolling counts no longer match the mock's `SPANS`: the mock predates both
// ADR-0031 and ADR-0046 and is not updated retroactively, so it still lists a
// 12-bucket `1h` and a `6h` span where the current code has `block`.
export const INTRADAY_SPANS: Record<
  Exclude<IntradaySpan, "block">,
  { bucketCount: number; bucketMs: number }
> = {
  "15m": { bucketCount: 15, bucketMs: 60_000 },
  "1h": { bucketCount: 60, bucketMs: 60_000 },
  today: { bucketCount: 24, bucketMs: 3_600_000 },
};

// ---------------------------------------------------------------------------
// Generalized span/granularity contract (ADR-0018)
// ---------------------------------------------------------------------------
//
// The bars [[Chart style]] keeps the ADR-0013 model above: the four intraday
// spans bucket at `INTRADAY_SPANS` sizes, `7d`/`30d` are daily-bucketed by
// `/api/daily`. The LINE styles (`cumulative`/`trend`) instead want a fixed
// 15-minute bucket on every span where that is finer, served by `/api/intraday`
// for all six spans. That requires two things `INTRADAY_SPANS` can't express:
// a window length for `7d`/`30d`, and a bucket size decoupled from the span.

// All six chart spans. `7d`/`30d` extend `IntradaySpan` — the endpoint now
// serves them (at a caller-supplied bucket size) for the line path; the name
// "intraday" is kept for historical reasons (ADR-0018).
export type Span = IntradaySpan | "7d" | "30d";

// Endpoint validation for the generalized `span` param — all six spans.
// `/api/intraday` parses its required `span` query param against this; an
// absent or unrecognized value is an HTTP 400.
export const spanSchema = z.enum(["15m", "1h", "block", "today", "7d", "30d"]);

// Each span's TOTAL window length in milliseconds — the `now`-relative range
// the chart covers, independent of bucket size. For the intraday spans with
// fixed buckets this equals `INTRADAY_SPANS[span].bucketCount * bucketMs`;
// `7d`/`30d` extend it. `bucketCount = SPAN_WINDOW_MS[span] / bucketMs`.
// `today` is the calendar-day span (ADR-0020): its REAL window is local
// midnight → now, computed server-side, never a fixed length. The value here is
// its MAXIMUM (a 24-hour day) — kept so consumers that bound bucket counts /
// pick label granularity off this map (`lineLabelsNeedDate` keys
// `> DAY_MS`, so `today` stays a single-day `HH:mm` axis) and the endpoint's
// `bucketMs`-divides-window + max-buckets guards stay valid. `aggregateIntraday`
// does NOT read this for `today` — it derives the dynamic count itself.
// One day in milliseconds — the single source of truth for the day magnitude,
// imported anywhere this constant is independently re-derived (the `today`
// window sentinel below, the renderer's `lineLabelsNeedDate`, the engine's
// calendar-day guard).
export const DAY_MS = 86_400_000;

// The block span's MAXIMUM window length — a full 5-hour quota window
// (ADR-0031). Like `today`, the REAL window is dynamic (block start → now,
// and an annulled block's full extent is under 5h); this value backs the
// bucketMs-divides-window validation and the label-granularity lookups.
export const BLOCK_WINDOW_MS = 5 * 60 * 60_000;

export const SPAN_WINDOW_MS: Record<Span, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  block: BLOCK_WINDOW_MS,
  today: DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

// A hard ceiling on the number of buckets any `/api/intraday` request may
// produce, guarding both the handler (a 400 before the engine runs) and any
// direct `aggregateIntraday` caller (a throw before allocation). Comfortably
// above the legitimate maximum — `30d` at the 15-min line floor is
// `30d / 15min = 2880` buckets — so it only ever rejects pathological
// `bucketMs` values, never a real chart request.
export const MAX_INTRADAY_BUCKETS = 5000;

// The span's native bars bucket size, or `undefined` for `block`/`7d`/`30d`
// (which have no `INTRADAY_SPANS` entry — `block`'s WINDOW is dynamic, so it
// has no fixed bucket count, even though the sidecar pins its bucket SIZE to
// the constant `BLOCK_BUCKET_MS`, ADR-0031/0046; `7d`/`30d` are bars-served by
// `/api/daily`). The `in` check guards the lookup so the cast only narrows the
// key inside the branch where it is sound, instead of a value-defeating cast
// that would hide `undefined` from the caller.
export function nativeBucketMs(span: Span): number | undefined {
  return span in INTRADAY_SPANS
    ? INTRADAY_SPANS[span as Exclude<IntradaySpan, "block">].bucketMs
    : undefined;
}

// The bucket duration the LINE chart styles request for a given span: a
// 15-minute FLOOR — 15 min wherever that is at least as coarse as the span's
// native bars bucket, and the finer native bucket where the span is already
// sub-15-min (`15m`→1min, `1h`→1min — ADR-0046 collapsed the two). Every
// result divides `SPAN_WINDOW_MS` evenly, so `aggregateIntraday` gets a whole
// bucket count.
const LINE_BUCKET_MS = 15 * 60_000;
export function lineGranularityFor(span: Span): number {
  const native = nativeBucketMs(span);
  if (native !== undefined && native < LINE_BUCKET_MS) return native;
  return LINE_BUCKET_MS;
}

// ---------------------------------------------------------------------------
// Adaptive `today`-line granularity (ADR-0022)
// ---------------------------------------------------------------------------
//
// `lineGranularityFor("today")` is the fixed 15-minute LINE floor (ADR-0018).
// But `today` is the one span whose window GROWS through the day — local
// midnight → now (ADR-0020) — so a fixed bucket leaves the curve with one or two
// points just after midnight. `todayLineBucketMs` picks the bucket adaptively.
//
// ADR-0046 raised the detail target from 24 buckets to 300, which reshapes what
// this ladder actually does: `today`'s line now draws at 1 MINUTE for the first
// ~9h58m of the day and 2 minutes thereafter, ending the day at ~721 points
// instead of ~96. The old four-step descent (1→2→5→10→15 min within the first
// six hours) is gone; only the 1- and 2-minute rungs are reachable inside a day
// at this target.
//
// LADDER. Day-dividing "nice" sizes 1/2/5/10/15 min. Every entry divides a day
// (so the engine's `DAY_MS % ms === 0` guard always holds), and every entry is
// ≥ 1 min (so the renderer's bare-`HH:mm` bucket labels stay unique within the
// day — the by-project join key included; ADR-0018). The 5/10/15 rungs are
// deliberately RETAINED though unreachable at the current target: they are the
// day-dividing sizes this policy is allowed to choose, and lowering the target
// must not also require rediscovering them.
const TODAY_LINE_MIN_BUCKET_MS = 60_000; // 1 min — the smallest (finest) ladder rung, used in the wee hours
const TODAY_LINE_LADDER_MS = [
  TODAY_LINE_MIN_BUCKET_MS,
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
];
// The detail target: keep at least this many buckets where the elapsed window
// allows it. Picking the COARSEST rung that still clears this keeps the line as
// readable as possible subject to "never fewer than ~this many points".
//
// ADR-0046 raised this 24 → 300. 300 is not arbitrary: it is the number of
// minutes in the 5-hour `block` window, so `today`'s line matches the `block`
// tab's minute resolution over any comparable stretch of the day rather than
// being an order of magnitude coarser than the tab beside it.
//
// DERIVATION (the single source for the boundary table below + ADR-0022's
// table): a rung of size `ms` first clears the target when
// `todayBucketCount(elapsed, ms) >= TODAY_LINE_TARGET_BUCKETS`, i.e. at
// `elapsed >= (TODAY_LINE_TARGET_BUCKETS - 1) * ms` (= 299·ms for the current
// value of 300). Change this constant or the ladder and every boundary below
// moves with it — they are not independently maintained.
const TODAY_LINE_TARGET_BUCKETS = 300;

// The densified `today` bucket count: how many fixed-width slots of size `ms`
// cover local midnight → `elapsed` ms past it, counting the in-progress slot.
// THE single source for this arithmetic, shared by `todayLineBucketMs` (the
// renderer's line-bucket ladder) and the engine's `aggregateToday`. The two
// must agree byte-for-byte — `aggregateToday` is golden-parity-tested — so they
// call this rather than each inlining `floor(elapsed / ms) + 1`.
export function todayBucketCount(elapsed: number, ms: number): number {
  return Math.floor(elapsed / ms) + 1;
}

// The line bucket size for the `today` span given how far into the local day we
// are (`msSinceMidnight`, the same quantity `aggregateToday` derives as
// `nowClock.msSinceMidnight`). Returns the coarsest ladder rung whose densified
// bucket count (`todayBucketCount`, matching `aggregateToday`) is at least
// `TODAY_LINE_TARGET_BUCKETS`, falling back to the finest 1-min rung early in
// the day when no rung reaches the target yet. Renderer-side policy
// (ADR-0022/0046); the engine is unchanged and just honours the resulting
// `bucketMs`.
//
// The guard + coarsest-rung loop used to live in a helper shared with an
// adaptive `blockBucketMs`; ADR-0046 pinned `block` to a constant minute, so
// this is the app's only adaptive bucket and the selection is inlined rather
// than kept behind a single-caller indirection.
//
//   The boundaries below are ≈ and DERIVED: each rung kicks in at
//   `elapsed ≥ (TODAY_LINE_TARGET_BUCKETS − 1)·ms` (see the DERIVATION note
//   above), so they move automatically if the target/ladder change.
//
//   elapsed since midnight   bucket   points
//   0 – ~9h58m               1 min    1 → 599
//   ~9h58m – midnight        2 min    300 → 721
//
//   Below ~4h59m no rung clears the target at all and the 1-min floor applies;
//   from ~4h59m the 1-min rung clears it outright. Same bucket either way, so
//   the whole day reads as ONE step, at ~9h58m.
export function todayLineBucketMs(msSinceMidnight: number): number {
  // A real elapsed is always ≥ 0; guard a NaN/negative input to the finest rung
  // rather than letting it produce a wild count.
  const elapsed = Number.isFinite(msSinceMidnight) && msSinceMidnight > 0 ? msSinceMidnight : 0;
  let chosen: number = TODAY_LINE_MIN_BUCKET_MS;
  for (const ms of TODAY_LINE_LADDER_MS) {
    if (todayBucketCount(elapsed, ms) >= TODAY_LINE_TARGET_BUCKETS) chosen = ms; // coarsest satisfying rung wins
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// The `block` bucket (ADR-0031, pinned by ADR-0046)
// ---------------------------------------------------------------------------
//
// The `block` span's window grows from the active block's start (ADR-0031), so
// it originally picked an adaptive rung (1→15 min, target 16) to keep a
// minutes-old block from drawing as a single bar. ADR-0046 replaced that ladder
// with a constant MINUTE for both BARS and LINES: the ladder's mature end —
// 15-minute bars on any block older than ~3h45m — was precisely the resolution
// that made the tab too coarse to read.
//
// A block window is at most 5 hours (BLOCK_WINDOW_MS), so a fixed minute is
// statically bounded at 300 buckets. That count is only drawable because the
// renderer switches to its step-area dense mode above ~121 buckets (ADR-0046).
//
// Still applied SIDECAR-side (the `options.bucketMs ??` default in
// `aggregateBlockSpan`) rather than sent by the renderer: a constant could
// travel either way, but keeping the default where the resolved window lives
// leaves `block` the one span whose bucket the server owns, as ADR-0031 had it.
export const BLOCK_BUCKET_MS = 60_000;

// ---------------------------------------------------------------------------
// BucketRow — one time bucket's rollup
// ---------------------------------------------------------------------------

// One intraday time bucket. The per-row fields mirror `DailyRow` (`./daily`)
// exactly — same four token counts, `totalTokens`, `totalCost`, `modelsUsed`,
// `modelBreakdowns` — so the chart's stacking + tooltip code is shared with
// the daily path. The ONLY difference is the time key: `bucketStart` (the
// bucket's start instant, ISO 8601, e.g. `2026-05-21T14:05:00.000Z`) instead
// of `DailyRow.date`'s `YYYY-MM-DD`.
//
// A bucket is emitted even when no events landed in it (densification — see
// `intradayResponseSchema`): a zero-usage bucket has all-zero counts, a `0`
// cost, and empty `modelsUsed` / `modelBreakdowns`.
export const bucketRowSchema = z.object({
  // The bucket's start instant, ISO 8601. The bucket spans
  // `[bucketStart, bucketStart + bucketMs)` for the request's bucket size.
  bucketStart: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  totalTokens: z.number(),
  totalCost: z.number(),
  cacheCreationCost: z.number().optional(),
  cacheReadCost: z.number().optional(),
  // ADR-0040 output slice — additive, same footing as the ADR-0026 cache split.
  outputCost: z.number().optional(),
  modelsUsed: z.array(z.string()),
  modelBreakdowns: z.array(modelBreakdownSchema),
});

export type BucketRow = z.infer<typeof bucketRowSchema>;

// ---------------------------------------------------------------------------
// IntradayResponse — the `/api/intraday` body
// ---------------------------------------------------------------------------

// The `block` span's resolved frame (ADR-0031): the active block's real window
// + its formation provenance (ADR-0028/0029 — same vocabulary as BlockRow's
// windowSource). `null` on the wire means "no active block" (the renderer's
// empty state); non-block spans always carry `null`.
export const blockSpanWindowSchema = z.object({
  start: z.string(), // ISO — the block's start (exact, or the heuristic hour-floor)
  end: z.string(), // ISO — the real reset / start+5h / the successor's start if annulled
  source: windowSourceSchema, // same provenance vocabulary as BlockRow.windowSource
});

export type BlockSpanWindow = z.infer<typeof blockSpanWindowSchema>;

// ADR-0041 (M6) — one machine's densified window pair, the byMachine entry.
// Same shape as a byProject entry minus `path` (machines have no working
// directory; names resolve renderer-side from the machine directory). When the
// project axis is ALSO on, each machine nests its own per-project sub-map —
// entries shaped exactly like top-level byProject entries — so the renderer's
// machine × project cross stays exact; the nested map replaces the top-level
// byProject (the lean rule: a machine-bearing request never populates both).
export const intradayMachineEntrySchema = z.object({
  buckets: z.array(bucketRowSchema),
  previousBuckets: z.array(bucketRowSchema),
  byProject: z
    .record(
      z.string(),
      z.object({
        path: z.string(),
        buckets: z.array(bucketRowSchema),
        previousBuckets: z.array(bucketRowSchema),
      }),
    )
    .optional(),
});

// The `/api/intraday` response body.
//
// `buckets` — the current window's model-stacked buckets. The current window
//   is `[now - count*bucketMs, now]` where `count = SPAN_WINDOW_MS[span] /
//   bucketMs`; the rightmost bucket ends at `now`. ALWAYS exactly `count`
//   entries (densified — a zero-usage bucket is still present), `bucketStart`-
//   ascending. (`INTRADAY_SPANS` is only the bars default bucket size and has
//   no `7d`/`30d` entry — the line path supplies its own `bucketMs`; ADR-0018.)
//   This is the chart's primary series. EXCEPTION — the `today` span: its window
//   is the local calendar day (local midnight in the request `tz` → now), not a
//   `now`-relative `count*bucketMs` span, and `count` is DYNAMIC (server-derived
//   from `now` + `tz`, one bar per elapsed local hour), not `SPAN_WINDOW_MS /
//   bucketMs` (ADR-0020). EXCEPTION — the `block` span: its window is the active
//   block's extent (block start → now, ≤ 5h), resolved server-side (ADR-0031).
//
// `previousBuckets` — the immediately-prior window of the same length:
//   `[now - 2*count*bucketMs, now - count*bucketMs]`, same `count` entries,
//   same densification. The renderer draws this as the ghost overlay — a
//   position-aligned previous-period comparison (~40% opacity bars behind each
//   current bucket, mirroring `/api/daily`'s ghost). `[]` when the ghost series
//   wasn't requested (`prev=0` → the lean ghost-off payload; ADR-0018).
//   EXCEPTION — the `today` span: the ghost is the PRIOR CALENDAR DAY's same
//   time-of-day slots (yesterday local-midnight → yesterday same-time), not a
//   `count*bucketMs`-offset window (ADR-0020). EXCEPTION — the `block` span:
//   the ghost is the PREVIOUS BLOCK's first `count` buckets aligned by
//   time-into-block (ADR-0031), and it is `[]` when no previous block exists,
//   even when the ghost was requested.
//
// `byProject` — per-project-slug buckets, for the chart's project-bearing
//   group-bys. Each entry carries the project's real working-directory `path`
//   (ADR-0009 — the slug key is a lossy encoding that can't be reversed to a
//   path) alongside its `buckets` (same length + densification as the
//   top-level `buckets`) and its `previousBuckets` (ADR-0034 — the slug's
//   previous-window ghost series, same count + densification + position
//   alignment as the top-level `previousBuckets`). Keys are slug-ascending.
//   `{}` when the by-project group-by wasn't requested (`byProject=0` → the
//   lean by-model payload; ADR-0018).
//
//   Per-entry `previousBuckets` is `[]` when the ghost wasn't requested
//   (`prev=0` — the lean ghost-off payload skips the per-slug previous grid)
//   or the span has no previous window (the `block` span with no previous
//   block). A slug active ONLY in the previous window still appears, its
//   current `buckets` densified to zeros — the ghost overlay works in every
//   group-by selection (ADR-0034).
export const intradayResponseSchema = z.object({
  buckets: z.array(bucketRowSchema),
  previousBuckets: z.array(bucketRowSchema),
  byProject: z.record(
    z.string(),
    z.object({
      path: z.string(),
      buckets: z.array(bucketRowSchema),
      // ADR-0034 — the slug's previous-window ghost series: same count +
      // densification as the top-level `previousBuckets`, `[]` when the ghost
      // wasn't requested (`prev=0`) or the span has no previous window.
      previousBuckets: z.array(bucketRowSchema),
    }),
  ),
  // ADR-0041 (M6) — per-machine buckets for the machine group-by. OPTIONAL and
  // present only when the request carried `byMachine=1`: a non-machine request's
  // payload stays byte-identical to the pre-M6 wire (the two-bit sourcing rule).
  // Keys are machineId-ascending; entries follow ADR-0034's ghost semantics
  // (per-machine previousBuckets, [] when the ghost wasn't requested).
  byMachine: z.record(z.string(), intradayMachineEntrySchema).optional(),
  // ADR-0031 — the resolved active-block frame for span=block; null otherwise.
  blockWindow: blockSpanWindowSchema.nullable(),
});

export type IntradayResponse = z.infer<typeof intradayResponseSchema>;
