import type { CostMode, ProjectRow } from "@maxprice/shared";
import { computeCostBreakdown } from "@maxprice/shared";
import { localDate } from "./local-date";
import { defaultTimeZone } from "./timezone";
import type { ModelRollup } from "./model-rollup";
import { byTimestamp, emptyModelRollup, foldModelUsage } from "./model-rollup";
import {
  capturePath,
  emptyPathCapture,
  resolveProjectPath,
  type PathCapture,
} from "./project-path";
import type { StoredEvent } from "./store";

// Part 4.5 — E7: the projects aggregator.
//
// THREE THINGS LIVE HERE — read this before editing anything below.
//
// 1. THE SHIPPED PATH is the two exported halves: `foldProjectEvent` (the
//    per-event fold) and `assembleProjects` (the inclusion + ordering tail),
//    over the exported `ProjectBucket`. `/api/projects` is served by the
//    dirty-bucket report cache (`engine/report-cache.ts`, #113 / ADR-0057),
//    which drives exactly those two — refolding a single dirty project from
//    its own events and re-assembling the response without re-walking the
//    whole store. That endpoint has NO un-cached branch: every
//    `/api/projects` response comes through the cache, so these two functions
//    are the only shipped code here. Note the date window rides along into
//    `foldProjectEvent`: the in-window partition happens PER EVENT inside the
//    fold rather than as a store-query date filter (the scoping block below
//    says what still needs the out-of-window events), which is also why the
//    projects cache must key on the window.
//
// 2. `aggregateProjects` (bottom of this file) is a TEST-ONLY ORACLE, and has
//    been production-dead since ADR-0057. It is those same two halves driven
//    over the full event set, so it is byte-identical with the shipped path BY
//    CONSTRUCTION — which is what makes it a trustworthy oracle, and also what
//    makes editing it alone ship NOTHING. Its callers are `projects.test.ts`
//    (golden parity + behaviour) and `report-cache.test.ts` (the cache's output
//    is diffed against it).
//
// 3. Either path reproduces `/api/projects`'s wire shape byte-for-byte against
//    the E1 golden ({ projects: ProjectRow[] }) — that is the contract the
//    whole module exists to hold.
//
// CAVEAT on the `daily.ts` pointer below: E5's three daily aggregators are NOT
// dead the way this one is. The daily endpoints' bounded-window branch still
// calls them, so they remain shipped code; only `aggregateProjects` and
// `aggregateSessions` were retired to oracles by ADR-0057.
//
// It mirrors E5's daily aggregator (read `daily.ts` first — its module header
// documents the five-step pattern). E7 keys the per-event fold on
// `projectSlug` and emits one windowed rollup per project.
//
// EVERY COLUMN IS RANGE-SCOPED, WITH ONE EXCEPTION (ADR-0068).
//
// `costRange`, the four token counts, `totalTokens`, `modelsUsed`,
// `modelBreakdowns`, `lastActivity`, `machines` and `sessions` are summed or
// counted over only the events INSIDE the date window. The exception is
// `firstActivity`, the earliest activity date across ALL the project's events
// — its all-time scope is the point of the stat, which answers "since when has
// this project existed"; windowing it would collapse it to the window's start.
//
// Through ADR-0057 this file also carried a SECOND, unwindowed `ModelRollup`
// per bucket, behind a `costAllTime` column and an all-time `sessions` count.
// ADR-0068 deleted both: the Projects report answers the date range and
// nothing else, and `range = all` reproduces the deleted figures exactly (the
// window predicate below admits every event when both bounds are absent).
//
// So `aggregateProjects` still takes the *unwindowed* event set plus the date
// window as an option, rather than a date-windowed store query. TWO THINGS
// STILL NEED THE OUT-OF-WINDOW EVENTS: `firstActivity`, and the `cwd` path
// capture (ADR-0009 — a worktree whose in-window events never leave the parent
// repo must still resolve). That is what keeps the partition a per-event test
// inside the fold. (Contrast E5, fed a date-windowed store query — a daily row
// IS a per-day slice; contrast E6, fed an unwindowed set but emitting one
// whole-session figure.)
//
// PROJECT INCLUSION — only projects with >=1 IN-WINDOW event appear. A
// project whose every event is out-of-window is absent from the response —
// even though the engine still holds its all-time data. Verified against the
// golden: the 24h cell has only `alpha-engine` + `beta-tooling`; `gamma-cli`
// (last event 2026-05-10, outside the 24h window) is dropped.
//
// ROW ORDERING — by (earliest in-window local date ascending, then slug
// ascending). So a project first active earlier in the window sorts first;
// ties (same earliest date) break by slug. Verified against every
// `projects__*` golden cell — the 7d cell is the proof: `gamma-cli` (first
// in-window event 2026-05-10) sorts before `alpha-engine` (2026-05-12) before
// `beta-tooling` (2026-05-13), whereas the 30d/90d/all cells order
// `alpha, gamma, beta` because alpha's earliest event then predates gamma's.
//
// MODEL FILTER (ADR-0017) — a store-query axis. This aggregator receives
// already-model-filtered events, so every column is model-scoped, including
// `firstActivity`: under an Opus filter, `sessions` counts in-window sessions
// that used Opus and `firstActivity` is the first date this project used Opus
// at all. A project with no matching events produces no row.
//
// PROJECT FILTER — `/api/projects` filters the row LIST to the selected slugs
// (any count >= 1). Passed as a store query on `projectSlug` (matching E5's
// daily test harness), so the event set the aggregator receives is already
// slug-filtered.
//
// HISTORICAL — where the two rules above came from. Through Part 4 this
// endpoint shelled out to the golden oracle's `daily --instances` report and
// rolled its per-day rows up in `apps/sidecar/src/rollup.ts`. That payload
// only keyed a project that had a daily row in the window, which is where
// PROJECT INCLUSION comes from; the rollup walked those rows date-ascending
// and inserted each project on first sight, preserving that key order, which
// is where ROW ORDERING comes from. Both the shell-out and that module were
// deleted at the Part 4.5 engine cutover (E9, ADR-0010) — ADR-0009 still
// describes the old rollup. The rules are the engine's own now, and what
// pins them is the golden cells cited with them, not the deleted code.

// ---------------------------------------------------------------------------
// Per-project accumulator
// ---------------------------------------------------------------------------

// A project holds its usage as ONE `ModelRollup` (see `./model-rollup`) over
// the events inside the date window; the shared `foldModelUsage` folds each
// in-window event into it with one `computeCost` result. ADR-0068 removed the
// second, unwindowed rollup that used to sit beside it.

// A project's full accumulator: the rollup plus the per-project scalars that
// need a running min/max across the fold.
//
// Exported because the report cache (#113) holds these buckets across
// refreshes; the fields are internal to this module's fold/flush pair, so
// treat it as opaque.
export type ProjectBucket = {
  range: ModelRollup;
  // Latest local date (`YYYY-MM-DD`) across the project's IN-WINDOW events —
  // the wire `lastActivity` (a range-scoped column).
  lastActivity: string;
  // Earliest local date across ALL the project's events — the wire
  // `firstActivity`, the one column the date window does not scope (ADR-0068).
  firstActivity: string;
  // Earliest in-window event's local date (`YYYY-MM-DD`) — the row-ordering
  // key. `""` until the project's first in-window event lands. It is the
  // *date*, not the raw timestamp: the ordering rule is date-granular, so two
  // projects whose earliest in-window events fall on the same local date tie
  // here regardless of intra-day time, and the tie breaks by slug. The 24h
  // golden cell is the proof — `alpha-engine` (event 17:30Z) sorts before
  // `beta-tooling` (14:00Z) because both land on `2026-05-15` and
  // `alpha` < `beta`.
  firstInWindowDate: string;
  // Distinct `sessionId`s across the project's IN-WINDOW events — the wire
  // `sessions` count (ADR-0068; all-time until then). A session straddling the
  // window boundary contributes its id once, from whichever of its events land
  // inside — a Set, so the count is of sessions present in the window, not of
  // sessions wholly contained by it.
  sessions: Set<string>;
  // Machines that contributed IN-WINDOW events, first-seen order (ADR-0041 M5)
  // — a Set preserves insertion order. Range-scoped, parallel to the range
  // rollup's `modelsUsed`.
  machines: Set<string>;
  // The project's real directory, recovered from its events' `cwd` (ADR-0009)
  // — the `cwd` that encodes back to the slug, falling back to the first one
  // seen. Held as a running capture rather than by retaining member events; see
  // `./project-path` for why the first `cwd` alone is not sufficient.
  cwd: PathCapture;
};

function emptyBucket(): ProjectBucket {
  return {
    range: emptyModelRollup(),
    lastActivity: "",
    firstActivity: "",
    firstInWindowDate: "",
    sessions: new Set(),
    machines: new Set(),
    cwd: emptyPathCapture(),
  };
}

// Flush a finished bucket into a wire `ProjectRow`. The range rollup supplies
// every usage column; `path` is resolved from the project's events' `cwd`
// (ADR-0009). `totalTokens` is the sum of the four range token counts.
function flushRow(slug: string, bucket: ProjectBucket): ProjectRow {
  const r = bucket.range;
  return {
    slug,
    path: resolveProjectPath(slug, bucket.cwd.path),
    costRange: r.totalCost,
    totalTokens: r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheCreationTokens: r.cacheCreationTokens,
    cacheReadTokens: r.cacheReadTokens,
    modelsUsed: Array.from(r.models.keys()),
    modelBreakdowns: Array.from(r.models.values()),
    lastActivity: bucket.lastActivity,
    machines: Array.from(bucket.machines),
    sessions: bucket.sessions.size,
    // The one column the window does not scope (ADR-0068).
    firstActivity: bucket.firstActivity,
  };
}

// ---------------------------------------------------------------------------
// /api/projects
// ---------------------------------------------------------------------------

// Fold ONE event into the slug-keyed bucket map — the exact per-event body of
// `aggregateProjects`' loop, exported so the report cache (#113) can refold a
// single dirty project from its own events with byte-identical arithmetic.
// Callers must present events in store sort order (ascending timestamp, ties by
// store insertion order); an unparseable timestamp is dropped whole.
//
// The date window rides along because the in-window partition happens PER EVENT
// inside the fold — `firstActivity` and the `cwd` capture need the out-of-window
// events, so this cannot be a store-query date filter — which is also why the
// projects cache keys on the window. `since` / `until` are dashless `YYYYMMDD`;
// an omitted bound is unbounded on that side.
export function foldProjectEvent(
  buckets: Map<string, ProjectBucket>,
  event: StoredEvent,
  mode: CostMode,
  timeZone: string,
  since?: string,
  until?: string,
): void {
  const date = localDate(event.timestamp, timeZone);
  // An unparseable timestamp is dropped *before* it touches any accumulator
  // — it must not set `bucket.path`, count into `sessions`, or contribute to
  // any rollup or date column. This mirrors E5/E6 (`daily.ts::rowsByDate`,
  // `sessions.ts`), keeping "an unparseable timestamp never reaches the wire"
  // a single invariant: `sessions` is a wire field, so the drop must precede
  // `bucket.sessions.add`. A project whose every event has an unparseable
  // timestamp produces no bucket and therefore no row.
  if (date === null) return;

  let bucket = buckets.get(event.projectSlug);
  if (!bucket) {
    bucket = emptyBucket();
    buckets.set(event.projectSlug, bucket);
  }
  // Capture the project's real directory across ALL its events, in the
  // `byTimestamp` fold order. UNCONDITIONAL (before the in-window check below):
  // the `path` derives from every one of the project's events, not just the
  // in-window subset — which also means a worktree whose in-window events never
  // leave the parent repo still resolves correctly.
  capturePath(bucket.cwd, event.projectSlug, event.cwd);

  if (bucket.firstActivity === "" || date.dashed < bucket.firstActivity) {
    bucket.firstActivity = date.dashed;
  }

  // In-window partition, inline on the already-computed `date` (f13) — the
  // retired `inWindow` helper recomputed `localDate` for the same event; its
  // `date === null` branch is dead here, the fold already returned on it.
  const within =
    (since === undefined || date.ymd >= since) && (until === undefined || date.ymd <= until);
  if (within) {
    // Pricing moved inside the partition with ADR-0068: with the all-time
    // rollup gone, an out-of-window event has nothing left to price.
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
    foldModelUsage(bucket.range, event, cost);
    // Range-scoped since ADR-0068, parallel to `machines` below and to the
    // range rollup's `modelsUsed`.
    bucket.sessions.add(event.sessionId);
    // ADR-0041: `machines` is range-scoped — only in-window events contribute,
    // parallel to the range rollup's `modelsUsed`.
    bucket.machines.add(event.machineId);
    if (date.dashed > bucket.lastActivity) bucket.lastActivity = date.dashed;
    if (bucket.firstInWindowDate === "") {
      // Events are folded timestamp-ascending, so the first in-window event
      // seen IS the project's earliest — its local date is the ordering key.
      bucket.firstInWindowDate = date.dashed;
    }
  }
}

// Flush finished buckets into the wire response — the exact inclusion +
// ordering tail of `aggregateProjects`, exported for the report cache (#113).
// Bucket iteration order does not matter for the OUTPUT order: the sort is
// total (date then slug, and slug is the bucket key, so unique).
export function assembleProjects(buckets: Map<string, ProjectBucket>): { projects: ProjectRow[] } {
  // Keep only projects with >=1 in-window event (the module header's PROJECT
  // INCLUSION rule). Flush the survivors to rows.
  const rows: ProjectRow[] = [];
  const orderKey = new Map<string, string>();
  for (const [slug, bucket] of buckets) {
    if (bucket.firstInWindowDate === "") continue;
    rows.push(flushRow(slug, bucket));
    orderKey.set(slug, bucket.firstInWindowDate);
  }

  // Order by (earliest in-window date asc, slug asc) — the module header's
  // ROW ORDERING rule.
  rows.sort((a, b) => {
    const da = orderKey.get(a.slug) ?? "";
    const db = orderKey.get(b.slug) ?? "";
    return da.localeCompare(db) || a.slug.localeCompare(b.slug);
  });

  return { projects: rows };
}

// Controls beyond the cost mode that shape the `/api/projects` body.
export type AggregateProjectsOptions = {
  // Inclusive date window, dashless `YYYYMMDD`. Scopes every column except
  // `firstActivity` (ADR-0068) — only events whose local-timezone date is
  // inside `[since, until]` contribute, and a project with zero in-window
  // events is omitted from the response. An omitted bound is unbounded on that
  // side, so an options object with neither is the whole corpus.
  since?: string;
  until?: string;
  // The IANA zone every date column (`firstActivity`, `lastActivity`) and the
  // in-window partition are bucketed in (ADR-0015) — the request's `tz`. Only
  // consulted via `localDate`; omitted = the host zone.
  timeZone?: string;
};

// TEST-ONLY ORACLE — production-dead (ADR-0057). The shipped path is
// foldProjectEvent + assembleProjects through the report cache.
//
// Aggregate a store query result into the `/api/projects` response body.
//
// `allEvents` must be the *unwindowed* event set — the project and model
// filter axes may have been applied by the store query. The date window is an
// inline per-event partition on each event's local date (`options.since` /
// `options.until`), NOT a store-query date filter, because `firstActivity` and
// the `cwd` path capture read every event. The model filter is a store-query
// axis (ADR-0017).
//
// This groups by `projectSlug`, folds each in-window event into the project's
// rollup, resolves each project's real `path`, drops projects with no in-window
// events, then orders rows by (earliest in-window date asc, slug asc) — i.e. it
// is exactly `foldProjectEvent` over every timestamp-sorted event, then
// `assembleProjects`.
export function aggregateProjects(
  allEvents: StoredEvent[],
  mode: CostMode,
  options: AggregateProjectsOptions = {},
): { projects: ProjectRow[] } {
  // The zone every date column is bucketed in (ADR-0015); host zone by default.
  const timeZone = options.timeZone ?? defaultTimeZone();

  // Group timestamp-sorted events into slug-keyed buckets, folding each into
  // the project's rollup when in-window.
  const buckets = new Map<string, ProjectBucket>();
  for (const event of byTimestamp(allEvents)) {
    foldProjectEvent(buckets, event, mode, timeZone, options.since, options.until);
  }

  return assembleProjects(buckets);
}
