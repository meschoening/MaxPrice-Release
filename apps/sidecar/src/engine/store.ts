import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  fleetDedupKey,
  fleetDedupTokenTotal,
  worktreeSlugPrefix,
  type FleetEvent,
} from "@maxprice/shared";
import { identityFromPath } from "../identity";
import { collectUsageRecords } from "./jsonl";
import { localDate } from "./local-date";
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
export type StoredEvent = UsageRecord & {
  projectSlug: string;
  sessionId: string;
  // ADR-0041 (M5): REQUIRED machine attribution — never identity (the dedup
  // key stays (messageId, requestId)). Locally-scanned/watched rows are tagged
  // with the machine's own id (loadOrCreateMachineId's value) at append;
  // replica-fed rows carry the hub-minted id. No "undefined = self" sentinel.
  machineId: string;
};

// ---------------------------------------------------------------------------
// StoreChange — the change feed's unit (consumed by the report cache, #113)
// ---------------------------------------------------------------------------

// One RAM-changing upsert, as the change feed reports it (Task F1/#113): the
// event now stored, and the exact event object it displaced (`null` for a new
// key). A replacement may differ from `replaced` in ANY field — including
// sessionId/projectSlug/timestamp — the merge rule is whole-row.
export type StoreChange = { event: StoredEvent; replaced: StoredEvent | null };

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
  // Inclusive lower bound, `YYYYMMDD`. An event is kept if its *local-timezone*
  // calendar date is >= this. Reproduces the golden oracle's `--since`.
  since?: string;
  // Inclusive upper bound, `YYYYMMDD`. An event is kept if its local-timezone
  // calendar date is <= this. Reproduces the golden oracle's `--until`.
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
export type StoreAxisQuery = Pick<StoreQuery, "projects" | "sessions" | "models" | "machines">;

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
export function compileAxisMatcher(q: StoreAxisQuery): ((e: StoredEvent) => boolean) | null {
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
  // Lowered ONCE here rather than per event (see `lowerModelNeedles`); the
  // `.length === 0` "unfiltered" check is unaffected by the mapping.
  const models = lowerModelNeedles(q.models ?? []);
  if (
    projectFilter === null &&
    sessionFilter === null &&
    machineFilter === null &&
    models.length === 0
  ) {
    return null;
  }
  return (e) => {
    if (!matchesProject(e.projectSlug)) return false;
    if (machineFilter !== null && !machineFilter.has(e.machineId)) return false;
    if (sessionFilter !== null && !sessionFilter.has(e.sessionId)) return false;
    return matchesLoweredModelFilter(e.model, models);
  };
}

// ---------------------------------------------------------------------------
// Dedup key
// ---------------------------------------------------------------------------

// The dedup key + token-total tie-breaker are the ONE fleet merge rule, defined
// once in `@maxprice/shared` (fleet-dedup.ts) and shared byte-for-byte with the
// hub archive + client replica (packages/usage-core/src/fleet-event-store.ts).
// Aliased to the local names `upsert` calls; the cross-store parity tests pin
// the invariant. Claude Code writes several rows per assistant message sharing
// `(messageId, requestId)` — 2–3 byte-identical content-block lines (E1 finding
// #1) plus, for a streamed turn, an `output_tokens: 1` partial ahead of the
// final row — and the store keeps exactly one per distinct tuple: the largest
// token-total, ties first-seen (an absent requestId is a DISTINCT key from an
// empty-string one — see fleet-dedup.ts).
const dedupKey = fleetDedupKey;
const tokenTotal = fleetDedupTokenTotal;

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
  // parsed records and the project/session they belong to. Deduped.
  append: (records: UsageRecord[], projectSlug: string, sessionId: string) => void;
  // The fleet replica feeder (ADR-0041 M5, see fleet.ts) — projects hub-minted
  // wire rows onto `StoredEvent` and upserts each through the SAME merge rule
  // the local path uses. Returns how many rows changed RAM (new + replaced),
  // the caller's poke-worthiness signal.
  appendFleet: (rows: FleetEvent[]) => number;
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
}): EventStore {
  // The machine id every locally-scanned/watched row is tagged with (ADR-0041).
  // The fleet feeder carries each replica row's own hub-minted id instead.
  const selfMachineId = opts.selfMachineId;
  const scanCache = opts.scanCache;

  // The deduped event set, keyed by `(messageId, requestId)`. A Map (not an
  // array) so a re-scan / truncation re-read / scan-watcher overlap is an O(1)
  // keyed upsert — a duplicate key is resolved by `upsert`'s
  // largest-token-total rule, never blindly re-added.
  const events = new Map<string, StoredEvent>();

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
  // whole-row largest-token-total upsert, ties keep first-seen. Returns
  // whether RAM changed, and appends that change to the caller's batch. Both
  // feeders — local scan/watcher and the fleet replica — converge through this
  // exact function. When a record's dedup key is already present the store
  // keeps whichever event has the larger token total (`tokenTotal`) — the
  // golden oracle's dedup rule, now the ONE fleet rule. A new record replaces
  // the stored one only when strictly larger, so equal-total duplicates (the
  // byte-identical content-block lines) keep first-seen, and a streamed
  // message's final row replaces the `output_tokens: 1` partial regardless of
  // which the scan reads first.
  function upsert(event: StoredEvent, changes: StoreChange[]): boolean {
    const key = dedupKey(event.messageId, event.requestId);
    const existing = events.get(key);
    if (existing !== undefined && tokenTotal(existing) >= tokenTotal(event)) return false;
    events.set(key, event);
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
  ): number {
    const changes: StoreChange[] = [];
    let changed = 0;
    for (const record of records) {
      if (upsert({ ...record, projectSlug, sessionId, machineId: selfMachineId }, changes)) {
        changed += 1;
      }
    }
    emitChanges(changes);
    return changed;
  }

  function append(records: UsageRecord[], projectSlug: string, sessionId: string): void {
    appendInternal(records, projectSlug, sessionId);
  }

  // The fleet feeder (ADR-0041): project a wire FleetEvent onto StoredEvent —
  // the engine keeps only the fields it interprets (the REPLICA is the
  // verbatim persistence layer; RAM projection is lossy by design) — and
  // upsert through the one merge rule. Returns how many rows changed RAM
  // (new + replaced), the caller's poke-worthiness signal. ONE change-feed emit
  // per call — i.e. per applied replica page.
  function appendFleet(rows: FleetEvent[]): number {
    const changes: StoreChange[] = [];
    let changed = 0;
    for (const row of rows) {
      const stored: StoredEvent = {
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
        projectSlug: row.projectSlug,
        sessionId: row.sessionId,
        machineId: row.machineId,
      };
      if (upsert(stored, changes)) changed += 1;
    }
    emitChanges(changes);
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
        changed += appendInternal(parsed[i] ?? [], file.projectSlug, file.sessionId);
      }
    } finally {
      // `ready` resolves even if the scan partially failed — endpoints must
      // not hang forever on a half-scannable filesystem. The watcher keeps the
      // store fresh regardless.
      resolveReady();
    }
    return changed;
  }

  function query(q: StoreQuery = {}): StoredEvent[] {
    const { since, until } = q;
    // The zone the date bounds are interpreted in (ADR-0015). Only used on the
    // date-filtered path; defaults to the host zone for a query that omits it.
    const timeZone = q.timeZone ?? defaultTimeZone();
    // The non-date axes as ONE compiled predicate; `null` = every one of them
    // is unfiltered (see `compileAxisMatcher`).
    const matches = compileAxisMatcher(q);

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
    const out: StoredEvent[] = [];
    for (const event of sortedEvents()) {
      if (since !== undefined || until !== undefined) {
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
      if (matches !== null && !matches(event)) continue;
      out.push(event);
    }
    return out;
  }

  return {
    ready,
    scan,
    append,
    appendFleet,
    query,
    onChanged: (listener) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    stampInsertionOrder: (visit) => {
      for (const e of events.values()) visit(e);
    },
    size: () => events.size,
  };
}
