import type {
  CostMode,
  DailyByMachineResponse,
  DailyByProjectResponse,
  DailyResponse,
  ProjectRow,
  SessionsResponse,
} from "@maxprice/shared";
import type { MachineAcc, SlugAcc } from "./daily";
import {
  assembleMachineRows,
  assembleSlugRows,
  emptyMachineAcc,
  emptySlugAcc,
  flushDailyRows,
  foldDailyEvent,
  foldMachineEvent,
  foldSlugEvent,
  sumDailyTotals,
} from "./daily";
import { localDate } from "./local-date";
import type { ModelRollup } from "./model-rollup";
import type { ProjectBucket } from "./projects";
import { assembleProjects, foldProjectEvent } from "./projects";
import type { SessionBucket } from "./sessions";
import { assembleSessions, foldSessionEvent } from "./sessions";
import type { EventStore, StoreChange, StoredEvent } from "./store";
import { compileAxisMatcher } from "./store";
import { defaultTimeZone } from "./timezone";

// #113 / ADR-0057 — the dirty-bucket report cache.
//
// Every report endpoint used to re-aggregate the WHOLE store per request. This
// cache makes report cost proportional to what CHANGED instead: it partitions a
// store query result into per-report-row buckets (a sessionId for the sessions
// family), keeps each bucket's member events in its OWN sorted array (the
// store's `query` result is READ-ONLY — nothing here ever mutates a
// `StoredEvent` or a store-returned array), and memoizes each bucket's folded
// accumulator. The store's change feed (`onChanged`, E4) marks only the touched
// buckets dirty; a query refolds exactly those and re-assembles the response
// from the memoized rest. Entries live per FAMILY (one per report kind —
// sessions, projects, and the three unbounded dailies: daily, daily-by-project,
// daily-by-machine), keyed on the JSON-encoded canonicalized filter axes
// (mode, tz, projects, models, machines — see `familyKey` for why JSON) plus
// an optional family-specific `extra` component. A per-family LRU (delete+set
// touch) caps entries at MAX_ENTRIES.
//
// WHERE THE DATE WINDOW LIVES differs by family, BY DESIGN — don't unify:
//   - sessions: NOT in the key. Windowing is a whole-session row post-filter
//     applied at ASSEMBLY (see sessions.ts), so one entry serves every window
//     and a window change costs zero refolds.
//   - projects: IN the key (`w:<since>..<until>`). The in-window partition
//     happens PER EVENT inside `foldProjectEvent` — each bucket carries a
//     range rollup AND an all-time rollup side by side — so an acc is only
//     valid for the window it was folded under; two windows are two entries.
//   - daily: NO window at all. The cache serves only UNBOUNDED queries (the
//     handler routes bounded ones to the direct aggregator path — a windowed
//     daily is a store-level date filter, and caching per window would
//     fragment entries for no reuse). Its `extra` instead carries the
//     totals-omission rule: `pfc:multi|single` from the RAW repeated-param
//     project count — duplicates NOT deduped for this rule, even though
//     canonicalization dedupes the filter SET — because `project=A&project=A`
//     omits `totals` today and must keep doing so; assembly omits `totals`
//     on a `multi` entry.
//   - daily-by-project / daily-by-machine: unbounded-only, like daily. The
//     by-project key carries no `extra` at all; by-machine's `extra` is the
//     `ip:1|ip:0` nesting axis — `includeProjects` changes the FOLD SHAPE
//     (nested per-slug sub-accs), so unlike daily's assembly-time pfc rule
//     the two variants can never share an acc.
//
// THE DAILY-SPLIT BUCKET GRAIN. The by-project family's bucket is the WHOLE
// slug — never slug×date. The pure path (`aggregateDailyByProject`) folds each
// slug's events as ONE sequential fold, capturing the slug's first non-empty
// `cwd` in the same walk; assembling a slug from per-date partials would make
// float-order byte-parity rest on a proof that no emitted sum spans a date
// (and still have to coordinate the slug-wide cwd capture across buckets).
// The whole-slug grain keeps the ONE invariant every family shares — each acc
// is one clean fold of the pure path's exact event sequence — at the cost that
// an append to a slug refolds that slug's whole history: O(slug), not O(date),
// by design. The by-machine family is the same rule on the machineId axis,
// its nested per-slug sub-accs fed by the same event walk (reproducing the
// pure path's literal "aggregateDailyByProject over that machine's events").
// Uniquely, these two families bucket with NO localDate gate: the pure path
// groups by slug/machine BEFORE its fold drops unparseable timestamps, so such
// an event's `cwd` still feeds the slug's first-cwd capture — the bucket must
// contain it. `foldDailyEvent` drops it from every rollup, and a bucket whose
// EVERY member is unparseable assembles to no entry (the rows-empty skip).
// Like the other three families, these two hold NO tail of their own: the
// accumulators and assemblers (`SlugAcc`/`foldSlugEvent`/`assembleSlugRows`,
// `MachineAcc`/`foldMachineEvent`/`assembleMachineRows`) live in `daily.ts`
// beside the aggregators that also run them, so a cached response and a pure
// one come out of literally the same code.
//
// THE SEQ-STAMPING RULE. Buckets must fold events in the store's stable sort
// order — ascending timestamp, ties by map-insertion order — or first-seen
// `modelsUsed` ordering and float-sum byte-parity break. Map-insertion order is
// not readable off an event, so the cache replicates it as a per-object seq in
// a WeakMap: rebind stamps the FULL current snapshot in one walk of the
// store's `stampInsertionOrder()` — MAP order, never the sorted `query()` — and the
// feed handler stamps EVERY change before any entry work — a new key gets
// `nextSeq++` (map-append: sorts after ties, exactly like the store), a
// replacement INHERITS `seq(replaced)` (`Map.set` keeps the original position,
// so the replacement must keep the original tie rank). Seqs must encode MAP
// rank, because inheritance keeps a stamp alive across replacements that may
// change the timestamp: under map-rank seqs, (timestamp, seq) === the store's
// stable sort (which tie-breaks by exactly that map rank) no matter what
// timestamp a replacement carries. A sorted-walk pre-stamp ranks DIFFERENT
// timestamps by time, so a replacement that moved its timestamp onto an
// exact-ms tie inherited a meaningless rank and folded in the wrong tie order
// (the pinned "moves onto an exact tie" regression test). Stamping is
// unconditional — even with zero live entries — because a later entry's
// buckets will binary-insert these same objects by (timestamp, seq).
//
// THE REBIND RULE. `onChanged` is per-store, and the fleet path swaps the
// whole EventStore in-session — so every public method starts with a
// synchronous `rebind()`: if `getStore()` returns a different store, it
// unsubscribes the old feed, clears ALL family entries (a swapped store is a
// different corpus), resubscribes, and pre-stamps the new store's full sorted
// snapshot BEFORE any await can let feed batches interleave. The store's
// initial scan emits feed batches before `ready` resolves; the rebind-time
// full-snapshot pre-stamp makes subscription timing irrelevant — anything
// already in the store is stamped by the walk, anything later is stamped by
// the feed.
//
// THE SINGLE-FLIGHT WORK CHAIN. Each entry serializes its cold build, refolds,
// and assembly on `entry.work` — a promise chain every query appends to — so
// two concurrent queries against one entry never interleave their fold work,
// and a second query simply reuses the first's completed build. The chain
// itself always resolves: a rejected build propagates to (only) its own
// caller, and the rejection handler resets the entry to cold (fresh bucket
// map, `built = false`) so one failed query can never poison the entry with a
// half-populated partition.
//
// HOW ASSEMBLY STAYS ATOMIC. `refoldDirty` sweeps until a full pass finds
// nothing dirty (a batch landing during a chunk yield re-dirties its bucket
// mid-refold — the next sweep picks it up before the clean pass can end), and
// then, SYNCHRONOUSLY with that clean pass, snapshots the proven-clean accs
// into a plain map and RETURNS it. The assembly consumes that snapshot, not
// `entry.buckets`. The snapshot is the guarantee — NOT turn ordering: awaiting
// `refoldDirty` puts a microtask hop between the clean pass and the assembly,
// and store mutations here really are microtask continuations (the scan's
// append storm after `await Promise.all(workers)`, `appendFleet` after `await
// attached.load()`, event-sync's page apply after `await fetch`). A batch in
// that gap runs `applyChanges`, which NULLS `bucket.acc` on any membership
// change — so an assembler re-reading the live buckets would skip the nulled
// bucket and OMIT ITS ROW ENTIRELY (a whole session vanishing from a response,
// not merely lagging). Residual, stated plainly: a batch landing in the gap is
// reflected in the NEXT query, never dropped from this one. Snapshotting refs
// is sound because accs are immutable once installed — a refold builds a fresh
// acc and swaps it in, and `applyChanges` only nulls the slot (REFOLDS BUILD A
// FRESH ACCUMULATOR, below). One further caveat: an entry evicted or orphaned
// (LRU / store swap) mid-build stops receiving the feed and answers its
// in-flight query from the build-time snapshot — stale at most once, since the
// next query gets a fresh entry.
//
// COLD BUILD ONLY PARTITIONS. It pushes the (already sorted) store query
// result into buckets, marking every bucket dirty; `refoldDirty` does ALL
// folding — one chunked code path (`chunkSize` events per event-loop yield)
// for cold and warm alike. Feed batches that land while a build is IN FLIGHT
// (`entry.building`) buffer in `entry.pending` (copied element-by-element — the
// feed hands the LIVE batch array) and replay through `applyChanges` after the
// partition. A cold entry with NO build in flight buffers nothing: such changes
// are already in the store when its next cold build takes its snapshot, so
// buffering them would only make a failed build's parked entry (the rejection
// handler resets it to cold and leaves it in the family) accumulate every later
// change — and pin each `replaced` event — for the process lifetime.
// A pending change may overlap the build's snapshot (the batch applied to the
// store before the snapshot was taken), so the bucket ops are idempotent:
// `binaryInsert` skips when the (timestamp, seq) key is already resident —
// same object or a replacement-chain sibling, which in-order replay always
// heals — and `binaryRemove` removes only the exact object it was asked for.
//
// REFOLDS BUILD A FRESH ACCUMULATOR. A refold folds the bucket's events into a
// brand-new tmp map and swaps the result in — NEVER into a retained acc. Two
// invariants depend on this: float sums are order-sensitive (byte-parity with
// the pure aggregators requires each acc to be one clean fold in (timestamp,
// seq) order), and `assembleSessions`' flushed rows alias the buckets' live
// `ModelBreakdown` objects — folding into a retained bucket would retroactively
// mutate previously-emitted responses.

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type ReportFilters = {
  mode: CostMode;
  // Resolved to `defaultTimeZone()` at the cache boundary.
  timeZone?: string;
  projects: string[];
  models: string[];
  machines: string[];
};

export type ReportCache = {
  sessions(q: ReportFilters & { since?: string; until?: string }): Promise<SessionsResponse>;
  projects(q: ReportFilters & { since?: string; until?: string }): Promise<{
    projects: ProjectRow[];
  }>;
  // Unbounded ONLY — no since/until: the handler routes bounded queries to the
  // direct aggregator path (module header). `projectFilterCount` is the RAW
  // repeated-param project count, BEFORE canonicalization dedupes the set.
  daily(q: ReportFilters & { projectFilterCount: number }): Promise<DailyResponse>;
  // Unbounded ONLY, like daily (module header).
  dailyByProject(q: ReportFilters): Promise<DailyByProjectResponse>;
  // Unbounded ONLY. `includeProjects` (the machine+project group-by cross) is
  // a KEY axis — it changes the fold shape, not just assembly (module header).
  dailyByMachine(q: ReportFilters & { includeProjects: boolean }): Promise<DailyByMachineResponse>;
};

// Test-only fold counter: total events folded by any cache instance since
// reset. The O(dirty) tests pin refold cost against it.
export const foldCounter = { count: 0 };

// Per-family LRU cap: at most this many distinct filter combinations stay
// warm. An evicted entry is simply unreachable — the feed stops updating it,
// and the next query for its key rebuilds cold.
const MAX_ENTRIES = 4;

// After this many `refoldDirty` sweeps without a clean pass, warn ONCE per call
// (see the `passes === SWEEP_WARN_PASSES` check — `>=` would spam). Pure
// instrumentation: sustained ingest re-dirtying buckets mid-refold is the one
// way this loop stays hot, and the packaged build's `sidecar.log` (ADR-0056)
// tees stdout, so the next such incident leaves a durable trace instead of
// nothing.
//
// THERE IS DELIBERATELY NO BOUND ON THE SWEEP. Assembling from "whatever is
// clean" is not a stale-number degrade, it is a DROPPED ROW: `applyChanges`
// nulls `bucket.acc` on any membership change, and the snapshot loop below
// copies only non-null accs — so a bucket left dirty by a bound is ABSENT from
// the returned map and the assembler emits no row for it (a whole
// session/project silently vanishing from a response). The sweep must run to a
// genuinely clean pass.
const SWEEP_WARN_PASSES = 8;

const yieldToLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Canonical query + family key
// ---------------------------------------------------------------------------

// The canonicalized query: tz resolved, projects/machines sorted+deduped,
// models sorted+deduped+LOWERCASED (`matchesModelFilter` is case-insensitive,
// so lowercasing is semantics-preserving and folds spelling variants of the
// same filter onto one cache entry). `since`/`until` ride along — never part
// of the BASE key, but a window-in-key family (projects) encodes them via the
// `extra` component and reads them at fold time (module header).
type Canon = {
  mode: CostMode;
  timeZone: string;
  projects: string[];
  models: string[];
  machines: string[];
  since?: string;
  until?: string;
  // The by-machine nesting flag — rides along like the window fields: only
  // `dailyByMachine` sets it, and that family both keys on it (`ip:` extra)
  // and reads it at fold time from `entry.q` (module header).
  includeProjects?: boolean;
};

function canonicalize(
  q: ReportFilters & { since?: string; until?: string; includeProjects?: boolean },
): Canon {
  return {
    mode: q.mode,
    timeZone: q.timeZone ?? defaultTimeZone(),
    projects: [...new Set(q.projects)].sort(),
    models: [...new Set(q.models.map((m) => m.toLowerCase()))].sort(),
    machines: [...new Set(q.machines)].sort(),
    since: q.since,
    until: q.until,
    includeProjects: q.includeProjects,
  };
}

// The JSON-encoded axis tuple (+ "|extra" for families that need a
// family-specific key component: the projects window, the daily pfc rule).
// JSON, not a `,`/`|` join, so the key is INJECTIVE: every array element is
// quote-escaped, so a filter value containing a would-be delimiter can't
// collide two keys (`?project=a,b` vs `project=a&project=b` were ONE key under
// the old join — the second query answered from the first's corpus). The base
// is a complete JSON array — self-delimiting, never a prefix of another — so
// appending `|extra` keeps (base, extra) pairs injective too. Window fields
// never contribute on their own — a family that keys on the window says so
// explicitly through `extra`.
function familyKey(c: Canon, extra?: string): string {
  const base = JSON.stringify([c.mode, c.timeZone, c.projects, c.models, c.machines]);
  return extra === undefined ? base : `${base}|${extra}`;
}

// ---------------------------------------------------------------------------
// Bucket membership arrays — (timestamp, seq)-ordered binary insert/remove
// ---------------------------------------------------------------------------

type SeqOf = (e: StoredEvent) => number;

// The bucket order: ascending timestamp, ties by seq — the store's stable sort
// order (see THE SEQ-STAMPING RULE). Plain string compare on ISO timestamps.
function compareEvents(a: StoredEvent, b: StoredEvent, seqOf: SeqOf): number {
  return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : seqOf(a) - seqOf(b);
}

// Lower bound: the first index whose element sorts >= `e`.
function lowerBound(events: StoredEvent[], e: StoredEvent, seqOf: SeqOf): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const at = events[mid];
    if (at !== undefined && compareEvents(at, e, seqOf) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Insert `e` at its (timestamp, seq) position. Returns false — untouched —
// when an element with the SAME key is already resident: either `e` itself
// (a pending-replay overlap re-offering a snapshot member) or its
// replacement-chain sibling (same inherited seq; one dedup key must never
// occupy two rows, and in-order replay converges the resident to the store's
// live row — see the module header's idempotence note).
function binaryInsert(events: StoredEvent[], e: StoredEvent, seqOf: SeqOf): boolean {
  const at = lowerBound(events, e, seqOf);
  const resident = events[at];
  if (resident !== undefined && compareEvents(resident, e, seqOf) === 0) return false;
  events.splice(at, 0, e);
  return true;
}

// Remove exactly the object `e` — located by binary search on its unique
// (timestamp, seq) key, then verified by IDENTITY: a pending-replay overlap
// can ask to remove a `replaced` that was never resident (or whose key slot
// holds its chain successor), and that must be a tolerated miss, never the
// removal of a different object. Returns whether anything was removed.
function binaryRemove(events: StoredEvent[], e: StoredEvent, seqOf: SeqOf): boolean {
  const at = lowerBound(events, e, seqOf);
  if (events[at] !== e) return false;
  events.splice(at, 1);
  return true;
}

// ---------------------------------------------------------------------------
// Entries and families
// ---------------------------------------------------------------------------

// One bucket: its member events in (timestamp, seq) order — the cache's OWN
// array, binary-maintained — and the memoized fold result. `dirty` means `acc`
// is stale (or never folded); `acc === null` on a clean bucket means the fold
// produced no row.
type BucketState<Acc> = {
  events: StoredEvent[];
  acc: Acc | null;
  dirty: boolean;
};

// One cached filter combination within a family.
type Entry<Acc> = {
  // The canonicalized query the key was built from. Fold paths read only the
  // keyed axes. Window-at-assembly families strip the window fields so nothing
  // can accidentally depend on the CREATING query's window (each assembly
  // applies its own); a window-in-key family RETAINS them — there the window
  // IS a keyed axis, read by every refold.
  q: Canon;
  // The store-query filter predicate, compiled once at entry creation from the
  // very axes the cold build's `store.query` uses; `null` = every axis is
  // unfiltered (this entry's corpus is the whole store).
  matches: ((e: StoredEvent) => boolean) | null;
  buckets: Map<string, BucketState<Acc>>;
  built: boolean;
  // A cold build is in flight: `pending` bridges the gap between the build's
  // `store.query` snapshot and `built`. A cold entry with NO build in flight
  // needs no buffer — its next cold build reads the live store — so the feed
  // must not accumulate into it (a failed build parks an entry exactly there).
  building: boolean;
  // Feed batches buffered while the cold build is in flight, replayed through
  // `applyChanges` once the partition lands.
  pending: StoreChange[];
  // The per-entry serialization chain (single-flight). Always resolves; see
  // `runQuery` for the rejection-reset contract.
  work: Promise<void>;
};

// One in-flight refold of one bucket: a fresh accumulator the caller drives
// event-by-event (so the chunked yield lives in ONE place, `refoldDirty`),
// then finishes into the bucket's acc.
type Refolder<Acc> = {
  fold(e: StoredEvent): void;
  finish(bucketKey: string): Acc | null;
};

// One report family: its LRU'd entries plus the family-specific pieces —
// whether the date window is a keyed axis (module header: WHERE THE DATE
// WINDOW LIVES), which bucket an event belongs to, and how a bucket refolds.
type Family<Acc> = {
  entries: Map<string, Entry<Acc>>;
  // true ⇒ the window rides the entry key (via `extra`) AND survives into
  // `entry.q` for the fold; false ⇒ stripped at entry creation.
  windowInKey: boolean;
  bucketOf(e: StoredEvent, q: Canon): string | null;
  beginRefold(q: Canon): Refolder<Acc>;
};

// ---------------------------------------------------------------------------
// createReportCache
// ---------------------------------------------------------------------------

export function createReportCache(opts: {
  getStore: () => EventStore;
  // Yield to the event loop after this many events folded (default 8192).
  // Injectable so tests can force yielding on small corpora.
  chunkSize?: number;
}): ReportCache {
  const chunkSize = opts.chunkSize ?? 8192;

  let boundStore: EventStore | null = null;
  let unsubscribe: (() => void) | null = null;

  // The seq stamps (see THE SEQ-STAMPING RULE). WeakMap keyed on the exact
  // StoredEvent objects — a replaced object's stamp dies with it.
  const seq = new WeakMap<StoredEvent, number>();
  let nextSeq = 0;

  const seqOf: SeqOf = (e) => {
    const s = seq.get(e);
    // Unreachable when the stamping rule holds: every object a bucket can
    // contain came off a pre-stamped snapshot or a stamped feed batch.
    if (s === undefined) throw new Error("report-cache: unstamped StoredEvent");
    return s;
  };

  // --- the sessions family -------------------------------------------------

  const sessionsFamily: Family<SessionBucket> = {
    entries: new Map(),
    // Windowing is a whole-session assembly-time row post-filter — one entry
    // serves every window (module header).
    windowInKey: false,
    // A session bucket is the sessionId; an unparseable timestamp has no
    // bucket at all (the fold would drop it anyway — see foldSessionEvent).
    // `localDate` is memoized per (zone, timestamp), so this is cheap on the
    // partition pass's repeats.
    bucketOf: (e, q) => (localDate(e.timestamp, q.timeZone) === null ? null : e.sessionId),
    beginRefold: (q) => {
      // Fresh tmp map per refold — NEVER a retained acc (module header:
      // REFOLDS BUILD A FRESH ACCUMULATOR).
      const tmp = new Map<string, SessionBucket>();
      return {
        fold: (e) => foldSessionEvent(tmp, e, q.mode, q.timeZone),
        // Every event in the bucket shares its sessionId, so the fold lands in
        // exactly one tmp slot; `?? null` covers the empty fold.
        finish: (bucketKey) => tmp.get(bucketKey) ?? null,
      };
    },
  };

  // --- the projects family -------------------------------------------------

  const projectsFamily: Family<ProjectBucket> = {
    entries: new Map(),
    // The window IS a keyed axis (`w:<since>..<until>` extra): the fold
    // partitions each event into the range vs all-time rollup against the
    // entry's own `since`/`until`, so an acc is window-specific and `entry.q`
    // must retain the bounds (module header: WHERE THE DATE WINDOW LIVES).
    windowInKey: true,
    // A project bucket is the slug; an unparseable timestamp has no bucket at
    // all (`foldProjectEvent` drops it before it touches any accumulator).
    bucketOf: (e, q) => (localDate(e.timestamp, q.timeZone) === null ? null : e.projectSlug),
    beginRefold: (q) => {
      // Fresh tmp map per refold — NEVER a retained acc (module header:
      // REFOLDS BUILD A FRESH ACCUMULATOR; `flushRow`'s modelBreakdowns alias
      // the bucket's live ModelBreakdown objects, like sessions').
      const tmp = new Map<string, ProjectBucket>();
      return {
        fold: (e) => foldProjectEvent(tmp, e, q.mode, q.timeZone, q.since, q.until),
        // Every event in the bucket shares its slug, so the fold lands in
        // exactly one tmp slot; `?? null` covers the empty fold. An
        // all-out-of-window bucket still yields a non-null acc (all-time
        // rollup only) — `assembleProjects`' inclusion rule drops it, exactly
        // like the pure path.
        finish: (bucketKey) => tmp.get(bucketKey) ?? null,
      };
    },
  };

  // --- the unbounded-daily family ------------------------------------------

  const dailyFamily: Family<ModelRollup> = {
    entries: new Map(),
    // No window at all — the cache serves only unbounded `/api/daily` queries
    // (module header); the key's `extra` is the `pfc:` totals rule instead.
    windowInKey: false,
    // A daily bucket is the event's local calendar date in the entry's zone;
    // an unparseable timestamp has no bucket (`foldDailyEvent` drops it).
    bucketOf: (e, q) => localDate(e.timestamp, q.timeZone)?.dashed ?? null,
    beginRefold: (q) => {
      // Fresh tmp map per refold — NEVER a retained acc (module header).
      const tmp = new Map<string, ModelRollup>();
      return {
        fold: (e) => foldDailyEvent(tmp, e, q.mode, q.timeZone),
        // Every event in the bucket shares its date — one tmp slot; `?? null`
        // covers the empty fold.
        finish: (bucketKey) => tmp.get(bucketKey) ?? null,
      };
    },
  };

  // --- the daily-by-project family -----------------------------------------

  const dailyByProjectFamily: Family<SlugAcc> = {
    entries: new Map(),
    // Unbounded-only, like daily (module header) — no window anywhere.
    windowInKey: false,
    // The bucket is the WHOLE slug — EVERY event of the slug, unparseable
    // timestamps included: no localDate gate, unlike the other families
    // (module header: THE DAILY-SPLIT BUCKET GRAIN). The pure path groups by
    // slug before its fold drops such events, so their `cwd` still feeds the
    // slug's path capture; gating here was the codebase's one cache-vs-pure
    // divergence.
    bucketOf: (e) => e.projectSlug,
    beginRefold: (q) => {
      // Fresh acc per refold — NEVER retained (module header). Every event in
      // the bucket shares its slug, so ONE acc serves the whole refold.
      // `foldSlugEvent` captures the `cwd` BEFORE the daily fold drops an
      // unparseable timestamp, so an all-unparseable bucket yields an acc
      // with empty rollups — `assembleSlugRows`' rows-empty skip drops it,
      // exactly like the pure path.
      const acc = emptySlugAcc();
      return {
        fold: (e) => foldSlugEvent(acc, e, q.mode, q.timeZone),
        finish: () => acc,
      };
    },
  };

  // --- the daily-by-machine family -----------------------------------------

  const dailyByMachineFamily: Family<MachineAcc> = {
    entries: new Map(),
    // Unbounded-only, like daily — the `ip:` extra is the key's only axis
    // beyond the base filters.
    windowInKey: false,
    // The bucket is the whole machineId — unparseable timestamps included, no
    // localDate gate, for the same reason as the by-project family (module
    // header: THE DAILY-SPLIT BUCKET GRAIN, transposed to the machine axis):
    // the nested per-slug sub-accs' cwd capture must see every event.
    bucketOf: (e) => e.machineId,
    beginRefold: (q) => {
      // Fresh acc per refold — NEVER retained (module header). The machine
      // rollups and each nested slug sub-acc are independent accumulators fed
      // by the same (timestamp, seq) walk — `foldMachineEvent` IS the pure
      // path's per-machine body.
      const acc = emptyMachineAcc(q.includeProjects === true);
      return {
        fold: (e) => foldMachineEvent(acc, e, q.mode, q.timeZone),
        finish: () => acc,
      };
    },
  };

  // Every family, for the feed handler's fan-out. (Family<X> is assignable to
  // Family<unknown>: the feed path only partitions/marks, never reads accs.)
  const families: Array<Family<unknown>> = [
    sessionsFamily,
    projectsFamily,
    dailyFamily,
    dailyByProjectFamily,
    dailyByMachineFamily,
  ];

  // --- rebind (THE REBIND RULE) --------------------------------------------

  function rebind(): void {
    const store = opts.getStore();
    if (store === boundStore) return;
    unsubscribe?.();
    // A swapped store is a different corpus — every entry is invalid.
    for (const family of families) family.entries.clear();
    boundStore = store;
    unsubscribe = store.onChanged(handleChanges);
    // Pre-stamp: assign seq to the FULL current snapshot in MAP-INSERTION
    // order (THE SEQ-STAMPING RULE — seqs must encode map rank, or a
    // replacement's inherited seq mis-ranks a moved-timestamp tie),
    // synchronously, before ANY await can let feed events interleave. Feed
    // stamps issued later are strictly greater, matching map-append order for
    // new keys. The STORE drives the walk (`stampInsertionOrder`), so no live
    // iterator over its private dedup map ever escapes to this side.
    store.stampInsertionOrder((e) => {
      if (!seq.has(e)) seq.set(e, nextSeq++);
    });
  }

  // --- the change feed -----------------------------------------------------

  function handleChanges(changes: readonly StoreChange[]): void {
    // Stamp ALWAYS, before any entry work, even with zero entries: a later
    // entry's binary inserts key on these stamps. New key → nextSeq++
    // (map-append sorts after ties); replacement → seq(replaced) (Map.set
    // keeps the original position, so the tie rank is inherited).
    for (const { event, replaced } of changes) {
      const inherited = replaced === null ? undefined : seq.get(replaced);
      seq.set(event, inherited ?? nextSeq++);
    }
    // HARDENING, not a bug fix: no throw can reach here today — `rebind`
    // pre-stamps the full snapshot synchronously (so `seqOf` cannot miss), and
    // an invalid `tz` is 400-rejected at the HTTP boundary long before it can
    // reach a fold. But the store deliberately swallows a listener throw so a
    // downstream cache can never break ingest, which leaves the CACHE owing
    // itself a compensating action: a partial fan-out would leave earlier
    // entries applied and later ones not, every one of them still `built`,
    // serving wrong numbers for the process lifetime. Abort the fan-out and
    // clear everything instead — the next query rebuilds cold, which is the
    // same blessed degrade an evicted/orphaned entry already takes.
    try {
      for (const family of families) {
        for (const entry of family.entries.values()) {
          if (entry.built) {
            applyChanges(family, entry, changes);
          } else if (entry.building) {
            // A build is in flight: this batch may post-date its `store.query`
            // snapshot, so buffer it for the post-partition replay. Copy
            // element-by-element: the feed hands the LIVE batch array, and
            // `pending` outlives this call. (No spread — a scan batch can be a
            // whole file's rows, and spread argument counts have a stack limit.)
            for (const change of changes) entry.pending.push(change);
          }
          // else: cold with NO build in flight — DROP the change. It is already
          // in the store, so the next `coldBuild`'s `store.query` snapshot
          // contains it; `pending` only ever existed to bridge batches landing
          // AFTER that snapshot. Buffering here is what let a failed build (the
          // rejection handler resets `built = false` and leaves the entry in
          // the family) park an entry that then accumulated every subsequent
          // change — and pinned each `replaced` event — for the process life.
        }
      }
    } catch (err) {
      console.error("[report-cache] change feed threw; dropping every cached entry:", err);
      // Clear AFTER aborting the loop, never mid-iteration.
      for (const family of families) family.entries.clear();
    }
  }

  // Does `e` belong to this entry's corpus? This IS the store-query filter
  // predicate (`compileAxisMatcher`), compiled at entry creation from the same
  // axes the cold build hands `store.query` — so the built corpus and the
  // incrementally-fed one cannot drift apart. `null` = unfiltered, everything
  // belongs. No date axis appears: cached families are unbounded at the store
  // level (module header: WHERE THE DATE WINDOW LIVES).
  function entryMatches<Acc>(entry: Entry<Acc>, e: StoredEvent): boolean {
    return entry.matches === null || entry.matches(e);
  }

  // Apply one batch of store changes to a built entry: un-bucket each
  // displaced row, bucket each new/replacing row, dirty what was touched.
  // Buckets are marked dirty only when their membership actually changed — a
  // tolerated pending-replay miss (see binaryInsert/binaryRemove) costs no
  // refold.
  function applyChanges<Acc>(
    family: Family<Acc>,
    entry: Entry<Acc>,
    changes: readonly StoreChange[],
  ): void {
    for (const { event, replaced } of changes) {
      if (replaced !== null && entryMatches(entry, replaced)) {
        const key = family.bucketOf(replaced, entry.q);
        if (key !== null) {
          const bucket = entry.buckets.get(key);
          if (bucket !== undefined && binaryRemove(bucket.events, replaced, seqOf)) {
            bucket.acc = null;
            bucket.dirty = true;
            if (bucket.events.length === 0) entry.buckets.delete(key);
          }
        }
      }
      if (entryMatches(entry, event)) {
        const key = family.bucketOf(event, entry.q);
        if (key !== null) {
          let bucket = entry.buckets.get(key);
          if (bucket === undefined) {
            bucket = { events: [], acc: null, dirty: true };
            entry.buckets.set(key, bucket);
          }
          if (binaryInsert(bucket.events, event, seqOf)) {
            bucket.acc = null;
            bucket.dirty = true;
          }
        }
      }
    }
  }

  // --- entry lifecycle -----------------------------------------------------

  function getOrCreateEntry<Acc>(family: Family<Acc>, c: Canon, extra?: string): Entry<Acc> {
    const key = familyKey(c, extra);
    const existing = family.entries.get(key);
    if (existing !== undefined) {
      // LRU touch: delete+set moves the entry to the back of eviction order.
      family.entries.delete(key);
      family.entries.set(key, existing);
      return existing;
    }
    if (family.entries.size >= MAX_ENTRIES) {
      const oldest = family.entries.keys().next().value;
      if (oldest !== undefined) family.entries.delete(oldest);
    }
    const entry: Entry<Acc> = {
      // Window fields stripped unless the family keys on the window — there
      // every query hitting this entry shares the bounds and the fold reads
      // them (Entry.q comment).
      q: family.windowInKey ? { ...c } : { ...c, since: undefined, until: undefined },
      matches: compileAxisMatcher({ projects: c.projects, models: c.models, machines: c.machines }),
      buckets: new Map(),
      built: false,
      building: false,
      pending: [],
      work: Promise.resolve(),
    };
    family.entries.set(key, entry);
    return entry;
  }

  // Cold build: PARTITION ONLY (module header). The store snapshot is already
  // in (timestamp, seq) order — the pre-stamp/feed rules guarantee it — so a
  // plain push keeps every bucket sorted. Every touched bucket starts dirty;
  // `refoldDirty` does all the folding. The snapshot array is never mutated by
  // the store (appends build a NEW snapshot), so iterating it across yields is
  // safe; rows that land mid-build arrive via `pending` and replay after.
  async function coldBuild<Acc>(family: Family<Acc>, entry: Entry<Acc>): Promise<void> {
    // Open the buffering window as the FIRST statement — before the snapshot
    // below, with nothing but synchronous code in between, so no feed batch can
    // land between the flag and `store.query` (Entry.building). The `finally`
    // closes it on every exit, success or throw: a cold entry with no build in
    // flight must not accumulate `pending`.
    entry.building = true;
    try {
      const store = boundStore;
      if (store === null) throw new Error("report-cache: coldBuild before rebind");
      const events = store.query({
        projects: entry.q.projects,
        models: entry.q.models,
        machines: entry.q.machines,
      });
      let sinceYield = 0;
      for (const e of events) {
        const key = family.bucketOf(e, entry.q);
        if (key === null) continue;
        let bucket = entry.buckets.get(key);
        if (bucket === undefined) {
          bucket = { events: [], acc: null, dirty: true };
          entry.buckets.set(key, bucket);
        }
        bucket.events.push(e);
        sinceYield += 1;
        if (sinceYield >= chunkSize) {
          sinceYield = 0;
          await yieldToLoop();
        }
      }
      entry.built = true;
      const pending = entry.pending;
      entry.pending = [];
      applyChanges(family, entry, pending);
    } finally {
      entry.building = false;
    }
  }

  // Refold every dirty bucket, chunked: one shared fold counter across the
  // whole pass yields to the event loop every `chunkSize` folds — yielding
  // mid-bucket is safe because the refolder's accumulator persists across the
  // await and fold order is unchanged. The outer loop sweeps until a full pass
  // finds nothing dirty: a feed batch landing during a yield can re-dirty ANY
  // bucket, including one this pass already refolded. The dirty flag clears
  // BEFORE the fold and the membership is snapshotted (`slice`) — a
  // mid-refold mutation re-marks the bucket, the possibly-stale acc write is
  // overwritten by the next sweep, and nothing reads accs before the clean
  // sweep. The sweep is UNBOUNDED by design and only instrumented — see
  // SWEEP_WARN_PASSES for why a bound would drop rows, not merely stale them.
  //
  // Returns the PROVEN-CLEAN accs (module header: HOW ASSEMBLY STAYS ATOMIC) —
  // built synchronously in the same stretch as the clean pass that proved them
  // clean, because the caller assembles after an await and `applyChanges` nulls
  // `bucket.acc` on any membership change: re-reading `entry.buckets` there
  // would OMIT every row a batch touched in the gap.
  async function refoldDirty<Acc>(
    family: Family<Acc>,
    entry: Entry<Acc>,
  ): Promise<Map<string, Acc>> {
    let sinceYield = 0;
    let passes = 0;
    for (;;) {
      passes += 1;
      // Instrumentation only — never a bound (see SWEEP_WARN_PASSES). `===`, so
      // one line per call rather than one per pass from here on.
      if (passes === SWEEP_WARN_PASSES) {
        console.warn(
          `[report-cache] refold swept ${passes} passes without going clean ` +
            `(${entry.buckets.size} buckets) — sustained ingest is re-dirtying mid-refold`,
        );
      }
      let refolded = false;
      for (const [key, bucket] of entry.buckets) {
        if (!bucket.dirty) continue;
        refolded = true;
        bucket.dirty = false;
        const events = bucket.events.slice();
        const refolder = family.beginRefold(entry.q);
        for (const e of events) {
          refolder.fold(e);
          foldCounter.count += 1;
          sinceYield += 1;
          if (sinceYield >= chunkSize) {
            sinceYield = 0;
            await yieldToLoop();
          }
        }
        bucket.acc = refolder.finish(key);
      }
      if (!refolded) {
        // The clean pass just ended with no await since its first read, so
        // every acc below is current. A `null` acc folded to nothing and
        // produces no row — the assemblers never see it.
        const accs = new Map<string, Acc>();
        for (const [key, bucket] of entry.buckets) {
          if (bucket.acc !== null) accs.set(key, bucket.acc);
        }
        return accs;
      }
    }
  }

  // Run one query on an entry's single-flight chain: cold-build if needed,
  // refold what's dirty, then assemble from the acc SNAPSHOT `refoldDirty`
  // returned (module header: HOW ASSEMBLY STAYS ATOMIC). The chain itself
  // always resolves — a rejection propagates to this caller only, and the
  // chain's rejection handler resets the entry to cold so a half-populated
  // partition can't poison every later query.
  function runQuery<Acc, T>(
    family: Family<Acc>,
    entry: Entry<Acc>,
    assemble: (accs: Map<string, Acc>) => T,
  ): Promise<T> {
    let result!: T;
    const run = entry.work.then(async () => {
      if (!entry.built) await coldBuild(family, entry);
      const accs = await refoldDirty(family, entry);
      result = assemble(accs);
    });
    entry.work = run.then(
      () => undefined,
      () => {
        entry.buckets = new Map();
        entry.built = false;
        // Belt-and-braces: `coldBuild`'s `finally` already cleared this on the
        // throw path. A cold entry with no build in flight buffers nothing, so
        // the reset entry cannot accumulate changes while it waits for a retry.
        entry.building = false;
        entry.pending = [];
      },
    );
    return run.then(() => result);
  }

  // --- public methods ------------------------------------------------------

  async function sessions(
    q: ReportFilters & { since?: string; until?: string },
  ): Promise<SessionsResponse> {
    rebind();
    const c = canonicalize(q);
    const entry = getOrCreateEntry(sessionsFamily, c);
    // The window is an assembly-time row post-filter — one entry, every window.
    return runQuery(sessionsFamily, entry, (accs) => assembleSessions(accs, c.since, c.until));
  }

  async function projects(
    q: ReportFilters & { since?: string; until?: string },
  ): Promise<{ projects: ProjectRow[] }> {
    rebind();
    const c = canonicalize(q);
    // The window rides the key (module header): two windows are two entries,
    // each bucket folded against its own range/all-time partition.
    const entry = getOrCreateEntry(projectsFamily, c, `w:${c.since ?? ""}..${c.until ?? ""}`);
    // Inclusion (>=1 in-window event) + row ordering live in
    // `assembleProjects` — the pure path's exact tail.
    return runQuery(projectsFamily, entry, assembleProjects);
  }

  async function daily(q: ReportFilters & { projectFilterCount: number }): Promise<DailyResponse> {
    rebind();
    const c = canonicalize(q);
    // The RAW repeated-param count decides the totals rule (module header):
    // canonicalization dedupes the SET, so `project=A&project=A` shares
    // `project=A`'s corpus but must live under its own `pfc:multi` key to
    // keep omitting `totals`.
    const multi = q.projectFilterCount >= 2;
    const entry = getOrCreateEntry(dailyFamily, c, `pfc:${multi ? "multi" : "single"}`);
    return runQuery(dailyFamily, entry, (accs) => {
      // `flushDailyRows` sorts by date, so the acc map's iteration order is
      // irrelevant here.
      const daily = flushDailyRows(accs);
      // `sumDailyTotals` folds the date-ascending wire rows, so the float
      // summation order — artifacts and all — is exactly `aggregateDaily`'s.
      return multi ? { daily } : { daily, totals: sumDailyTotals(daily) };
    });
  }

  async function dailyByProject(q: ReportFilters): Promise<DailyByProjectResponse> {
    rebind();
    const c = canonicalize(q);
    const entry = getOrCreateEntry(dailyByProjectFamily, c);
    // Slug ordering, empty-rows skip, and path resolution live in
    // `assembleSlugRows` — the pure path's exact tail.
    return runQuery(dailyByProjectFamily, entry, (accs) => ({ projects: assembleSlugRows(accs) }));
  }

  async function dailyByMachine(
    q: ReportFilters & { includeProjects: boolean },
  ): Promise<DailyByMachineResponse> {
    rebind();
    const c = canonicalize(q);
    // The nesting flag rides the key (module header): `ip:1` and `ip:0` fold
    // different acc shapes, so they are two entries.
    const entry = getOrCreateEntry(dailyByMachineFamily, c, c.includeProjects ? "ip:1" : "ip:0");
    // machineId ordering, empty-rows skip, and the `rows`-then-`projects` field
    // order live in `assembleMachineRows` — the pure path's exact tail.
    return runQuery(dailyByMachineFamily, entry, (accs) => ({
      machines: assembleMachineRows(accs),
    }));
  }

  return { sessions, projects, daily, dailyByProject, dailyByMachine };
}
