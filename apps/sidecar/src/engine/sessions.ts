import type { CostMode, SessionRow, SessionsResponse } from "@maxprice/shared";
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

// Part 4.5 — E6: the sessions aggregator.
//
// THREE THINGS LIVE HERE — read this before editing anything below.
//
// 1. THE SHIPPED PATH is the two exported halves: `foldSessionEvent` (step 2
//    of the pattern below) and `assembleSessions` (steps 4-5), over the
//    exported `SessionBucket`. `/api/sessions` is served by the dirty-bucket
//    report cache (`engine/report-cache.ts`, #113 / ADR-0057), which drives
//    exactly those two — refolding a single dirty bucket from its own events
//    and re-assembling the response without re-walking the whole store. That
//    endpoint has NO un-cached branch: every `/api/sessions` response comes
//    through the cache, so these two functions are the only shipped code here.
//
// 2. `aggregateSessions` (bottom of this file) is a TEST-ONLY ORACLE, and has
//    been production-dead since ADR-0057. It is those same two halves driven
//    over the full event set, so it is byte-identical with the shipped path BY
//    CONSTRUCTION — which is what makes it a trustworthy oracle, and also what
//    makes editing it alone ship NOTHING. Its callers are `sessions.test.ts`
//    (golden parity + behaviour), `report-cache.test.ts` (the cache's output is
//    diffed against it) and `../session-events.test.ts` (the session-detail
//    endpoint's totals are diffed against it).
//
// 3. Either path reproduces `/api/sessions`'s wire shape byte-for-byte against
//    the E1 golden ({ sessions: SessionRow[] }) — that is the contract the
//    whole module exists to hold.
//
// CAVEAT on the `daily.ts` pointer below: E5's three daily aggregators are NOT
// dead the way this one is. The daily endpoints' bounded-window branch still
// calls them, so they remain shipped code; only `aggregateSessions` and
// `aggregateProjects` were retired to oracles by ADR-0057.
//
// It mirrors E5's daily aggregator (read `daily.ts` first — its module header
// documents the five-step pattern). E6 keys the per-event fold on `sessionId`
// instead of the calendar date, and folds in the `cwd` → real `path`
// resolution (ADR-0009) via `resolveProjectPath` over the session's first
// captured `cwd`.
//
// THE AGGREGATOR PATTERN (shared with E5):
//   1. Sort events by timestamp ascending — `modelsUsed` / `modelBreakdowns`
//      are emitted in first-seen order, which is only deterministic over
//      timestamp-sorted events.
//   2. Fold each event into a `SessionBucket` keyed by `sessionId`.
//   3. Cost is `computeCost(model, tokenCounts, mode, costUSD)` — per event,
//      per model. Per-session / per-model totals are plain float sums (the
//      golden carries float-arithmetic artifacts, e.g. `0.19708999999999996`,
//      so DO NOT round).
//   4. Flush buckets into wire rows; sort rows the way the `session`
//      report does — see ROW ORDERING below.
//   5. The model filter is a STORE-QUERY axis (ADR-0017) — this aggregator
//      receives already-model-filtered events (see MODEL FILTER below).
//
// TWO QUIRKS E6 REPRODUCES THAT E5 DOES NOT — both surfaced by the E1 golden.
//
// WINDOWING IS WHOLE-SESSION, NOT WHOLE-EVENT.
// The session report's `--since/--until` filters which *sessions* appear by
// the session's `lastActivity`, but each surviving session's token + cost
// totals are summed over **every** event in the session — including events
// outside the window. The golden proves it: `sessions__auto__24h__nofilter`'s
// `alpha-may` row reports `totalTokens: 79529` (the full three-event session)
// even though only its 2026-05-15 event lies in the 24h window; its 04-20 and
// 05-12 events are out-of-window yet still counted. So the aggregator must NOT
// be fed a date-windowed store query (that would truncate the per-session
// sums). It takes the *unwindowed* event set, builds full per-session
// rollups, then drops rows whose `lastActivity` falls outside `[since, until]`
// — `applyWindow` below. (Contrast E5, where the store's date filter is
// correct because a daily row IS a per-day slice.)
//
// MODEL FILTER (ADR-0017).
// The model filter is a store-query axis: this aggregator receives already-
// model-filtered events, so each session's totals, breakdowns, and
// `lastActivity` are model-scoped. A session with no matching events produces
// no row. (Through Part 6 this was a post-aggregation breakdown filter; see
// ADR-0017 for why that was retired.)
//
// ROW ORDERING.
// The `session` report sorts sessions by `totalCost` descending. The
// sort is stable over a deterministic pre-order — verified against the
// `display`-mode golden, where every `totalCost` is `0` (display mode passes
// through the absent `costUSD`, so all rows tie) and the rows stay in
// `(projectPath, sessionId)`-ascending order. So: build rows in
// `(projectPath, sessionId)` order, then stable-sort by `totalCost`
// descending.

// ---------------------------------------------------------------------------
// Per-session accumulator
// ---------------------------------------------------------------------------

// A mutable accumulator folding many events sharing one `sessionId`: a shared
// `ModelRollup` (token totals + first-seen per-model breakdowns — see
// `./model-rollup`) extended with the session-specific fields. `path` captures
// the first non-empty `cwd` seen so the session's real `path` can be resolved
// after the fold (ADR-0009) without retaining every member event.
//
// Exported because the report cache (#113) holds these buckets across
// refreshes; the fields are internal to this module's fold/flush pair, so
// treat it as opaque.
export type SessionBucket = ModelRollup & {
  projectSlug: string;
  // The latest local-date (`YYYY-MM-DD`) seen across the session's events.
  lastActivity: string;
  // The machine of the LATEST event folded (ADR-0041 M5) — the session's
  // attribution. `latestTimestamp` is the raw ISO timestamp that machine was
  // seen at, so a later fold with an equal-or-greater timestamp wins (matching
  // `lastActivity`'s last-fold-wins posture at day granularity, but resolved at
  // the event's own timestamp so a same-day migration still flips it).
  machineId: string;
  latestTimestamp: string;
  // The session's real directory, recovered from its events' `cwd` (ADR-0009)
  // — the `cwd` that encodes back to the project slug, falling back to the
  // first one seen. A session that opens in a repo and switches into a worktree
  // reports the worktree, matching the slug it is filed under; see
  // `./project-path`.
  cwd: PathCapture;
};

function emptyBucket(projectSlug: string): SessionBucket {
  return {
    ...emptyModelRollup(),
    projectSlug,
    lastActivity: "",
    machineId: "",
    latestTimestamp: "",
    cwd: emptyPathCapture(),
  };
}

// Fold one event into a bucket: delegate its four token counts + cost + model
// breakdown to the shared `foldModelUsage`, capture the first non-empty `cwd`
// for the later `path` resolution, and advance `lastActivity`.
function foldEvent(
  bucket: SessionBucket,
  event: StoredEvent,
  mode: CostMode,
  dashed: string,
): void {
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
  foldModelUsage(bucket, event, cost);
  // Events fold in timestamp order, so the fallback is still the first
  // non-empty `cwd`; a `cwd` that encodes to the session's project slug wins.
  capturePath(bucket.cwd, event.projectSlug, event.cwd);
  // Events are folded in timestamp order, so the last fold wins — but compare
  // anyway so the field is correct even if a caller passes unsorted events.
  if (dashed > bucket.lastActivity) bucket.lastActivity = dashed;
  // ADR-0041: attribution follows the LATEST event (>= so equal timestamps
  // keep the later fold, matching the last-fold-wins posture of lastActivity).
  if (event.timestamp >= bucket.latestTimestamp) {
    bucket.latestTimestamp = event.timestamp;
    bucket.machineId = event.machineId;
  }
}

// Flush a finished bucket into a wire `SessionRow`. `totalTokens` is the sum
// of all four token counts. `modelsUsed` / `modelBreakdowns` follow the
// bucket's first-seen insertion order; `path` is resolved from the session's
// captured first `cwd` (ADR-0009); `projectPath` is the slug.
function flushRow(sessionId: string, bucket: SessionBucket): SessionRow {
  return {
    sessionId,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheCreationTokens: bucket.cacheCreationTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    totalTokens:
      bucket.inputTokens +
      bucket.outputTokens +
      bucket.cacheCreationTokens +
      bucket.cacheReadTokens,
    totalCost: bucket.totalCost,
    lastActivity: bucket.lastActivity,
    modelsUsed: Array.from(bucket.models.keys()),
    modelBreakdowns: Array.from(bucket.models.values()),
    projectPath: bucket.projectSlug,
    path: resolveProjectPath(bucket.projectSlug, bucket.cwd.path),
    machineId: bucket.machineId,
  };
}

// ---------------------------------------------------------------------------
// Window post-filter
// ---------------------------------------------------------------------------

// Drop rows whose `lastActivity` falls outside `[since, until]` — the
// whole-session windowing quirk from the module header. `since` / `until` are
// dashless `YYYYMMDD`; `lastActivity` is dashed `YYYY-MM-DD`, so strip the
// dashes before the lexical compare. An omitted bound is "no bound on that
// side". The row's token + cost totals are NOT narrowed — they stay the full
// session sums (that is the whole point of whole-session windowing).
function applyWindow(rows: SessionRow[], since?: string, until?: string): SessionRow[] {
  if (since === undefined && until === undefined) return rows;
  return rows.filter((row) => {
    const ymd = row.lastActivity.replace(/-/g, "");
    if (since !== undefined && ymd < since) return false;
    if (until !== undefined && ymd > until) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// /api/sessions
// ---------------------------------------------------------------------------

// Fold ONE event into the session-keyed bucket map — the exact per-event body
// of `aggregateSessions`' loop, exported so the report cache (#113) can refold
// a single dirty bucket from its own events with byte-identical arithmetic.
// Callers must present events in store sort order (ascending timestamp, ties
// by store insertion order); an unparseable timestamp is dropped whole.
export function foldSessionEvent(
  buckets: Map<string, SessionBucket>,
  event: StoredEvent,
  mode: CostMode,
  timeZone: string,
): void {
  const date = localDate(event.timestamp, timeZone);
  // An unparseable timestamp is dropped — the established invariant (see
  // `daily.ts::rowsByDate`). It can never contribute a `lastActivity`.
  if (date === null) return;
  let bucket = buckets.get(event.sessionId);
  if (!bucket) {
    bucket = emptyBucket(event.projectSlug);
    buckets.set(event.sessionId, bucket);
  }
  foldEvent(bucket, event, mode, date.dashed);
}

// Flush finished buckets into the wire response — the exact assembly tail of
// `aggregateSessions` (pre-order sort, window post-filter, stable cost sort),
// exported for the report cache (#113). Bucket iteration order does not matter:
// the `(projectPath, sessionId)` pre-sort makes the output deterministic.
export function assembleSessions(
  buckets: Map<string, SessionBucket>,
  since?: string,
  until?: string,
): SessionsResponse {
  // Flush in `(projectPath, sessionId)`-ascending order — the deterministic
  // pre-order the stable cost-descending sort below relies on (module header,
  // ROW ORDERING).
  const rows = Array.from(buckets.entries())
    .map(([sessionId, bucket]) => flushRow(sessionId, bucket))
    .sort(
      (a, b) =>
        a.projectPath.localeCompare(b.projectPath) || a.sessionId.localeCompare(b.sessionId),
    );

  // Window-filter, then sort by cost descending. The sort must be stable so
  // display-mode all-zero-cost rows keep the pre-order. `Array.prototype.sort`
  // is stable in V8/JSC, so a plain `b - a` comparator preserves the
  // `(projectPath, sessionId)` pre-order on ties.
  const windowed = applyWindow(rows, since, until);
  windowed.sort((a, b) => b.totalCost - a.totalCost);

  return { sessions: windowed };
}

// Controls beyond the cost mode that shape the `/api/sessions` body.
export type AggregateSessionsOptions = {
  // Inclusive date window, dashless `YYYYMMDD`. Filters which *sessions*
  // appear by each session's `lastActivity`; the surviving sessions keep their
  // full, whole-session token + cost sums (see the module header). An omitted
  // bound is unbounded on that side.
  since?: string;
  until?: string;
  // The IANA zone each session's `lastActivity` local date is bucketed in
  // (ADR-0015) — the request's `tz`. Only consulted via `localDate`; omitted =
  // the host zone.
  timeZone?: string;
};

// TEST-ONLY ORACLE — production-dead (ADR-0057). The shipped path is
// foldSessionEvent + assembleSessions through the report cache.
//
// Aggregate a store query result into the `/api/sessions` response body.
//
// `events` must be the *unwindowed* event set — the project and model filter
// axes may have been applied by the store query. The date window is a
// post-filter on `lastActivity` (`options.since` / `options.until`), NOT a
// store-query filter, because each session's totals are whole-session sums
// (module header). The model filter is a store-query axis (ADR-0017).
//
// This function groups by `sessionId`, costs, sums, resolves each session's
// real `path`, then window-filters and sorts by `totalCost` descending over a
// `(projectPath, sessionId)`-ascending pre-order — i.e. it is exactly
// `foldSessionEvent` over every timestamp-sorted event, then
// `assembleSessions`.
export function aggregateSessions(
  events: StoredEvent[],
  mode: CostMode,
  options: AggregateSessionsOptions = {},
): SessionsResponse {
  // The zone each `lastActivity` date is bucketed in (ADR-0015); host by default.
  const timeZone = options.timeZone ?? defaultTimeZone();

  // Group timestamp-sorted events into session-keyed buckets.
  const buckets = new Map<string, SessionBucket>();
  for (const event of byTimestamp(events)) {
    foldSessionEvent(buckets, event, mode, timeZone);
  }

  return assembleSessions(buckets, options.since, options.until);
}
