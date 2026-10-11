import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import {
  fleetEventSchema,
  fleetChangeSchema,
  fleetSnapshotPageSchema,
  fleetChangesPageSchema,
  type FleetChange,
  type FleetChangesPage,
  type FleetSnapshotPage,
  type FleetEvent,
  type StoredEventWire,
  type HubEventStamp,
  fleetCopySupersedes,
  fleetDedupKey,
  fleetDedupTokenTotal,
  fleetFullnessPartsExceed,
  internRowStrings,
} from "@maxprice/shared";

// The ONE merge rule's key and token total (ADR-0103), defined once in
// `@maxprice/shared` (fleet-dedup.ts) and shared byte-for-byte with the engine
// store's private copy (apps/sidecar/src/engine/store.ts), re-exported under
// the names the stores, event-sync and the tests use.
export const fleetEventKey = fleetDedupKey;
export const fleetTokenTotal = fleetDedupTokenTotal;

// The byte cost of one row's canonical line: its JSON and one "\n". Storage's
// unbacked bytes (#130) sum it over a replica's records, and a record carries it
// so Storage reads no row (ADR-0111 §2).
export function fleetRowBytes(row: FleetEvent): number {
  return Buffer.byteLength(JSON.stringify(row)) + 1;
}

// `fleetRowBytes` of a row whose JSON is already in hand. The replica counts
// its records this way (#363), from the `JSON.stringify(row)` it stores as the
// row's `body`, rather than serializing every row a second time at load.
export function fleetJsonBytes(json: string): number {
  return Buffer.byteLength(json) + 1;
}

export class FleetRecoveryRequired extends Error {}
export class FleetUploadConflict extends Error {}

type Snapshot = {
  rows: readonly FleetEvent[];
  cursor: number;
  generation: number;
  expires: number;
};
type DeleteReceipt = {
  epoch: string;
  deletionGeneration: number;
  removed: number;
  sessionsMatched: number;
};

/**
 * What a replica keeps resident for one key in place of its row (ADR-0111 §1).
 * Every per-row read answers from it: the push pass's stamp predicate,
 * `mayArchiveFleet` and Storage's unbacked classification. `total` and
 * `organizationUuid` are the row's fullness parts (ADR-0103); `bytes` is its
 * canonical line's byte cost (`fleetRowBytes`), which Storage sums for the
 * unbacked bytes. The strings are the row's interned ones (ADR-0110 §3).
 */
export type FleetRecord = {
  readonly seq: number;
  readonly total: number;
  readonly organizationUuid: string | undefined;
  readonly machineId: string;
  readonly projectSlug: string;
  readonly sessionId: string;
  readonly bytes: number;
};

/** The record of `row`, whose canonical line costs `bytes`. */
export function fleetRecord(row: FleetEvent, bytes = fleetRowBytes(row)): FleetRecord {
  return {
    seq: row.seq,
    total: fleetDedupTokenTotal(row),
    organizationUuid: row.organizationUuid,
    machineId: row.machineId,
    projectSlug: row.projectSlug,
    sessionId: row.sessionId,
    bytes,
  };
}

/**
 * What the Local archive keeps resident for one key in place of its row
 * (ADR-0111 §1). The archive's per-row reads answer from it alone: the stamp
 * predicate, `excludedPairs`, the forgets' choice of keys and Storage's
 * earliest-at, which reads `timestamp` and skips withheld rows. `total` and
 * `organizationUuid` are the row's fullness parts (ADR-0103). The categorical
 * strings are the row's interned ones (ADR-0110 §3); the timestamp is a
 * per-event value and is not interned.
 */
export type ArchiveRecord = {
  readonly seq: number;
  readonly total: number;
  readonly organizationUuid: string | undefined;
  readonly machineId: string;
  readonly projectSlug: string;
  readonly sessionId: string;
  readonly timestamp: string;
};

/** The archive record of `row`. */
export function archiveRecord(row: FleetEvent): ArchiveRecord {
  return {
    seq: row.seq,
    total: fleetDedupTokenTotal(row),
    organizationUuid: row.organizationUuid,
    machineId: row.machineId,
    projectSlug: row.projectSlug,
    sessionId: row.sessionId,
    timestamp: row.timestamp,
  };
}

// The rows a whole-corpus read parses and hands on at a time (ADR-0111 §3): a
// chunk's parse and apply take milliseconds, so the event loop answers
// `/api/status` between chunks.
const ROW_CHUNK = 1_000;

type StoredRow = { key: string; seq: number; body: string };

export type FleetStoreOptions = {
  path: string;
  nowImpl?: () => string;
  retentionMs?: number;
  retentionBytes?: number;
  snapshotTtlMs?: number;
  beforeCommit?: () => void;
};
type FleetStoreMode = "hub" | "replica" | "archive";

/** ADR-0100. SQLite owns committed rows, replay progress, and operation receipts.
 * RAM holds one resident entry per key, published only after COMMIT succeeds.
 * The mode decides what that entry is (ADR-0111): the Hub keeps the row, which
 * its fixed snapshots pin (§4), and a replica and the Local archive keep the
 * row's record (§1, §5).
 */
function openFleetDatabase<T extends { readonly seq: number }>(
  opts: FleetStoreOptions & { mode: FleetStoreMode },
  // A stored row's resident entry, given the JSON stored as its body.
  toResident: (row: FleetEvent, json: string) => T,
  // The resident entries changed: a commit published writes, or the map was dropped.
  onChange: () => void,
) {
  let db: Database | null = null;
  let resident: Map<string, T> | null = null;
  let staged: { clear: boolean; entries: Map<string, T | null> } | null = null;
  let loaded = false;
  let recovered = false;
  // Counts every open and close of the database, so a read that awaits between
  // chunks can tell the database it started on is gone.
  let openings = 0;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  function database(): Database {
    if (db === null) throw new Error("Fleet database is not open");
    return db;
  }
  function get(name: string): string {
    return (
      database().query<{ value: string }, [string]>("SELECT value FROM meta WHERE name=?").get(name)
        ?.value ?? ""
    );
  }
  function number(name: string): number {
    return Number(get(name));
  }
  function set(name: string, value: string | number): void {
    database()
      .query("INSERT OR REPLACE INTO meta(name,value) VALUES (?,?)")
      .run(name, String(value));
  }
  function transaction<R>(fn: () => R): R {
    if (staged !== null) throw new Error("Nested fleet transaction");
    const changes = { clear: false, entries: new Map<string, T | null>() };
    staged = changes;
    try {
      const result = database()
        .transaction(() => {
          const result = fn();
          opts.beforeCommit?.();
          return result;
        })
        .immediate();
      // Publish only committed changes. Keeping the resident entries avoids
      // parsing the complete archive again after every small transaction or
      // snapshot.
      if (resident !== null) {
        if (changes.clear) resident.clear();
        for (const [key, entry] of changes.entries) {
          if (entry === null) resident.delete(key);
          else resident.set(key, entry);
        }
      }
      if (changes.clear || changes.entries.size > 0) onChange();
      return result;
    } finally {
      staged = null;
    }
  }
  function close(): void {
    db?.close();
    if (db !== null) openings++;
    db = null;
    loaded = false;
    resident = null;
    onChange();
  }
  async function load(): Promise<void> {
    if (loaded) return;
    if (
      opts.mode === "hub" &&
      !existsSync(opts.path) &&
      existsSync(join(dirname(opts.path), "events.jsonl"))
    )
      throw new Error(
        "Legacy Hub archive requires the manual SQLite cutover before event sync can start",
      );
    mkdirSync(dirname(opts.path), { recursive: true });
    try {
      db = new Database(opts.path, { create: true, strict: true });
      openings++;
      if (opts.mode === "hub") db.exec("PRAGMA locking_mode=EXCLUSIVE;");
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      const check = db.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
      if (check?.quick_check !== "ok") throw new Error("Fleet database integrity check failed");
      const fresh =
        db
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM sqlite_master WHERE type='table'")
          .get()!.count === 0;
      const createSchema = () =>
        database().exec(`
        CREATE TABLE IF NOT EXISTS meta(name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(key TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS changes(cursor INTEGER PRIMARY KEY, at INTEGER NOT NULL, bytes INTEGER NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, scope TEXT NOT NULL, body TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0);
      `);
      // A fresh file has no committed tables until its metadata is committed
      // too. A crash at any earlier statement rolls the entire initialization
      // back, so the next open is still fresh. Established archives continue
      // to fail closed when their metadata is missing; they are never reset.
      if (fresh)
        transaction(() => {
          createSchema();
          set("format", 1);
          set("epoch", opts.mode === "hub" ? crypto.randomUUID() : "");
          for (const name of [
            "cursor",
            "eventSeq",
            "generation",
            "floor",
            "seeded",
            "snapshotOffset",
          ])
            set(name, 0);
        });
      else {
        createSchema();
        if (get("format") === "") throw new Error("Fleet database integrity: missing metadata");
      }
      if (get("format") !== "1") throw new Error("Unsupported fleet database format");
      for (const name of [
        "cursor",
        "eventSeq",
        "generation",
        "floor",
        "seeded",
        "snapshotOffset",
      ]) {
        if (!/^\d+$/.test(get(name)) || !Number.isSafeInteger(number(name)))
          throw new Error("Fleet database integrity: invalid metadata");
      }
      if (number("floor") > number("cursor") || (opts.mode === "hub" && get("epoch") === ""))
        throw new Error("Fleet database integrity: invalid archive boundary");
      loaded = true;
      // Validate complete payloads. A corrupt archive must never become writable.
      committed();
    } catch (error) {
      close();
      // Only the replica, a disposable cache, is ever deleted and recreated. The
      // Hub's archive and the Local archive (ADR-0069 §3) are archives of
      // record: the error reaches the caller, and the file stays as it is.
      if (
        opts.mode !== "replica" ||
        recovered ||
        !(error instanceof Error) ||
        !(
          error instanceof SyntaxError ||
          /malformed|not a database|integrity|ZodError/i.test(String(error))
        )
      )
        throw error;
      recovered = true;
      // Disposable cache only; never used for the Hub archive.
      for (const suffix of ["", "-wal", "-shm"]) rmSync(opts.path + suffix, { force: true });
      await load();
    } finally {
      resolveReady();
    }
  }
  // One stored row, parsed, interned (ADR-0110 §3) and checked against the key
  // and seq it is stored under.
  function parseStored({ key, seq, body }: StoredRow): FleetEvent {
    const row = internRowStrings(fleetEventSchema.parse(JSON.parse(body)));
    if (key !== fleetEventKey(row.messageId, row.requestId) || seq !== row.seq)
      throw new Error("Fleet database integrity mismatch");
    return row;
  }
  // Every stored row, in seq order, a chunk at a time. Each chunk is its own
  // statement, run to completion, so nothing stays open between chunks: a
  // caller may write between them, and the next chunk reads past the last seq
  // it saw.
  function* storedChunks(): Generator<StoredRow[]> {
    const query = database().query<StoredRow, [number, number]>(
      "SELECT key,seq,body FROM events WHERE seq>? ORDER BY seq LIMIT ?",
    );
    for (let after = 0; ; ) {
      const stored = query.all(after, ROW_CHUNK);
      if (stored.length === 0) return;
      yield stored;
      if (stored.length < ROW_CHUNK) return;
      after = stored.at(-1)!.seq;
    }
  }
  // The committed resident entries, built once from every stored row: that
  // parse is the load's validation of complete payloads.
  function committed(): Map<string, T> {
    if (resident === null) {
      const entries = new Map<string, T>();
      for (const stored of storedChunks())
        for (const row of stored) entries.set(row.key, toResident(parseStored(row), row.body));
      resident = entries;
    }
    return resident;
  }
  // Every full row, or with `select` only the rows whose resident entry it
  // picks, in seq order, from SQLite (ADR-0111 §3). Each chunk is read and
  // handed to `apply` in one synchronous step, and the read awaits the event
  // loop between chunks. So a change committed between two chunks lands after
  // the chunk that held the row it changes: a later chunk reads past it, and
  // the change's own feed carries it. A read whose database closes under it (a
  // detach, a shutdown) stops there.
  async function readRows(
    apply: (rows: FleetEvent[]) => void,
    select?: (entry: T) => boolean,
  ): Promise<void> {
    const opened = openings;
    for (const stored of select === undefined ? storedChunks() : selectedChunks(select)) {
      if (stored.length > 0) apply(stored.map(parseStored));
      await yieldToLoop();
      if (openings !== opened) return;
    }
  }
  // `readRows` without awaiting, for the boot seed, which may stay synchronous.
  function readRowsSync(apply: (rows: FleetEvent[]) => void): void {
    for (const stored of storedChunks()) apply(stored.map(parseStored));
  }
  // The rows of the entries `select` picks now, in their seq order, read by
  // key a chunk at a time. A key deleted since is skipped; one replaced since
  // reads its current row.
  function* selectedChunks(select: (entry: T) => boolean): Generator<StoredRow[]> {
    const picked: [number, string][] = [];
    for (const [key, entry] of committed()) if (select(entry)) picked.push([entry.seq, key]);
    picked.sort((a, b) => a[0] - b[0]);
    const lookup = database().query<{ seq: number; body: string }, [string]>(
      "SELECT seq,body FROM events WHERE key=?",
    );
    for (let i = 0; i < picked.length; i += ROW_CHUNK) {
      const stored: StoredRow[] = [];
      for (const [, key] of picked.slice(i, i + ROW_CHUNK)) {
        const row = lookup.get(key);
        if (row !== null) stored.push({ key, ...row });
      }
      yield stored.sort((a, b) => a.seq - b.seq);
    }
  }
  // One key's resident entry as this connection sees it: the committed entries
  // under the open transaction's own writes, so a key put earlier in the same
  // batch reads back exactly as SQLite would return it (ADR-0110 §2). The push
  // loop and the archive sweep ask this once per local row, and the Hub once
  // per pushed row, so it never reads or parses a row per call (#361). Callers
  // only read the entry.
  function residentByKey(key: string): T | undefined {
    if (resident !== null) {
      if (staged !== null) {
        const pending = staged.entries.get(key);
        if (pending !== undefined) return pending ?? undefined;
        if (staged.clear) return undefined;
      }
      return resident.get(key);
    }
    const stored = database()
      .query<{ seq: number; body: string }, [string]>("SELECT seq,body FROM events WHERE key=?")
      .get(key);
    return stored === null ? undefined : toResident(parseStored({ key, ...stored }), stored.body);
  }
  // Stages a written row's resident entry; it is published on commit.
  function stage(key: string, row: FleetEvent, json: string): void {
    staged?.entries.set(key, toResident(row, json));
  }
  function stageDelete(key: string): void {
    staged?.entries.set(key, null);
  }
  function stageClear(): void {
    if (staged !== null) staged.clear = true;
  }
  function put(row: FleetEvent): void {
    internRowStrings(row); // its strings become resident on commit (#361)
    const key = fleetEventKey(row.messageId, row.requestId);
    const json = JSON.stringify(row);
    database()
      .query(
        "INSERT INTO events(key,seq,body) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET seq=excluded.seq, body=excluded.body",
      )
      .run(key, row.seq, json);
    stage(key, row, json);
  }
  function fileBytes(): number {
    let bytes = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        bytes += statSync(opts.path + suffix).size;
      } catch {
        /* absent companion */
      }
    }
    return bytes;
  }
  function reclaimableBytes(): number {
    const row = database().query<{ freelist_count: number }, []>("PRAGMA freelist_count").get();
    const page = database().query<{ page_size: number }, []>("PRAGMA page_size").get();
    return (row?.freelist_count ?? 0) * (page?.page_size ?? 0);
  }
  async function compact() {
    const before = fileBytes();
    database().exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
    return { droppedLines: 0, freedBytes: Math.max(0, before - fileBytes()) };
  }
  function size(): number {
    return database().query<{ count: number }, []>("SELECT count(*) AS count FROM events").get()!
      .count;
  }
  return {
    // The surface every mode shares.
    storage: { ready, load, compact, size, fileBytes, reclaimableBytes },
    // The Hub's and the replica's replication state (ADR-0100). The Local
    // archive has no epoch, cursor or deletion generation (ADR-0111 §5).
    replication: {
      epoch: () => get("epoch"),
      durableSeq: () => number("cursor"),
      cursor: () => number("cursor"),
      deletionGeneration: () => number("generation"),
      seeded: () => number("seeded") === 1,
      seedState: () => ({
        snapshot: get("snapshot") || undefined,
        offset: number("snapshotOffset"),
      }),
      flush: async () => {},
    },
    database,
    get,
    number,
    set,
    transaction,
    close,
    committed,
    residentByKey,
    readRows,
    readRowsSync,
    stage,
    stageDelete,
    stageClear,
    put,
  };
}

// The Hub's archive of record. It keeps every row resident: a fixed snapshot
// pins the resident row array, the only place a row deleted after the
// snapshot's cursor can still be served from (ADR-0111 §4).
function hubStore(opts: FleetStoreOptions) {
  let cache: readonly FleetEvent[] | null = null;
  const core = openFleetDatabase<FleetEvent>(
    { ...opts, mode: "hub" },
    (row) => row,
    () => {
      cache = null;
    },
  );
  const { database, get, number, set, transaction } = core;
  const snapshots = new Map<string, Snapshot>();
  const now = () => opts.nowImpl?.() ?? new Date().toISOString();
  const clock = () => Date.parse(now());
  const retentionMs = opts.retentionMs ?? 90 * 86400_000;
  const retentionBytes = opts.retentionBytes ?? 256 * 1024 * 1024;
  function all(): readonly FleetEvent[] {
    return (cache ??= [...core.committed().values()].sort((a, b) => a.seq - b.seq));
  }
  // The resident row of one key, as this connection sees it (ADR-0110 §2).
  function event(messageId: string, requestId: string | undefined): FleetEvent | undefined {
    return core.residentByKey(fleetEventKey(messageId, requestId));
  }
  function prune(): void {
    const rows = database()
      .query<
        { cursor: number; at: number; bytes: number },
        []
      >("SELECT cursor,at,bytes FROM changes ORDER BY cursor")
      .all();
    let bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    let floor = number("floor");
    for (const row of rows) {
      if (row.at >= clock() - retentionMs && bytes <= retentionBytes) break;
      floor = row.cursor;
      bytes -= row.bytes;
    }
    database().query("DELETE FROM changes WHERE cursor<=?").run(floor);
    set("floor", floor);
  }
  function appendChange(upserts: FleetEvent[], deletes: FleetChange["deletes"]): void {
    if (upserts.length === 0 && deletes.length === 0) return;
    if (deletes.length > 0) set("generation", number("generation") + 1);
    const change: FleetChange = {
      cursor: number("cursor") + 1,
      deletionGeneration: number("generation"),
      upserts,
      deletes,
    };
    const body = JSON.stringify(change);
    database()
      .query("INSERT INTO changes(cursor,at,bytes,body) VALUES (?,?,?,?)")
      .run(change.cursor, clock(), Buffer.byteLength(body), body);
    set("cursor", change.cursor);
    set("lastAppend", now());
    prune();
  }
  async function push(
    rows: StoredEventWire[],
    machineId: string,
    fence?: { epoch: string; deletionGeneration: number },
  ) {
    return transaction(() => {
      if (
        fence !== undefined &&
        (fence.epoch !== get("epoch") || fence.deletionGeneration !== number("generation"))
      ) {
        throw new FleetUploadConflict("Reconcile deletions before contributing");
      }
      const upserts: FleetEvent[] = [];
      const stamps: HubEventStamp[] = [];
      for (const input of rows) {
        const previous = event(input.messageId, input.requestId);
        let row = previous;
        // The one merge rule (ADR-0103): a larger total, or an equal total
        // gaining a tag or a smaller one (#374). A loser is stamped with the
        // incumbent's seq below.
        if (previous === undefined || fleetCopySupersedes(input, previous)) {
          const seq = number("eventSeq") + 1;
          row = fleetEventSchema.parse({ ...input, machineId, seq });
          core.put(row);
          set("eventSeq", seq);
          upserts.push(row);
        }
        stamps.push({ messageId: input.messageId, requestId: input.requestId, seq: row!.seq });
      }
      appendChange(upserts, []);
      return {
        epoch: get("epoch"),
        deletionGeneration: number("generation"),
        added: upserts.length,
        stamps,
      };
    });
  }
  async function remove(
    operationId: string,
    scope: string,
    matches: (row: FleetEvent) => boolean,
  ): Promise<DeleteReceipt> {
    return transaction(() => {
      const prior = database()
        .query<
          { scope: string; body: string },
          [string]
        >("SELECT scope,body FROM operations WHERE id=?")
        .get(operationId);
      if (prior !== null) {
        if (prior.scope !== scope)
          throw new FleetUploadConflict("Deletion operation scope changed");
        return JSON.parse(prior.body) as DeleteReceipt;
      }
      const rows = all().filter(matches);
      const removeRow = database().query("DELETE FROM events WHERE key=?");
      for (const row of rows) {
        const key = fleetEventKey(row.messageId, row.requestId);
        removeRow.run(key);
        core.stageDelete(key);
      }
      appendChange(
        [],
        rows.map(({ messageId, requestId, seq }) => ({ messageId, requestId, seq })),
      );
      const receipt: DeleteReceipt = {
        epoch: get("epoch"),
        deletionGeneration: number("generation"),
        removed: rows.length,
        sessionsMatched: new Set(
          rows.map((row) => JSON.stringify([row.projectSlug, row.sessionId])),
        ).size,
      };
      database()
        .query("INSERT INTO operations(id,scope,body) VALUES (?,?,?)")
        .run(operationId, scope, JSON.stringify(receipt));
      return receipt;
    });
  }
  function changes(since: number, limit: number, through = number("cursor")): FleetChangesPage {
    transaction(prune);
    if (
      since < number("floor") ||
      since > number("cursor") ||
      through > number("cursor") ||
      through < since
    ) {
      throw new FleetRecoveryRequired("Incremental history is unavailable");
    }
    const rows: FleetChange[] = [];
    let bytes = 0;
    // A statement of its own, finalized below: leaving a cached query()'s
    // iterate() early breaks every later run of that SQL (#358).
    const query = database().prepare<{ body: string; bytes: number }, [number, number, number]>(
      "SELECT body,bytes FROM changes WHERE cursor>? AND cursor<=? ORDER BY cursor LIMIT ?",
    );
    try {
      for (const row of query.iterate(since, through, limit)) {
        if (rows.length > 0 && bytes + row.bytes > 4 * 1024 * 1024) break;
        rows.push(fleetChangeSchema.parse(JSON.parse(row.body)));
        bytes += row.bytes;
      }
    } finally {
      query.finalize();
    }
    return {
      epoch: get("epoch"),
      seq: through,
      deletionGeneration: number("generation"),
      floor: number("floor"),
      changes: rows,
      complete: (rows.at(-1)?.cursor ?? since) === through,
    };
  }
  function snapshotPage(id: string | undefined, offset: number, limit: number): FleetSnapshotPage {
    const time = clock();
    for (const [key, value] of snapshots) if (value.expires <= time) snapshots.delete(key);
    if (id === undefined) {
      if (offset !== 0) throw new FleetRecoveryRequired("Missing snapshot identity");
      // Reuse an immutable current snapshot; at most two generations are held.
      id = [...snapshots].find(([, value]) => value.cursor === number("cursor"))?.[0];
      if (id === undefined) {
        if (snapshots.size >= 2) snapshots.delete(snapshots.keys().next().value!);
        id = crypto.randomUUID();
        snapshots.set(id, {
          rows: all(),
          cursor: number("cursor"),
          generation: number("generation"),
          expires: time + (opts.snapshotTtlMs ?? 15 * 60_000),
        });
      }
    }
    const snapshot = snapshots.get(id);
    if (
      snapshot === undefined ||
      snapshot.cursor < number("floor") ||
      offset > snapshot.rows.length
    )
      throw new FleetRecoveryRequired("Snapshot expired");
    const events = snapshot.rows.slice(offset, offset + limit);
    const nextOffset = offset + events.length;
    return {
      epoch: get("epoch"),
      snapshot: id,
      seq: snapshot.cursor,
      deletionGeneration: snapshot.generation,
      offset,
      nextOffset,
      total: snapshot.rows.length,
      events,
      complete: nextOffset === snapshot.rows.length,
    };
  }
  return {
    ...core.storage,
    ...core.replication,
    push,
    remove,
    changes,
    snapshotPage,
    all,
    get: event,
    getByKey: core.residentByKey,
    changeBytes: () =>
      database()
        .query<{ bytes: number }, []>("SELECT coalesce(sum(bytes),0) AS bytes FROM changes")
        .get()!.bytes,
    lastAppendAt: () => get("lastAppend") || null,
    completeOperation: (id: string) =>
      transaction(() => database().query("UPDATE operations SET complete=1 WHERE id=?").run(id)),
    hasOperation: (id: string) =>
      database().query("SELECT id FROM operations WHERE id=?").get(id) !== null,
    operationComplete: (id: string) =>
      database()
        .query<{ complete: number }, [string]>("SELECT complete FROM operations WHERE id=?")
        .get(id)?.complete === 1,
    pendingOperations: () =>
      database()
        .query<
          { id: string; scope: string },
          []
        >("SELECT id,scope FROM operations WHERE complete=0")
        .all(),
    close: async () => {
      core.close();
      snapshots.clear();
    },
  };
}

// A client's disposable copy of the Hub archive. It keeps a record per key,
// never the row (ADR-0111 §1): per-row reads answer from the records, and only
// a whole-corpus operation reads full rows, from SQLite (§3).
function replicaStore(opts: FleetStoreOptions) {
  const core = openFleetDatabase<FleetRecord>(
    { ...opts, mode: "replica" },
    (row, json) => fleetRecord(row, fleetJsonBytes(json)),
    () => {},
  );
  const { database, get, number, set, transaction } = core;
  function event(messageId: string, requestId: string | undefined): FleetRecord | undefined {
    return core.residentByKey(fleetEventKey(messageId, requestId));
  }
  function applySnapshot(page: FleetSnapshotPage): void {
    page = fleetSnapshotPageSchema.parse(page);
    transaction(() => {
      if (number("seeded")) throw new FleetRecoveryRequired("Snapshot already committed");
      if (
        page.offset !== number("snapshotOffset") ||
        (get("snapshot") !== "" && get("snapshot") !== page.snapshot)
      )
        throw new FleetRecoveryRequired("Out-of-order snapshot");
      if (
        page.nextOffset !== page.offset + page.events.length ||
        page.complete !== (page.nextOffset === page.total)
      )
        throw new FleetRecoveryRequired("Invalid snapshot boundary");
      if (get("epoch") !== "" && get("epoch") !== page.epoch)
        throw new FleetRecoveryRequired("Archive changed");
      if (page.nextOffset > page.total || (!page.complete && page.events.length === 0))
        throw new FleetRecoveryRequired("Invalid snapshot progress");
      if (
        get("snapshot") !== "" &&
        (number("snapshotCursor") !== page.seq ||
          number("snapshotGeneration") !== page.deletionGeneration ||
          number("snapshotTotal") !== page.total)
      )
        throw new FleetRecoveryRequired("Snapshot metadata changed");
      set("epoch", page.epoch);
      set("snapshot", page.snapshot);
      set("snapshotCursor", page.seq);
      set("snapshotGeneration", page.deletionGeneration);
      set("snapshotTotal", page.total);
      const insert = database().query("INSERT INTO events(key,seq,body) VALUES (?,?,?)");
      for (const row of page.events) {
        internRowStrings(row); // its strings become resident on commit (#361)
        const key = fleetEventKey(row.messageId, row.requestId);
        const json = JSON.stringify(row);
        try {
          insert.run(key, row.seq, json);
          core.stage(key, row, json);
        } catch {
          throw new FleetRecoveryRequired("Repeated snapshot key or version");
        }
      }
      set("snapshotOffset", page.nextOffset);
      if (page.complete) {
        set("cursor", page.seq);
        set("generation", page.deletionGeneration);
        set("seeded", 1);
      }
    });
  }
  // The applied changes carry the page's parsed rows, which the caller feeds to
  // the engine; the store keeps only their records.
  function applyChanges(page: FleetChangesPage): FleetChange[] {
    page = fleetChangesPageSchema.parse(page);
    return transaction(() => {
      if (page.floor > number("cursor") || page.seq < number("cursor"))
        throw new FleetRecoveryRequired("Invalid history boundary");
      if (page.epoch !== get("epoch") || !number("seeded"))
        throw new FleetRecoveryRequired("Archive changed");
      const applied: FleetChange[] = [];
      let previousCursor = 0;
      for (const change of page.changes) {
        if (change.cursor <= previousCursor || change.cursor > page.seq)
          throw new FleetRecoveryRequired("Invalid change ordering");
        previousCursor = change.cursor;
        if (change.cursor <= number("cursor")) continue; // replayed committed batch
        if (change.cursor !== number("cursor") + 1)
          throw new FleetRecoveryRequired("Change history gap");
        if (
          change.deletionGeneration !==
          number("generation") + (change.deletes.length > 0 ? 1 : 0)
        )
          throw new FleetRecoveryRequired("Invalid deletion generation");
        const removed: FleetChange["deletes"] = [];
        for (const row of change.deletes) {
          const key = fleetEventKey(row.messageId, row.requestId);
          const result = database()
            .query("DELETE FROM events WHERE key=? AND seq=?")
            .run(key, row.seq);
          if (result.changes > 0) {
            core.stageDelete(key);
            removed.push(row);
          }
        }
        for (const row of change.upserts) core.put(row);
        set("cursor", change.cursor);
        set("generation", change.deletionGeneration);
        applied.push({ ...change, deletes: removed });
      }
      if (page.complete && number("cursor") !== page.seq)
        throw new FleetRecoveryRequired("Incomplete change page");
      return applied;
    });
  }
  return {
    ...core.storage,
    ...core.replication,
    applySnapshot,
    applyChanges,
    // Every committed record, as a fresh iterator. Read it synchronously:
    // records are published by commits.
    records: (): Iterable<FleetRecord> => core.committed().values(),
    // Whole-corpus reads (ADR-0111 §3): with `select`, only the rows whose
    // record it picks, read by key.
    readRows: core.readRows,
    readRowsSync: core.readRowsSync,
    get: event,
    getByKey: core.residentByKey,
    unlink: async (): Promise<void> => {
      transaction(() => {
        database().exec("DELETE FROM events; DELETE FROM changes; DELETE FROM operations;");
        core.stageClear();
        set("epoch", "");
        set("snapshot", "");
        for (const name of [
          "cursor",
          "generation",
          "eventSeq",
          "floor",
          "seeded",
          "snapshotOffset",
        ])
          set(name, 0);
      });
    },
    discard: async () => {
      core.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(opts.path + suffix, { force: true });
    },
    close: async () => core.close(),
  };
}

// The Local archive (ADR-0069): this machine's own events, kept durably past
// Claude Code's transcript window. It keeps a record per key, never the row
// (ADR-0111 §1, §5), mints its own seqs under the one merge rule, and has no
// change history, snapshots, deletion fence or epoch. It is an archive of
// record: an unreadable or corrupt database fails its load and is never
// deleted or recreated (`load` above); deleting the file is the supported reset.
function archiveStore(opts: FleetStoreOptions) {
  const core = openFleetDatabase<ArchiveRecord>(
    { ...opts, mode: "archive" },
    (row) => archiveRecord(row),
    () => {},
  );
  const { database, number, set, transaction } = core;
  // Own-machine rows, stamped `machineId` and a fresh seq (ADR-0069 §2). A row
  // is written only when it supersedes the copy held under the one merge rule
  // (ADR-0103); a key the same batch wrote earlier reads back its staged record.
  // The batch commits before any record is published, so a row is durable
  // before it is visible.
  async function push(rows: readonly StoredEventWire[], machineId: string) {
    return transaction(() => {
      let added = 0;
      for (const input of rows) {
        const held = core.residentByKey(fleetEventKey(input.messageId, input.requestId));
        if (
          held !== undefined &&
          !fleetFullnessPartsExceed(
            fleetDedupTokenTotal(input),
            input.organizationUuid,
            held.total,
            held.organizationUuid,
          )
        )
          continue;
        const seq = number("eventSeq") + 1;
        core.put(fleetEventSchema.parse({ ...input, machineId, seq }));
        set("eventSeq", seq);
        added++;
      }
      return { added };
    });
  }
  // Deletes every row whose record `select` picks, by its key, in one
  // transaction (ADR-0111 §5): Storage's Forget picks a pair's rows, the
  // Organization repair's forget a pair's excluded keys (#375). Returns how many
  // rows went. A failed commit removes nothing.
  function remove(select: (record: ArchiveRecord, key: string) => boolean): number {
    return transaction(() => {
      const statement = database().query("DELETE FROM events WHERE key=?");
      let removed = 0;
      for (const [key, record] of core.committed()) {
        if (!select(record, key)) continue;
        statement.run(key);
        core.stageDelete(key);
        removed++;
      }
      return removed;
    });
  }
  // Writes already-stamped rows verbatim, seqs included, in one transaction.
  // Only the one-time JSONL conversion writes this way (ADR-0111 §6), and it
  // goes with the converter (#397). A key or seq already stored fails the batch.
  function importRows(rows: readonly FleetEvent[]): void {
    transaction(() => {
      const insert = database().query("INSERT INTO events(key,seq,body) VALUES (?,?,?)");
      let last = number("eventSeq");
      for (const row of rows) {
        internRowStrings(row); // its strings become resident on commit (#361)
        const key = fleetEventKey(row.messageId, row.requestId);
        const json = JSON.stringify(row);
        insert.run(key, row.seq, json);
        core.stage(key, row, json);
        if (row.seq > last) last = row.seq;
      }
      set("eventSeq", last);
    });
  }
  return {
    ...core.storage,
    push,
    remove,
    importRows,
    // The record of one key, as this connection sees it (ADR-0110 §2).
    get: (messageId: string, requestId: string | undefined): ArchiveRecord | undefined =>
      core.residentByKey(fleetEventKey(messageId, requestId)),
    getByKey: core.residentByKey,
    // Every committed record with its key, as a fresh iterator. Read it
    // synchronously: records are published by commits.
    entries: (): Iterable<[string, ArchiveRecord]> => core.committed().entries(),
    // Whole-corpus reads (ADR-0111 §3).
    readRows: core.readRows,
    readRowsSync: core.readRowsSync,
    close: async () => core.close(),
  };
}

export type FleetEventStore = ReturnType<typeof hubStore>;
export type FleetReplicaStore = ReturnType<typeof replicaStore>;
export type LocalArchiveStore = ReturnType<typeof archiveStore>;

export function createFleetEventStore(opts: FleetStoreOptions & { mode: "hub" }): FleetEventStore;
export function createFleetEventStore(
  opts: FleetStoreOptions & { mode: "replica" },
): FleetReplicaStore;
export function createFleetEventStore(
  opts: FleetStoreOptions & { mode: "archive" },
): LocalArchiveStore;
export function createFleetEventStore(
  opts: FleetStoreOptions & { mode: FleetStoreMode },
): FleetEventStore | FleetReplicaStore | LocalArchiveStore {
  if (opts.mode === "hub") return hubStore(opts);
  return opts.mode === "replica" ? replicaStore(opts) : archiveStore(opts);
}
