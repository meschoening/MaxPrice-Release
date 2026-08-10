import type { BucketRow, CostMode, IntradayResponse, Span } from "@maxprice/shared";
import {
  BLOCK_BUCKET_MS,
  BLOCK_WINDOW_MS,
  computeCostBreakdown,
  DAY_MS,
  MAX_INTRADAY_BUCKETS,
  nativeBucketMs,
  SPAN_WINDOW_MS,
  todayBucketCount,
} from "@maxprice/shared";
import type { ResolvedBlockSpan, WindowSpan } from "./block-windows";
import { localClock, shiftYmd, zonedInstant } from "./local-date";
import type { ModelRollup } from "./model-rollup";
import { byTimestamp, emptyModelRollup, flushRollup, foldModelUsage } from "./model-rollup";
import {
  capturePath,
  emptyPathCapture,
  resolveProjectPath,
  type PathCapture,
} from "./project-path";
import type { StoredEvent } from "./store";

// Part 5 — T5.4a: the intraday aggregator.
//
// `aggregateIntraday` is the sibling of `engine/daily.ts`'s `aggregateDaily` —
// one pure function over a store query result that produces the `/api/intraday`
// wire body. It mirrors the daily aggregator pattern (E5) wholesale: a SINGLE
// per-event fold into keyed `ModelRollup`s, then a deterministic flush into
// sorted wire rows. The differences from `daily.ts` are confined to the
// grouping axis and the densification:
//
//   - DAILY groups by local-timezone calendar date; INTRADAY groups by a
//     fixed-width time bucket relative to `now` (no wall-clock snapping).
//   - DAILY emits only the dates that had events; INTRADAY emits EVERY bucket
//     in the window, zero-valued where nothing landed (the chart needs a
//     fixed-length, gap-free series).
//   - DAILY and INTRADAY both filter the model axis at the store level
//     (ADR-0017 — daily's old post-aggregation quirk is retired); for intraday
//     this was always the case.
//
// WINDOWS. The FOUR now-relative spans (`15m`/`1h`/`7d`/`30d`) window by
// epoch-ms relative to `now`, with NO wall-clock snapping (described next).
// CAVEAT (f10): `today` is the calendar-day exception (ADR-0020) — it DOES
// wall-clock-snap, anchoring to local midnight in `tz` and binning by tz-local
// time-of-day; that regime lives in `aggregateToday`, not in the text below.
//
// For a now-relative span `S`: `ms = options.bucketMs ?? INTRADAY_SPANS[S].bucketMs`
// (the explicit override else the span's native bars size), and
// `count = SPAN_WINDOW_MS[S] / ms`. The current window is
// `[now - count*ms, now]`; the previous window is the window of identical
// length immediately before it, `[now - 2*count*ms, now - count*ms]`. Bucket
// `k` (0-indexed) of a window starting at `windowStart` spans
// `[windowStart + k*ms, windowStart + (k+1)*ms)`; its `bucketStart` wire field
// is `new Date(windowStart + k*ms).toISOString()`. Not snapping to a wall-
// clock minute/hour boundary is deliberate — it is simpler, and it makes the
// rightmost bucket end exactly at `now`, which is what the live chart wants.
//
// BUCKET ASSIGNMENT. An event's timestamp is parsed to epoch-ms with
// `Date.parse`. An unparseable timestamp yields `NaN` and the event is
// *dropped* — mirroring `daily.ts`'s `localDate === null` skip, so a malformed
// timestamp can never reach the wire. A parseable event is assigned to bucket
// `floor((t - windowStart)/ms)` of whichever window it falls in; an event
// outside BOTH windows is excluded. Boundary semantics follow the half-open
// interval: an event exactly at a bucket boundary belongs to the *later*
// bucket, an event exactly at `windowEnd` (`= now` for the current window) is
// *outside* the window (index `count`, out of range), and an event exactly at
// `windowStart` is bucket 0.
//
// SINGLE PASS. Every event is timestamp-parsed and `computeCost`-d EXACTLY
// once, then routed by index into the current-window rollups, the previous-
// window rollups, or neither — and, whichever window it landed in, also into
// its project slug's rollups for that window (ADR-0034; the per-slug previous
// grid only when both the ghost and the by-project map are requested). The
// expensive `computeCost` therefore runs once per event, not once per
// (event × window/slug). Per-bucket / per-model
// totals are plain float sums of those per-event costs; no rounding (matching
// every other aggregator).

// The all-zero rollup every EMPTY bucket flushes through (f15). Never folded
// into — `flushRollup` only reads, and it constructs a fresh object literal with
// fresh `Array.from` results per call, so flushing this one shared instance N
// times yields N structurally-distinct all-zero wire rows with no aliasing.
const ZERO_ROLLUP = emptyModelRollup();

// One window's worth of rollups — one slot per bucket index, allocated LAZILY
// (f15): a bucket that never receives an event stays `undefined` and flushes
// through `ZERO_ROLLUP`, so a 300-bucket window with three busy buckets
// constructs three `Map`s, not 300. The wire output is unchanged — every bucket
// still densifies to an all-zero row.
//
// `.fill(undefined)` is load-bearing: a sparse `new Array(count)` has HOLES,
// and `flushWindow`'s `.map` SKIPS holes — the result would keep them, and
// `JSON.stringify` renders a hole as `null`. A filled array has no holes.
type BucketRollups = (ModelRollup | undefined)[];

function emptyWindow(count: number): BucketRollups {
  return new Array<ModelRollup | undefined>(count).fill(undefined);
}

// Materialize bucket `idx`'s rollup so an event can fold into it, creating it on
// first use. Returns `undefined` ONLY for an out-of-range index — preserving the
// exact bounds-guard semantics of the old `rollups[idx]` reads, where
// `undefined` likewise meant "no such bucket". Every fold site keeps its
// `!== undefined` check for that reason.
function ensureRollup(arr: BucketRollups, idx: number): ModelRollup | undefined {
  if (idx < 0 || idx >= arr.length) return undefined;
  return (arr[idx] ??= emptyModelRollup());
}

// Flush a window's rollups into its densified `count`-bucket `BucketRow[]`.
// `starts[k]` is bucket `k`'s precomputed `bucketStart` ISO string — the same
// for the top-level window and every per-project slug, so the strings are
// built once by the caller and reused rather than recomputed per slug. Each
// `BucketRow` is the shared `flushRollup` eight fields plus the `bucketStart`
// time-key — the same shape `daily.ts`'s `flushRow` produces with a `date` key
// instead.
function flushWindow(rollups: BucketRollups, starts: string[]): BucketRow[] {
  return rollups.map((rollup, k) => ({
    bucketStart: starts[k] ?? "",
    ...flushRollup(rollup ?? ZERO_ROLLUP),
  }));
}

// The classification of one event by a window regime's per-event classifier:
//   - `bucket` — the event lands in the current window's bucket `currentIdx`
//     and/or the previous window's bucket `previousIdx`; a `null` index means
//     "not in that window". `computeCost` runs once and folds into both.
//   - `skip`   — the event is unparseable or out of every window: drop it and
//     keep scanning.
//   - `stop`   — the event (and, because the input is timestamp-ascending,
//     every event after it) is past the right edge of the window: break the
//     loop. Only the now-relative regime returns it (its right edge is `now`);
//     the `today` regime never does (it filters by calendar date, not by a
//     monotone right edge).
type EventClass =
  | { kind: "bucket"; currentIdx: number | null; previousIdx: number | null }
  | { kind: "skip" }
  | { kind: "stop" };

// The shared TAIL of both window regimes (f2). Only the per-event CLASSIFICATION
// and the window math (bucket `count` + `bucketStart` strings) differ between
// the now-relative path and the `today` path; everything here — the single
// timestamp-ascending fold, the per-event `computeCost`-once, the current /
// previous-window rollups, the per-slug `byProject` bookkeeping with its
// first-non-empty-`cwd` capture, the `flushWindow` densification, and the
// slug-ascending `byProject` assembly — is identical, so it lives here once.
function assembleWindows(
  events: StoredEvent[],
  mode: CostMode,
  params: {
    count: number;
    currentStarts: string[];
    previousStarts: string[];
    includePrevious: boolean;
    includeByProject: boolean;
    includeByMachine: boolean;
    classify: (event: StoredEvent) => EventClass;
  },
): IntradayResponse {
  const {
    count,
    currentStarts,
    previousStarts,
    includePrevious,
    includeByProject,
    includeByMachine,
    classify,
  } = params;

  // The current + previous windows' rollups, plus a per-slug map of
  // current- (and, with the ghost on, previous-) window rollups built lazily
  // as events route into it.
  const current = emptyWindow(count);
  const previous = includePrevious ? emptyWindow(count) : [];
  // ADR-0041 (M6) lean rule: the TOP-LEVEL byProject map is populated only when
  // the machine axis is off — a machine-bearing request nests its projects under
  // each machine instead, never both. ADR-0034: the per-project ghost is tracked
  // only when the ghost is also on (a lean by-project payload skips the per-slug
  // previous grid).
  const trackTopLevelProjects = includeByProject && !includeByMachine;
  const trackPrevByProject = trackTopLevelProjects && includePrevious;
  // Per-slug current/previous-window rollups, plus a running capture of the
  // slug's real directory for the later `path` resolution (ADR-0009) — the
  // `cwd` that encodes back to the slug, without retaining every member event.
  const bySlug = new Map<
    string,
    { cwd: PathCapture; rollups: BucketRollups; prevRollups: BucketRollups }
  >();
  // First-seen slug entry — shared by the current and previous fold sites so a
  // slug active ONLY in the previous window still appears (its current buckets
  // densify to zeros; the renderer ranks by current totals, so it folds into
  // "Other" unless the window has few projects). `cwd` capture follows
  // byTimestamp order across both windows.
  const slugEntry = (event: StoredEvent) => {
    let slug = bySlug.get(event.projectSlug);
    if (slug === undefined) {
      slug = {
        cwd: emptyPathCapture(),
        rollups: emptyWindow(count),
        prevRollups: trackPrevByProject ? emptyWindow(count) : [],
      };
      bySlug.set(event.projectSlug, slug);
    }
    capturePath(slug.cwd, event.projectSlug, event.cwd);
    return slug;
  };

  // ADR-0041 (M6): per-machine rollups, keyed by the event's machineId — the
  // byProject pattern transposed. `bySlug` inside each entry is the nested
  // machine × project grid, built only when BOTH axes are requested. First-seen
  // entry creation spans both windows (a prev-only machine densifies zero
  // current buckets — the ADR-0034 ghost semantics, machine edition).
  const trackNestedProjects = includeByMachine && includeByProject;
  const byMachineMap = new Map<
    string,
    {
      rollups: BucketRollups;
      prevRollups: BucketRollups;
      bySlug: Map<string, { cwd: PathCapture; rollups: BucketRollups; prevRollups: BucketRollups }>;
    }
  >();
  const machineEntry = (event: StoredEvent) => {
    let entry = byMachineMap.get(event.machineId);
    if (entry === undefined) {
      entry = {
        rollups: emptyWindow(count),
        prevRollups: includePrevious ? emptyWindow(count) : [],
        bySlug: new Map(),
      };
      byMachineMap.set(event.machineId, entry);
    }
    return entry;
  };
  const machineSlugEntry = (entry: ReturnType<typeof machineEntry>, event: StoredEvent) => {
    let slug = entry.bySlug.get(event.projectSlug);
    if (slug === undefined) {
      slug = {
        cwd: emptyPathCapture(),
        rollups: emptyWindow(count),
        prevRollups: includePrevious ? emptyWindow(count) : [],
      };
      entry.bySlug.set(event.projectSlug, slug);
    }
    capturePath(slug.cwd, event.projectSlug, event.cwd);
    return slug;
  };

  // SINGLE per-event pass — `byTimestamp` first so `modelsUsed` /
  // `modelBreakdowns` come out first-seen-ordered (the invariant `daily.ts`
  // relies on), and so the ascending order lets the classifier `stop` early.
  for (const event of byTimestamp(events)) {
    const cls = classify(event);
    if (cls.kind === "stop") break;
    if (cls.kind === "skip") continue;
    const { currentIdx, previousIdx } = cls;

    // `computeCostBreakdown` runs EXACTLY once per kept event, then folds into whichever
    // windows the classifier picked — never once per (event × window/slug).
    const cost = computeCostBreakdown(
      event.model,
      {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheCreationTokens: event.cacheCreationTokens,
        cacheReadTokens: event.cacheReadTokens,
      },
      mode,
      event.costUSD,
    );

    if (currentIdx !== null) {
      const rollup = ensureRollup(current, currentIdx);
      if (rollup !== undefined) foldModelUsage(rollup, event, cost);

      // The event also folds into its slug's own bucket index — skipped
      // entirely when the top-level per-project map isn't requested (ADR-0018;
      // ADR-0041 lean rule suppresses it when the machine axis is on).
      if (trackTopLevelProjects) {
        const slugRollup = ensureRollup(slugEntry(event).rollups, currentIdx);
        if (slugRollup !== undefined) foldModelUsage(slugRollup, event, cost);
      }

      // ADR-0041 (M6): the per-machine current-window fold, plus the nested
      // machine × project fold when both axes are on.
      if (includeByMachine) {
        const entry = machineEntry(event);
        const machineRollup = ensureRollup(entry.rollups, currentIdx);
        if (machineRollup !== undefined) foldModelUsage(machineRollup, event, cost);
        if (trackNestedProjects) {
          const nested = ensureRollup(machineSlugEntry(entry, event).rollups, currentIdx);
          if (nested !== undefined) foldModelUsage(nested, event, cost);
        }
      }
    }

    if (previousIdx !== null) {
      const rollup = ensureRollup(previous, previousIdx);
      if (rollup !== undefined) foldModelUsage(rollup, event, cost);

      // ADR-0034: the slug's previous-window ghost series — same fold, into
      // the per-slug previous grid, only when both flags are on.
      if (trackPrevByProject) {
        const slugRollup = ensureRollup(slugEntry(event).prevRollups, previousIdx);
        if (slugRollup !== undefined) foldModelUsage(slugRollup, event, cost);
      }

      // ADR-0041 (M6): the per-machine previous-window ghost, mirroring the
      // current-window fold above (nested machine × project when both on).
      if (includeByMachine && includePrevious) {
        const entry = machineEntry(event);
        const machineRollup = ensureRollup(entry.prevRollups, previousIdx);
        if (machineRollup !== undefined) foldModelUsage(machineRollup, event, cost);
        if (trackNestedProjects) {
          const nested = ensureRollup(machineSlugEntry(entry, event).prevRollups, previousIdx);
          if (nested !== undefined) foldModelUsage(nested, event, cost);
        }
      }
    }
  }

  const buckets = flushWindow(current, currentStarts);
  const previousBuckets = flushWindow(previous, previousStarts);

  const byProject: IntradayResponse["byProject"] = {};
  // Slug-ascending key order, mirroring `aggregateDailyByProject`.
  const slugEntries = Array.from(bySlug.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [slug, { cwd, rollups, prevRollups }] of slugEntries) {
    byProject[slug] = {
      path: resolveProjectPath(slug, cwd.path),
      buckets: flushWindow(rollups, currentStarts),
      previousBuckets: trackPrevByProject ? flushWindow(prevRollups, previousStarts) : [],
    };
  }

  // ADR-0041 (M6): the byMachine map — machineId-ascending, each entry's nested
  // byProject (when both axes are on) slug-ascending. Absent entirely when the
  // machine axis is off (the conditional spread in the return keeps the pre-M6
  // body byte-identical). The per-machine previous grid follows `includePrevious`
  // exactly as the top-level pair does.
  let byMachine: NonNullable<IntradayResponse["byMachine"]> | undefined;
  if (includeByMachine) {
    byMachine = {};
    const machineEntries = Array.from(byMachineMap.entries()).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [machineId, entry] of machineEntries) {
      const wire: NonNullable<IntradayResponse["byMachine"]>[string] = {
        buckets: flushWindow(entry.rollups, currentStarts),
        previousBuckets: includePrevious ? flushWindow(entry.prevRollups, previousStarts) : [],
      };
      if (trackNestedProjects) {
        const nested: NonNullable<(typeof wire)["byProject"]> = {};
        const nestedEntries = Array.from(entry.bySlug.entries()).sort(([a], [b]) =>
          a.localeCompare(b),
        );
        for (const [slug, { cwd, rollups, prevRollups }] of nestedEntries) {
          nested[slug] = {
            path: resolveProjectPath(slug, cwd.path),
            buckets: flushWindow(rollups, currentStarts),
            previousBuckets: includePrevious ? flushWindow(prevRollups, previousStarts) : [],
          };
        }
        wire.byProject = nested;
      }
      byMachine[machineId] = wire;
    }
  }

  return {
    buckets,
    previousBuckets,
    byProject,
    ...(byMachine !== undefined ? { byMachine } : {}),
    blockWindow: null,
  };
}

// Controls beyond the cost mode that shape the `/api/intraday` body — common to
// every span. The discriminated `span`/`tz` pairing is layered on in
// `AggregateIntradayOptions` below.
type IntradayCommonOptions = {
  // The bucket duration in ms. Omitted → the span's native bars granularity
  // (`INTRADAY_SPANS[span].bucketMs`). The line path passes a 15-min floor
  // (`lineGranularityFor`). Must divide the span window evenly (a whole day,
  // for `today`).
  bucketMs?: number;
  // "Now", epoch-ms. The current window ends here; the handler passes
  // `Date.now()`. A parameter (not an internal `Date.now()`) so tests can pin
  // a fixed reference instant.
  now: number;
  // Lean-payload flags (ADR-0018). Default true (pre-ADR-0018 behaviour).
  // `includePrevious` false → skip the previous-window fold and return an empty
  // `previousBuckets`; `includeByProject` false → skip the per-slug bookkeeping
  // and return an empty `byProject`. The dense line spans set these so a
  // `30d` `by model` line with ghost off ships one array, not three.
  includePrevious?: boolean;
  includeByProject?: boolean;
  // ADR-0041 (M6): the per-machine map for the machine group-by. Default false
  // (the pre-M6 body — no byMachine key at all). When true, `includeByProject`
  // switches the per-machine NESTED project sub-maps instead of the top-level
  // byProject (the lean rule — the renderer never needs both).
  includeByMachine?: boolean;
};

// A discriminated union on `span` (f11): the `today` calendar-day span anchors
// its window to local midnight, so it REQUIRES `tz` at COMPILE time (ADR-0020);
// the now-relative spans window by epoch-ms and never read it, so `tz` is
// optional there. This turns `{ span: "today", now }` (no tz) into a type error
// rather than a silent runtime throw — though `aggregateToday`'s runtime guard
// stays as the last line of defence (and a downstream test exercises it).
export type AggregateIntradayOptions =
  | ({
      // The calendar-day span (ADR-0020): local midnight → now, tz-aware.
      span: "today";
      // The IANA zone — REQUIRED for `today`, which anchors its window to local
      // midnight in this zone and bins events by their tz-local time-of-day.
      tz: string;
    } & IntradayCommonOptions)
  | ({
      // The chart span — picks the total window length from `SPAN_WINDOW_MS`.
      // The now-relative spans (`15m`/`1h`/`7d`/`30d`); the line path
      // requests `7d`/`30d` here too.
      span: Exclude<Span, "today" | "block">;
      // The IANA zone — ignored by the now-relative spans (they window purely by
      // epoch-ms), so optional here.
      tz?: string;
    } & IntradayCommonOptions)
  | ({
      // The active-block span (ADR-0031): the HANDLER resolves the frame via
      // resolveBlockSpanWindow (all-model/all-project — the events passed HERE
      // are filter-narrowed, the boundaries never are) and hands it in. `tz` is
      // not load-bearing — the frame anchors at the block start, not a calendar
      // boundary.
      span: "block";
      blockWindow: ResolvedBlockSpan;
      tz?: string;
    } & IntradayCommonOptions);

// Aggregate a store query result into the `/api/intraday` response body.
//
// `events` must ALREADY be project-/model-filtered by the store's `query` —
// this function does NOT filter. Unlike the date axis, the intraday window is
// sub-day and the store's date filter is day-granular, so the caller passes no
// `since`/`until`; the precise windowing is done here from event timestamps.
//
// Returns `{ buckets, previousBuckets, byProject }`:
//   - `buckets` / `previousBuckets` — the current and immediately-prior
//     windows, each exactly `count` densified `BucketRow`s, `bucketStart`-
//     ascending.
//   - `byProject` — both windows' events grouped by `projectSlug`, each slug
//     bucketed independently into the same `count` densified buckets (its
//     `buckets` + `previousBuckets` mirroring the top-level pair — ADR-0034;
//     `previousBuckets` is `[]` when the ghost wasn't requested), keyed
//     slug-ascending, each entry carrying the slug's real `path` (ADR-0009,
//     via `resolveProjectPath` over the slug's first captured `cwd`).
export function aggregateIntraday(
  events: StoredEvent[],
  mode: CostMode,
  options: AggregateIntradayOptions,
): IntradayResponse {
  // `today` is the calendar-day span (ADR-0020): a different windowing regime
  // — local midnight → now, tz-aware, bucket count grows with the day — so it
  // has its own path. `block` is the active-block span (ADR-0031): a growing
  // window anchored to the resolved block start, sidecar-side rung. Everything
  // below is the `now`-relative windowing the remaining spans share.
  if (options.span === "today") return aggregateToday(events, mode, options);
  if (options.span === "block") return aggregateBlockSpan(events, mode, options);

  // ADR-0041 (M6) lean rule: with the machine axis ON, the project axis defaults
  // OFF (the nested per-machine byProject grid builds only when explicitly asked)
  // — a machine request never drags in projects unpromptedly. With it off, the
  // project axis keeps its pre-M6 default (ON), so a non-machine body is
  // byte-identical to before.
  const {
    now,
    includePrevious = true,
    includeByMachine = false,
    includeByProject = !includeByMachine,
  } = options;
  // Bucket duration: explicit override (the line path's 15-min floor) or the
  // span's native bars granularity. The window length comes from the span;
  // `count` is the whole number of buckets that tiles it (ADR-0018).
  const ms = options.bucketMs ?? nativeBucketMs(options.span);
  if (ms === undefined || ms <= 0) {
    throw new Error(`intraday: no bucket size for span ${options.span}`);
  }
  const windowMs = SPAN_WINDOW_MS[options.span];
  if (windowMs % ms !== 0) {
    throw new Error(`intraday: bucketMs ${ms} does not divide span window ${windowMs}`);
  }
  const count = windowMs / ms;
  // Guard ANY direct caller before allocating the (possibly huge) bucket grid —
  // the handler also 400s this, but a non-HTTP caller would otherwise OOM.
  if (count > MAX_INTRADAY_BUCKETS) {
    throw new Error(
      `intraday: ${count} buckets for span ${options.span} at bucketMs ${ms} exceeds the ${MAX_INTRADAY_BUCKETS} ceiling`,
    );
  }

  // The two windows, back to back. The current window ends exactly at `now`.
  // The previous window is only walked when its ghost series is requested.
  const currentStart = now - count * ms;
  const previousStart = now - 2 * count * ms;
  // The earliest instant any event can land in (f12): the previous window's
  // start when its ghost is wanted, else the current window's. Combined with the
  // ascending input, this lets the classifier `skip` the long pre-window history
  // of a `7d`/`30d` query and `stop` once past `now`, without index math.
  const windowStart = includePrevious ? previousStart : currentStart;

  // Each bucket's `bucketStart` ISO string, precomputed once per window. The
  // current-window strings are shared by the top-level `buckets` AND every
  // per-project slug (all keyed on `currentStart + k*ms`), so building them
  // once and reusing avoids re-stringifying the same instants per slug. The
  // previous-window strings are built only when its ghost series is requested.
  const currentStarts = Array.from({ length: count }, (_, k) =>
    new Date(currentStart + k * ms).toISOString(),
  );
  const previousStarts = includePrevious
    ? Array.from({ length: count }, (_, k) => new Date(previousStart + k * ms).toISOString())
    : [];

  // Classify by epoch-ms offset from each window's start. The input is
  // timestamp-ascending (UTC-`Z`, lexical == chronological), so once a parseable
  // event is past `now` every later one is too → `stop`; before `windowStart` →
  // `skip` (f12).
  const classify = (event: StoredEvent): EventClass => {
    const t = Date.parse(event.timestamp);
    // Unparseable timestamp → NaN → dropped (mirrors daily.ts's localDate skip).
    if (Number.isNaN(t)) return { kind: "skip" };
    if (t > now) return { kind: "stop" };
    if (t < windowStart) return { kind: "skip" };
    const currentIndex = Math.floor((t - currentStart) / ms);
    const previousIndex = Math.floor((t - previousStart) / ms);
    const inCurrent = currentIndex >= 0 && currentIndex < count;
    // The previous window is only considered when its ghost series is wanted.
    const inPrevious = includePrevious && previousIndex >= 0 && previousIndex < count;
    if (!inCurrent && !inPrevious) return { kind: "skip" };
    return {
      kind: "bucket",
      currentIdx: inCurrent ? currentIndex : null,
      previousIdx: inPrevious ? previousIndex : null,
    };
  };

  return assembleWindows(events, mode, {
    count,
    currentStarts,
    previousStarts,
    includePrevious,
    includeByProject,
    includeByMachine,
    classify,
  });
}

// The `today` calendar-day span (ADR-0020). Unlike the now-relative path above,
// the window is anchored to LOCAL MIDNIGHT in `tz` and grows to `now`: the
// rightmost bucket is the in-progress local hour (or 15-min slot for the line
// `bucketMs`). Events are binned by their tz-local time-of-day, and ONLY
// today's events count — so the current buckets sum penny-exactly to
// `/api/daily`'s today row (the Today tile), which is the entire reason the
// span exists. The previous window is YESTERDAY's same positions (bucket `k` =
// yesterday's same time-of-day slot), for a day-over-day ghost overlay.
//
// PARITY ROBUSTNESS (f13): a future-dated SAME-DAY event (clock skew — its
// tz-local date is today but its time-of-day is later than `now`'s, so its raw
// index ≥ `count`) is FOLDED into the final in-progress bucket rather than
// dropped. `/api/daily`'s today row counts such an event, so dropping it would
// silently break the penny-exact parity above; folding keeps the sum exact. The
// fold is current-window only — the yesterday/previous ghost keeps the strict
// range check (a yesterday event later than now's time-of-day has no in-progress
// bucket to fold into and stays excluded). Normal events have index ≤ count-1
// already, so the fold is a no-op for them.
//
// DST: binning by tz-local time-of-day and anchoring at the tz-correct midnight
// keep parity exact on transition days. On the fall-back 25-hour day the two
// occurrences of the repeated wall-clock hour share a time-of-day slot and are
// summed into it — the totals stay exact; the chart just can't distinguish the
// two physical hours (acceptable for a per-hour-of-day view).
function aggregateToday(
  events: StoredEvent[],
  mode: CostMode,
  options: AggregateIntradayOptions,
): IntradayResponse {
  // ADR-0041 (M6) lean rule: machine axis on ⇒ project axis defaults off (see
  // `aggregateIntraday`); off ⇒ pre-M6 default (on), so a non-machine body stays
  // byte-identical.
  const {
    now,
    tz,
    includePrevious = true,
    includeByMachine = false,
    includeByProject = !includeByMachine,
  } = options;
  if (tz === undefined) {
    throw new Error("intraday: span today requires a tz");
  }
  // Default to the hourly bars bucket; the line path passes the 15-min floor.
  const ms = options.bucketMs ?? nativeBucketMs("today");
  if (ms === undefined || ms <= 0) {
    throw new Error("intraday: no bucket size for span today");
  }
  // The bucket must tile a whole day so time-of-day slots align to midnight.
  if (DAY_MS % ms !== 0) {
    throw new Error(`intraday: bucketMs ${ms} does not divide a day`);
  }

  // `now` is epoch-ms; `localClock` takes it directly (f21 — no ISO round-trip).
  const nowClock = localClock(now, tz);
  if (nowClock === null) {
    throw new Error("intraday: unparseable now");
  }
  const todayYmd = nowClock.ymd;
  // The in-progress slot is the one holding `now`; `count` buckets cover
  // midnight → now inclusive of it. A day-dividing `ms` keeps `count` ≤ 96 for
  // the bars/line sizes, but a tiny override could grow it — so guard the grid.
  const count = todayBucketCount(nowClock.msSinceMidnight, ms);
  if (count > MAX_INTRADAY_BUCKETS) {
    throw new Error(
      `intraday: ${count} buckets for span today at bucketMs ${ms} exceeds the ${MAX_INTRADAY_BUCKETS} ceiling`,
    );
  }
  // `undefined` (not a `""` sentinel) when the ghost is off — every read below
  // is gated on `includePrevious`, so the undefined value is never reached then.
  const yesterdayYmd: string | undefined = includePrevious ? shiftYmd(todayYmd, -1) : undefined;

  // Each bucket's `bucketStart` ISO string — the UTC instant of local hour/slot
  // `k` on the day, DST-correct via `zonedInstant`. Current-window strings are
  // shared by the top-level buckets and every per-project slug.
  const currentStarts = Array.from({ length: count }, (_, k) =>
    new Date(zonedInstant(todayYmd, k * ms, tz)).toISOString(),
  );
  const previousStarts =
    includePrevious && yesterdayYmd !== undefined
      ? Array.from({ length: count }, (_, k) =>
          new Date(zonedInstant(yesterdayYmd, k * ms, tz)).toISOString(),
        )
      : [];

  // Prefilter (f4): only today's / yesterday's events can bucket, so compute the
  // lower-bound local-midnight instant ONCE and cheaply `Date.parse`-reject
  // anything earlier BEFORE the per-event `localClock` (an `Intl.formatToParts`
  // call) — the hot path on a busy day. `yesterdayYmd ?? todayYmd` is yesterday's
  // midnight when the ghost is wanted, else today's (the same `includePrevious`
  // branch the windows take).
  const lowerBound = zonedInstant(yesterdayYmd ?? todayYmd, 0, tz);

  // Bin by tz-local time-of-day. Never returns `stop`: events are filtered by
  // calendar date, not by a monotone right edge, so a later event might still be
  // a yesterday-window match.
  const classify = (event: StoredEvent): EventClass => {
    const t = Date.parse(event.timestamp);
    // Unparseable, or before the lower bound → dropped without an `Intl` call.
    if (Number.isNaN(t) || t < lowerBound) return { kind: "skip" };
    const clock = localClock(event.timestamp, tz);
    if (clock === null) return { kind: "skip" };
    const idx = Math.floor(clock.msSinceMidnight / ms);
    if (clock.ymd === todayYmd) {
      // f13: fold a future-dated same-day event into the final in-progress
      // bucket (see the function header) so the current window stays penny-exact
      // with `/api/daily`'s today row. `idx ≥ 0` always (msSinceMidnight ≥ 0),
      // so `min(idx, count-1)` is in range; for normal events it is a no-op.
      return { kind: "bucket", currentIdx: Math.min(idx, count - 1), previousIdx: null };
    }
    // Yesterday's same time-of-day slot → the previous (ghost) window, which
    // keeps the strict range check (a later-than-now yesterday slot stays out).
    if (includePrevious && clock.ymd === yesterdayYmd && idx >= 0 && idx < count) {
      return { kind: "bucket", currentIdx: null, previousIdx: idx };
    }
    return { kind: "skip" };
  };

  return assembleWindows(events, mode, {
    count,
    currentStarts,
    previousStarts,
    includePrevious,
    includeByProject,
    includeByMachine,
    classify,
  });
}

// Is `t` inside any exclusion window? Linear scan — the list is tiny (resolved
// windows overlapping one block's span; usually zero or one).
function inExclusion(t: number, exclusions: WindowSpan[]): boolean {
  return exclusions.some((w) => t >= w.startMs && t < w.endMs);
}

// The `block` span (ADR-0031): the active block's GROWING window — block start
// → now, rightmost bucket in progress — at a fixed one-minute bucket
// (BLOCK_BUCKET_MS; ADR-0046 retired the adaptive rung this used to pick, and
// the default stays sidecar-side where the resolved window lives) unless an
// explicit bucketMs override is passed. A minute divides the 5h window, so the
// divisibility guard below holds by construction. The ghost is the
// PREVIOUS block, aligned by time-into-block: ghost bucket k covers the same
// [k·ms, (k+1)·ms) offset from the previous block's start, same count — the
// block analogue of today's "yesterday, same local hours". A future-dated
// in-window event (clock skew: now < t < end) folds into the final in-progress
// bucket so the buckets sum penny-exactly to the active BlockRow's
// model-filtered sums (the aggregateToday f13 move, block edition). Events
// inside an exclusion window belong to a NEIGHBORING resolved window (the
// ADR-0028 heuristic seam overlap), never to this block — skipped in both
// frames.
function aggregateBlockSpan(
  events: StoredEvent[],
  mode: CostMode,
  options: AggregateIntradayOptions,
): IntradayResponse {
  if (options.span !== "block") throw new Error("intraday: aggregateBlockSpan requires span block");
  // ADR-0041 (M6) lean rule: machine axis on ⇒ project axis defaults off (see
  // `aggregateIntraday`); off ⇒ pre-M6 default (on).
  const {
    now,
    includePrevious = true,
    includeByMachine = false,
    includeByProject = !includeByMachine,
  } = options;
  const { startMs, endMs, source, exclusions } = options.blockWindow;

  const ms = options.bucketMs ?? BLOCK_BUCKET_MS;
  if (ms <= 0) throw new Error("intraday: no bucket size for span block");
  if (BLOCK_WINDOW_MS % ms !== 0) {
    throw new Error(`intraday: bucketMs ${ms} does not divide the 5h block window`);
  }
  // The growing frame: an active block always has now < endMs (the resolver's
  // predicate), so elapsed < 5h and the count stays small; the ceiling guard
  // protects direct callers with a pathological override regardless.
  const elapsed = Math.max(0, now - startMs);
  const count = todayBucketCount(elapsed, ms);
  if (count > MAX_INTRADAY_BUCKETS) {
    throw new Error(
      `intraday: ${count} buckets for span block at bucketMs ${ms} exceeds the ${MAX_INTRADAY_BUCKETS} ceiling`,
    );
  }

  const prevWin = includePrevious ? options.blockWindow.previous : null;
  const currentStarts = Array.from({ length: count }, (_, k) =>
    new Date(startMs + k * ms).toISOString(),
  );
  const previousStarts =
    prevWin === null
      ? []
      : Array.from({ length: count }, (_, k) => new Date(prevWin.startMs + k * ms).toISOString());

  const classify = (event: StoredEvent): EventClass => {
    const t = Date.parse(event.timestamp);
    if (Number.isNaN(t)) return { kind: "skip" };
    // Ascending input: past the block's real end nothing later can land in
    // either frame (the previous block is earlier still). The half-open right
    // edge carries a measure-zero seam for HEURISTIC blocks only: the
    // heuristic walk's strict `>` gap check means a heuristic block can include an event
    // at exactly startMs + 5h, which `t >= endMs` excludes — accepted,
    // unreachable for real JSONL timestamps and impossible for observed/
    // annulled windows (their end is the real reset / truncation instant).
    // Dual seam: a previous HEURISTIC block can likewise contain an event at
    // exactly its startMs + 5h (the walk's strict `>`), which can coincide
    // with the active heuristic block's floored start — `classify` claims it
    // for the current frame while the tile counts it in the previous block;
    // same unreachable measure-zero class.
    if (t >= endMs) return { kind: "stop" };
    // The two frames are evaluated INDEPENDENTLY — never else-if'd on the time
    // ranges. A heuristic block's hour-floored span can cut into the previous
    // resolved window's tail (the ADR-0028 seam), so an event can sit in BOTH
    // ranges; gating the ghost check on `t < startMs` would drop the previous
    // block's tail there. No double-count is possible — a both-ranges event is
    // either (a) inside one of the current block's exclusions (heuristic-current
    // case: `exclusionsFor` hands it every overlapping resolved window, so the
    // event falls through to the ghost) or (b) partition-owned by the current
    // observed window itself (observed-current case: the event is claimed by the
    // current branch and cannot be a heuristic-previous block's member, since
    // heuristic blocks form only from residual events). Either way exactly one
    // frame claims it — current and ghost membership stay partition-disjoint.
    if (t >= startMs && !inExclusion(t, exclusions)) {
      return {
        kind: "bucket",
        currentIdx: Math.min(Math.floor((t - startMs) / ms), count - 1),
        previousIdx: null,
      };
    }
    if (
      prevWin !== null &&
      t >= prevWin.startMs &&
      t < prevWin.endMs &&
      !inExclusion(t, prevWin.exclusions)
    ) {
      const idx = Math.floor((t - prevWin.startMs) / ms);
      // Same-time-into-block only: the ghost stops where the current frame does.
      if (idx < count) return { kind: "bucket", currentIdx: null, previousIdx: idx };
    }
    return { kind: "skip" };
  };

  const body = assembleWindows(events, mode, {
    count,
    currentStarts,
    previousStarts,
    includePrevious: prevWin !== null,
    includeByProject,
    includeByMachine,
    classify,
  });
  return {
    ...body,
    blockWindow: {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      source,
    },
  };
}
