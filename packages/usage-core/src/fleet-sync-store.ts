import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
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
} from "@maxprice/shared";
import { fleetEventKey, fleetTokenTotal } from "./fleet-event-store";

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

/** ADR-0100. SQLite owns committed rows, replay progress, and operation receipts.
 * RAM is a disposable read cache, invalidated only after COMMIT succeeds.
 * The independent own-machine archive continues to use the JSONL store.
 */
export function createFleetEventStore(opts: {
  path: string;
  mode: "hub" | "replica";
  nowImpl?: () => string;
  retentionMs?: number;
  retentionBytes?: number;
  snapshotTtlMs?: number;
  beforeCommit?: () => void;
}) {
  let db: Database | null = null;
  let cache: readonly FleetEvent[] | null = null;
  let rowsByKey: Map<string, FleetEvent> | null = null;
  let staged: { clear: boolean; rows: Map<string, FleetEvent | null> } | null = null;
  let loaded = false;
  let recovered = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const snapshots = new Map<string, Snapshot>();
  const now = () => opts.nowImpl?.() ?? new Date().toISOString();
  const clock = () => Date.parse(now());
  const retentionMs = opts.retentionMs ?? 90 * 86400_000;
  const retentionBytes = opts.retentionBytes ?? 256 * 1024 * 1024;
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
  function transaction<T>(fn: () => T, invalidate = true): T {
    if (staged !== null) throw new Error("Nested fleet transaction");
    const changes = { clear: false, rows: new Map<string, FleetEvent | null>() };
    staged = changes;
    try {
      const result = database()
        .transaction(() => {
          const result = fn();
          opts.beforeCommit?.();
          return result;
        })
        .immediate();
      // Publish only committed changes. Keeping the parsed rows avoids parsing
      // the complete archive again after every small transaction or snapshot.
      if (rowsByKey !== null) {
        if (changes.clear) rowsByKey.clear();
        for (const [key, row] of changes.rows) {
          if (row === null) rowsByKey.delete(key);
          else rowsByKey.set(key, row);
        }
      }
      if (invalidate && (changes.clear || changes.rows.size > 0)) cache = null;
      return result;
    } finally {
      staged = null;
    }
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
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta(name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(key TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS changes(cursor INTEGER PRIMARY KEY, at INTEGER NOT NULL, bytes INTEGER NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, scope TEXT NOT NULL, body TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0);
      `);
      if (get("format") === "" && !fresh)
        throw new Error("Fleet database integrity: missing metadata");
      if (get("format") === "")
        transaction(() => {
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
      all();
    } catch (error) {
      db?.close();
      db = null;
      loaded = false;
      cache = null;
      rowsByKey = null;
      if (
        opts.mode === "hub" ||
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
  function all(): readonly FleetEvent[] {
    if (rowsByKey === null) {
      rowsByKey = new Map(
        database()
          .query<{ key: string; seq: number; body: string }, []>(
            "SELECT key,seq,body FROM events ORDER BY seq",
          )
          .all()
          .map(({ key, seq, body }) => {
            const row = fleetEventSchema.parse(JSON.parse(body));
            if (key !== fleetEventKey(row.messageId, row.requestId) || seq !== row.seq)
              throw new Error("Fleet database integrity mismatch");
            return [key, row];
          }),
      );
    }
    return (cache ??= [...rowsByKey.values()].sort((a, b) => a.seq - b.seq));
  }
  function event(messageId: string, requestId: string | undefined): FleetEvent | undefined {
    const row = database()
      .query<{ body: string }, [string]>("SELECT body FROM events WHERE key=?")
      .get(fleetEventKey(messageId, requestId));
    return row === null ? undefined : fleetEventSchema.parse(JSON.parse(row.body));
  }
  function put(row: FleetEvent): void {
    database()
      .query(
        "INSERT INTO events(key,seq,body) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET seq=excluded.seq, body=excluded.body",
      )
      .run(fleetEventKey(row.messageId, row.requestId), row.seq, JSON.stringify(row));
    staged?.rows.set(fleetEventKey(row.messageId, row.requestId), row);
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
    if (opts.mode !== "hub") throw new Error("Cannot contribute to a replica");
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
        if (previous === undefined || fleetTokenTotal(input) > fleetTokenTotal(previous)) {
          const seq = number("eventSeq") + 1;
          row = fleetEventSchema.parse({ ...input, machineId, seq });
          put(row);
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
    if (opts.mode !== "hub") throw new Error("Cannot forget through a replica");
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
        staged?.rows.set(key, null);
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
    transaction(prune, false);
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
    const query = database().query<{ body: string; bytes: number }, [number, number, number]>(
      "SELECT body,bytes FROM changes WHERE cursor>? AND cursor<=? ORDER BY cursor LIMIT ?",
    );
    for (const row of query.iterate(since, through, limit)) {
      if (rows.length > 0 && bytes + row.bytes > 4 * 1024 * 1024) break;
      rows.push(fleetChangeSchema.parse(JSON.parse(row.body)));
      bytes += row.bytes;
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
  function applySnapshot(page: FleetSnapshotPage): void {
    if (opts.mode !== "replica") throw new Error("Not a replica");
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
        try {
          insert.run(fleetEventKey(row.messageId, row.requestId), row.seq, JSON.stringify(row));
          staged?.rows.set(fleetEventKey(row.messageId, row.requestId), row);
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
  function applyChanges(page: FleetChangesPage): FleetChange[] {
    if (opts.mode !== "replica") throw new Error("Not a replica");
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
            staged?.rows.set(key, null);
            removed.push(row);
          }
        }
        for (const row of change.upserts) put(row);
        set("cursor", change.cursor);
        set("generation", change.deletionGeneration);
        applied.push({ ...change, deletes: removed });
      }
      if (page.complete && number("cursor") !== page.seq)
        throw new FleetRecoveryRequired("Incomplete change page");
      return applied;
    });
  }
  async function unlink(): Promise<void> {
    if (opts.mode !== "replica") throw new Error("Cannot wipe the archive of record");
    transaction(() => {
      database().exec("DELETE FROM events; DELETE FROM changes; DELETE FROM operations;");
      if (staged !== null) staged.clear = true;
      set("epoch", "");
      set("snapshot", "");
      for (const name of ["cursor", "generation", "eventSeq", "floor", "seeded", "snapshotOffset"])
        set(name, 0);
    });
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
    ready,
    load,
    push,
    remove,
    changes,
    snapshotPage,
    applySnapshot,
    applyChanges,
    unlink,
    compact,
    discard: async () => {
      if (opts.mode !== "replica") throw new Error("Cannot discard the archive of record");
      db?.close();
      db = null;
      loaded = false;
      cache = null;
      rowsByKey = null;
      snapshots.clear();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(opts.path + suffix, { force: true });
    },
    all,
    get: event,
    size,
    fileBytes,
    reclaimableBytes,
    epoch: () => get("epoch"),
    durableSeq: () => number("cursor"),
    cursor: () => number("cursor"),
    deletionGeneration: () => number("generation"),
    seeded: () => number("seeded") === 1,
    seedState: () => ({ snapshot: get("snapshot") || undefined, offset: number("snapshotOffset") }),
    changeBytes: () =>
      database()
        .query<{ bytes: number }, []>("SELECT coalesce(sum(bytes),0) AS bytes FROM changes")
        .get()!.bytes,
    lastAppendAt: () => get("lastAppend") || null,
    completeOperation: (id: string) =>
      transaction(
        () => database().query("UPDATE operations SET complete=1 WHERE id=?").run(id),
        false,
      ),
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
    flush: async () => {},
    close: async () => {
      db?.close();
      db = null;
      loaded = false;
      cache = null;
      rowsByKey = null;
      snapshots.clear();
    },
  };
}
export type FleetEventStore = ReturnType<typeof createFleetEventStore>;
