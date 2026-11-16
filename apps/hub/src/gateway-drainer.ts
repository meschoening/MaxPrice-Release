// Exported via a package.json subpath for the fleet test rigs (the sidecar's test Hub, ADR-0141's fleet acceptance) — keep signatures stable, a cross-app test contract.
import {
  createCliProxyApi,
  checkGateway,
  CREDENTIALS_REFRESH_MS,
  drainGatewayOnce,
  type CliProxyApi,
  type GatewayDrainBaseline,
  type FetchLike,
} from "@maxprice/usage-core";
import {
  gatewayId,
  gatewayUrlHost,
  normalizeGatewayUrl,
  type GatewayConnectRequest,
  type GatewayConnectResponse,
  type GatewayRecordsAck,
  type GatewayRecordsFeed,
  type GatewayState,
  type HubGateway,
  type HubStatus,
  type ReducedGatewayRecord,
} from "@maxprice/shared";
import type { HubFanout } from "./fanout";
import type { GatewayRecordsStore } from "./gateway-records";
import type { GatewayRegistry } from "./gateway-registry";
import type { HubKeys } from "./hub-keys";
import type { HubGatewayKeyStore } from "./key-store";

// The Hub's Gateways at run time (ADR-0141 §5, §7, §9; D8, D9): the one place
// that connects, drains and removes them, so the registry, the key store, the
// records feed and `HubStatus.gateways` move together. The Headless Hub and
// the tray app's embedded daemon run it alike (serve(), index.ts).
//
// Each connected Gateway is drained every DRAIN_INTERVAL_MS through the
// CLIProxyAPI adapter (usage-core `gateway/cliproxyapi.ts`), which calls only
// the credential list and the usage queue, never `/credentials/download`,
// in the drain step a client's fallback drain shares (usage-core
// `gateway/drain-step.ts`).
// The credential list is read at the first drain and every
// CREDENTIALS_REFRESH_MS after: it maps each record's `auth_index` to its
// credential's email hash, and two successive reads with no record drained
// between them while a credential's counters rose say `statistics-off`
// (`inferStatisticsOff`). Each record is reduced (a failed attempt skipped,
// §2), its Account resolved through the Hub's own keys' `/api/account`
// emails held as hashes in memory (`HubKeys.accountForEmailHash`, ADR-0138
// §9), its email hash dropped, and the reduced record stored in the feed
// (gateway-records.ts); new records poke `hub:gateway-records`.
//
// A Gateway's state, as `HubStatus.gateways` lists it:
// - `draining`: its last drain read the queue;
// - `unreachable` | `unauthorized` | `error`: its last read failed so (no key
//   in the store reads as `unauthorized`: Connect again);
// - `statistics-off`: it reads, but its credentials served requests while
//   the queue gave nothing, until a record arrives or a later pair of
//   credential reads says otherwise.
// `lastRecordAt` is when a drain last read a record, this run (null after a
// restart until the next one).
//
// The management key is write-only outward: no route, status or line ever
// carries it, and lines name a Gateway by its URL host alone.

export const DRAIN_INTERVAL_MS = 10_000;
export const RECORDS_PRUNE_MS = 60 * 60_000;

export type HubGateways = {
  // Boot (runReadySequence, after keys.boot()): prunes the feed, reads each
  // registered Gateway's key and starts draining it, and publishes the
  // status. Never rejects.
  start: () => Promise<void>;
  // Teardown: no drain starts after it resolves, and none is in flight.
  stop: () => Promise<void>;
  // POST /api/gateways. The check first; on success the key is stored, then
  // the registry, then draining starts. An already connected Gateway takes
  // the new key. Throws when a write fails (the route's 500).
  connect: (request: GatewayConnectRequest) => Promise<GatewayConnectResponse>;
  // DELETE /api/gateways/:id; false when the Hub holds no such Gateway.
  // Throws when the registry write fails.
  remove: (id: string) => Promise<boolean>;
  // GET /api/gateway-records.
  feed: (since: string | null) => GatewayRecordsFeed;
  // POST /api/gateway-records. Throws when the feed's write fails.
  push: (records: readonly ReducedGatewayRecord[]) => GatewayRecordsAck;
  // Drains now (each Gateway, or the one named), after any drain in flight.
  drainNow: (id?: string) => Promise<void>;
};

export type GatewayDrainerOptions = {
  registry: GatewayRegistry;
  keyStore: HubGatewayKeyStore;
  records: GatewayRecordsStore;
  fanout: Pick<HubFanout, "getStatus" | "patchStatus" | "emitGatewayRecordsPoke">;
  resolver: Pick<HubKeys, "accountForEmailHash" | "resolveEmailHashes">;
  fetch?: FetchLike;
  now?: () => number;
  intervalMs?: number;
  credentialsRefreshMs?: number;
  pruneMs?: number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
};

// The drain step's baseline (credentials, `statisticsOff`, `lastRecordAt`)
// beside the Gateway's run-time state.
type Running = GatewayDrainBaseline & {
  id: string;
  url: string;
  host: string;
  // Null when the key store holds no key for it.
  api: CliProxyApi | null;
  state: GatewayState;
  timer: ReturnType<typeof setTimeout> | null;
  busy: Promise<void> | null;
  stopped: boolean;
};

export function createGatewayDrainer(opts: GatewayDrainerOptions): HubGateways {
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? DRAIN_INTERVAL_MS;
  const refreshMs = opts.credentialsRefreshMs ?? CREDENTIALS_REFRESH_MS;
  const pruneMs = opts.pruneMs ?? RECORDS_PRUNE_MS;
  const log = opts.log ?? ((line: string) => console.log(line));
  const warn = opts.warn ?? ((line: string) => console.warn(line));
  const running = new Map<string, Running>();
  let pruneTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let published: string | null = null;

  const iso = () => new Date(now()).toISOString();
  const api = (url: string, managementKey: string) =>
    createCliProxyApi({ url, managementKey, ...(opts.fetch ? { fetch: opts.fetch } : {}) });

  function entryOf(g: Running): HubGateway {
    return { id: g.id, urlHost: g.host, state: g.state, lastRecordAt: g.lastRecordAt };
  }

  // `HubStatus.gateways`, sorted by id; patched only when it changed, and
  // never while the Hub has held no Gateway, so such a Hub serves the status
  // it served before #651. The last one removed takes the field away again.
  function publish(): void {
    const gateways = [...running.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(entryOf);
    if (gateways.length === 0) {
      if (opts.fanout.getStatus().gateways === undefined) return;
      published = null;
      opts.fanout.patchStatus({ gateways: undefined } satisfies Partial<HubStatus>);
      return;
    }
    const text = JSON.stringify(gateways);
    if (text === published) return;
    published = text;
    opts.fanout.patchStatus({ gateways } satisfies Partial<HubStatus>);
  }

  function setState(g: Running, state: GatewayState): void {
    if (g.state !== state) log(`[hub] Gateway ${g.host}: ${state}`);
    g.state = state;
  }

  function store(records: readonly ReducedGatewayRecord[], push: boolean) {
    const result = opts.records.add(records, { push });
    if (result.stored > 0) opts.fanout.emitGatewayRecordsPoke();
    return result;
  }

  async function drainOnce(g: Running): Promise<void> {
    if (g.api === null) return;
    await drainGatewayOnce(g, {
      api: g.api,
      host: g.host,
      logPrefix: "[hub]",
      now,
      refreshMs,
      gone: () => g.stopped,
      afterCredentials: async () => {
        // The Hub's keys' emails, as hashes, before the records they resolve.
        try {
          await opts.resolver.resolveEmailHashes();
        } catch {
          // A key's read failing leaves its Account unresolved, never the drain.
        }
      },
      resolver: () => (hash) => opts.resolver.accountForEmailHash(hash),
      sink: (drained) => {
        // The email hash stays behind: only the reduced record is kept.
        const reduced = drained.map((r) => r.reduced);
        try {
          store(reduced, false);
        } catch (err) {
          // The queue no longer holds them: they are lost, and their lines
          // fall to ADR-0141 §4.
          warn(
            `[hub] Gateway ${g.host}: ${reduced.length} drained record(s) could not be stored: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      setState: (state) => setState(g, state),
      warn,
    });
  }

  // One drain at a time per Gateway: a caller waits for the one in flight,
  // then runs its own.
  function runDrain(g: Running): Promise<void> {
    const previous = g.busy ?? Promise.resolve();
    const next = previous
      .then(() => (g.stopped ? undefined : drainOnce(g)))
      .catch((err: unknown) => {
        warn(
          `[hub] Gateway ${g.host}: drain failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (!g.stopped) setState(g, "error");
      })
      .finally(() => {
        if (g.busy === next) g.busy = null;
        if (!g.stopped) publish();
      });
    g.busy = next;
    return next;
  }

  function schedule(g: Running): void {
    if (g.stopped || stopped || g.api === null) return;
    g.timer = setTimeout(() => {
      g.timer = null;
      void runDrain(g).then(() => schedule(g));
    }, intervalMs);
  }

  function begin(id: string, url: string, managementKey: string | null, carry?: Running): Running {
    const g: Running = {
      id,
      url,
      host: gatewayUrlHost(url),
      api: managementKey === null ? null : api(url, managementKey),
      state: managementKey === null ? "unauthorized" : "draining",
      lastRecordAt: carry?.lastRecordAt ?? null,
      credentials: null,
      credentialsAt: null,
      readSinceCredentials: 0,
      statisticsOff: false,
      timer: null,
      busy: null,
      stopped: false,
    };
    running.set(id, g);
    if (g.api !== null && !stopped) void runDrain(g).then(() => schedule(g));
    return g;
  }

  async function halt(g: Running): Promise<void> {
    g.stopped = true;
    if (g.timer !== null) clearTimeout(g.timer);
    g.timer = null;
    await g.busy;
  }

  function prune(): void {
    try {
      opts.records.prune();
    } catch (err) {
      warn(
        `[hub] Gateway record feed prune failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Connect and Remove for one Gateway run one at a time (#651 Sol S1): two
  // concurrent Connects (several clients sending one Gateway up at once)
  // would each halt the same previous drainer and each begin one, and the
  // one `running` lost would drain on, out of reach of Remove and shutdown.
  const queues = new Map<string, Promise<unknown>>();
  function serially<T>(id: string, op: () => Promise<T>): Promise<T> {
    const prior = queues.get(id) ?? Promise.resolve();
    const next = prior.then(op, op);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    queues.set(id, settled);
    void settled.then(() => {
      if (queues.get(id) === settled) queues.delete(id);
    });
    return next;
  }

  async function removeNow(id: string): Promise<boolean> {
    const g = running.get(id);
    if (opts.registry.get(id) === null && g === undefined) return false;
    // The list first, then the key: a failure between leaves an unlisted
    // key, never a listed Gateway with no key.
    opts.registry.remove(id);
    running.delete(id);
    if (g !== undefined) await halt(g);
    try {
      await opts.keyStore.remove(id);
    } catch (err) {
      warn(
        `[hub] a removed Gateway's key could not be deleted: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    publish();
    return true;
  }

  return {
    async start() {
      prune();
      pruneTimer = setInterval(prune, pruneMs);
      for (const { id, url } of opts.registry.list()) {
        let key: string | null = null;
        try {
          key = await opts.keyStore.get(id);
        } catch (err) {
          warn(
            `[hub] Gateway ${gatewayUrlHost(url)}: its key could not be read: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (stopped) return;
        if (key === null)
          warn(`[hub] Gateway ${gatewayUrlHost(url)}: no key held; connect it again`);
        begin(id, url, key);
      }
      publish();
    },
    async stop() {
      stopped = true;
      if (pruneTimer !== null) clearInterval(pruneTimer);
      pruneTimer = null;
      await Promise.all([...running.values()].map(halt));
    },
    async connect({ url, managementKey }) {
      const normalized = normalizeGatewayUrl(url);
      if (normalized === null) throw new Error("not a Gateway URL");
      const check = await checkGateway({
        url: normalized,
        managementKey,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
      if (!check.ok) return { ok: false, failure: check.failure };
      const id = gatewayId(normalized);
      return serially(id, async () => {
        // The key first, then the list: a failure between leaves an unlisted
        // key, which nothing reads, never a listed Gateway with no key.
        await opts.keyStore.set(id, managementKey, iso());
        opts.registry.set({ id, url: normalized });
        const previous = running.get(id);
        if (previous !== undefined) await halt(previous);
        const g = begin(id, normalized, managementKey, previous);
        publish();
        return { ok: true as const, gateway: entryOf(g), warnings: check.warnings };
      });
    },
    remove: (id) => serially(id, () => removeNow(id)),
    feed: (since) => opts.records.feed(since),
    push: (records) => ({ accepted: store(records, true).accepted }),
    async drainNow(id) {
      const targets =
        id === undefined ? [...running.values()] : [running.get(id)].filter((g) => g !== undefined);
      await Promise.all(targets.map((g) => runDrain(g)));
    },
  };
}
