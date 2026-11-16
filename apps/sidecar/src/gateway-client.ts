import { z } from "zod";
import {
  checkGateway,
  createCliProxyApi,
  CREDENTIALS_REFRESH_MS,
  drainGatewayOnce,
  type CliProxyApi,
  type GatewayDrainBaseline,
  type FetchLike,
} from "@maxprice/usage-core";
import {
  GATEWAY_RECORDS_PAGE_MAX,
  HUB_GATEWAYS_PATH,
  HUB_GATEWAY_RECORDS_PATH,
  gatewayConnectResponseSchema,
  gatewayId,
  gatewayRecordsAckSchema,
  gatewayRecordsFeedSchema,
  gatewayUrlHost,
  hubGatewayRecordsFeedPath,
  normalizeGatewayUrl,
  type GatewayCheckResponse,
  type GatewayConfigEntry,
  type GatewayState,
  type HubConnection,
  type HubGateway,
  type LocalGateway,
  type ReducedGatewayRecord,
} from "@maxprice/shared";
import { loadDurably, writeDurably } from "./durable-file";
import type { GatewayMatcher } from "./gateway-matcher";
import type { GatewayPendingStore } from "./gateway-pending";
import { GATEWAY_SEEN_TTL_MS } from "./gateway-pending";

// The client side of Gateways (ADR-0141 §5, §7; D10, D11): the Gateways this
// machine holds, their fallback drain, and the relay through the Hub. One
// module, because the drain's predicate, the push-up after a drain and the
// feed pull all read the one Hub connection.
//
// ── The held set ──
// The host pushes the whole held set ({url, managementKey} each): the Desktop
// renderer through POST /api/gateways/config at launch and on change, the
// Headless client through `bootSidecar({ gateways })` from secrets.json.
// `configure` replaces it. The keys are memory only here, and never leave
// this module but toward their Gateway (the drain's Bearer) and, once, the
// joined Hub (the send-up below).
//
// ── The fallback drain (§5, D10) ──
// Every DRAIN_INTERVAL_MS each held Gateway is evaluated afresh: the Hub
// drains it — and this client does not — only while a Hub is configured, the
// hub-client is `connected`, and the Hub's last status lists this Gateway as
// `draining` or `statistics-off` (inferred, and indistinguishable from
// another consumer taking the records, while the Hub still holds a working
// connection: this client must not be a second consumer; #651). Anything else (no Hub; a Hub unreachable, connecting, keyless
// or refusing; a Hub that lists the Gateway in another state or not at all)
// and this client drains it through the step the Hub's drainer shares
// (usage-core `gateway/drain-step.ts`):
// the credential list at the first drain and every CREDENTIALS_REFRESH_MS,
// the queue read dry, `statistics-off` inferred from two credential reads.
// Each record is reduced with the pair table as its resolver (an Account
// uuid only for an email this machine paired), offered to the matcher with
// its email hash (local only), and put in the outbox without the hash,
// matched or not, until a Hub acks it. A flip
// between the Hub and this machine drops the credential baseline, so records
// the Hub drained in between never read as `statistics-off` here.
//
// Each credential read also keeps the list's email hashes
// (`credentialEmails`), which GET /api/account-sources resolves to the
// Accounts the Gateway holds (#639). A flip to the Hub drops the baseline but
// keeps them: this machine reads nothing from a Gateway the Hub drains, so
// they stay as of its own last drain, and one the Hub has drained since this
// boot names none.
//
// The outbox is kept with no Hub configured too, so a client that joins a
// Hub later pushes up what it drained before (ADR-0141 §5: every record
// drained, matched or not, until the Hub acknowledges it). It is bounded by
// the feed's window: a record whose timestamp is older than 7 days
// (GATEWAY_SEEN_TTL_MS) is dropped at each tick, which the Hub would refuse
// anyway. An install with no Gateway drains nothing, so writes nothing.
//
// ── The relay (§5) ──
// While connected (the hub-client's `onConnected` hook hands the connection):
// - feed pull: GET /api/gateway-records from the stored cursor on connect, on
//   each hub:gateway-records poke and every SWEEP_MS, paging while a page is
//   full; every record is offered to the matcher (no email hash: the feed
//   carries none). The cursor is kept per Hub URL in gateway-relay.json,
//   written only once a page carried a record. A cursor the Hub cannot read
//   (another epoch) replays its feed from the oldest record, which the
//   pending store's executionId seen-set deduplicates;
// - push-up: POST /api/gateway-records with the outbox in pages of at most
//   GATEWAY_RECORDS_PAGE_MAX, on connect, after each fallback drain that
//   added to it, and every SWEEP_MS; each ack's `accepted` leaves the outbox.
//   A failed push keeps it;
// - send-up (§7): each held Gateway not yet sent to this Hub is sent with
//   POST /api/gateways, once — on connect and on a held-set change while
//   connected. A Hub that answers `ok: true` records it as sent in
//   gateway-relay.json (written only then), so no later boot sends it again;
//   one that answers `ok: false` is asked again at the next connection. The
//   client never removes a Gateway at the Hub.
// A Hub from before #651 404s each route: the 404 latches that route off for
// the connection (`onConnected` clears it), as fleet.ts's directories do.
//
// Nothing here writes a file while no Gateway record and no send-up exist: an
// install with no Gateway writes nothing.

export const DRAIN_INTERVAL_MS = 10_000;
export const SWEEP_MS = 5 * 60_000;
// A feed pull pages at most this many times per pull; the next poke or
// sweep resumes from the cursor.
const FEED_PAGES_MAX = 100;
const HUB_REQUEST_TIMEOUT_MS = 30_000;

export type GatewayClientHub = {
  // The configured Hub's URL, or null when no Hub is configured.
  target: () => string | null;
  state: () => HubConnection;
  // The Hub's last status's Gateways (`HubClientHandle.hubGateways`).
  gateways: () => readonly HubGateway[] | null;
};

export type GatewayClientDeps = {
  pending: Pick<GatewayPendingStore, "addOutbox" | "outbox" | "ack">;
  matcher: Pick<GatewayMatcher, "offer">;
  // The pair table, email hash to Account uuid (ADR-0137 §1).
  pairs: () => ReadonlyMap<string, string>;
  hub: GatewayClientHub;
  // gateway-relay.json.
  relayPath: string;
  // Toward each Gateway, and toward the Hub. Default: the global fetch.
  fetch?: FetchLike;
  hubFetch?: FetchLike;
  now?: () => number;
  intervalMs?: number;
  credentialsRefreshMs?: number;
  sweepMs?: number;
  // GET /api/gateways' answer moved (the gateways:changed poke).
  onChanged?: () => void;
  log?: (line: string) => void;
  warn?: (line: string) => void;
};

export type GatewayClientConnection = { url: string; headers: Record<string, string> };

// One held Gateway's credential emails as hashes (local only, ADR-0137 §1).
export type GatewayCredentialEmails = { id: string; emailHashes: readonly string[] };

export type GatewayClient = {
  // Replaces the held set (deduplicated by Gateway id, the last entry
  // winning). Throws on a URL `normalizeGatewayUrl` refuses: callers
  // validate with `gatewaysConfigRequestSchema` first.
  configure: (entries: readonly GatewayConfigEntry[]) => void;
  // Connect's checks (D8), holding nothing.
  check: (entry: GatewayConfigEntry) => Promise<GatewayCheckResponse>;
  // GET /api/gateways, by id. Never a key.
  list: () => LocalGateway[];
  // Each held Gateway's credential emails, as hashes, from the credential
  // list this machine last read (GET /api/account-sources, #639): sorted,
  // each once, and empty before any read. Kept while the Hub drains it,
  // since this machine then reads nothing from the Gateway (§5): the list
  // is as of this machine's last own drain this run.
  credentialEmails: () => GatewayCredentialEmails[];
  // The hub-client's hooks (boot.ts adds them beside fleet.ts's).
  onConnected: (connection: GatewayClientConnection) => void;
  onDisconnected: () => void;
  onGatewayRecordsPoke: () => void;
  // Evaluates and, where the predicate says, drains every held Gateway once
  // (the timer's tick; tests drive it directly).
  tick: () => Promise<void>;
  // Settles once every relay request started so far has (tests).
  settled: () => Promise<void>;
  stop: () => Promise<void>;
};

// ── gateway-relay.json ───────────────────────────────────────────────────────

const relayFileSchema = z.object({
  version: z.literal(1),
  hubs: z.record(
    z.object({
      cursor: z.string().min(1).max(256).nullable(),
      sent: z.array(z.string()),
    }),
  ),
});
type RelayHub = { cursor: string | null; sent: Set<string> };

function createRelayFile(path: string, warn: (line: string) => void) {
  const hubs = new Map<string, RelayHub>();
  load();

  function load(): void {
    const parsed = loadDurably(path, relayFileSchema, "gateway-relay.json", warn);
    if (parsed === null) return;
    for (const [url, hub] of Object.entries(parsed.hubs)) {
      hubs.set(url, { cursor: hub.cursor, sent: new Set(hub.sent) });
    }
  }

  function write(): void {
    try {
      writeDurably(
        path,
        JSON.stringify({
          version: 1,
          hubs: Object.fromEntries(
            [...hubs].map(([url, hub]) => [url, { cursor: hub.cursor, sent: [...hub.sent] }]),
          ),
        }),
      );
    } catch (err) {
      warn(`[sidecar] gateway-relay.json write failed: ${String(err)}`);
    }
  }

  function entry(url: string): RelayHub {
    let hub = hubs.get(url);
    if (hub === undefined) {
      hub = { cursor: null, sent: new Set() };
      hubs.set(url, hub);
    }
    return hub;
  }

  return {
    cursor: (url: string): string | null => hubs.get(url)?.cursor ?? null,
    setCursor: (url: string, cursor: string): void => {
      const hub = entry(url);
      if (hub.cursor === cursor) return;
      hub.cursor = cursor;
      write();
    },
    sent: (url: string, id: string): boolean => hubs.get(url)?.sent.has(id) ?? false,
    markSent: (url: string, id: string): void => {
      const hub = entry(url);
      if (hub.sent.has(id)) return;
      hub.sent.add(id);
      write();
    },
  };
}

// ── The client ───────────────────────────────────────────────────────────────

// The drain step's baseline (credentials, `statisticsOff`, `lastRecordAt`)
// beside what the client keeps.
type Held = GatewayDrainBaseline & {
  id: string;
  url: string;
  host: string;
  managementKey: string;
  api: CliProxyApi;
  state: GatewayState;
  // Who drained it at the last tick.
  drainedBy: "hub" | "this-machine" | null;
  // The credential list's email hashes as last read, sorted and each once;
  // null before any read. Unlike `credentials`, a flip to the Hub keeps it.
  emailHashes: string[] | null;
  busy: Promise<void> | null;
  removed: boolean;
};

export function createGatewayClient(deps: GatewayClientDeps): GatewayClient {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? DRAIN_INTERVAL_MS;
  const refreshMs = deps.credentialsRefreshMs ?? CREDENTIALS_REFRESH_MS;
  const sweepMs = deps.sweepMs ?? SWEEP_MS;
  const log = deps.log ?? ((line: string) => console.error(line));
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const gatewayFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const hubFetch: FetchLike = deps.hubFetch ?? ((url, init) => fetch(url, init));
  const relay = createRelayFile(deps.relayPath, warn);
  const held = new Map<string, Held>();
  let drainTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  // The list and the credential emails as last announced; they start empty,
  // so holding nothing never pokes.
  let listed = "[[],[]]";

  // ── The predicate (D10) ──

  // The Hub's entry for `id` when the Hub drains it now, else null (this
  // machine drains it).
  function hubDrains(id: string): HubGateway | null {
    if (deps.hub.target() === null) return null;
    if (deps.hub.state() !== "connected") return null;
    const entry = deps.hub.gateways()?.find((g) => g.id === id);
    // `statistics-off` is inferred, and reads the same as another consumer
    // taking the records: the Hub still holds a working connection then, so
    // this machine must not become a second consumer.
    return entry !== undefined && (entry.state === "draining" || entry.state === "statistics-off")
      ? entry
      : null;
  }

  function credentialEmailsNow(): GatewayCredentialEmails[] {
    return [...held.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((g) => ({ id: g.id, emailHashes: g.emailHashes ?? [] }));
  }

  function listNow(): LocalGateway[] {
    return [...held.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((g) => {
        const hub = hubDrains(g.id);
        return hub !== null
          ? {
              id: g.id,
              urlHost: g.host,
              state: hub.state,
              lastRecordAt: hub.lastRecordAt,
              drainedBy: "hub" as const,
            }
          : {
              id: g.id,
              urlHost: g.host,
              state: g.state,
              lastRecordAt: g.lastRecordAt,
              drainedBy: "this-machine" as const,
            };
      });
  }

  // The gateways:changed poke, only when the list moved, or a credential list
  // read named other emails (GET /api/account-sources reads them).
  function announce(): void {
    const text = JSON.stringify([listNow(), credentialEmailsNow()]);
    if (text === listed) return;
    listed = text;
    deps.onChanged?.();
  }

  // ── The fallback drain ──

  function setState(g: Held, state: GatewayState): void {
    if (g.state !== state) log(`[sidecar] Gateway ${g.host}: ${state}`);
    g.state = state;
  }

  function dropBaseline(g: Held): void {
    g.credentials = null;
    g.credentialsAt = null;
    g.readSinceCredentials = 0;
    g.statisticsOff = false;
  }

  async function drainOnce(g: Held): Promise<void> {
    const sunk = await drainGatewayOnce(g, {
      api: g.api,
      host: g.host,
      logPrefix: "[sidecar]",
      now,
      refreshMs,
      gone: () => g.removed,
      afterCredentials: async () => {
        g.emailHashes = [
          ...new Set((g.credentials ?? []).flatMap((c) => (c.emailHash ? [c.emailHash] : []))),
        ].sort();
      },
      resolver: () => {
        const pairs = deps.pairs();
        return (hash) => pairs.get(hash);
      },
      sink: (offers) => {
        // The outbox first: a record is relayed whatever the matcher makes of
        // it, Hub or not yet, and never with its hash.
        deps.pending.addOutbox(offers.map((o) => o.reduced));
        deps.matcher.offer(offers);
      },
      setState: (state) => setState(g, state),
      warn,
    });
    if (sunk > 0 && conn !== null) pushUp();
  }

  function runGateway(g: Held): Promise<void> {
    if (g.busy !== null) return g.busy;
    const run = (async () => {
      if (hubDrains(g.id) !== null) {
        if (g.drainedBy !== "hub") dropBaseline(g);
        g.drainedBy = "hub";
        return;
      }
      if (g.drainedBy === "hub") dropBaseline(g);
      g.drainedBy = "this-machine";
      await drainOnce(g);
    })()
      .catch((err: unknown) => {
        warn(`[sidecar] Gateway ${g.host}: drain failed: ${String(err)}`);
        if (!g.removed) setState(g, "error");
      })
      .finally(() => {
        g.busy = null;
      });
    g.busy = run;
    return run;
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    pruneOutbox();
    await Promise.all([...held.values()].map(runGateway));
    announce();
  }

  function armDrain(): void {
    if (stopped) return;
    if (held.size === 0) {
      if (drainTimer !== null) clearInterval(drainTimer);
      drainTimer = null;
      return;
    }
    drainTimer ??= setInterval(() => void tick(), intervalMs);
  }

  // Outbox records past the feed's window leave it (header).
  function pruneOutbox(): void {
    const floor = now() - GATEWAY_SEEN_TTL_MS;
    const old = deps.pending
      .outbox()
      .filter((r) => Date.parse(r.timestamp) < floor)
      .map((r) => r.executionId);
    if (old.length > 0) deps.pending.ack(old);
  }

  // ── The relay ──

  let conn: GatewayClientConnection | null = null;
  let connGen = 0;
  let feedUnsupported = false;
  let pushUnsupported = false;
  let sendUnsupported = false;
  // Gateways asked of this connection already (an `ok: false` waits for the
  // next one).
  let askedThisConnection = new Set<string>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  const warned = new Set<string>();
  const inFlight = new Set<Promise<void>>();

  function warnOnce(what: string, detail: string): void {
    if (warned.has(what)) return;
    warned.add(what);
    warn(`[sidecar] Gateway ${what} failed: ${detail}`);
  }

  async function hubRequest(
    c: GatewayClientConnection,
    path: string,
    init: { method: "GET" } | { method: "POST"; body: unknown },
  ): Promise<Response> {
    return hubFetch(`${c.url}${path}`, {
      method: init.method,
      headers:
        init.method === "POST" ? { ...c.headers, "content-type": "application/json" } : c.headers,
      ...(init.method === "POST" ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(HUB_REQUEST_TIMEOUT_MS),
    });
  }

  // One run at a time per relay leg; a call during a run asks for one more.
  function serialized(
    what: string,
    once: (c: GatewayClientConnection, gen: number) => Promise<void>,
  ) {
    let running: Promise<void> | null = null;
    let again = false;
    const trigger = (): void => {
      if (conn === null || stopped) return;
      if (running !== null) {
        again = true;
        return;
      }
      const c = conn;
      const gen = connGen;
      running = once(c, gen)
        .catch((err: unknown) => {
          if (connGen === gen) warnOnce(what, String(err));
        })
        .finally(() => {
          inFlight.delete(tracked);
          running = null;
          if (again) {
            again = false;
            trigger();
          }
        });
      const tracked = running;
      inFlight.add(tracked);
    };
    return trigger;
  }

  const pullFeed = serialized("record feed pull", async (c, gen) => {
    for (let page = 0; page < FEED_PAGES_MAX; page++) {
      if (feedUnsupported) return;
      const res = await hubRequest(c, hubGatewayRecordsFeedPath(relay.cursor(c.url)), {
        method: "GET",
      });
      if (connGen !== gen) return;
      if (res.status === 404) {
        await res.body?.cancel();
        feedUnsupported = true; // a Hub from before #651: silent, per-connection
        return;
      }
      if (!res.ok) {
        await res.body?.cancel();
        warnOnce("record feed pull", String(res.status));
        return;
      }
      const parsed = gatewayRecordsFeedSchema.safeParse(await res.json());
      if (connGen !== gen) return;
      if (!parsed.success) {
        warnOnce("record feed pull", "malformed answer");
        return;
      }
      const { records, cursor } = parsed.data;
      if (records.length > 0) {
        deps.matcher.offer(records.map((reduced) => ({ reduced })));
        relay.setCursor(c.url, cursor);
      } else if (relay.cursor(c.url) !== null) {
        relay.setCursor(c.url, cursor);
      }
      if (records.length < GATEWAY_RECORDS_PAGE_MAX) return;
    }
  });

  const pushUp = serialized("push-up", async (c, gen) => {
    if (pushUnsupported) return;
    pruneOutbox();
    const outbox: readonly ReducedGatewayRecord[] = deps.pending.outbox();
    for (let i = 0; i < outbox.length; i += GATEWAY_RECORDS_PAGE_MAX) {
      const records = outbox.slice(i, i + GATEWAY_RECORDS_PAGE_MAX);
      const res = await hubRequest(c, HUB_GATEWAY_RECORDS_PATH, {
        method: "POST",
        body: { records },
      });
      if (connGen !== gen) return;
      if (res.status === 404) {
        await res.body?.cancel();
        pushUnsupported = true; // a Hub from before #651: silent, per-connection
        return;
      }
      if (!res.ok) {
        await res.body?.cancel();
        warnOnce("push-up", String(res.status));
        return;
      }
      const ack = gatewayRecordsAckSchema.safeParse(await res.json());
      if (!ack.success) {
        warnOnce("push-up", "malformed answer");
        return;
      }
      deps.pending.ack(ack.data.accepted);
    }
  });

  const sendUp = serialized("send-up", async (c, gen) => {
    for (const g of [...held.values()]) {
      if (sendUnsupported) return;
      if (g.removed || relay.sent(c.url, g.id) || askedThisConnection.has(g.id)) continue;
      askedThisConnection.add(g.id);
      const res = await hubRequest(c, HUB_GATEWAYS_PATH, {
        method: "POST",
        body: { url: g.url, managementKey: g.managementKey },
      });
      if (connGen !== gen) return;
      if (res.status === 404) {
        await res.body?.cancel();
        sendUnsupported = true; // a Hub from before #651: silent, per-connection
        return;
      }
      if (!res.ok) {
        await res.body?.cancel();
        warnOnce("send-up", String(res.status));
        continue;
      }
      const answer = gatewayConnectResponseSchema.safeParse(await res.json());
      if (connGen !== gen) return;
      if (!answer.success) {
        warnOnce("send-up", "malformed answer");
        continue;
      }
      if (answer.data.ok) {
        relay.markSent(c.url, g.id);
        log(`[sidecar] Gateway ${g.host}: sent to the Hub`);
      } else {
        log(`[sidecar] Gateway ${g.host}: the Hub could not connect it (${answer.data.failure})`);
      }
    }
  });

  function clearSweep(): void {
    if (sweepTimer !== null) clearInterval(sweepTimer);
    sweepTimer = null;
  }

  // ── The handle ──

  return {
    configure(entries) {
      const next = new Map<string, GatewayConfigEntry>();
      for (const entry of entries) {
        const url = normalizeGatewayUrl(entry.url);
        if (url === null) throw new Error("not a Gateway URL");
        next.set(gatewayId(url), { url, managementKey: entry.managementKey });
      }
      for (const [id, g] of held) {
        if (next.has(id)) continue;
        g.removed = true;
        held.delete(id);
      }
      for (const [id, { url, managementKey }] of next) {
        const previous = held.get(id);
        if (previous !== undefined && previous.managementKey === managementKey) continue;
        if (previous !== undefined) previous.removed = true;
        held.set(id, {
          id,
          url,
          host: gatewayUrlHost(url),
          managementKey,
          api: createCliProxyApi({ url, managementKey, fetch: gatewayFetch }),
          state: "draining",
          lastRecordAt: previous?.lastRecordAt ?? null,
          credentials: null,
          credentialsAt: null,
          readSinceCredentials: 0,
          statisticsOff: false,
          drainedBy: null,
          // The same Gateway, so the same credential list until read again.
          emailHashes: previous?.emailHashes ?? null,
          busy: null,
          removed: false,
        });
      }
      armDrain();
      announce();
      sendUp();
    },
    async check({ url, managementKey }) {
      const result = await checkGateway({ url, managementKey, fetch: gatewayFetch });
      return result.ok
        ? { ok: true, warnings: result.warnings }
        : { ok: false, failure: result.failure };
    },
    list: listNow,
    credentialEmails: credentialEmailsNow,
    onConnected(connection) {
      connGen += 1;
      conn = connection;
      feedUnsupported = false;
      pushUnsupported = false;
      sendUnsupported = false;
      askedThisConnection = new Set();
      warned.clear();
      clearSweep();
      if (!stopped) {
        sweepTimer = setInterval(() => {
          pullFeed();
          pushUp();
        }, sweepMs);
      }
      pullFeed();
      pushUp();
      sendUp();
    },
    onDisconnected() {
      connGen += 1;
      conn = null;
      clearSweep();
    },
    onGatewayRecordsPoke: () => pullFeed(),
    tick,
    async settled() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
    async stop() {
      stopped = true;
      connGen += 1;
      conn = null;
      clearSweep();
      if (drainTimer !== null) clearInterval(drainTimer);
      drainTimer = null;
      for (const g of held.values()) g.removed = true;
      await Promise.all([...held.values()].map((g) => g.busy));
      await Promise.all([...inFlight]);
    },
  };
}
