// ADR-0100: a single pump applies committed snapshots/changes before uploads.
// Connection and reset generations separately fence asynchronous engine feeds.
import {
  fleetChangesPageSchema,
  fleetSnapshotPageSchema,
  hubEventsPushResponseSchema,
  EVENT_PUSH_BATCH_MAX,
  EVENT_PULL_LIMIT_MAX,
  hubStatusSchema,
  HUB_PROTOCOL_VERSION,
  fleetDedupTokenTotal,
  fleetFullnessPartsExceed,
  type FleetDeletion,
  type FleetEvent,
  type StoredEventWire,
} from "@maxprice/shared";
import { fleetEventKey } from "./fleet-sync-store";
import { FleetRecoveryRequired, type FleetReplicaStore } from "./fleet-sync-store";

export type EventSyncConnection = {
  url: string; // hub base URL, no trailing slash
  headers: Record<string, string>; // hub-client's headers(c) — auth + machine + hostname
  events: { epoch: string; seq: number; deletionGeneration: number } | null; // HubStatus.events; null ⇒ pre-event-sync hub ⇒ degraded
};

// The structural subset of an engine row the stamp predicate (and the prune
// below) read — (messageId, requestId) identity + the four token totals + the
// Organization evidence (ADR-0103), and the timestamp a pass of changed keys
// sends in (#364). Both the raw engine `StoredEvent` and the wire
// `StoredEventWire` satisfy it, so the push pass scans RAW store rows and
// projects ONLY the survivors onto the wire shape via `toWire` (no full-corpus
// wire allocation per push trigger).
export type StampableRow = {
  timestamp: string;
  messageId: string;
  requestId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  organizationUuid?: string;
};

// The contribution source's change feed (#364), so that an ordinary push pass
// re-examines only the keys whose eligible contribution changed. fleet.ts
// wires it to the Eligible contribution view.
//
// Past this many changed keys, a list of them gives way to a full pass. Both
// holders keep it: the view's list between two takes, and the keys a pass cut
// short leaves behind. It bounds what either holds while no pass completes
// (disconnected, sharing off, a pull or a push that keeps failing), and a
// pass of that many keys costs about what reading the view whole does.
export const PUSH_CHANGED_KEYS_MAX = 10_000;

export type LocalChanges<Row extends StampableRow> = {
  // The dedup keys (`fleetEventKey`) whose eligible contribution may have
  // changed since the previous take, or `null` when the source changed in a
  // way no key list names (a removal, a wholesale replacement, a swapped
  // store, an eligibility change): the next pass must read `localEvents`.
  // Each take starts a new interval; what it returns is the caller's to keep.
  take: () => Iterable<string> | null;
  // `key`'s eligible contribution, under the same eligibility as
  // `localEvents`, or undefined when it has none.
  get: (key: string) => Row | undefined;
};

export type EventSyncDeps<Row extends StampableRow = StoredEventWire> = {
  // The engine feed + push source (fleet.ts wires these to the live EventStore):
  localEvents: () => Row[]; // EVERY eligible contribution as RAW store rows, timestamp-sorted; the stamp predicate filters, toWire projects the survivors
  // Absent ⇒ every pass reads `localEvents` whole, as every pass did before #364.
  localChanges?: LocalChanges<Row>;
  toWire: (row: Row) => StoredEventWire; // project a surviving row onto the push wire shape
  applyFleetDeletes?: (rows: FleetDeletion[], mayApply: () => boolean) => void | Promise<void>;
  prepareContributions?: () => Promise<void>;
  // Engine RAM upsert; returns the changed count. May resolve LATER: fleet.ts
  // parks it on the engine's `ready` during the boot walk (ADR-0098).
  // Check mayApply after any await: an accepted page may finish on disconnect,
  // but must never enter a replacement engine after a replica reset/detach.
  applyFleetRows: (rows: FleetEvent[], mayApply: () => boolean) => number | Promise<number>;
  // The replica — null ⇒ contribute-only (replica off / not attached):
  replica: () => FleetReplicaStore | null;
  // Wiring callbacks (fleet.ts debounces/orchestrates):
  onPagesApplied: (changed: number) => void; // fired per completed page with the engine-changed count
  onSeedProgress: (seed: { cursor: number; target: number } | null) => void;
  onEpochMismatch: () => void; // fleet.ts unlinks + rebuilds, then MUST call resync()
  // Fired with the fresh capability verdict on EVERY connect (even unchanged —
  // the display layer clears on disconnect and needs the re-assert) and when a
  // mid-session 404 latches degraded true (M7: the async-probe re-mirror).
  onDegraded?: (degraded: boolean) => void;
  fetchImpl?: typeof fetch;
  sweepMs?: number; // default 300_000 — the 5-minute push sweep
  pushBatchSize?: number; // default EVENT_PUSH_BATCH_MAX
  pullLimit?: number; // default 1,000; protocol cap EVENT_PULL_LIMIT_MAX
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
};

export type EventSync = {
  connect: (ctx: EventSyncConnection) => void; // trigger: (re)connect — kicks push + pull, arms the sweep
  disconnect: () => void; // hub-client fail()/teardown — disarms everything
  onEventsPoke: (seq: number) => void; // hub:events {seq} — pull trigger
  onStatusEvents: (
    events: { epoch: string; seq: number; deletionGeneration: number } | null,
  ) => void; // mid-stream hub:status echo
  notifyLocalChange: () => void; // trigger: watcher flush — push
  setShareEnabled: (on: boolean) => void; // hubShareEvents — gates every push trigger
  kickPull: () => void; // replica re-attach (toggle on) — ordinary reseed
  suspend: () => void; // before unlink/rebuild: invalidate outstanding responses and gate both loops
  resync: () => void; // post-unlink: drops the ack set, re-push + re-pull
  idle: () => Promise<void>; // test seam — resolves when no loop is in flight or pending
  // `caughtUpSeq` — the seq PROVEN drained (ADR-0055); 0 until a drain ends on
  // a short page. Its gap to the hub's advertised watermark is what
  // reconciliation acts on.
  getState: () => {
    degraded: boolean;
    seeding: boolean;
    skippedPullRows: number;
    caughtUpSeq: number;
  };
  isCaughtUp: () => boolean;
  stop: () => Promise<void>;
};

// The acknowledged fullness per key, held as a token total per key and the
// Organization of each key acknowledged tagged: one number and at most one map
// entry per pushed row, never one `FleetFullness` object each (#361). The tag
// is the row's own string, held by reference, because the tag order (#374)
// compares its value. Read only through `fleetFullnessPartsExceed`, the one
// fullness order.
function createAckedFullness() {
  const totals = new Map<string, number>();
  const tags = new Map<string, string>();
  return {
    /** `row` is strictly fuller than the acknowledged copy of `key`, or none was acknowledged. */
    exceededBy(key: string, row: StampableRow): boolean {
      const total = totals.get(key);
      return (
        total === undefined ||
        fleetFullnessPartsExceed(
          fleetDedupTokenTotal(row),
          row.organizationUuid,
          total,
          tags.get(key),
        )
      );
    },
    record(key: string, row: StampableRow): void {
      totals.set(key, fleetDedupTokenTotal(row));
      if (row.organizationUuid !== undefined) tags.set(key, row.organizationUuid);
      else tags.delete(key);
    },
    delete(key: string): void {
      totals.delete(key);
      tags.delete(key);
    },
    /** Forgets every key `live` does not hold. */
    keepOnly(live: ReadonlySet<string>): void {
      for (const key of totals.keys()) if (!live.has(key)) this.delete(key);
    },
    clear(): void {
      totals.clear();
      tags.clear();
    },
  };
}

export function createEventSync<Row extends StampableRow = StoredEventWire>(
  deps: EventSyncDeps<Row>,
): EventSync {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const setTimer = deps.setIntervalImpl ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearTimer =
    deps.clearIntervalImpl ??
    ((id: unknown) => clearInterval(id as ReturnType<typeof setInterval>));
  let ctx: EventSyncConnection | null = null;
  let generation = 0;
  let resetGeneration = 0;
  let suspended = false;
  let shareEnabled = true;
  let degraded = false;
  let seeding = false;
  let caughtUpSeq = 0;
  let sourceGeneration = -1;
  let sourceEpoch = "";
  let pending = false;
  let running: Promise<void> | null = null;
  let timer: unknown = null;
  let malformed = 0;
  const requests = new Set<AbortController>();
  // Per key, the fullness of the copy the Hub last acknowledged from this push
  // loop — accepted or stamped a loser, either way the Hub holds at least that.
  const acked = createAckedFullness();
  // What the next push pass examines (#364): the whole Eligible contribution
  // view while `fullPass` is set, otherwise only `dirty`, the keys
  // `localChanges` named since a pass consumed them. A pass takes both at its
  // start and puts back what it could not finish, so a request landing
  // mid-pass outlives it. The set is replaced, never cleared: a long-lived Set
  // cleared once per pass is churn (ADR-0110 §4).
  let fullPass = true;
  let dirty = new Set<string>();
  // The replica the last pass stamped against. Another one (attached,
  // detached, replaced) stamps differently, so the next pass reads the view whole.
  let pushedReplica: FleetReplicaStore | null | undefined;
  function invalidateRequests(): void {
    for (const request of requests) request.abort();
  }
  function degrade(): void {
    degraded = true;
    pending = false;
    deps.onDegraded?.(true);
  }
  const current = (g: number) => g === generation && ctx !== null && !suspended && !degraded;
  function recovery(): void {
    suspend();
    deps.onEpochMismatch();
  }
  function suspend(): void {
    if (suspended) return;
    suspended = true;
    generation++;
    resetGeneration++;
    pending = false;
    invalidateRequests();
  }
  async function request(
    url: string,
    connection: EventSyncConnection,
    init?: RequestInit,
  ): Promise<Response> {
    const abort = new AbortController();
    requests.add(abort);
    const deadline = setTimeout(() => abort.abort(), 30_000);
    deadline.unref();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Fleet request cancelled"));
      abort.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([
        aborted,
        (async () => {
          const response = await fetchImpl(url, {
            ...init,
            headers: { ...connection.headers, ...init?.headers },
            signal: abort.signal,
          });
          const body = await response.arrayBuffer();
          return new Response(response.status === 204 ? null : body, {
            status: response.status,
            headers: response.headers,
          });
        })(),
      ]);
    } finally {
      clearTimeout(deadline);
      abort.signal.removeEventListener("abort", onAbort);
      requests.delete(abort);
    }
  }

  async function pull(connection: EventSyncConnection, g: number): Promise<boolean> {
    const replica = deps.replica();
    if (replica === null) return true;
    const accepts = () => current(g) && deps.replica() === replica;
    const acceptedReset = resetGeneration;
    const mayApply = () => acceptedReset === resetGeneration && deps.replica() === replica;
    // A partial snapshot is durable and resumes at its own offset after restart.
    if (!replica.seeded()) {
      seeding = true;
      while (accepts() && !replica.seeded()) {
        const seed = replica.seedState();
        const query = new URLSearchParams({
          offset: String(seed.offset),
          limit: String(deps.pullLimit ?? Math.min(1_000, EVENT_PULL_LIMIT_MAX)),
        });
        if (seed.snapshot !== undefined) query.set("snapshot", seed.snapshot);
        const response = await request(
          `${connection.url}/api/events/snapshot?${query}`,
          connection,
        );
        if (!accepts()) return false;
        if (response.status === 410) {
          recovery();
          return false;
        }
        if (response.status === 404 || response.status === 409) {
          degrade();
          return false;
        }
        if (!response.ok) throw new Error(`Snapshot rejected (${response.status})`);
        const page = fleetSnapshotPageSchema.parse(await response.json());
        if (!accepts()) return false;
        replica.applySnapshot(page);
        const changed = await feedCommitted(() => deps.applyFleetRows(page.events, mayApply));
        if (!accepts()) return false;
        deps.onPagesApplied(changed);
        deps.onSeedProgress({ cursor: page.nextOffset, target: Math.max(1, page.total) });
      }
    }
    // Capture H from the first response; new traffic cannot keep this drain open.
    let through: number | undefined;
    while (accepts()) {
      const query = new URLSearchParams({
        epoch: replica.epoch(),
        since: String(replica.cursor()),
        limit: "100",
      });
      if (through !== undefined) query.set("through", String(through));
      const response = await request(`${connection.url}/api/events?${query}`, connection);
      if (!accepts()) return false;
      if (response.status === 410) {
        recovery();
        return false;
      }
      if (response.status === 404 || response.status === 409) {
        degrade();
        return false;
      }
      if (!response.ok) throw new Error(`Changes rejected (${response.status})`);
      const page = fleetChangesPageSchema.parse(await response.json());
      if (!accepts()) return false;
      through ??= page.seq;
      if (page.seq !== through) throw new FleetRecoveryRequired("Changed catch-up boundary");
      if (
        page.changes.some((change) => change.deletes.length > 0) &&
        deps.applyFleetDeletes === undefined
      )
        throw new Error("Missing deletion consumer");
      const applied = replica.applyChanges(page);
      for (const change of applied) {
        if (change.deletes.length > 0) {
          await feedCommitted(() => deps.applyFleetDeletes?.(change.deletes, mayApply));
          for (const row of change.deletes)
            acked.delete(fleetEventKey(row.messageId, row.requestId));
        }
        const changed = await feedCommitted(() => deps.applyFleetRows(change.upserts, mayApply));
        if (!mayApply()) return false;
        deps.onPagesApplied(changed + change.deletes.length);
      }
      if (!accepts()) return false;
      if (page.complete) {
        caughtUpSeq = page.seq;
        const advertised = connection.events;
        connection.events = {
          epoch: page.epoch,
          seq: Math.max(page.seq, advertised?.epoch === page.epoch ? advertised.seq : 0),
          deletionGeneration: Math.max(
            page.deletionGeneration,
            advertised?.epoch === page.epoch ? advertised.deletionGeneration : 0,
          ),
        };
        if (seeding) {
          seeding = false;
          deps.onSeedProgress(null);
        }
        // A status frame can advance while this fixed drain is in flight.
        // Keep that knowledge: old report rows must not become archive sources
        // during the gap before the next drain learns the advertised deletion.
        if (connection.events.deletionGeneration > replica.deletionGeneration()) {
          pending = true;
          return false;
        }
        return true;
      }
      if (applied.length === 0) throw new FleetRecoveryRequired("Change page made no progress");
    }
    return false;
  }
  async function feedCommitted<T>(feed: () => T | Promise<T>): Promise<T> {
    try {
      return await feed();
    } catch (error) {
      // The durable cursor already advanced. Retrying its next page cannot
      // repair an incomplete RAM feed; rebuild through the recovery barrier.
      throw new FleetRecoveryRequired(`Committed engine feed failed: ${String(error)}`);
    }
  }
  async function push(connection: EventSyncConnection, g: number): Promise<void> {
    if (!shareEnabled || connection.events === null) return;
    // Share-only clients refresh the fence from status; they never need a replica.
    if (deps.replica() === null) {
      const response = await request(`${connection.url}/api/status`, connection);
      if (!current(g) || !response.ok) return;
      const status = hubStatusSchema.parse(await response.json());
      if (status.protocolVersion !== HUB_PROTOCOL_VERSION) {
        degrade();
        return;
      }
      if (!current(g) || status.events == null) return;
      connection.events = status.events;
    }
    const fence = connection.events;
    if (fence === null) return;
    if (sourceEpoch !== fence.epoch || sourceGeneration !== fence.deletionGeneration) {
      if (sourceEpoch !== "") await deps.prepareContributions?.();
      if (!current(g)) return;
      acked.clear();
      fullPass = true;
      sourceEpoch = fence.epoch;
      sourceGeneration = fence.deletionGeneration;
    }
    const replica = deps.replica();
    if (replica !== pushedReplica) {
      pushedReplica = replica;
      fullPass = true;
    }
    // Taken after the preparation above, so its wholesale replacement of the
    // contributions is reported to this pass, which then reads them whole.
    const changed = deps.localChanges?.take() ?? null;
    if (changed === null) fullPass = true;
    else for (const key of changed) dirty.add(key);
    if (dirty.size > PUSH_CHANGED_KEYS_MAX) fullPass = true;
    const full = fullPass;
    const changedKeys = dirty;
    fullPass = false;
    dirty = new Set();
    // A row is unstamped only while it is strictly fuller (ADR-0103: a larger
    // total; at an equal total a tag against none, or a smaller tag against a
    // larger one, #374) than both the replica's held copy and the acked copy —
    // so a tag gained at an equal total is sent once, and a copy held tagged is
    // never re-sent untagged.
    // Fuller than both is fuller than the better of the two, so the pass
    // builds no object per row beyond its key (#361). The held copy is the
    // replica's record of it: its fullness parts (ADR-0111 §2).
    const isUnstamped = (key: string, row: Row): boolean => {
      const held = replica?.getByKey(key);
      if (
        held !== undefined &&
        !fleetFullnessPartsExceed(
          fleetDedupTokenTotal(row),
          row.organizationUuid,
          held.total,
          held.organizationUuid,
        )
      )
        return false;
      return acked.exceededBy(key, row);
    };
    // The rows this pass sends, in timestamp order; null until examined.
    let unstamped: Row[] | null = null;
    // How many of them the Hub has acknowledged.
    let done = 0;
    try {
      if (full) {
        const rows = deps.localEvents();
        // Each row's key, built once and read twice below (#361).
        const rowKeys = rows.map((row) => fleetEventKey(row.messageId, row.requestId));
        // An acknowledgement of a key that left the view must never suppress
        // its Re-contribution (ADR-0100).
        acked.keepOnly(new Set(rowKeys));
        unstamped = rows.filter((row, i) => isUnstamped(rowKeys[i]!, row));
      } else {
        // Only the keys whose contribution changed: no other row's stamp can
        // have moved since a pass last examined it, because everything else
        // that could move one makes the pass full (#364). No per-corpus key
        // array, Set or sorted copy. A key with no eligible contribution
        // (removed, or written while the view is closed or its pair barred)
        // is consumed unsent. Its acknowledgement needs no pruning: whatever
        // made it ineligible asked for a full pass, which pruned it, and
        // nothing has acknowledged it since.
        const rows: Row[] = [];
        for (const key of changedKeys) {
          const row = deps.localChanges!.get(key);
          if (row !== undefined && isUnstamped(key, row)) rows.push(row);
        }
        unstamped = rows.sort((a, b) =>
          a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
        );
      }
      const size = deps.pushBatchSize ?? EVENT_PUSH_BATCH_MAX;
      for (let i = 0; i < unstamped.length; i += size) {
        if (!current(g) || !shareEnabled) return;
        const batch = unstamped.slice(i, i + size).map(deps.toWire);
        const response = await request(`${connection.url}/api/events`, connection, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            events: batch,
            epoch: fence.epoch,
            deletionGeneration: fence.deletionGeneration,
          }),
        });
        if (!current(g)) return;
        if (response.status === 409) {
          sourceGeneration = -1;
          return;
        }
        if (!response.ok) throw new Error(`Contribution rejected (${response.status})`);
        const receipt = hubEventsPushResponseSchema.parse(await response.json());
        if (!current(g)) return;
        if (
          receipt.epoch !== fence.epoch ||
          receipt.deletionGeneration !== fence.deletionGeneration
        )
          throw new FleetRecoveryRequired("Contribution receipt fence changed");
        for (const row of batch) acked.record(fleetEventKey(row.messageId, row.requestId), row);
        done = i + batch.length;
      }
    } finally {
      // A pass cut short (an error, a disconnect, sharing turned off, a 409)
      // leaves what the Hub did not acknowledge to the next pass, whatever
      // triggers it: a full pass asks for another, an ordinary one puts its
      // unsent keys back. A key it found stamped or ineligible, or saw
      // acknowledged, is consumed; one written again meanwhile waits in the
      // feed for the next take.
      if (unstamped === null || done < unstamped.length) {
        if (full) fullPass = true;
        else if (unstamped === null) for (const key of changedKeys) dirty.add(key);
        else
          for (const row of unstamped.slice(done))
            dirty.add(fleetEventKey(row.messageId, row.requestId));
      }
    }
  }
  function kick(): void {
    pending = true;
    if (running !== null || ctx === null || suspended || degraded) return;
    const g = generation;
    running = (async () => {
      try {
        do {
          pending = false;
          const connection = ctx;
          if (connection === null || !current(g)) return;
          if (await pull(connection, g)) await push(connection, g);
          if (current(g)) deps.onDegraded?.(false);
        } while (pending && current(g));
      } catch (error) {
        if (!current(g)) {
          // Disconnect does not cancel a committed engine feed. If that feed
          // fails, the next connection must rebuild rather than skip its cursor.
          if (error instanceof FleetRecoveryRequired && !suspended && deps.replica() !== null)
            recovery();
          return;
        }
        console.error("[usage-core] fleet synchronization failed:", error);
        // Recover malformed data once. Repeated errors remain surfaced; a new
        // connection/manual retry can probe again without an automatic reset loop.
        pending = false;
        if (
          error instanceof FleetRecoveryRequired ||
          (error instanceof Error && (error.name === "ZodError" || error instanceof SyntaxError))
        ) {
          malformed++;
          if (malformed === 1 && deps.replica() !== null) recovery();
          else degrade();
        } else deps.onDegraded?.(true);
      }
    })().finally(() => {
      running = null;
      if (pending && ctx !== null && !suspended && !degraded) kick();
    });
  }
  function disconnect(): void {
    generation++;
    ctx = null;
    pending = false;
    invalidateRequests();
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  return {
    connect: (connection) => {
      disconnect();
      ctx = connection;
      degraded = connection.events === null;
      malformed = 0;
      caughtUpSeq = 0;
      deps.onDegraded?.(degraded);
      if (!degraded) {
        // The sweep reads the view whole: the convergence safety net
        // (ADR-0055, ADR-0100) under every pass of changed keys (#364).
        timer = setTimer(() => {
          fullPass = true;
          kick();
        }, deps.sweepMs ?? 300_000);
        kick();
      }
    },
    disconnect,
    suspend,
    onEventsPoke: () => kick(),
    onStatusEvents: (events) => {
      if (ctx !== null && events !== null) {
        ctx.events = events;
        const replica = deps.replica();
        if (replica !== null && replica.epoch() !== "" && replica.epoch() !== events.epoch) {
          recovery();
          return;
        }
        if (
          events.seq > caughtUpSeq ||
          events.epoch !== sourceEpoch ||
          events.deletionGeneration !== sourceGeneration
        )
          kick();
      }
    },
    notifyLocalChange: kick,
    setShareEnabled: (on) => {
      // Sharing back on reads the view whole, as #364's triage asked. Nothing
      // needs it: the view kept every change made meanwhile, and the fence
      // and the replica are checked first. It costs one full pass per toggle.
      if (on && !shareEnabled) fullPass = true;
      shareEnabled = on;
      if (on) kick();
    },
    kickPull: kick,
    resync: () => {
      resetGeneration++;
      suspended = false;
      acked.clear();
      fullPass = true;
      sourceGeneration = -1;
      caughtUpSeq = 0;
      seeding = false;
      kick();
    },
    idle: async () => {
      while (running !== null) await running;
    },
    getState: () => ({ degraded, seeding, skippedPullRows: 0, caughtUpSeq }),
    isCaughtUp: () => {
      const replica = deps.replica();
      return (
        ctx !== null &&
        ctx.events !== null &&
        !suspended &&
        !degraded &&
        !seeding &&
        replica !== null &&
        replica.seeded() &&
        replica.epoch() === ctx.events.epoch &&
        replica.deletionGeneration() === ctx.events.deletionGeneration &&
        caughtUpSeq >= ctx.events.seq
      );
    },
    stop: async () => {
      disconnect();
      if (running !== null) await running;
    },
  };
}
