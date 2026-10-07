import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  fleetCopySupersedes,
  fleetDedupKey,
  fleetDedupTokenTotal,
  fleetFullnessPartsExceed,
  worktreeSlugPrefix,
  type FleetDedupTokens,
  type FleetEvent,
  type ForgetSessionRef,
} from "@maxprice/shared";
import { identityFromPath, parentSessionPath } from "../identity";
import { collectUsageRecords } from "./jsonl";
import { localDate } from "./local-date";
import {
  eventOrganization,
  NO_DORMANT,
  NO_PRESUMPTION,
  presumedOrganization,
  type Presumption,
} from "./presumption";
import { isInstantBound } from "./range";
import type { ScanCache } from "./scan-cache";
import { defaultTimeZone } from "./timezone";
import type { UsageRecord } from "./types";

// Part 4.5 — E4: the in-memory event store.
//
// The store holds every parsed assistant usage event from every watched root.
// It is filled by an initial full scan (kicked off after the LISTENING
// handshake) and kept fresh by the file watcher's single `flush` path. The
// four aggregators (E5–E8) query it; the endpoint cutover (E9) wires the HTTP
// handlers onto it. Its `StoredEvent` type and `query` interface are a frozen
// contract — E5–E8 depend on both.

// ---------------------------------------------------------------------------
// StoredEvent — the frozen stored-event contract (consumed by E5–E8)
// ---------------------------------------------------------------------------

// One deduplicated assistant usage event, tagged with the project + session it
// belongs to. `UsageRecord` (the E2 parser's output) carries neither — both
// are derived from the JSONL file's path:
//   - `projectSlug` — the `<slug>` directory name under a watched root. This is
//      the Claude Code project slug every report keys on; the aggregators group
//      projects / daily-by-project by it.
//   - `sessionId`   — the session identity (`identityFromPath`): the `<session>`
//      filename for a flat session, or the parent `<session-id>` directory for
//      a nested subagent transcript. The sessions aggregator (E6) groups by it.
//
// The `cwd` for a real project path (ADR-0009) lives on the embedded
// `UsageRecord` — `StoredEvent` does not duplicate it.
//
// `organizationUuid` on a stored row is the RESOLVED Organization (ADR-0098):
// the record's own tag for a parent transcript's row; for a subagent's row,
// the owner the session's owner points name at its timestamp (a subagent
// transcript carries no Attribution evidence of its own, so the parser's tag
// from its copied Login record is ignored — ADR-0109 §5). A row whose
// resolved organization is not a member of the store's tracked set never
// becomes a `StoredEvent` at all — `appendInternal` drops it at the feeder.
// The set generalises ADR-0098's single Home organization (#275); #299
// records it in the ADR. Dormant rows (#311) are refused too, and are not
// foreign. The wire carries the tag (ADR-0103): `storedEventToWire`
// projects it as owner evidence and `appendFleet` reads it back, so a replica
// or archive row keeps the tag its producer resolved. Absent still means "no evidence".
export type StoredEvent = UsageRecord & {
  projectSlug: string;
  sessionId: string;
  // ADR-0041 (M5): REQUIRED machine attribution — never identity (the dedup
  // key stays (messageId, requestId)). Locally-scanned/watched rows are tagged
  // with the machine's own id (loadOrCreateMachineId's value) at append;
  // replica-fed rows carry the hub-minted id. No "undefined = self" sentinel.
  machineId: string;
  // ADR-0089: `Date.parse(timestamp)`, computed ONCE at `upsert` and carried
  // for the row's lifetime. `NaN` when the timestamp is unparseable — the
  // store keeps such rows (dropping them would be a semantic change) and every
  // consumer already fails them safe.
  //
  // THE INVARIANT: `ms === Date.parse(timestamp)`, always. It holds by
  // construction because `upsert` is the ONE place a `StoredEvent` becomes
  // stored, and it derives `ms` there rather than trusting a caller. Never
  // build a `StoredEvent` literal outside the store and never patch
  // `timestamp` without re-deriving `ms` — a desynced pair is invisible
  // (the wire still shows the right timestamp) and silently rebuckets the
  // event in blocks, intraday, and every instant-bounded query.
  //
  // This is a RAM-only field: `storedEventToWire` does not carry it, and the
  // fleet wire shape (`FleetEvent`) has no such member.
  ms: number;
};

// A `StoredEvent` as a FEEDER builds it — every field but the derived `ms`.
// Both feeders (local scan/watcher and the fleet replica) hand this to
// `upsert`, which derives `ms` and is the only producer of a real
// `StoredEvent`.
export type StoredEventInput = Omit<StoredEvent, "ms">;

// THE derivation of `ms`, and the only one. `upsert` calls it on the ingest
// path; the engine suites' `ev()` fixtures call it so a test that overrides
// `timestamp` cannot leave a stale `ms` behind it — a desync no assertion
// would catch, because every wire field would still look right. Any `ms`
// already on `input` is overwritten, deliberately: the timestamp is the truth
// and this field is a cache of it.
export function withEventMs<T extends { timestamp: string }>(input: T): T & { ms: number } {
  return { ...input, ms: Date.parse(input.timestamp) };
}

// ---------------------------------------------------------------------------
// StoreChange — the change feed's unit (consumed by the report cache, #113)
// ---------------------------------------------------------------------------

// One RAM-changing upsert, as the change feed reports it (Task F1/#113): the
// event now stored, and the exact event object it displaced (`null` for a new
// key). A replacement may differ from `replaced` in ANY field — including
// sessionId/projectSlug/timestamp — the merge rule is whole-row.
export type StoreChange =
  | { event: StoredEvent; replaced: StoredEvent | null }
  | { event: null; replaced: StoredEvent }; // newly proven foreign: remove the incumbent

export type LocalAppend = {
  isSubagent: boolean;
  records: UsageRecord[];
  projectSlug: string;
  sessionId: string;
};

// ---------------------------------------------------------------------------
// ScanProgress — the walk's own counters (consumed by the boot reporter, #77)
// ---------------------------------------------------------------------------

// How far `scan` has got, reported RAW: once per file whose parse settled, plus
// one frame the moment the denominator is known. No throttling and no phase
// naming here — the store counts, `boot-progress.ts` decides what is worth
// putting on the wire (ADR-0067). `filesTotal: 0` means the walk is still
// enumerating (or found nothing).
export type ScanProgress = { filesParsed: number; filesTotal: number };

// ---------------------------------------------------------------------------
// Query interface — the frozen query contract (consumed by E5–E8)
// ---------------------------------------------------------------------------

// A store query. Every field is optional; an omitted field means "no filter on
// this axis". An empty array on any multi-value axis likewise means "no filter"
// — it mirrors how the index.ts endpoints treat a missing repeated `project=`
// / `model=` param (an empty list = unfiltered).
export type StoreQuery = {
  // Lower bound, in one of two forms (ADR-0083). `YYYYMMDD`: inclusive — an
  // event is kept if its *local-timezone* calendar date is >= this
  // (reproduces the golden oracle's `--since`). An ISO-8601 instant with a
  // time part (`2026-08-27T13:30:00Z`): an event is kept if its own timestamp
  // is >= the instant, no zone involved. `since` and `until` must share a
  // form; the HTTP layer rejects a mix before it reaches the store.
  since?: string;
  // Upper bound, same two forms. `YYYYMMDD`: inclusive — local calendar date
  // <= this (the oracle's `--until`). ISO instant: EXCLUSIVE — timestamp <
  // the instant, so `[since, until)` is half-open and adjacent windows never
  // double-count an event on the seam.
  until?: string;
  // The IANA zone the `since`/`until` bounds are interpreted in (ADR-0015).
  // Only consulted when a date bound is set; omitted = the host zone. The
  // endpoints always pass the request's `tz` so the bound comparison buckets
  // into the user's chosen Timezone setting.
  timeZone?: string;
  // Project slugs to include. Empty / omitted = every project. A slug matches
  // exactly, OR because it names a WORKTREE of a selected project — selecting
  // `D--git-MaxPrice` includes `D--git-MaxPrice--claude-worktrees-t5-app-info`,
  // because a worktree's spend is the project's spend (ADR-0061). The slug is
  // still the stable identifier (ADR-0009); this widens what a selected slug
  // reaches, never what an event is keyed by.
  projects?: string[];
  // Session IDs to include. Empty / omitted = every session. Exact-match on
  // `event.sessionId` — the JSONL filename without the `.jsonl` suffix.
  // Added in Part 5 (T5.1) to support the session-events NDJSON endpoint;
  // the four existing aggregators (E5–E8) do not use this axis.
  sessions?: string[];
  // Model families/strings to include. Empty / omitted = every model. Match
  // semantics live in `matchesModelFilter` below: a stored event's `model`
  // matches if it contains (case-insensitive substring) any requested value —
  // so `["Opus"]` matches `claude-opus-4-7`.
  models?: string[];
  // Machine ids to include (ADR-0041). Empty / omitted = every machine. EXACT
  // match on machineId — ids are opaque UUIDs, so the model filter's substring
  // semantics would be meaningless here. Alias expansion (mergedInto chains) is
  // renderer-side; the engine stays id-exact.
  machines?: string[];
  // Organization uuids to include (#261 item 6, #262 item 4). Empty / omitted =
  // every Organization. EXACT match on the event's RESOLVED-OR-PRESUMED
  // Organization — its own `organizationUuid` where owner evidence tagged it,
  // else the Organization its session is asserted to (#309), else its
  // machine's Presumed organization (`eventOrganization` in ./presumption) —
  // so the axis narrows by the Organization the app counts a row UNDER, not by
  // the evidence the row happens to carry. Uuids are opaque, so no substring
  // and no case folding, exactly like `machines`. An event that resolves to
  // NOTHING (no evidence, no assertion, and no Home to presume it under) never
  // matches a non-empty selection: it is absent from every scoped answer
  // rather than present in all of them.
  organizations?: string[];
};

// Case-insensitive substring match of one model name against a list of
// requested model values. An empty list means "no filter" — everything
// matches. This is THE model-matching semantics for the whole engine
// (ADR-0017): the store query applies it to every model-filterable report,
// and the blocks aggregator applies it to narrow per-block sums (blocks form
// from ALL events — quota truth — but sum only matching events; see
// engine/blocks.ts).
// `toLowerCase` is locale-INDEPENDENT (ECMA-262 Unicode Default Case
// Conversion, NOT the host locale — contrast `toLocaleLowerCase`), so lowering
// a needle here is byte-identical to lowering it inside the per-event loop.
// Hoisting it out of the hot loop is a measured win on the raw-param paths
// (intraday, blocks, session-events, bounded daily), where the renderer sends
// capitalized filter values (`"Opus"`, `"Sonnet"`) and every event re-lowered
// every needle.
export function lowerModelNeedles(models: string[]): string[] {
  return models.map((m) => m.toLowerCase());
}

// `matchesModelFilter` with the needles ALREADY lowered by `lowerModelNeedles`.
export function matchesLoweredModelFilter(model: string, loweredModels: string[]): boolean {
  if (loweredModels.length === 0) return true;
  const lower = model.toLowerCase();
  return loweredModels.some((needle) => lower.includes(needle));
}

export function matchesModelFilter(model: string, models: string[]): boolean {
  return matchesLoweredModelFilter(model, lowerModelNeedles(models));
}

// The NON-DATE filter axes of a store query — everything `compileAxisMatcher`
// can decide from one event alone (the date axis needs the query's zone and is
// applied separately by `query`).
export type StoreAxisQuery = Pick<
  StoreQuery,
  "projects" | "sessions" | "models" | "machines" | "organizations"
>;

// The non-date filter axes compiled ONCE into a per-event predicate — the one
// definition of "does this event belong to this query's corpus". `query`'s
// filter loop and the report cache's incremental feed (#113) both run it, so
// the cold-build corpus and the incrementally-fed corpus cannot disagree.
// Returns null when EVERY axis is unfiltered: that is the caller's "no filter
// at all" signal (query's memoized-snapshot fast path depends on it) and means
// "matches everything" with no per-event call.
//
// A closure, not a `(event, query)` predicate, because the membership Sets must
// be built once per query — the cache holds the compiled matcher on its entry
// and runs it per changed event, where rebuilding Sets would be a real cost.
//
// `presumption` is the rule the Organization axis resolves an owner-less event
// through, taken EXPLICITLY rather than read from anywhere: this function is
// pure, and the store is the one source of the value (`EventStore.presumption`)
// so a retained matcher and the cold build that fed it can never have been
// compiled against different Homes. The default keeps every caller that filters
// on no Organization — `identity-probe.ts` filters on `projects` alone —
// one-argument and unaffected.
export function compileAxisMatcher(
  q: StoreAxisQuery,
  presumption: Presumption = NO_PRESUMPTION,
): ((e: StoredEvent) => boolean) | null {
  const projectFilter = q.projects && q.projects.length > 0 ? new Set(q.projects) : null;
  // The worktree half of the project axis (ADR-0061), precomputed: one prefix
  // per selected project, tested with `startsWith` only after the exact Set
  // lookup misses.
  //
  // WHY A PREDICATE AND NOT AN EXPANDED SLUG LIST. Expanding the selection into
  // its member slugs would have to happen against the store's slug universe,
  // and the report cache compiles this matcher ONCE per entry and keeps it
  // (#113 / ADR-0057) — so the first worktree created after an entry was built
  // would be missing from that entry's expansion, permanently and silently. A
  // prefix test is total: it needs no universe, and a slug that appears later
  // simply matches. The cached entry stays valid, and the raw repeated-param
  // count `projectFilterCount` depends on never sees an expansion.
  const worktreePrefixes = projectFilter === null ? [] : [...projectFilter].map(worktreeSlugPrefix);
  const matchesProject = (slug: string): boolean =>
    projectFilter === null ||
    projectFilter.has(slug) ||
    worktreePrefixes.some((p) => slug.startsWith(p));
  const sessionFilter = q.sessions && q.sessions.length > 0 ? new Set(q.sessions) : null;
  const machineFilter = q.machines && q.machines.length > 0 ? new Set(q.machines) : null;
  // The Organization axis (#261/#262) — a genuine per-event predicate whenever
  // the selection is non-empty, and NEVER short-circuited to `null` because the
  // selection happens to cover every Organization the store holds right now.
  //
  // WHY THE "COVERS EVERYTHING PRESENT" NO-OP IS NOT TAKEN HERE. The set of
  // Organizations present in the engine GROWS, and this matcher is RETAINED:
  // the report cache compiles one per entry and keeps it (ADR-0057). With two
  // Organizations tracked and only Home holding data, an entry scoped to
  // `[Home]` would compile to `null` — "everything belongs" — and the first row
  // the watcher appended for the other Organization would be counted under the
  // Home scope, silently, for as long as that entry lived. `query` takes the
  // no-op instead, PER CALL, re-reading the present set every time; the two
  // agree at every instant (the invariant ADR-0057 actually needs), and only
  // the retained one has to survive growth — which is this one.
  const organizationFilter =
    q.organizations && q.organizations.length > 0 ? new Set(q.organizations) : null;
  // Lowered ONCE here rather than per event (see `lowerModelNeedles`); the
  // `.length === 0` "unfiltered" check is unaffected by the mapping.
  const models = lowerModelNeedles(q.models ?? []);
  if (
    projectFilter === null &&
    sessionFilter === null &&
    machineFilter === null &&
    organizationFilter === null &&
    models.length === 0
  ) {
    return null;
  }
  return (e) => {
    if (!matchesProject(e.projectSlug)) return false;
    if (machineFilter !== null && !machineFilter.has(e.machineId)) return false;
    if (sessionFilter !== null && !sessionFilter.has(e.sessionId)) return false;
    if (organizationFilter !== null) {
      // Resolved-or-presumed, never the raw tag: an owner-less row belongs to
      // the Organization its session is asserted to, else the one the
      // presumption names for its machine. `undefined` — no evidence, no
      // assertion and no Home to presume under — matches no selection.
      const organization = eventOrganization(e, presumption);
      if (organization === undefined || !organizationFilter.has(organization)) return false;
    }
    return matchesLoweredModelFilter(e.model, models);
  };
}

// ---------------------------------------------------------------------------
// Dedup key
// ---------------------------------------------------------------------------

// The dedup key + fullness tie-breaker are the ONE fleet merge rule, defined
// once in `@maxprice/shared` (fleet-dedup.ts) and shared byte-for-byte with the
// hub archive + client replica (packages/usage-core/src/fleet-event-store.ts).
// Aliased to the local names `upsert` calls; the cross-store parity tests pin
// the invariant. Claude Code writes several rows per assistant message sharing
// `(messageId, requestId)` — 2–3 byte-identical content-block lines (E1 finding
// #1) plus, for a streamed turn, an `output_tokens: 1` partial ahead of the
// final row — and the store keeps exactly one per distinct tuple: the fullest
// copy (the largest token-total; at an equal total, a copy carrying
// Organization evidence over one carrying none, and of two different tags the
// smaller uuid — ADR-0103, #374), ties first-seen (an absent requestId is a
// DISTINCT key from an empty-string one — see fleet-dedup.ts).
const dedupKey = fleetDedupKey;
const supersedes = fleetCopySupersedes;

// The forget unit's one order, (projectSlug, sessionId) ascending, shared by
// `foreignSessions()` and `dormantPairs()` so a marker diff over either is stable.
function byPair(a: ForgetSessionRef, b: ForgetSessionRef): number {
  return a.projectSlug === b.projectSlug
    ? a.sessionId < b.sessionId
      ? -1
      : a.sessionId > b.sessionId
        ? 1
        : 0
    : a.projectSlug < b.projectSlug
      ? -1
      : 1;
}

// ---------------------------------------------------------------------------
// EventStore
// ---------------------------------------------------------------------------

// The store's event set never *shrinks* for the process lifetime: `unlink`
// resets a tail-reader offset but never evicts a deleted session's events, and
// nothing else removes them. (A dedup-key collision can *replace* an event
// in place — see `appendInternal` — but the key count only ever grows.) This
// is a deliberate choice — a single-user local JSONL history is small enough
// that unbounded growth is a non-issue, and an eviction path would complicate
// the dedup invariant. Revisit only if memory becomes a measured concern.
export type EventStore = {
  // Resolves when the initial `scan` completes. Endpoints await this (E9).
  readonly ready: Promise<void>;
  // Walk every `.jsonl` under each root (sessions and nested subagent
  // transcripts alike), parse, append deduped. Call once, after the LISTENING
  // handshake. Resolves `ready`. Idempotent against the watcher: dedup makes a
  // scan/append overlap safe. Returns how many rows THIS walk changed in RAM
  // (new + replaced), the caller's poke-worthiness signal — the same contract
  // `appendFleet` documents below, and exact regardless of what any concurrent
  // feeder (watcher flush, fleet replica pull) lands in the same map.
  //
  // `onProgress` is the boot splash's channel (ADR-0067), and it is a PER-CALL
  // argument rather than a store option on purpose: exactly one walk per process
  // — the boot one — is a boot, and the other three (manual rescan, a
  // claudePaths edit, the fleet's rebuild) must stay silent. A store-level
  // option would make every one of them broadcast progress frames for a splash
  // that is long gone.
  scan: (roots: string[], onProgress?: (p: ScanProgress) => void) => Promise<number>;
  // Incremental-append path — the watcher's `flush` calls this with freshly
  // parsed records and the project/session they belong to. Only a subagent
  // batch inherits the parent session's owner points. Deduped.
  append: (
    records: UsageRecord[],
    projectSlug: string,
    sessionId: string,
    isSubagent?: boolean,
  ) => void;
  // Local ingest only, including duplicate and excluded records: rebuilds must
  // replay owner evidence as well as changed rows. Batches are read-only to
  // subscribers. Fleet pages never emit here.
  onLocalAppend: (listener: (batch: LocalAppend) => void) => () => void;
  // Remove a known hub deletion from a retained report view immediately.
  // No tombstone: a later local transcript may legitimately restore a row.
  removeMachineSessions: (machineId: string, sessions: readonly ForgetSessionRef[]) => void;
  // The fleet replica feeder (ADR-0041 M5, see fleet.ts) — projects hub-minted
  // wire rows onto `StoredEvent` and upserts each through the SAME merge rule
  // the local path uses. Returns how many rows changed RAM (new + replaced),
  // the caller's poke-worthiness signal.
  appendFleet: (rows: FleetEvent[], source?: "archive") => number;
  contributions: () => StoredEvent[];
  localContribution: (messageId: string, requestId?: string) => StoredEvent | undefined;
  replaceContributions: (rows: StoredEvent[]) => void;
  removeFleetKeys: (rows: readonly { messageId: string; requestId?: string }[]) => void;
  // Query the store. Returns matching events in ascending timestamp order. The
  // returned array is READ-ONLY — callers MUST NOT mutate it: the unfiltered
  // path (since/until unset, no project/session/model filter) returns the
  // shared memoized sorted snapshot DIRECTLY rather than a fresh copy (f27), so
  // mutating it would corrupt every later query. No current aggregator mutates
  // it — daily/sessions/projects/intraday only iterate; blocks `.filter`s into a
  // new array; every `.sort()` is on derived rows/buckets. The ordering is part
  // of the contract: the aggregators fold events in timestamp order so
  // `modelsUsed` / `modelBreakdowns` come out first-seen-ordered, and `blocks`
  // forms blocks chronologically — none of them re-sort.
  query: (q?: StoreQuery) => StoredEvent[];
  // Subscribe to RAM changes (the report cache's feed — #113). One call per
  // append batch that changed at least one row (per scanned file, per watcher
  // flush, per appendFleet page); a batch that changed nothing never emits.
  // Listeners run after the batch is fully applied; a throwing listener is
  // caught and logged so it can never break an ingest path. Returns an
  // unsubscribe function.
  onChanged: (listener: (changes: readonly StoreChange[]) => void) => () => void;
  // READ-ONLY walk of every stored event in MAP-INSERTION order — the dedup
  // map's `values()` verbatim. That order is exactly the tie order of the
  // stable timestamp sort `query` returns (the sort's input is this walk), and
  // `Map.set` on a replacement keeps the original position — so an event's
  // rank here is its tie rank under EVERY future replacement, whatever
  // timestamp the replacement carries. ONE consumer: the report cache's rebind
  // pre-stamp (#113), whose replacement-inheritance rule needs seqs that
  // encode map rank. `query()` cannot serve it: sorted order ranks ties
  // correctly but ranks DIFFERENT timestamps by time, so a replacement that
  // CHANGES its timestamp onto a tie would inherit a meaningless sorted-walk
  // rank. The store drives the walk, so the iterator can never escape — a
  // consumer cannot retain it, mutate through it, or hold it across an append.
  stampInsertionOrder: (visit: (e: StoredEvent) => void) => void;
  // Total deduped event count — for tests and `/api/status`.
  size: () => number;
  // Every distinct raw `model` string this store has ever upserted (#110,
  // ADR-0087). The sidecar resolves this set against the active pricing
  // snapshot to publish `pricing.unpricedModels`; it is a store scan rather
  // than a resolver side effect precisely so the answer does not depend on
  // which reports have run. Re-derived when foreign evidence removes rows.
  models: () => ReadonlySet<string>;
  // ADR-0098: every session that held at least one record the tracked set
  // excluded, or a copy of one (#370), as the forget unit (ADR-0063) — the
  // repair's input. Only pairs a walk or watcher read yielded a record for
  // (#370 review). Sorted by
  // (projectSlug, sessionId) so a marker diff is stable. "foreign" here means
  // "not a member of the tracked set" (#275); the name predates the set.
  foreignSessions: () => ForgetSessionRef[];
  // #368 review, #374: whether an excluded copy holds this dedup key — the
  // fullest copy any own feeder offered is tagged with an Organization outside
  // the tracked set (`excludedHolders`). A key two transcripts share (a resumed
  // session's copied lines) whose copies resolve differently is excluded only
  // while the excluded copy wins the merge; an admitted copy that supersedes
  // it takes the key back. An excluded key is never in the event map: the two
  // are disjoint by construction. The repair asks this of each Local archive
  // row (`localArchive.excludedPairs()`).
  isExcludedKey: (messageId: string, requestId?: string) => boolean;
  onForeignEvidence: (listener: (sessions: readonly ForgetSessionRef[]) => void) => () => void;
  // #311 (ADR-0107 §12): the dormant snapshot this store was built with — the
  // sessions whose owner-less own rows it refuses (`dormantSessions` in
  // ./presumption.ts). A construction-time constant, like the tracked set: a
  // change is a rebuild. `NO_DORMANT` when nothing is dormant.
  dormantSessions: () => ReadonlySet<string>;
  // #311: every (projectSlug, sessionId) a LOCALLY BACKED feeder (walk,
  // watcher, archive) offered a dormant row for, sorted like
  // `foreignSessions()` — the repair's lossless Hub forget list. A dormant row
  // only the replica carries is refused but never listed: forgetting it would
  // delete its last copy. Dormant pairs are never foreign.
  dormantPairs: () => ForgetSessionRef[];
  // #311: THE dormancy test: this machine's own row, no evidence, its session
  // in the construction-time snapshot. Another machine's row is never dormant.
  // No production caller since #295: it is the dormant half of `isWithheld`
  // below, which is what Storage reads, kept as its own test for the store
  // suite.
  isDormant: (row: { machineId: string; sessionId: string; organizationUuid?: string }) => boolean;
  // #295: Storage's ONE withholding predicate (`StorageReporterDeps.withheld`),
  // which the Forget classifier and the archive's earliest-date reader both
  // skip. This machine's own row, and EITHER dormant (`isDormant`) OR tagged
  // with an Organization outside a non-null tracked set (`outsideTrackedSet`).
  // An own Excluded-tagged row is one of two populations: (a) a walked
  // session's, awaiting the scoped repair (Hub offline) — transient, and the
  // repair owns it; (b) a pruned session's, which ADR-0103's accepted
  // departure leaves on the Hub and in the replica for good, since the repair
  // forgets walked sessions only and the replica feeder never filters by tag.
  // No report counts either (every scope narrows to the tracked set), and
  // Storage neither counts nor names what is excluded (ADR-0098), so Forget
  // never offers them. Another machine's row is never withheld: this machine
  // cannot forget it, and the classifier skips it before asking.
  isWithheld: (row: { machineId: string; sessionId: string; organizationUuid?: string }) => boolean;
  // ADR-0098: every Organization any record named, kept OR excluded — walked
  // transcripts and, since the wire carries the tag (ADR-0103), fleet rows too,
  // refused or not — split by whose record named it (#287). `machine`: walked
  // records, archive rows, and replica rows carrying this machine's own id.
  // `fleet`: replica rows of any other machine. An Organization may be in
  // both. These feed the roster's "seen on" facts — the only place an
  // untracked organization's existence is allowed to surface, as a label with
  // no count.
  organizationsSeen: () => { machine: ReadonlySet<string>; fleet: ReadonlySet<string> };
  // ADR-0098: how many sessions each Organization owned when they ended — the
  // organization of every session's LAST owner point. Sessions, not events, and
  // counted whether or not the tracked set excluded them, so a store built with
  // NO tracked set (a first launch) can say which organization this machine
  // mostly works under. Internal to the sidecar's first-launch seed; it never
  // leaves the process — the app shows no count of anything it hides.
  organizationSessionCounts: () => ReadonlyMap<string, number>;
  // The tracked set this store was built with (the #260 lifecycle decision,
  // item 7): the Organizations whose usage it counts, generalising ADR-0098's
  // single Home organization (#275; #299 records it in the ADR). `null` =
  // nothing is excluded (the golden corpus runs this way, and so does the
  // first-launch selection walk).
  trackedOrganizations: () => ReadonlySet<string> | null;
  // The Presumed organization rule in force (#261 item 2, see
  // ./presumption.ts): how an owner-less event's Organization is answered at
  // query time. The store is the ONE source of it — a holder that needs the
  // same rule (the report cache) reads it from here rather than taking its own
  // injectable, so an entry's retained axis matcher and the cold build's
  // `store.query` can never be compiled against different Homes. Read through
  // the thunk on every call, so a settings change is visible immediately and a
  // swap is detectable by IDENTITY (`createPresumption` mints a new one per
  // call).
  presumption: () => Presumption;
};

// How many files the initial scan reads+parses concurrently. Parse work is
// single-threaded JS either way — the pool's job is overlapping file I/O and
// decode with it (worth the most on genuinely cold OS file cache) while
// keeping the open-handle count corpus-independent.
const SCAN_CONCURRENCY = 8;

export function createEventStore(opts: {
  selfMachineId: string;
  // The on-disk parse cache (ADR-0048). When present, the scan reads each
  // file through it — cached records on a (size, mtimeMs) match, a real parse
  // otherwise — instead of always parsing. The store never saves the cache;
  // that is main()'s one post-ready write (`wireScanCachePersist`).
  scanCache?: ScanCache;
  // The tracked set (the #260 lifecycle decision, item 7): the Organizations
  // whose usage this store counts, already unioned with the Home organization
  // by `resolveTrackedOrganizations`. A record whose resolved organization is
  // not a member is dropped at the feeder and never becomes a StoredEvent.
  // `null`/omitted = nothing is excluded. This generalises ADR-0098's single
  // Home organization (#275); #299 records it in the ADR.
  trackedOrganizations?: ReadonlySet<string> | null;
  // #311 (ADR-0107 §12): the dormant snapshot — `dormantSessions(assertions,
  // tracked)` taken at construction. This machine's own owner-less rows in
  // these sessions are refused on every feeder, and are not foreign. A
  // construction-time constant beside the tracked set, so a change is a
  // rebuild. Omitted = `NO_DORMANT`: nothing is dormant.
  dormantSessions?: ReadonlySet<string>;
  // The Presumed organization rule (#261 item 2), threaded as a THUNK rather
  // than a value: a Home change re-answers the presumption without rebuilding
  // the store, because it moves no row and re-walks nothing. Omitted =
  // `NO_PRESUMPTION`, under which an owner-less row resolves to no Organization
  // at all — today's behaviour, and the golden corpus's.
  getPresumption?: () => Presumption;
}): EventStore {
  // The machine id every locally-scanned/watched row is tagged with (ADR-0041).
  // The fleet feeder carries each replica row's own hub-minted id instead.
  const selfMachineId = opts.selfMachineId;
  const scanCache = opts.scanCache;
  const getPresumption = opts.getPresumption ?? ((): Presumption => NO_PRESUMPTION);

  // The deduped event set, keyed by `(messageId, requestId)`. A Map (not an
  // array) so a re-scan / truncation re-read / scan-watcher overlap is an O(1)
  // keyed upsert — a duplicate key is resolved by `upsert`'s fullest-copy
  // rule, never blindly re-added.
  const events = new Map<string, StoredEvent>();
  const contributions = new Map<string, StoredEvent>();

  // Distinct raw model strings seen by `upsert` — see `EventStore.models`.
  const modelsSeen = new Set<string>();

  // Which Organizations the STORED events currently resolve under, in the two
  // halves the presumption splits them into: the distinct tags of tagged rows,
  // and the machines of the rest — an owner-less row's Organization is not a
  // property of the row, so it contributes its MACHINE here and is resolved
  // against the presumption when the question is asked. Maintained beside
  // `modelsSeen` in `upsert` and rebuilt with it by `rebuildDerivedSets`.
  //
  // NOT `organizationsSeen()`, and they must never be confused: that is every
  // Organization any RECORD named, kept OR excluded, and exists so the roster
  // can list an untracked one. These are the Organizations of STORED events, AFTER
  // exclusion, and they never leave this module — their only job is to let
  // `query` decide whether the Organization axis is a no-op right now.
  //
  // Deliberately an OVER-APPROXIMATION between rebuilds: a replacement can
  // change a row's tag and strand a member neither set can retract on the hot
  // path. A tag gained at an equal total (ADR-0103) leaves the row's machine in
  // `untaggedMachines`; a tagged → untagged flip, or a tie won by a smaller
  // tag (#374), leaves the old Organization in `taggedOrganizations`. A tag is
  // never lost at an equal total, so that flip needs an untagged copy with a
  // strictly LARGER token total — but the merge rule never merges fields, so it
  // stays possible and add-only stays the rule. Over-approximating can only
  // ever LOSE the shortcut — it can never admit an event the axis predicate
  // would reject — so add-only is safe here, and the four removal paths
  // rebuild both sets exactly.
  const taggedOrganizations = new Set<string>();
  const untaggedMachines = new Set<string>();

  // Record one newly-stored event in every derived set. The single definition
  // of what those sets hold, so the incremental path and the rebuild below
  // cannot drift apart.
  function recordDerived(event: StoredEvent): void {
    modelsSeen.add(event.model);
    if (event.organizationUuid !== undefined) taggedOrganizations.add(event.organizationUuid);
    else untaggedMachines.add(event.machineId);
  }

  // Re-derive every add-only set from `events`. THE response to a shrinking
  // store, and the four paths that can shrink one (`appendInternal`'s
  // exclusion branch, `appendFleet`'s archive eviction (#374),
  // `removeMachineSessions`, `removeFleetKeys`) all call it:
  // a model belonging only to removed events must not linger in pricing
  // discovery, and an Organization or machine belonging only to removed events
  // must not keep costing `query` its no-op. O(events), so once per batch.
  function rebuildDerivedSets(): void {
    modelsSeen.clear();
    taggedOrganizations.clear();
    untaggedMachines.clear();
    for (const event of events.values()) recordDerived(event);
  }

  const trackedOrganizations = opts.trackedOrganizations ?? null;

  // The ONE admission test (ADR-0098, #275), shared by the walk and the Local
  // archive feed: an Organization outside a non-null tracked set is excluded.
  // No evidence (`undefined`) never is, and a null set excludes nothing.
  function outsideTrackedSet(organizationUuid: string | undefined): boolean {
    return (
      trackedOrganizations !== null &&
      organizationUuid !== undefined &&
      !trackedOrganizations.has(organizationUuid)
    );
  }

  // #311 (ADR-0107 §12): the dormant snapshot, beside the tracked set and, like
  // it, a construction-time constant. `NO_DORMANT` keeps every older caller and
  // the golden corpus exactly as they were.
  const dormant = opts.dormantSessions ?? NO_DORMANT;
  // Pairs a LOCALLY BACKED feeder (walk, watcher, archive) offered a dormant
  // row for: the repair's lossless forget list. A dormant row only the replica
  // carries is refused unrecorded, because forgetting it would delete its last copy.
  const dormantPairsSeen = new Map<string, ForgetSessionRef>();

  // THE dormancy test (#311, ADR-0107 §12): this machine's own row, no
  // evidence after resolution, its session in the snapshot. A refused dormant
  // row is never foreign: it enters neither `foreignSessions` nor
  // `excludedHolders`, so the evidence repair, whose forgets are lossy where no
  // transcript backs the pair (ADR-0103 §5), never sees it.
  function dormantRow(
    sessionId: string,
    organizationUuid: string | undefined,
    own: boolean,
  ): boolean {
    return own && organizationUuid === undefined && dormant.has(sessionId);
  }

  // ADR-0098 state. `ownerPoints`: per session, the (ms, organization) of every
  // TAGGED record its parent transcript carried, ascending — a subagent record,
  // which carries no Attribution evidence of its own (ADR-0109 §5), resolves
  // against these by timestamp.
  // Filled from every record BEFORE the exclusion below, so a parent outside
  // the tracked set still teaches the store who owns its subagents.
  // `foreignSessions`: the repair's forget list; the name predates the tracked
  // set (#275) and keeps its spelling, "foreign" now reading "not a member of
  // the tracked set". `excludedHolders`: per excluded dedup key, the fullness
  // of the excluded copy holding it (ADR-0103 §5, #374). Every copy of a key
  // competes under the one merge rule whatever its Organization, so the key's
  // winner is decided without the tracked set and without the walk order; the
  // set then admits or refuses the winner whole. A key is excluded only while
  // an excluded copy holds it, and every feeder (another walked transcript,
  // the Local archive, the replica, the Hub before the repair lands) offers a
  // copy that takes the key back only when it supersedes that holder. A
  // holder is always tagged (no evidence is never excluded), and the map
  // never shares a key with `events`.
  // `organizationsSeen`: the roster's "seen on this machine / the fleet".
  const ownerPoints = new Map<string, Array<{ ms: number; organizationUuid: string }>>();
  const foreignSessions = new Map<string, ForgetSessionRef>();
  const excludedHolders = new Map<string, { total: number; organizationUuid: string }>();
  // #370: every pair a walk or watcher read yielded at least one record for,
  // at any time in this process. An unreadable file, an empty one and an
  // unlink flush each arrive as an empty batch and mark nothing (#370
  // review): none of them recovered a row, so the archive may hold the only
  // copy of that pair's rows. The forget list only ever holds marked pairs,
  // because the repair's forgets are lossy where no transcript backs the pair
  // (ADR-0103 §5): the Hub forget is pair-wide, so a pair only the Hub holds
  // would lose its rows there, and the Local archive forget drops excluded
  // lines it may hold the only copy of. Marked still does not mean "still on
  // disk": a transcript pruned after a successful read and before the next
  // restart stays marked. Since #375 that costs no admitted row: the archive
  // forget keeps them, and the resync re-pushes them from it.
  const walkedPairs = new Set<string>();
  const foreignListeners = new Set<(sessions: readonly ForgetSessionRef[]) => void>();
  const organizationsSeen = { machine: new Set<string>(), fleet: new Set<string>() };

  function sessionKey(projectSlug: string, sessionId: string): string {
    return `${projectSlug}\u0000${sessionId}`;
  }

  function addOwnerPoint(key: string, ms: number, organizationUuid: string): void {
    if (Number.isNaN(ms)) return;
    let points = ownerPoints.get(key);
    if (points === undefined) {
      points = [];
      ownerPoints.set(key, points);
    }
    // Sorted insert; an identical point is a re-presented record (rescan,
    // scan/watcher overlap) and is not duplicated.
    let i = points.length;
    while (i > 0 && (points[i - 1] as { ms: number }).ms > ms) i -= 1;
    const prev = points[i - 1];
    if (prev !== undefined && prev.ms === ms && prev.organizationUuid === organizationUuid) return;
    points.splice(i, 0, { ms, organizationUuid });
  }

  // The owner in effect at `ms` for a session: the last point at or before it,
  // or the earliest known owner for a record that precedes every point (a
  // subagent line stamped a moment before its parent's first assistant line).
  function resolveOwner(key: string, ms: number): string | undefined {
    const points = ownerPoints.get(key);
    if (points === undefined || points.length === 0 || Number.isNaN(ms)) return undefined;
    let owner = (points[0] as { organizationUuid: string }).organizationUuid;
    for (const p of points) {
      if (p.ms <= ms) owner = p.organizationUuid;
      else break;
    }
    return owner;
  }

  // #374: offer one excluded copy of `key` (`total` tokens, tagged
  // `organizationUuid`) to the competition for it. It loses to a holder or an
  // admitted incumbent at least as full, and changes nothing. Otherwise it
  // becomes the key's holder; an admitted incumbent it supersedes is evicted
  // (its contribution with it), so the caller can list a walked pair whose
  // copy may already be archived or pushed. Returns the evicted incumbent,
  // `null` when the key is newly excluded with nothing to evict, and
  // `undefined` when it was not newly excluded (the copy lost, or replaced a
  // holder in place). Allocates only when a key is newly excluded (#361).
  function offerExcluded(
    key: string,
    total: number,
    organizationUuid: string,
    changes: StoreChange[],
  ): StoredEvent | null | undefined {
    const holder = excludedHolders.get(key);
    if (holder !== undefined) {
      if (
        fleetFullnessPartsExceed(total, organizationUuid, holder.total, holder.organizationUuid)
      ) {
        holder.total = total;
        holder.organizationUuid = organizationUuid;
      }
      return undefined;
    }
    const incumbent = events.get(key);
    if (
      incumbent !== undefined &&
      !fleetFullnessPartsExceed(
        total,
        organizationUuid,
        fleetDedupTokenTotal(incumbent),
        incumbent.organizationUuid,
      )
    ) {
      return undefined;
    }
    excludedHolders.set(key, { total, organizationUuid });
    contributions.delete(key);
    if (incumbent === undefined) return null;
    events.delete(key);
    sorted = null;
    changes.push({ event: null, replaced: incumbent });
    return incumbent;
  }

  // #374: whether an admitted copy of `key` may enter: no excluded copy holds
  // the key, or the candidate supersedes the one that does. The caller removes
  // the holder only once it really upserts, so a refusal between this test and
  // the upsert (a dormant row) leaves the key held.
  function beatsExcludedHolder(
    key: string,
    candidate: FleetDedupTokens,
    organizationUuid: string | undefined,
  ): boolean {
    const holder = excludedHolders.get(key);
    return (
      holder === undefined ||
      fleetFullnessPartsExceed(
        fleetDedupTokenTotal(candidate),
        organizationUuid,
        holder.total,
        holder.organizationUuid,
      )
    );
  }

  // Lazily-built timestamp-sorted snapshot of every event, memoized so a burst
  // of back-to-back queries (`/api/daily` + `/api/daily-by-project` share a
  // store query; an SSE invalidation refetches every report) sorts the corpus
  // once, not once per query. `appendInternal` invalidates it to `null`
  // whenever it actually adds an event; the next `query` rebuilds it.
  let sorted: StoredEvent[] | null = null;

  function sortedEvents(): StoredEvent[] {
    sorted ??= [...events.values()].sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
    );
    return sorted;
  }

  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  // The change feed's subscribers (#113 — the report cache invalidates its
  // dirty buckets from here rather than recomputing every report from scratch).
  // A Set so an unsubscribe is O(1) and a double-subscribe of the same function
  // is idempotent; iteration order is registration order.
  const changeListeners = new Set<(changes: readonly StoreChange[]) => void>();
  const localAppendListeners = new Set<(batch: LocalAppend) => void>();

  // Deliver one fully-applied batch. Called AFTER the whole batch has landed in
  // `events`, so a listener that queries the store sees the post-batch RAM, not
  // a half-applied one. A no-op batch never reaches a listener at all — the
  // feed's contract is "at least one row changed". A throwing listener is
  // caught and logged: the ingest paths (scan, watcher flush, replica pull)
  // must never fail because a downstream cache did.
  function emitChanges(changes: StoreChange[]): void {
    if (changes.length === 0) return;
    for (const listener of changeListeners) {
      try {
        listener(changes);
      } catch (err) {
        console.error("[store] onChanged listener threw:", err);
      }
    }
  }

  // The ONE merge rule (shared with the hub store and the replica): keyed
  // whole-row fullest-copy upsert, ties keep first-seen. Returns whether RAM
  // changed, and appends that change to the caller's batch. Both feeders —
  // local scan/watcher and the fleet replica — converge through this exact
  // function, and the local contributions map applies the same rule. When a
  // record's dedup key is already present the store keeps whichever event is
  // fuller (`supersedes`): the larger token total — the golden oracle's dedup
  // rule — or, at an equal total, the copy carrying Organization evidence over
  // one carrying none (ADR-0103). A new record replaces the stored one only
  // when strictly fuller, so equal-total duplicates (the byte-identical
  // content-block lines) keep first-seen, a streamed message's final row
  // replaces the `output_tokens: 1` partial regardless of which the scan reads
  // first, and a tag gained at an equal total is a replacement like any other
  // — `{ event, replaced }` on the change feed. No field merging: a strictly
  // larger untagged copy still displaces a smaller tagged one whole-row.
  function upsert(input: StoredEventInput, changes: StoreChange[], local = false): boolean {
    const key = dedupKey(input.messageId, input.requestId);
    let derived: StoredEvent | undefined;
    if (local) {
      const held = contributions.get(key);
      if (held === undefined || supersedes(input, held)) {
        derived = withEventMs(input);
        contributions.set(key, derived);
      }
    }
    const existing = events.get(key);
    if (existing !== undefined && !supersedes(input, existing)) return false;
    // Derive `ms` HERE and nowhere else (ADR-0089) — this is the single funnel
    // both feeders converge on, so the `ms === Date.parse(timestamp)` invariant
    // cannot be violated by a caller. Deliberately AFTER the dedup rejection:
    // a re-scan or a scan/watcher overlap re-presents rows that are already
    // stored, and parsing a timestamp only to discard the row is the exact
    // waste this change exists to remove.
    const event: StoredEvent = derived ?? withEventMs(input);
    events.set(key, event);
    recordDerived(event);
    // A new or replacing event invalidates the memoized sorted snapshot.
    sorted = null;
    // The displaced row rides along so a subscriber can un-count it without
    // holding its own copy of the store (`null` = this key is brand new).
    changes.push({ event, replaced: existing ?? null });
    return true;
  }

  // Append one batch of parsed records, deduped. Shared by `scan` and
  // `append`. Tags each record with this machine's own id (ADR-0041) and
  // upserts through the one merge rule. Returns how many rows changed RAM
  // (new + replaced) — `scan` accumulates it into its own return value;
  // `append` (the watcher path, whose caller pokes unconditionally) ignores it.
  // ONE change-feed emit per call, so the batch granularity a subscriber sees
  // is exactly one scanned file / one watcher flush.
  function appendInternal(
    records: Iterable<UsageRecord>,
    projectSlug: string,
    sessionId: string,
    isSubagent: boolean,
  ): number {
    const changes: StoreChange[] = [];
    let newForeignEvidence = false;
    // Other walked pairs whose admitted copy this batch evicted (#370).
    const evictedPairs = new Map<string, ForgetSessionRef>();
    let changed = 0;
    const key = sessionKey(projectSlug, sessionId);
    // Whether this pair was on the forget list before the batch (#370 review).
    const listedBefore = foreignSessions.has(key);
    const batch = Array.isArray(records) ? (records as UsageRecord[]) : [...records];
    // #370 review: only a read that yielded a record marks the pair walked. An
    // unreadable file and an empty one reach here as an empty batch, as does an
    // unlink flush, and none of them recovered a row of the transcript.
    if (batch.length > 0) walkedPairs.add(key);
    // Pass 1 — learn the session's owner points from every tagged record of a
    // parent transcript. A subagent's tag teaches no point (ADR-0109 §5) and
    // still marks its Organization seen on this machine.
    // ADR-0098's ONE sanctioned Date.parse on ingest: this is the RAW record's
    // timestamp, classified before `upsert` derives `ms` (ADR-0089 governs
    // stored events, which these are not yet).
    for (const record of batch) {
      if (record.organizationUuid !== undefined) {
        organizationsSeen.machine.add(record.organizationUuid);
        if (!isSubagent) addOwnerPoint(key, Date.parse(record.timestamp), record.organizationUuid);
      }
    }
    // Pass 2 — resolve, exclude, upsert.
    for (const record of batch) {
      // A subagent transcript carries no Attribution evidence of its own (ADR-0109
      // §5): its Login record is a copy of the parent's raw login-cache value at
      // spawn, which no `/login` gates, so the parser's tag is ignored and the row
      // takes the parent session's owner point at its timestamp.
      const organizationUuid = isSubagent
        ? resolveOwner(key, Date.parse(record.timestamp))
        : record.organizationUuid;
      if (outsideTrackedSet(organizationUuid)) {
        // The pair holds an excluded record whether or not its copy wins the
        // key: an earlier build that tracked this Organization may have
        // archived or pushed its rows.
        foreignSessions.set(key, { projectSlug, sessionId });
        // #374: the copy competes for its key (`offerExcluded`); a loser
        // excludes nothing and evicts nothing.
        const incumbent = offerExcluded(
          dedupKey(record.messageId, record.requestId),
          fleetDedupTokenTotal(record),
          organizationUuid as string,
          changes,
        );
        if (incumbent !== undefined) newForeignEvidence = true;
        if (incumbent !== undefined && incumbent !== null) {
          changed += 1;
          // #370: an own copy admitted from ANOTHER walked transcript (a resume
          // pair's original) may already be archived or pushed, so its pair
          // joins the forget list, as it would had the walk read it second.
          const holder = sessionKey(incumbent.projectSlug, incumbent.sessionId);
          if (incumbent.machineId === selfMachineId && holder !== key && walkedPairs.has(holder)) {
            const pair = { projectSlug: incumbent.projectSlug, sessionId: incumbent.sessionId };
            foreignSessions.set(holder, pair);
            evictedPairs.set(holder, pair);
          }
        }
        continue;
      }
      if (dormantRow(sessionId, organizationUuid, true)) {
        dormantPairsSeen.set(key, { projectSlug, sessionId });
        continue;
      }
      // #370, #374 (ADR-0103 §5): a copy of a key an excluded copy holds is
      // refused here too, tagged or not, unless it supersedes the holder, so
      // the verdict cannot depend on walk order. A resume or fork copy repeats
      // its original's rows below its own Owner record: tagged there,
      // owner-less here. A refused copy's session joins the forget list,
      // because an earlier build may have archived or pushed this copy, and
      // when that lists the pair for the first time the evidence listener is
      // told below, so a repair that already completed the pair runs again. A
      // copy that supersedes the holder takes the key back. After the dormant
      // test, so a dormant session's copy stays dormant and never foreign
      // (ADR-0107 §12).
      if (excludedHolders.size > 0) {
        const recordKey = dedupKey(record.messageId, record.requestId);
        if (!beatsExcludedHolder(recordKey, record, organizationUuid)) {
          foreignSessions.set(key, { projectSlug, sessionId });
          continue;
        }
        excludedHolders.delete(recordKey);
      }
      if (
        upsert(
          { ...record, organizationUuid, projectSlug, sessionId, machineId: selfMachineId },
          changes,
          true,
        )
      ) {
        changed += 1;
      }
    }
    if (changes.some((change) => change.event === null)) {
      // Exclusion is the only removal path on this feeder. Rebuild once per
      // batch, never per removed row.
      rebuildDerivedSets();
    }
    emitChanges(changes);
    // A newly excluded key, or a refusal that put this pair on the forget list
    // for the first time (#370 review), tells the repair, with every pair an
    // eviction listed. A pair already listed stays silent, so re-reading a
    // transcript (a rescan, the watcher's first read from byte 0) never
    // re-invalidates it. No listener is attached during a boot or rebuild
    // walk: main() installs a store only after that walk has run, so it lists
    // its pairs silently and the boot-gate repair reads them against its done
    // lists. A rescan of the live store re-presents pairs already listed.
    if (newForeignEvidence || (!listedBefore && foreignSessions.has(key))) {
      const sessions = [{ projectSlug, sessionId }, ...evictedPairs.values()];
      for (const listener of foreignListeners) {
        try {
          listener(sessions);
        } catch (err) {
          console.error("[store] foreign evidence listener threw:", err);
        }
      }
    }
    for (const listener of localAppendListeners) {
      try {
        listener({ records: batch, projectSlug, sessionId, isSubagent });
      } catch (err) {
        console.error("[store] onLocalAppend listener threw:", err);
      }
    }
    return changed;
  }

  function append(
    records: UsageRecord[],
    projectSlug: string,
    sessionId: string,
    isSubagent = false,
  ): void {
    appendInternal(records, projectSlug, sessionId, isSubagent);
  }

  // The fleet feeder (ADR-0041): project a wire FleetEvent onto StoredEvent —
  // the engine keeps only the fields it interprets (the REPLICA is the
  // verbatim persistence layer; RAM projection is lossy by design) — and
  // upsert through the one merge rule. The row's Organization evidence is one
  // of those fields (ADR-0103): the tag its producer resolved, kept as-is.
  // Returns how many rows changed RAM (new + replaced), the caller's
  // poke-worthiness signal. ONE change-feed emit per call — i.e. per applied
  // replica page.
  function appendFleet(rows: FleetEvent[], source?: "archive"): number {
    const changes: StoreChange[] = [];
    let changed = 0;
    // Walked pairs an archive line evicted an admitted copy from (#374).
    const evictedPairs = new Map<string, ForgetSessionRef>();
    for (const row of rows) {
      // This machine's own rows: the archive, or a replica row carrying its id.
      const own = source === "archive" || row.machineId === selfMachineId;
      // `organizationsSeen` is every Organization any record named, kept or
      // excluded, so a tag counts here before any refusal below. Own rows are
      // "seen on this machine"; any other machine's are "seen on the fleet",
      // the roster's word for a tag only the replica carries.
      if (row.organizationUuid !== undefined) {
        (own ? organizationsSeen.machine : organizationsSeen.fleet).add(row.organizationUuid);
      }
      const rowKey = dedupKey(row.messageId, row.requestId);
      // The Local archive is this machine's own feeder, so the admission
      // boundary covers it too, by the evidence its line carries (#280): a line
      // tagged with an Excluded organization is refused, and stays on disk
      // untouched, so the refusal is reversible. It still competes for its key
      // as a walked excluded copy does (#374), so a smaller copy from another
      // feeder cannot win the key only because the Organization is excluded.
      // No walk read its pair, so its own pair is never listed. Replica rows
      // are never filtered by their tag — exclusion is producer-side.
      if (source === "archive" && outsideTrackedSet(row.organizationUuid)) {
        const incumbent = offerExcluded(
          rowKey,
          fleetDedupTokenTotal(row),
          row.organizationUuid as string,
          changes,
        );
        if (incumbent !== undefined && incumbent !== null) {
          changed += 1;
          // As the walk's eviction does (#370): a walked pair's admitted copy
          // may already be archived or pushed, so the pair joins the forget list.
          const holder = sessionKey(incumbent.projectSlug, incumbent.sessionId);
          if (
            incumbent.machineId === selfMachineId &&
            walkedPairs.has(holder) &&
            !foreignSessions.has(holder)
          ) {
            const pair = { projectSlug: incumbent.projectSlug, sessionId: incumbent.sessionId };
            foreignSessions.set(holder, pair);
            evictedPairs.set(holder, pair);
          }
        }
        continue;
      }
      // ADR-0098, #374: a copy of a key an excluded copy holds (archive,
      // replica, hub; tagged or not) enters only when it supersedes the holder.
      if (excludedHolders.size > 0 && !beatsExcludedHolder(rowKey, row, row.organizationUuid))
        continue;
      // #311: a dormant row is refused from every feeder; only the archive's
      // pair is recorded, because only the archive (of the fleet feeders) is
      // locally backed. Another machine's row is never dormant here.
      if (dormantRow(row.sessionId, row.organizationUuid, own)) {
        if (source === "archive") {
          dormantPairsSeen.set(sessionKey(row.projectSlug, row.sessionId), {
            projectSlug: row.projectSlug,
            sessionId: row.sessionId,
          });
        }
        continue;
      }
      const stored: StoredEventInput = {
        timestamp: row.timestamp,
        messageId: row.messageId,
        requestId: row.requestId,
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheCreationTokens: row.cacheCreationTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheCreation: row.cacheCreation,
        costUSD: row.costUSD,
        cwd: row.cwd,
        organizationUuid: row.organizationUuid,
        projectSlug: row.projectSlug,
        sessionId: row.sessionId,
        machineId: row.machineId,
      };
      if (excludedHolders.size > 0) excludedHolders.delete(rowKey);
      if (upsert(stored, changes, source === "archive")) changed += 1;
    }
    // An archive line's eviction is a removal (#374): rebuild once per page.
    if (changes.some((change) => change.event === null)) rebuildDerivedSets();
    emitChanges(changes);
    // A walked pair an archive line's eviction listed for the first time tells
    // the repair, as a walked eviction does (#370).
    if (evictedPairs.size > 0) {
      const sessions = [...evictedPairs.values()];
      for (const listener of foreignListeners) {
        try {
          listener(sessions);
        } catch (err) {
          console.error("[store] foreign evidence listener threw:", err);
        }
      }
    }
    return changed;
  }

  async function scan(roots: string[], onProgress?: (p: ScanProgress) => void): Promise<number> {
    // How many rows this walk changed in RAM (new + replaced). Declared outside
    // the try so the `finally` that resolves `ready` can't swallow it, and so
    // the throw path still runs `resolveReady()` without returning a count.
    let changed = 0;
    try {
      // Gather the full file list across every root first, so parsing can fan
      // out over the whole corpus regardless of how files split across roots.
      const files: Array<{ path: string; projectSlug: string; sessionId: string }> = [];
      for (const root of roots) {
        // Each root is a `<config>/projects` dir. Sessions live at
        // `<root>/<slug>/<session>.jsonl`, but Claude Code also nests subagent
        // transcripts at `<root>/<slug>/<session>/subagents/agent-*.jsonl` —
        // so the scan recurses the whole tree (the golden oracle globs it
        // recursively too). `identityFromPath` maps each `.jsonl` back to
        // its (projectSlug, sessionId), nested or flat.
        let entries: string[];
        try {
          entries = await readdir(root, { recursive: true });
        } catch {
          // A configured root that doesn't exist yet (no sessions recorded for
          // that config dir) is not an error — just nothing to scan.
          continue;
        }
        // Bun's recursive readdir races sibling directories, so its order is
        // NOT stable call-to-call (observed on Windows: the same tree lists
        // both ways in one process). The append order below is the dedup
        // first-seen tie contract, so pin it: sort within each root (roots
        // keep their configured order). Without this, an equal-token duplicate
        // key spanning two directories lands in a different project/session
        // from boot to boot — and a cached scan could disagree with the parse
        // it was recorded from.
        entries.sort();
        for (const entry of entries) {
          if (!entry.endsWith(".jsonl")) continue;
          const path = join(root, entry);
          // Derive the (projectSlug, sessionId) tag the same way the watcher
          // does — via the shared `identityFromPath` — so a scan-tagged event
          // and a watcher-tagged event for the same file are never split.
          const { projectSlug, sessionId } = identityFromPath(path, roots);
          files.push({ path, projectSlug, sessionId });
        }
      }

      // The denominator is known the instant enumeration finishes and BEFORE a
      // single file is parsed — which is the whole reason honest boot progress
      // is available here for free (ADR-0067). Reported even when it is 0, so
      // "nothing to read" is distinguishable from "no frame yet".
      onProgress?.({ filesParsed: 0, filesTotal: files.length });

      // Parse files under a bounded worker pool — each worker takes the next
      // unparsed index, so at most SCAN_CONCURRENCY reads+decodes are in
      // flight (overlapping file I/O with the single JS thread's parse work,
      // without holding a corpus-sized number of file handles open). Results
      // land by index; the append below then runs in the sorted file order
      // above, so dedup's first-seen tie rule sees the same order every scan
      // — run-to-run deterministic regardless of completion order.
      const parsed: UsageRecord[][] = new Array<UsageRecord[]>(files.length);
      let next = 0;
      // Files whose parse has SETTLED, counted across every worker. Not `next`:
      // `next` is how many have been CLAIMED, so it runs up to
      // SCAN_CONCURRENCY ahead of the truth and would let the bar reach 100%
      // with eight files still being read.
      let settled = 0;
      const worker = async (): Promise<void> => {
        while (next < files.length) {
          const i = next;
          next += 1;
          const file = files[i];
          if (file === undefined) return;
          // collectUsageRecords warns-and-continues on a bad line and never
          // throws on a parse failure; a genuinely unreadable file (vanished
          // mid-scan, or a directory that happens to end in `.jsonl`) is
          // caught here so one file can't abort the whole scan. The scan
          // cache's readRecords keeps that contract — it stats then either
          // returns cached records or delegates to collectUsageRecords.
          try {
            parsed[i] =
              scanCache !== undefined
                ? await scanCache.readRecords(file.path)
                : await collectUsageRecords(file.path);
          } catch (err) {
            console.warn(`[store] scan skipped ${file.path}: ${String(err)}`);
            parsed[i] = [];
          }
          // After the catch, so a skipped file still counts: it is done being
          // waited on, and a denominator the numerator can never reach is the
          // one way this bar could deadlock at 99%.
          settled += 1;
          onProgress?.({ filesParsed: settled, filesTotal: files.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, files.length) }, worker));

      for (const [i, file] of files.entries()) {
        changed += appendInternal(
          parsed[i] ?? [],
          file.projectSlug,
          file.sessionId,
          parentSessionPath(file.path, roots) !== null,
        );
      }
    } finally {
      // `ready` resolves even if the scan partially failed — endpoints must
      // not hang forever on a half-scannable filesystem. The watcher keeps the
      // store fresh regardless.
      resolveReady();
    }
    return changed;
  }

  // Does `selection` cover every Organization the stored events resolve under
  // RIGHT NOW? `false` for an empty or omitted selection — that is already "no
  // filter" to `compileAxisMatcher`, so there is nothing to normalise away.
  // An untagged row whose machine has no Home to presume resolves to nothing,
  // and nothing is in no selection, so its mere presence ends the no-op.
  //
  // An untagged row in an ASSERTED session (#309) resolves to the assertion,
  // not to its machine's presumption, and `untaggedMachines` cannot say which
  // sessions its rows sit in. So, conservatively, every asserted Organization
  // must be selected too — whether or not any stored row is actually in an
  // asserted session. Answering `false` more often only costs the fast path;
  // it can never count a row wrongly. A machine with no assertions keeps its
  // single-Organization fast path untouched.
  function coversEveryOrganizationPresent(
    selection: readonly string[] | undefined,
    presumption: Presumption,
  ): boolean {
    if (selection === undefined || selection.length === 0) return false;
    const selected = new Set(selection);
    for (const organization of taggedOrganizations) if (!selected.has(organization)) return false;
    for (const machineId of untaggedMachines) {
      const organization = presumedOrganization(presumption, machineId);
      if (organization === undefined || !selected.has(organization)) return false;
    }
    for (const organization of presumption.assertedBySession.values()) {
      if (!selected.has(organization)) return false;
    }
    return true;
  }

  function query(q: StoreQuery = {}): StoredEvent[] {
    const { since, until } = q;
    // The zone the date bounds are interpreted in (ADR-0015). Only used on the
    // date-filtered path; defaults to the host zone for a query that omits it.
    const timeZone = q.timeZone ?? defaultTimeZone();
    // The Presumed organization rule, read ONCE per query from the store's one
    // source — so the no-op below and the matcher it then compiles cannot
    // disagree about the Home in force even if a settings change lands between
    // the two statements.
    const presumption = getPresumption();
    // THE "covers everything present" no-op (#261/#262), taken PER CALL and
    // only here. When every Organization currently present is in the selection
    // the axis predicate would accept every stored event, so dropping the axis
    // is provably an identity — and dropping it is what keeps the unfiltered
    // fast path below alive on a single-Organization machine, which is the
    // whole purpose of the rule.
    //
    // PER CALL, because the present set GROWS. A matcher that took this no-op
    // and was then RETAINED — the report cache keeps one per entry, ADR-0057 —
    // would go on answering "everything belongs" after a second Organization's
    // first row landed, silently counting it under the first Organization's
    // scope for the life of the entry. So `compileAxisMatcher` never takes it
    // and this call site re-reads the present set every query: the two agree at
    // every instant, and the only copy that could go stale is recomputed
    // immediately before each use.
    const axes: StoreAxisQuery = coversEveryOrganizationPresent(q.organizations, presumption)
      ? { ...q, organizations: undefined }
      : q;
    // The non-date axes as ONE compiled predicate; `null` = every one of them
    // is unfiltered (see `compileAxisMatcher`).
    const matches = compileAxisMatcher(axes, presumption);

    // Unfiltered fast path — every axis is "no filter", so the result IS the
    // shared sorted snapshot (f27). Return it DIRECTLY rather than copying it
    // element-by-element. Per the query contract the result is read-only, so
    // sharing the memoized array is safe — no aggregator mutates it.
    if (since === undefined && until === undefined && matches === null) {
      return sortedEvents();
    }

    // Iterate the timestamp-sorted snapshot, not `events.values()` (insertion
    // order): a filter preserves order, so `out` comes out sorted with no
    // per-query re-sort.
    // ADR-0083: the bounds' form is decided ONCE per query (they share a
    // kind — the HTTP layer rejects a mix) and the instants are parsed once
    // here rather than per event.
    const instantBounds =
      (since !== undefined && isInstantBound(since)) ||
      (until !== undefined && isInstantBound(until));
    const sinceMs = instantBounds && since !== undefined ? Date.parse(since) : undefined;
    const untilMs = instantBounds && until !== undefined ? Date.parse(until) : undefined;
    const out: StoredEvent[] = [];
    for (const event of sortedEvents()) {
      if (since !== undefined || until !== undefined) {
        if (instantBounds) {
          // Half-open `[since, until)` window on the event's own timestamp,
          // read off the row's derived `ms` (ADR-0089) rather than re-parsed.
          const t = event.ms;
          // An unparseable timestamp fails the filter safe, as on the ymd path.
          if (Number.isNaN(t)) continue;
          if (sinceMs !== undefined && t < sinceMs) continue;
          // `continue`, never `break`: `sortedEvents` is a plain STRING sort
          // on `timestamp`, and the parser does not normalize, so a stream
          // holding an offset-bearing stamp (`...+02:00`) string-sorts hours
          // away from its instant — a `break` there would drop every later
          // in-window event. No ordering assumption is made; the ymd branch
          // already pays the same O(n).
          if (untilMs !== undefined && t >= untilMs) continue;
        } else {
          // Reproduce the golden oracle's `--since`/`--until` day grouping: an
          // event is kept if its *local-timezone* calendar date is within the
          // bound.
          const date = localDate(event.timestamp, timeZone);
          // An unparseable timestamp fails the date filter safe — excluded from
          // any since/until-bounded query rather than leaking past both bounds.
          if (date === null) {
            console.warn(
              `[store] event ${event.messageId} has an unparseable timestamp: ${event.timestamp}`,
            );
            continue;
          }
          if (since !== undefined && date.ymd < since) continue;
          if (until !== undefined && date.ymd > until) continue;
        }
      }
      if (matches !== null && !matches(event)) continue;
      out.push(event);
    }
    return out;
  }

  return {
    ready,
    scan,
    append,
    onLocalAppend: (listener) => {
      localAppendListeners.add(listener);
      return () => localAppendListeners.delete(listener);
    },
    removeMachineSessions: (machineId, sessions) => {
      const keys = new Set(sessions.map((s) => sessionKey(s.projectSlug, s.sessionId)));
      const changes: StoreChange[] = [];
      for (const [key, event] of events) {
        if (
          event.machineId !== machineId ||
          !keys.has(sessionKey(event.projectSlug, event.sessionId))
        )
          continue;
        events.delete(key);
        contributions.delete(key);
        changes.push({ event: null, replaced: event });
      }
      if (changes.length === 0) return;
      sorted = null;
      rebuildDerivedSets();
      emitChanges(changes);
    },
    appendFleet,
    localContribution: (messageId, requestId) => contributions.get(dedupKey(messageId, requestId)),
    contributions: () =>
      [...contributions.values()].sort((a, b) =>
        a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
      ),
    replaceContributions: (rows) => {
      contributions.clear();
      for (const row of rows) {
        const key = dedupKey(row.messageId, row.requestId);
        // #374: a contribution of a key an excluded copy holds is withheld
        // unless it supersedes the holder, as every feeder's copy is.
        if (excludedHolders.size > 0 && !beatsExcludedHolder(key, row, row.organizationUuid))
          continue;
        // #311: a dormant row is withheld from push, whatever store offers it.
        if (dormantRow(row.sessionId, row.organizationUuid, row.machineId === selfMachineId))
          continue;
        contributions.set(key, row);
      }
    },
    removeFleetKeys: (rows) => {
      const changes: StoreChange[] = [];
      for (const row of rows) {
        const key = dedupKey(row.messageId, row.requestId);
        const previous = events.get(key);
        if (previous !== undefined) {
          events.delete(key);
          changes.push({ event: null, replaced: previous });
        }
        const local = contributions.get(key);
        if (local !== undefined) {
          events.set(key, local);
          changes.push({ event: local, replaced: null });
        }
      }
      if (changes.length > 0) {
        sorted = null;
        rebuildDerivedSets();
        emitChanges(changes);
      }
    },
    query,
    onChanged: (listener) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    stampInsertionOrder: (visit) => {
      for (const e of events.values()) visit(e);
    },
    size: () => events.size,
    models: () => modelsSeen,
    foreignSessions: () => [...foreignSessions.values()].sort(byPair),
    isExcludedKey: (messageId, requestId) => excludedHolders.has(dedupKey(messageId, requestId)),
    organizationsSeen: () => organizationsSeen,
    organizationSessionCounts: () => {
      const counts = new Map<string, number>();
      for (const points of ownerPoints.values()) {
        const last = points[points.length - 1];
        if (last === undefined) continue;
        counts.set(last.organizationUuid, (counts.get(last.organizationUuid) ?? 0) + 1);
      }
      return counts;
    },
    onForeignEvidence: (listener) => {
      foreignListeners.add(listener);
      return () => {
        foreignListeners.delete(listener);
      };
    },
    dormantSessions: () => dormant,
    dormantPairs: () => [...dormantPairsSeen.values()].sort(byPair),
    isDormant: (row) =>
      dormantRow(row.sessionId, row.organizationUuid, row.machineId === selfMachineId),
    isWithheld: (row) =>
      row.machineId === selfMachineId &&
      (dormantRow(row.sessionId, row.organizationUuid, true) ||
        outsideTrackedSet(row.organizationUuid)),
    trackedOrganizations: () => trackedOrganizations,
    presumption: getPresumption,
  };
}
