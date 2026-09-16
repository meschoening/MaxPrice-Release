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
  type FleetDeletion,
  type FleetEvent,
  type StoredEventWire,
} from "@maxprice/shared";
import { fleetEventKey, fleetTokenTotal } from "./fleet-event-store";
import { FleetRecoveryRequired, type FleetEventStore } from "./fleet-sync-store";

export type EventSyncConnection = {
  url: string; // hub base URL, no trailing slash
  headers: Record<string, string>; // hub-client's headers(c) — auth + machine + hostname
  events: { epoch: string; seq: number; deletionGeneration: number } | null; // HubStatus.events; null ⇒ pre-event-sync hub ⇒ degraded
};

// The structural subset of an engine row the stamp predicate (and the prune
// below) read — (messageId, requestId) identity + the four token totals. Both
// the raw engine `StoredEvent` and the wire `StoredEventWire` satisfy it, so
// the push pass scans RAW store rows and projects ONLY the survivors onto the
// wire shape via `toWire` (no full-corpus wire allocation per push trigger).
export type StampableRow = {
  messageId: string;
  requestId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};

export type EventSyncDeps<Row extends StampableRow = StoredEventWire> = {
  // The engine feed + push source (fleet.ts wires these to the live EventStore):
  localEvents: () => Row[]; // EVERY engine event as RAW store rows; the stamp predicate filters, toWire projects the survivors
  toWire: (row: Row) => StoredEventWire; // project a surviving row onto the push wire shape
  applyFleetDeletes?: (rows: FleetDeletion[], mayApply: () => boolean) => void | Promise<void>;
  prepareContributions?: () => Promise<void>;
  // Engine RAM upsert; returns the changed count. May resolve LATER: fleet.ts
  // parks it on the engine's `ready` during the boot walk (ADR-0098).
  // Check mayApply after any await: an accepted page may finish on disconnect,
  // but must never enter a replacement engine after a replica reset/detach.
  applyFleetRows: (rows: FleetEvent[], mayApply: () => boolean) => number | Promise<number>;
  // The replica — null ⇒ contribute-only (replica off / not attached):
  replica: () => FleetEventStore | null;
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
  const acked = new Map<string, number>();
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
      sourceEpoch = fence.epoch;
      sourceGeneration = fence.deletionGeneration;
    }
    const rows = deps.localEvents();
    const live = new Set(rows.map((row) => fleetEventKey(row.messageId, row.requestId)));
    for (const key of acked.keys()) if (!live.has(key)) acked.delete(key);
    const unstamped = rows.filter((row) => {
      const held = deps.replica()?.get(row.messageId, row.requestId);
      return (
        Math.max(
          held ? fleetTokenTotal(held) : -Infinity,
          acked.get(fleetEventKey(row.messageId, row.requestId)) ?? -Infinity,
        ) < fleetTokenTotal(row)
      );
    });
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
      if (receipt.epoch !== fence.epoch || receipt.deletionGeneration !== fence.deletionGeneration)
        throw new FleetRecoveryRequired("Contribution receipt fence changed");
      for (const row of batch)
        acked.set(fleetEventKey(row.messageId, row.requestId), fleetTokenTotal(row));
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
        timer = setTimer(kick, deps.sweepMs ?? 300_000);
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
      shareEnabled = on;
      if (on) kick();
    },
    kickPull: kick,
    resync: () => {
      resetGeneration++;
      suspended = false;
      acked.clear();
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
