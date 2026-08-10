import { EVENT_PUSH_BATCH_MAX, sessionPairKey } from "@maxprice/shared";
import {
  createFleetEventStore,
  fleetEventKey,
  fleetTokenTotal,
  type FleetEventStore,
} from "@maxprice/usage-core";
import type { EventStore, StoreChange, StoredEvent } from "./engine/store";
import { storedEventToWire } from "./stored-event-wire";

// The Local archive (#140, ADR-0069): a durable, append-only store of THIS
// machine's own parsed events — the client-side counterpart of the hub's
// archive of record, always on, independent of any hub. It exists because
// Claude Code prunes its session JSONL on a rolling window; once a transcript
// is swept, this file is the only copy of that history on a hub-less install.
//
// The store is createFleetEventStore in HUB mode, unmodified (ADR-0069 §2):
// fsync'd appends, torn-tail tolerance, bad-header REPAIR, rewrite compaction.
// The locally-minted seqs and the epoch header are inert freight. ONE inversion
// happens here at the call site, not in the store: hub-mode load() THROWS on an
// unreadable file (correct on the hub), but the archive is a backstop, not a
// dependency — a failure degrades (onDegraded → the Settings amber line) and
// the app runs archive-less until a sweep's retry repairs it.
//
// Writes converge by RECONCILIATION (the ADR-0055 shape): the engine store's
// onChanged feed appends promptly; the boot/interval sweep is the guarantee —
// it re-offers every self row the archive does not hold at ≥ its token
// fullness (the stamp predicate, pointed at the archive instead of the
// replica). That sweep is what makes crash-loss, a deleted file, and the
// first boot after upgrade all self-heal from whatever the corpus still holds.
//
// Own events only (ADR-0069 §4): rows whose machineId is this machine's.
// Replica-fed self rows riding back from a hub qualify too — past local
// retention they legitimately DEEPEN the archive.
//
// FORGET DURING A DEGRADE (ADR-0069 §8, "non-negotiable"). A forget that lands
// while the archive is unopenable cannot rewrite anything, and the next
// successful load would re-seed the engine with exactly the rows the user
// deleted — the archive resurrecting deliberately-forgotten data is the
// privacy regression the ADR forbids. So a forget that cannot be applied is
// REMEMBERED in `pendingForgets` and replayed by the next successful open,
// BEFORE that open seeds the engine. A rewrite failure on an already-open store
// is replayed by the next sweep. Both failures REJECT the forget call after
// queuing the retry: fleet.ts still performs the mandatory resync, but the HTTP
// request cannot acknowledge durability that the archive did not achieve. The
// pending set remains process-lifetime RAM; reporting the failure is what keeps
// a restart before the retry from becoming a falsely successful privacy action.
//
// FORGET LEAVES A PERMANENT INGESTION BAR (`forgottenPairs`, also ADR-0069 §8).
// The rewrite prunes the FILE; it cannot prune the live engine, and the client
// forget only removes those rows from RAM later — fleet.ts rewrites the archive,
// then unlinks the replica, rescans, and swaps the store (a forgotten session is
// storage-unbacked, so nothing short of that resync drops it). In the window
// between those two the engine still holds the forgotten rows, and every
// ingestion route here is key-blind: the sweep's filter is "self and unstamped",
// and after the rewrite those rows are precisely unstamped. A tick landing in
// that window re-appends them — and the damage does not stop at the file, since
// the next boot's seed puts them back in the engine unstamped against the
// replica, where the ordinary push loop sends them BACK to the hub. A silent,
// permanent, fleet-propagating undo of a privacy action. (The same bar also
// covers the narrower replica-off-during-rewrite rebuild, which would otherwise
// self-heal only until the next sweep converted it into the same resurrection.)
// So every pair passed to `forgetSessions` — on every path, including the
// degraded one — is remembered here and barred from the change feed, the sweep,
// and `seedInto` alike.
//
// NEVER CLEARED, deliberately: a forgotten session can produce no new legitimate
// events, because its transcript is gone — that is what made it forgettable in
// the first place. So a process-lifetime bar costs nothing real and needs no
// invalidation rule. This is RAM only, matching `pendingForgets`' posture and
// its documented residual above: a forget followed by a process restart relies
// on the rewrite having landed, which on the ordinary path it has.

const DEFAULT_SWEEP_MS = 300_000;

export type LocalArchiveDeps = {
  path: string; // <app-data>/local-archive.jsonl
  machineId: string; // this machine's own id — the ONLY machineId archived
  getStore: () => EventStore; // live engine accessor (the fleet rebuild swaps stores)
  onDegraded: (degraded: boolean) => void; // edge-triggered; wire to patchStatus
  sweepMs?: number; // default DEFAULT_SWEEP_MS
  createStoreImpl?: (path: string) => FleetEventStore; // test seam
  setIntervalImpl?: (cb: () => void, ms: number) => unknown; // test seam
  clearIntervalImpl?: (handle: unknown) => void; // test seam
};

export type LocalArchive = {
  loadAtBoot: () => Promise<void>; // NEVER rejects (rides engineReady's Promise.all)
  attachStore: (store: EventStore) => void; // (re)subscribe onChanged; boot + every swap
  seedInto: (store: EventStore) => number; // fresh.appendFleet([...all()]) for rebuildEngine
  sweep: () => Promise<void>; // reconcile engine→archive; also the degrade-retry
  startSweeps: () => void; // arm the interval (idempotent)
  forgetSessions: (
    sessions: readonly { projectSlug: string; sessionId: string }[],
  ) => Promise<void>; // rejects until rewrite is durable; fleet still resyncs
  // For the storage reporter. `null` means the archive has never LOADED — before
  // the first open, and after a load failure. It is NOT the inverse of
  // `degraded()`: a failed push degrades with the store still present and
  // readable (write failure), while a failed load degrades with `null` (no
  // store at all). Callers wanting "is the archive healthy" ask `degraded()`.
  store: () => FleetEventStore | null;
  degraded: () => boolean;
  stop: () => Promise<void>;
};

export function createLocalArchive(deps: LocalArchiveDeps): LocalArchive {
  const createStoreImpl =
    deps.createStoreImpl ?? ((path: string) => createFleetEventStore({ path, mode: "hub" }));
  const sweepMs = deps.sweepMs ?? DEFAULT_SWEEP_MS;
  const setIntervalImpl =
    deps.setIntervalImpl ?? ((cb: () => void, ms: number): unknown => setInterval(cb, ms));
  const clearIntervalImpl =
    deps.clearIntervalImpl ??
    ((h: unknown): void => clearInterval(h as ReturnType<typeof setInterval>));

  let archive: FleetEventStore | null = null;
  let isDegraded = false;
  let unsubscribe: (() => void) | null = null;
  let sweepTimer: unknown = null;
  // `stop()` is a BARRIER, not merely a drain: it closes the store's write
  // handle, so a straggler sweep enqueueing afterwards would silently reopen a
  // file nobody is going to close again. Every entry point consults this.
  let stopped = false;
  // Forgets that had no archive to rewrite — replayed by the next successful
  // open, before it seeds. See the header's FORGET DURING A DEGRADE note.
  const pendingForgets = new Set<string>();
  // Every pair this process has been asked to forget, barred from re-entering
  // the archive or the engine for the process lifetime. See the header's FORGET
  // LEAVES A PERMANENT INGESTION BAR note for the race and for why never
  // clearing is safe. Deliberately NOT merged with `pendingForgets`, whose keys
  // must keep clearing once replayed.
  const forgottenPairs = new Set<string>();
  // Serializes every archive write (change-feed appends, sweep batches, the
  // forget rewrite) so RAM/apply order matches disk order and a failure can't
  // interleave. `chain` NEVER rejects — append failures report via setDegraded,
  // while a forget keeps its rejecting `link` for the caller and forks a
  // swallowed continuation back into `chain`. Anything awaiting sweep/stop is
  // therefore safe without hiding destructive-action failures from fleet.ts.
  let chain: Promise<void> = Promise.resolve();

  function setDegraded(next: boolean): void {
    if (isDegraded === next) return;
    isDegraded = next;
    try {
      deps.onDegraded(next);
    } catch (err) {
      // The callback is a status-snapshot patch. If it throws it must not take
      // the caller with it: `loadAtBoot` promises never to reject, and a throw
      // out of a chain link would leave `chain` permanently rejected.
      console.warn("[sidecar] local archive onDegraded listener threw:", err);
    }
  }

  // The stamp predicate, pointed at the archive: a row is archived ⇔ the
  // archive holds its key at ≥ its token fullness. fleetTokenTotal is
  // structural over the four token counts, which StoredEvent and FleetEvent
  // both carry.
  function stamped(row: StoredEvent): boolean {
    const held = archive?.get(row.messageId, row.requestId);
    return held !== undefined && fleetTokenTotal(held) >= fleetTokenTotal(row);
  }

  function forgotten(row: { projectSlug: string; sessionId: string }): boolean {
    return forgottenPairs.has(sessionPairKey(row.projectSlug, row.sessionId));
  }

  // Collapse a batch to ONE row per dedup key, last wins.
  //
  // `push` documents its input as key-unique ("each key appears once in
  // `applied`") and its failed-fsync rollback depends on that: a repeated key
  // makes the batch's own earlier row the "incumbent" it restores, leaving RAM
  // holding a row whose line never reached disk. The change feed really does
  // emit repeated keys — `upsert` emits one StoreChange per CHANGING record, so
  // a streamed turn's `output_tokens: 1` partial and its final row arrive as two
  // changes sharing one key. Last-wins is exact rather than merely plausible:
  // the engine emits a second change for a key only on a STRICTLY greater token
  // total, so the later row is always the fuller one. It also keeps the archive
  // free of an immediately-superseded line per streamed turn.
  //
  // A no-op for the sweep, whose rows come from the engine's dedup map and are
  // unique by construction — applied there anyway so the invariant holds at the
  // one place that feeds `push`, not per caller.
  function dedupeByKey(rows: readonly StoredEvent[]): StoredEvent[] {
    if (rows.length < 2) return [...rows];
    const byKey = new Map<string, StoredEvent>();
    for (const row of rows) byKey.set(fleetEventKey(row.messageId, row.requestId), row);
    return [...byKey.values()];
  }

  function enqueueAppend(unfiltered: readonly StoredEvent[]): void {
    if (stopped) return;
    const rows = dedupeByKey(unfiltered);
    if (rows.length === 0) return;
    chain = chain.then(async () => {
      const a = archive;
      if (a === null) return; // degraded — the sweep's reload re-offers these
      for (let i = 0; i < rows.length; i += EVENT_PUSH_BATCH_MAX) {
        // Re-check the stamp inside the chain: an earlier link may have
        // archived the same key at equal fullness (scan/watcher overlap).
        const batch = rows.slice(i, i + EVENT_PUSH_BATCH_MAX).filter((r) => !stamped(r));
        if (batch.length === 0) continue;
        try {
          await a.push(batch.map(storedEventToWire), deps.machineId);
          setDegraded(false);
        } catch (err) {
          // Push rolled its rows back out of RAM — they stay unstamped, so the
          // next sweep re-offers them. Surface and stop this run.
          console.warn("[sidecar] local archive append failed:", err);
          setDegraded(true);
          return;
        }
      }
    });
  }

  function onChanges(changes: readonly StoreChange[]): void {
    const own = changes
      .map((c) => c.event)
      .filter((e) => e.machineId === deps.machineId && !forgotten(e) && !stamped(e));
    enqueueAppend(own);
  }

  function attachStore(store: EventStore): void {
    unsubscribe?.();
    unsubscribe = store.onChanged(onChanges);
  }

  // The keep-predicate a forget rewrite runs. `sessionPairKey` is the ONE
  // (projectSlug, sessionId) key helper — its own header states why a private
  // joiner is a bug waiting to happen.
  function keepAllBut(
    keys: ReadonlySet<string>,
  ): (row: { projectSlug: string; sessionId: string }) => boolean {
    return (row) => !keys.has(sessionPairKey(row.projectSlug, row.sessionId));
  }

  // Create + load the store, replay any pending forget, seed the engine from
  // what survived. Shared by boot, the sweep's degrade-retry, and a forget that
  // arrives with no archive open. Throws on any of those failing.
  async function openAndSeedInner(): Promise<void> {
    const store = createStoreImpl(deps.path);
    await store.load();
    // BEFORE the seed, not after: the whole point is that the engine never
    // re-ingests a forgotten row. A throw here leaves `archive` null and the
    // pending set intact, so the next sweep retries the pair together.
    await applyPendingForgets(store);
    archive = store;
    deps.getStore().appendFleet([...store.all()]);
  }

  async function applyPendingForgets(store: FleetEventStore): Promise<void> {
    if (pendingForgets.size === 0) return;
    const keys = new Set(pendingForgets);
    await store.rewrite({ keep: keepAllBut(keys), newEpoch: false });
    for (const key of keys) pendingForgets.delete(key);
  }

  // One open in flight at a time. Without this a sweep racing a forget (or two
  // sweeps racing on a slow disk) would each build a store over the same path,
  // both loading and both assigning `archive` — two writers, one file.
  let opening: Promise<void> | null = null;
  function openAndSeed(): Promise<void> {
    opening ??= openAndSeedInner().finally(() => {
      opening = null;
    });
    return opening;
  }

  async function loadAtBoot(): Promise<void> {
    try {
      await openAndSeed();
      setDegraded(false);
    } catch (err) {
      // NEVER rejects: this rides engineReady's Promise.all, and an unreadable
      // backstop must not 500 every report (ADR-0069 §3).
      console.warn("[sidecar] local archive load failed — running archive-less:", err);
      setDegraded(true);
    }
  }

  function seedInto(store: EventStore): number {
    if (archive === null) return 0;
    return store.appendFleet([...archive.all()].filter((r) => !forgotten(r)));
  }

  async function sweep(): Promise<void> {
    if (stopped) return;
    if (archive === null) {
      try {
        await openAndSeed();
        setDegraded(false);
      } catch {
        return; // still degraded; the next sweep retries
      }
    }
    const a = archive;
    if (a === null) return; // unreachable: openAndSeed either assigns or throws
    if (pendingForgets.size > 0) {
      // A failed rewrite leaves the store open and readable. Retry the pending
      // privacy deletion on that SAME serialized write chain; waiting for a
      // future reopen would make the queue inert for the rest of this process.
      const link = chain.then(() => applyPendingForgets(a));
      chain = link.then(
        () => {},
        () => {},
      );
      try {
        await link;
        setDegraded(false);
      } catch (err) {
        console.warn("[sidecar] local archive pending forget retry failed:", err);
        setDegraded(true);
        return;
      }
    }
    // query() with no args returns the shared memoized snapshot BY REFERENCE —
    // .filter copies before we hold it across awaits.
    const own = deps
      .getStore()
      .query()
      .filter((e) => e.machineId === deps.machineId && !forgotten(e) && !stamped(e));
    enqueueAppend(own);
    await chain;
  }

  function startSweeps(): void {
    if (stopped) return;
    sweepTimer ??= setIntervalImpl(() => {
      void sweep();
    }, sweepMs);
  }

  async function forgetSessions(
    sessions: readonly { projectSlug: string; sessionId: string }[],
  ): Promise<void> {
    if (sessions.length === 0) return;
    const keys = new Set(sessions.map((s) => sessionPairKey(s.projectSlug, s.sessionId)));
    // Bar these pairs from every ingestion route FIRST, before any await: the
    // rewrite below prunes the file, but the live engine keeps serving the rows
    // until the caller's resync swaps the store, and a sweep or change-feed tick
    // landing in that window would put them straight back (and, next boot, back
    // on the hub). Unconditional and ahead of the degrade branch so the queued
    // path is covered too. Never cleared — see the header.
    for (const key of keys) forgottenPairs.add(key);
    if (archive === null) {
      // Do not reopen a store `stop()` has already closed. The rewrite below
      // stays ungated on purpose — a destructive user action must still land
      // durably while a store exists — but resurrecting one after shutdown
      // would leave a writer nobody is going to close.
      if (stopped) return;
      // Remember the forget BEFORE attempting the open, not only when the open
      // fails. `openAndSeedInner` replays `pendingForgets` *before* it seeds the
      // engine, so this is what keeps the forgotten rows out of RAM on the
      // SUCCESS path too: registering the keys afterwards would let the retry's
      // seed carry exactly the rows being forgotten into the live store, and the
      // rewrite below would prune only the file. That is the ADR-0069 §8
      // resurrection shape, so the ordering here is load-bearing rather than
      // stylistic. On success the replay clears these keys and the rewrite below
      // is a no-op; on failure they stay queued for the next successful open.
      for (const key of keys) pendingForgets.add(key);
      // A forget is exactly the moment worth spending the degrade-retry on.
      try {
        await openAndSeed();
        setDegraded(false);
      } catch (err) {
        // `isDegraded` is already true from the load failure that put us here,
        // so there is no state to set — only the record already kept above.
        console.warn(
          `[sidecar] local archive unavailable — ${String(keys.size)} forgotten session(s) queued for the next successful open:`,
          err,
        );
        throw err;
      }
    }
    const a = archive;
    if (a === null) return; // unreachable: openAndSeed either assigns or throws
    const link = chain.then(() => a.rewrite({ keep: keepAllBut(keys), newEpoch: false }));
    chain = link.then(
      () => {},
      () => {},
    );
    try {
      await link;
      // Applied for real — anything queued for these pairs is settled.
      for (const key of keys) pendingForgets.delete(key);
    } catch (err) {
      // The file may still hold the rows. Queue the pairs for the next sweep,
      // surface the degrade, AND reject: the caller must resync because the hub
      // rewrite landed, but it must not acknowledge a local privacy deletion
      // that is not durable yet. The rows cannot resurrect into the engine in
      // this process because `forgottenPairs` bars every seed/ingestion path.
      for (const key of keys) pendingForgets.add(key);
      console.warn("[sidecar] local archive forget rewrite failed:", err);
      setDegraded(true);
      throw err;
    }
  }

  return {
    loadAtBoot,
    attachStore,
    seedInto,
    sweep,
    startSweeps,
    forgetSessions,
    store: () => archive,
    degraded: () => isDegraded,
    stop: async () => {
      stopped = true;
      if (sweepTimer !== null) {
        clearIntervalImpl(sweepTimer);
        sweepTimer = null;
      }
      unsubscribe?.();
      unsubscribe = null;
      await chain;
      await archive?.close();
    },
  };
}
