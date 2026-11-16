import {
  HUB_PROTOCOL_VERSION,
  HUB_SSE_EVENT,
  HUB_CREDENTIALS_PATH,
  hubAccountsConnection,
  hubEventsPokeSchema,
  hubKeyless,
  hubMembershipProjection,
  hubSamplesResponseSchema,
  hubStatusPreambleSchema,
  hubStatusSchema,
  hubWantsKey,
  splitSseFrames,
  usageSampleSchema,
  type HubAccount,
  type HubGateway,
  type HubConnection,
  type HubSamplesPushRequest,
  type SseFrame,
  type UsageConnection,
  type UsageCredential,
  type UsageSampleEvent,
  type HubStatus,
} from "@maxprice/shared";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { SampleStore } from "./sample-store";
import type { UsagePoller } from "./poller";

// The sidecar's hub connection (ADR-0035/0037): connect → verify
// HUB_PROTOCOL_VERSION (exact match; mismatch is a terminal-per-attempt state,
// never a shim) → backfill missed samples (since=latest local capturedAt) →
// live SSE. The password is OPTIONAL (ADR-0037): none configured ⇒ no
// Authorization header (an open hub ignores credentials; a protected hub 401s
// → the `unauthorized` state). While connected the LOCAL poller is stopped —
// the hub is the fleet's single poller; any failure — including the hub
// holding no working key (`keyless`, ADR-0138 §7), or rejecting our password
// (401 → `unauthorized`) — resumes it ([[Fallback polling]]) and retries on a
// timer. Epoch-guarded like the poller (poller.ts f1/f19): configure() bumps
// the epoch so an in-flight connect/stream from a previous config can never
// apply its results.
//
// The CURSORLESS SAMPLE EXCHANGE (ADR-0139 §8, #634): the since-cursors above
// pass only samples newer than a side's tip, so an Account stamp given to an
// old sample never crosses them. The exchange pulls the Hub's whole history
// (GET /api/samples with no `since`) and pushes this store's whole history,
// and the store's cover rule then takes each side's stamps to the other. It
// runs in the background once connected, one at a time, whenever the marker
// (`SampleExchangeMarker`, written only after an exchange completes) differs
// from now: the first connect to this Hub at this protocol, the store's
// `localSamplesStampedAt` moved (its own stamping, `samplesStamped()`), or the
// Hub's `samplesStampedAt` moved (on connect or on a status frame). The values
// recorded are those read when the exchange began, so a stamp landing on
// either side meanwhile runs one more. An exchange's own push that stamps the
// Hub's copies moves the Hub's `samplesStampedAt` too: that one more exchange
// finds nothing left to stamp, and its value then holds. A failed exchange
// records nothing and waits for the next connect.

export type HubClientConfig = { url: string; password: string | null; autoHeal: boolean };

// The ADR-0041 event-sync seam. The hub-client stays the SINGLE owner of hub
// connection custody; the event-sync engine (event-sync/fleet.ts, Tasks 5/6)
// learns about connections and pokes THROUGH these hooks and NEVER opens its
// own stream. Every call site is optional-chained: a client with no `fleet`
// wired behaves bit-for-bit like the pre-event-sync client. The receiving side
// is idempotent — these hooks only fire; they never gate connection behavior.
export type HubFleetHooks = {
  // After the client settles "connected" (post-backfill, pre-stream-open): the
  // event surface's connection context. events = HubStatus.events ?? null.
  onConnected: (ctx: {
    url: string;
    headers: Record<string, string>;
    events: { epoch: string; seq: number; deletionGeneration: number } | null;
  }) => void;
  // Any transition off "connected": fail() of every kind, configure(), stop().
  // Idempotent on the receiving side.
  onDisconnected: () => void;
  onEventsPoke: (seq: number) => void; // hub:events SSE frame
  onMachinesPoke: () => void; // hub:machines SSE frame
  onLabelsPoke: () => void; // hub:labels SSE frame (#288, #635)
  onMembershipAssertionsPoke: () => void; // hub:membership-assertions SSE frame (#310, #635)
  // hub:gateway-records SSE frame (ADR-0141 §5, #651): the Gateway record
  // feed grew. Optional: only the sidecar's Gateway relay listens.
  onGatewayRecordsPoke?: () => void;
  onStatusEvents: (
    events: { epoch: string; seq: number; deletionGeneration: number } | null,
  ) => void; // hub:status frames
};

// Cap on the SSE frame buffer (f7). A UsageSample/HubStatus JSON frame is
// sub-1KB, so a buffer that grows past this without yielding a "\n\n" frame
// separator is a hub streaming bytes that never frame — drop to fallback
// rather than grow `buffer` unbounded. The idle deadline can't cover this case:
// continuous bytes re-arm it on every read(), so it only ever fires on a
// genuinely SILENT wire.
const MAX_FRAME_BYTES = 64 * 1024;

// Push-up batch size (F27). The whole-replica seed of an empty hub can be a
// year's history (~525k samples ≈ ~80MB — sample-store.ts), which past
// Bun.serve's default 128MB request cap would fail on EVERY reconnect forever.
// Chunk the push into ordered (oldest-first) batches, POSTed sequentially,
// advancing pushUpFloor after each ack so a mid-seed failure resumes from the
// last acked point rather than re-seeding the whole replica each time.
const PUSH_UP_BATCH_SIZE = 5000;

export type HubClientDeps = {
  store: SampleStore;
  liveHub: {
    emitUsageSample: (event: UsageSampleEvent) => void;
    patchStatus: (
      partial: Partial<{
        hubConnection: HubConnection;
        usageConnection: UsageConnection;
        usageLastSampleAt: string | null;
      }>,
    ) => void;
  };
  // pollOnce closes the ~60s first-poll gap when fail() resumes the poller on
  // the transition into fallback/mismatch.
  localPoller: {
    start: () => void;
    stop: () => Promise<void>;
    pollOnce: () => Promise<void>;
    setRemoteState: UsagePoller["setRemoteState"];
    getCurrent: UsagePoller["getCurrent"];
    getOrganizations: UsagePoller["getOrganizations"];
  };
  machineId: string;
  // Friendly per-machine label for the hub roster (ADR-0036). Emitted as
  // x-maxprice-hostname when non-empty; an empty string (or absent) omits the
  // header — best-effort, additive under v1 when introduced.
  hostname?: string;
  // Auto-heal read seam (ADR-0035 M2, per key since ADR-0138 §7): every key
  // this machine holds, each with its Account (null: the legacy key whose
  // Account is not yet known) and when it was set (null: unknown, as the
  // legacy key's is). The poller's keyset, read at each decision.
  getLocalKeys: () => readonly HubHealKey[];
  // The Home membership's Account (null: none known), which the Hub's
  // per-Organization projection prefers (`hubMembershipProjection`).
  homeAccount?: () => string | null;
  // The Hub's Accounts as this client last read them moved (`hubAccounts`).
  onHubAccounts?: () => void;
  // `hubOwnsLiveState()` flipped (#685): whatever reads the Hub's Accounts
  // only while it owns live state now answers from the other side.
  onHubOwnsLiveState?: () => void;
  fetchImpl?: typeof fetch;
  retryMs?: number;
  // No-bytes deadline on the live stream — the hub heartbeats every 15s, so a
  // silent wire this long means a dead connection (default 60s = 4 missed
  // heartbeats).
  streamIdleTimeoutMs?: number;
  setTimeoutImpl?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (handle: ReturnType<typeof setTimeout>) => void;
  // The ADR-0041 event-sync seam ([[HubFleetHooks]]). Optional: absent ⇒ the
  // pre-event-sync client, every hook call site optional-chained.
  fleet?: HubFleetHooks;
  // Where the cursorless sample exchange's marker lives (header;
  // `createSampleExchangeMarkerFile`). Absent: no exchange runs, which only
  // the tests of the cursor sync choose.
  sampleExchange?: SampleExchangeMarkerStore;
};

// What the last completed cursorless sample exchange read when it began.
export type SampleExchangeMarker = {
  hubUrl: string;
  protocol: number;
  hubSamplesStampedAt: string | null;
  localSamplesStampedAt: string | null;
};

export type SampleExchangeMarkerStore = {
  // null: none recorded (or unreadable, which runs one exchange).
  read: () => Promise<SampleExchangeMarker | null>;
  write: (marker: SampleExchangeMarker) => Promise<void>;
};

// The marker as a small JSON file (`hub-sample-exchange.json` beside the
// usage history), replaced whole through a temp file and a rename.
export function createSampleExchangeMarkerFile(path: string): SampleExchangeMarkerStore {
  return {
    read: async () => {
      try {
        const raw = JSON.parse(await readFile(path, "utf8")) as Partial<SampleExchangeMarker>;
        const stamp = (v: unknown) => v === null || typeof v === "string";
        if (
          typeof raw?.hubUrl !== "string" ||
          typeof raw.protocol !== "number" ||
          !stamp(raw.hubSamplesStampedAt) ||
          !stamp(raw.localSamplesStampedAt)
        ) {
          return null;
        }
        return {
          hubUrl: raw.hubUrl,
          protocol: raw.protocol,
          hubSamplesStampedAt: raw.hubSamplesStampedAt ?? null,
          localSamplesStampedAt: raw.localSamplesStampedAt ?? null,
        };
      } catch {
        return null;
      }
    },
    write: async (marker) => {
      const tmp = `${path}.tmp`;
      try {
        await writeFile(tmp, `${JSON.stringify(marker)}\n`);
        await rename(tmp, path);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
    },
  };
}

// The cursorless exchange's whole-history GET may be a year of samples
// (~80 MB, PUSH_UP_BATCH_SIZE's note): a longer deadline than the backfill's.
const EXCHANGE_FETCH_TIMEOUT_MS = 120_000;

export type HubClientHandle = {
  configure: (config: HubClientConfig | null) => void;
  getState: () => HubConnection;
  // The Accounts the configured Hub's last status listed (ADR-0139 §1), from
  // its connect or its stream; null before any, and after configure() names
  // another Hub or none.
  hubAccounts: () => readonly HubAccount[] | null;
  // Whether the Hub owns live state (ADR-0139 §1): connected, or reconnecting
  // from connected, when the local poller is still paused under the Hub's
  // remote state (a configure() to the same Hub, #685). False from any other
  // state, the reconnects out of a fallback included, where the poller is on
  // duty.
  hubOwnsLiveState: () => boolean;
  // The Gateways the configured Hub's last status listed (ADR-0141 §9), as
  // `hubAccounts`: null before any status and after configure() names
  // another Hub or none; an empty list from a status that names none (a Hub
  // holding no Gateway, or one from before #651).
  hubGateways: () => readonly HubGateway[] | null;
  // The Home membership's Account moved: re-project the Hub's state now.
  homeAccountChanged: () => void;
  // The local store stamped samples (its `localSamplesStampedAt` moved): run
  // the cursorless sample exchange now if connected (header).
  samplesStamped: () => void;
  stop: () => Promise<void>;
};

// One local key, as auto-heal reads it (ADR-0138 §7).
export type HubHealKey = { accountUuid: string | null; sessionKey: string; setAt: string | null };

// What damping remembers of a pushed key: the key and when it was set
// locally. The same key pasted again after a removal at the Hub carries a
// later `setAt`, which `hubWantsKey` honours, so it must not read as already
// pushed (#634 Sol S2); an unchanged entry stays damped.
function pushedIdentity(key: HubHealKey): string {
  return JSON.stringify([key.sessionKey, key.setAt]);
}

// The damping slot of the legacy key, whose Account is not known.
const LEGACY_SLOT = "\u0000legacy";

export function createHubClient(deps: HubClientDeps): HubClientHandle {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const retryMs = deps.retryMs ?? 15_000;
  const streamIdleTimeoutMs = deps.streamIdleTimeoutMs ?? 60_000;
  const setTimeoutImpl = deps.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? ((h) => clearTimeout(h));

  let config: HubClientConfig | null = null;
  let state: HubConnection = "off";
  let epoch = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let streamAbort: AbortController | null = null;
  // Per-connect-attempt abort. The connect-phase fetches carry
  // AbortSignal.timeout deadlines (10s/30s), but stop()/configure() must not
  // wait those out against a black-holed hub — the sidecar's parent-death
  // watchdog awaits stop() inside shutdown(), and "orphan dies within ~1s"
  // (CLAUDE.md) can't survive a ~40s stall. teardownCurrent() aborts this
  // alongside the stream; every connect() creates a FRESH controller (never
  // reuses an aborted one across retries/reconfigures).
  let connectAbort: AbortController | null = null;
  let inFlight: Promise<void> | null = null;
  // Push-up floor (ADR-0035 M2): the capturedAt tip at the start of the
  // OLDEST unresolved fallback episode — everything captured after it is a
  // sample the hub missed. "" = push everything (the store was empty when the
  // episode began). First-set-wins across episodes: fail()'s transition gate
  // skips repeat retry failures, so the min comparison earns its keep on a
  // re-fall after a FAILED push (failed push → connected → fall again — the
  // older episode's floor must survive the newer, higher tip). Cleared ONLY
  // by a successful push; deliberately NOT reset by configure() (pushing
  // extra to a different hub is dedup-harmless; resetting would drop a
  // pending episode on a settings re-save). null = nothing pending.
  // In-memory only, by design: a client restart mid-fallback drops the floor,
  // and the pre-restart fallback samples then stay local-only unless the hub
  // is empty (the "" cutoff). Bounded, accepted — do not persist it.
  let pushUpFloor: string | null = null;
  // Auto-heal damping (ADR-0035 M2, per key since ADR-0138 §7): for each
  // local key's Account (LEGACY_SLOT for the legacy key), the session key this
  // client last successfully POSTed to the Hub. A key already given is never
  // re-pushed: if the Hub still reports it dead, the key is bad everywhere,
  // and re-pushing every retry would hit claude.ai (the Hub reads
  // `/api/account` inside the POST) 4×/min. A NEW key for that Account (a
  // fresh paste in Settings), or the same key pasted again (a later `setAt`),
  // compares unequal and un-damps — "one paste into
  // any machine heals the fleet" — and one Account's push never damps
  // another's. Reset on configure(): a different hub is a different
  // relationship.
  const pushedKeys = new Map<string, string>();
  // One background heal at a time from the stream (`healFromFrame`).
  let frameHeal: Promise<void> | null = null;
  // The configured Hub's last parsed status (`hubAccounts`, re-projection on a
  // Home change). Cleared when configure() names another Hub or none.
  let lastStatus: HubStatus | null = null;
  let lastAccountsJson = "null";
  // fail()'s "transition INTO fallback/mismatch" check must see through the
  // "connecting" state: connect() flips state to "connecting" at the top of
  // EVERY attempt — including the retry-timer attempts fired FROM fallback —
  // so by the time a connect-phase failure lands, the live `state` alone
  // can't tell a fresh transition from a repeat failure inside an episode.
  // connect() records what the machine was doing before it flipped; fail()
  // reads through it.
  let stateBeforeConnecting: HubConnection = "off";
  // `hubOwnsLiveState()` as `onHubOwnsLiveState` last announced it.
  let ownedAnnounced = false;
  // The cursorless sample exchange (header). `connection` names the current
  // stay in "connected": bumped when the client settles there and when it
  // leaves (fail(), teardown), so an exchange of an earlier one applies
  // nothing. `marker` is the last recorded one (undefined: not read yet).
  let connection = 0;
  let marker: SampleExchangeMarker | null | undefined;
  let exchanging: Promise<void> | null = null;
  let exchangeAgain = false;
  let exchangeFailedOn: number | null = null;
  let exchangeAbort: AbortController | null = null;

  function headers(c: HubClientConfig): Record<string, string> {
    const h: Record<string, string> = {
      "x-maxprice-machine": deps.machineId,
      "x-maxprice-protocol": String(HUB_PROTOCOL_VERSION),
    };
    // No password configured ⇒ no Authorization header at all (ADR-0037): an
    // open hub ignores credentials; a protected hub 401s → "unauthorized".
    if (c.password !== null) h.authorization = `Bearer ${c.password}`;
    if (deps.hostname !== undefined && deps.hostname !== "") {
      h["x-maxprice-hostname"] = deps.hostname;
    }
    return h;
  }

  // One reading per Organization this client polls, as the Hub's snapshot now
  // answers it — never the Hub's other Organizations, and never Home's alone.
  function emitCurrent(): void {
    for (const organizationUuid of deps.localPoller.getOrganizations()) {
      const { sample, weeklyResetAt } = deps.localPoller.getCurrent(organizationUuid);
      deps.liveHub.emitUsageSample({ organizationUuid, sample, weeklyResetAt });
    }
  }

  function setState(next: HubConnection): void {
    state = next;
    deps.liveHub.patchStatus({ hubConnection: next });
    announceOwnership();
  }

  // See `hubOwnsLiveState`. A reconnect from "connected" leaves the poller
  // stopped under the Hub's remote state until it lands or fails: connect()
  // stops the poller only once connected, and only fail() and configure(null)
  // restart it.
  function ownsLiveState(): boolean {
    return (
      state === "connected" || (state === "connecting" && stateBeforeConnecting === "connected")
    );
  }

  // Announces each flip of `ownsLiveState()` once (#685). A reconnect to the
  // same Hub stays owned throughout, so it announces nothing; a first connect
  // announces when it lands, after `onHubAccounts` already fired from the
  // connecting state, whose readers read the poller.
  function announceOwnership(): void {
    const owns = ownsLiveState();
    if (owns === ownedAnnounced) return;
    ownedAnnounced = owns;
    deps.onHubOwnsLiveState?.();
  }

  function clearRetry(): void {
    if (retryTimer !== null) {
      clearTimeoutImpl(retryTimer);
      retryTimer = null;
    }
  }

  // Any failure while configured: local poller back on duty, retry later.
  function fail(myEpoch: number, kind: "fallback" | "keyless" | "mismatch" | "unauthorized"): void {
    if (epoch !== myEpoch) return;
    streamAbort?.abort();
    streamAbort = null;
    leaveConnection();
    // Transition INTO fallback/mismatch (not a repeat failure inside it):
    // mark the push-up floor — from here until a successful push, locally
    // captured samples are ones the hub missed — and fire an immediate poll
    // so the resumed poller doesn't idle a full interval (~60s) before its
    // first sample. Repeat failures do neither: the retry loop runs every
    // retryMs and must not multiply claude.ai traffic. "connecting" is read
    // through to the state before the attempt ([[stateBeforeConnecting]]).
    // Accepted edge: a hub that answers connect but instantly drops the
    // stream makes every retry a GENUINE transition (~4 extra polls/min for
    // the flap's duration, loud in the logs, ceiling set by retryMs) — a
    // pathological topology not worth a rate limiter here.
    const settled = state === "connecting" ? stateBeforeConnecting : state;
    const wasFallenBack =
      settled === "fallback" ||
      settled === "keyless" ||
      settled === "mismatch" ||
      settled === "unauthorized";
    setState(kind);
    deps.fleet?.onDisconnected();
    deps.localPoller.setRemoteState(null);
    deps.localPoller.start();
    if (!wasFallenBack) {
      const tip = deps.store.latest()?.capturedAt ?? "";
      if (pushUpFloor === null || tip < pushUpFloor) pushUpFloor = tip;
      void deps.localPoller.pollOnce();
    }
    clearRetry();
    retryTimer = setTimeoutImpl(() => {
      retryTimer = null;
      void connect();
    }, retryMs);
  }

  // The local keys this Hub wants (`hubWantsKey`) that this client has not
  // already given it ([[pushedKeys]]); none while auto-heal is off.
  function healCandidates(c: HubClientConfig, status: HubStatus): HubHealKey[] {
    if (!c.autoHeal) return [];
    return deps
      .getLocalKeys()
      .filter(
        (key) =>
          pushedKeys.get(key.accountUuid ?? LEGACY_SLOT) !== pushedIdentity(key) &&
          hubWantsKey(status, key.accountUuid, key.setAt),
      );
  }

  // POSTs each key to /api/credentials, in order, the key alone: the Hub
  // learns its Account from claude.ai, so the answer's `accountUuid` is
  // informational. Damped on success only: a transient Hub-side 500 retries
  // next cycle. Answers "unauthorized" on a 401 (the password changed since the
  // status GET, ADR-0037), "stale" when the epoch moved, else whether any key
  // took. Any other failure is logged and the next key still goes.
  async function pushKeys(
    c: HubClientConfig,
    myEpoch: number,
    keys: readonly HubHealKey[],
    signal: AbortSignal,
  ): Promise<"unauthorized" | "stale" | boolean> {
    let took = false;
    for (const key of keys) {
      console.warn(
        "[usage-core] hub holds no working key for " +
          (key.accountUuid === null ? "this machine's unmoved key" : "an Account") +
          " — pushing this machine's key to heal it",
      );
      let res: Response;
      try {
        res = await fetchImpl(`${c.url}${HUB_CREDENTIALS_PATH}`, {
          method: "POST",
          headers: { ...headers(c), "content-type": "application/json" },
          // The key alone, whatever else the local credential carries: the
          // Hub refuses a body with anything beside it (ADR-0104).
          body: JSON.stringify({ sessionKey: key.sessionKey } satisfies UsageCredential),
          // The Hub reads claude.ai before acking — this is the slow lane.
          // Politeness edge: a claude.ai brown-out where requests hang past
          // this 30s deadline never damps (damping is success-only), so each
          // timed-out attempt plus the retry interval sustains ~1.3 claude.ai
          // reads/min per key until it recovers. Self-limiting, and
          // damping-on-send would mis-damp transient Hub 500s.
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        });
      } catch (err) {
        if (epoch !== myEpoch) return "stale";
        console.warn("[usage-core] hub credential heal failed:", err);
        continue;
      }
      if (epoch !== myEpoch) return "stale";
      if (res.status === 401) return "unauthorized";
      if (res.ok) {
        pushedKeys.set(key.accountUuid ?? LEGACY_SLOT, pushedIdentity(key));
        took = true;
      } else {
        console.warn(`[usage-core] hub credential heal rejected (${res.status})`);
      }
    }
    return took;
  }

  // A live status frame that newly wants a local key (a partial gap: some key
  // on the Hub still works, so the client stays connected): one heal in the
  // background, never blocking the stream, one at a time. The Hub's next
  // status frame carries what the heal changed.
  function healFromFrame(
    c: HubClientConfig,
    myEpoch: number,
    status: HubStatus,
    signal: AbortSignal,
  ): void {
    if (frameHeal !== null) return;
    const wanted = healCandidates(c, status);
    if (wanted.length === 0) return;
    frameHeal = pushKeys(c, myEpoch, wanted, signal)
      .then((outcome) => {
        if (outcome === "unauthorized") fail(myEpoch, "unauthorized");
      })
      .finally(() => {
        frameHeal = null;
      });
  }

  // The Hub's Accounts as last read; announced when they move.
  function recordStatus(status: HubStatus | null): void {
    lastStatus = status;
    const json = JSON.stringify(status?.accounts ?? null);
    if (json === lastAccountsJson) return;
    lastAccountsJson = json;
    deps.onHubAccounts?.();
  }

  // The per-Organization state the local poller shows while the Hub owns
  // polling, from the Hub's Memberships (ADR-0139 §10), the Home membership's
  // Account preferred.
  function remoteStateOf(status: HubStatus) {
    return hubMembershipProjection(status.accounts, deps.homeAccount?.() ?? null, Date.now());
  }

  // healBudget: one heal per connect attempt — a successful heal POST recurses
  // with the budget decremented, so a pushed key that is ALSO dead lands back
  // in the dead-credential branch with the budget exhausted and falls back.
  // Not redundant with damping: damping already blocks the re-check for the
  // SAME key, but a mid-attempt credential swap (a renderer paste landing
  // between the POST and the re-check) compares unequal and would otherwise
  // permit a second heal inside one attempt — the budget bounds that, and it
  // makes termination locally obvious without reasoning about damping state.
  async function connect(healBudget = 1): Promise<void> {
    if (config === null) return;
    const c = config;
    const myEpoch = epoch;
    // Wait for the local history to finish loading before backfilling (F6).
    // configure() can fire while the sample store is still reading
    // usage-history.jsonl; if that load loses the race, store.latest() is null,
    // `since` is undefined, and we backfill the hub's ENTIRE history — then
    // merge() appends every sample to disk (the seen set is still empty), up to
    // a full duplicate copy of the history per losing boot. store.ready never
    // rejects (the file-missing early-return and any read error settle it), so
    // this can only delay, never break, the connect. Epoch-guarded like every
    // other await: a teardown during the load bumps the epoch and we bail.
    await deps.store.ready;
    if (epoch !== myEpoch) return;
    // Fresh per-attempt controller (see [[connectAbort]]). On teardown the
    // composed signal below rejects the in-flight fetch; the catch's
    // `epoch !== myEpoch` guard then turns that rejection into a clean early
    // exit (teardownCurrent bumps the epoch BEFORE aborting).
    const abort = new AbortController();
    connectAbort = abort;
    // Capture only from settled states, preserving the invariant "the last
    // NON-connecting state": the post-heal recursion re-enters while state is
    // already "connecting", and re-capturing here would store "connecting" —
    // fail()'s read-through would then misclassify a failure inside the
    // recursion as a fresh transition (an extra pollOnce from inside a
    // fallback episode).
    if (state !== "connecting") stateBeforeConnecting = state;
    setState("connecting");
    let hubStatus: HubStatus;
    // The hub's event-sync watermark, captured near the status parse (below) so
    // it survives the block-scoped `status` const out to the connected block
    // where onConnected fires — the ADR-0041 seam ([[HubFleetHooks]]). null ⇒ a
    // pre-event-sync hub (no `events` on its status).
    let hubEvents: { epoch: string; seq: number; deletionGeneration: number } | null = null;
    try {
      const statusRes = await fetchImpl(`${c.url}/api/status`, {
        headers: headers(c),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
      });
      if (epoch !== myEpoch) return;
      // A 401 is a REJECTED credential, not an unreachable hub (ADR-0037):
      // surface it as its own state so the Settings panel can say "password
      // rejected" instead of the overloaded "unreachable" label.
      if (statusRes.status === 401) return fail(myEpoch, "unauthorized");
      if (!statusRes.ok) return fail(myEpoch, "fallback");
      const rawStatus: unknown = await statusRes.json();
      if (epoch !== myEpoch) return;
      // F5 (ADR-0035): read the version-INVARIANT preamble ({ service,
      // protocolVersion }) FIRST, before the full hubStatusSchema parse. A
      // future breaking HubStatus shape change would fail the full safeParse and
      // be reported as "fallback" (Hub unreachable) — masking the very mismatch
      // the version gate exists to catch. The preamble is guaranteed stable
      // across ALL protocol versions, so it detects the mismatch even when the
      // rest of the body has moved fields under it.
      const preamble = hubStatusPreambleSchema.safeParse(rawStatus);
      if (!preamble.success) return fail(myEpoch, "fallback");
      if (preamble.data.protocolVersion !== HUB_PROTOCOL_VERSION) {
        console.warn(
          `[usage-core] hub protocol mismatch: hub=${preamble.data.protocolVersion} client=${HUB_PROTOCOL_VERSION}`,
        );
        return fail(myEpoch, "mismatch");
      }
      // Version matches → parse the v-current shape from the SAME raw value.
      const status = hubStatusSchema.safeParse(rawStatus);
      if (!status.success) return fail(myEpoch, "fallback");
      hubStatus = status.data;
      // Capture the event-sync watermark before the block-scoped `status` const
      // falls out of scope at the connected block ([[hubEvents]]).
      hubEvents = status.data.events ?? null;
      recordStatus(hubStatus);
      // Auto-heal (ADR-0035 M2, per key since ADR-0138 §7): before deciding
      // whether to fail over, push every local key the Hub wants (no working
      // key for its Account, set after any removal there; the legacy key only
      // while the Hub is keyless) and re-run the attempt once — inside POST
      // /api/credentials the Hub reads the key's Account, stores it and polls
      // before acking, so the re-check reads the healed truth, not a race.
      // One heal per attempt (healBudget): a pushed key that is also dead lands
      // here again, damped. A partial gap heals here too while the client
      // stays on the Hub. The frame-time path heals only a partial gap, in the
      // background; a keyless frame fails over and the heal rides this retry.
      const wanted = healBudget > 0 ? healCandidates(c, hubStatus) : [];
      if (wanted.length > 0) {
        const outcome = await pushKeys(c, myEpoch, wanted, abort.signal);
        if (outcome === "stale") return;
        if (outcome === "unauthorized") return fail(myEpoch, "unauthorized");
        if (outcome) return connect(healBudget - 1);
      }
      // A Hub none of whose keys works can't accrue samples for anyone —
      // staying "connected" with the local poller paused would halt fleet-wide
      // accrual, so fall back under the distinct `keyless` state (ADR-0039,
      // ADR-0138 §7; visibly not "Hub unreachable", the ADR-0037 precedent).
      // Checked BEFORE the backfill: a keyless hub's history syncs once it is
      // re-keyed and the retry reconnects. A held key pending its first read,
      // or one reading `error`, keeps the client on the Hub (`hubKeyless`).
      if (hubKeyless(hubStatus)) {
        // The key-dead value is also this client's derived value — no working
        // key reads the same for every Organization. Every other display is
        // getCurrent().connection: the view Organization's state from the
        // Hub's Memberships (#267 item 2) — the sidecar's Quota organization.
        deps.liveHub.patchStatus({ usageConnection: hubAccountsConnection(hubStatus.accounts) });
        console.warn(
          "[usage-core] hub has no usable credential (" +
            hubAccountsConnection(hubStatus.accounts) +
            ") — falling back to local polling",
        );
        return fail(myEpoch, "keyless");
      }

      // Backfill everything captured since our latest local sample.
      const since = deps.store.latest()?.capturedAt;
      const samplesUrl = `${c.url}/api/samples${since === undefined ? "" : `?since=${encodeURIComponent(since)}`}`;
      const samplesRes = await fetchImpl(samplesUrl, {
        headers: headers(c),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
      });
      if (epoch !== myEpoch) return;
      // A password changed mid-connect must not masquerade as unreachable
      // (ADR-0037): a 401 on the backfill is the same rejected-credential case.
      if (samplesRes.status === 401) return fail(myEpoch, "unauthorized");
      if (!samplesRes.ok) return fail(myEpoch, "fallback");
      const batch = hubSamplesResponseSchema.safeParse(await samplesRes.json());
      if (epoch !== myEpoch) return;
      if (!batch.success) return fail(myEpoch, "fallback");
      deps.store.merge(batch.data.samples);

      // Push-up (ADR-0035 M2): everything the hub provably lacks goes up
      // before we settle into connected. Cutoff "" ⇒ the hub is empty — seed
      // it with the whole replica. Otherwise the smaller of the fallback
      // floor and the hub's tip (the tip term covers the boot overhang where
      // the local poller ran before the hub config arrived). ISO-8601 UTC
      // capturedAt strings compare lexicographically. When floor < hubLatest
      // the push re-uploads hub-originated samples backfilled in between —
      // dedup-harmless, the hub's `added` count excludes them. Failure is
      // deliberately NOT fail(): the hub answered status+samples and is
      // polling — falling back would double-poll and churn; the floor
      // survives for the next reconnect and the samples stay safe in the
      // local replica. That also covers a 404 from a hub built before this
      // endpoint (see hub.ts).
      const hubLatest = status.data.usageLastSampleAt;
      const cutoff =
        hubLatest === null
          ? ""
          : pushUpFloor === null || hubLatest < pushUpFloor
            ? hubLatest
            : pushUpFloor;
      const toPush = deps.store.all().filter((s) => s.capturedAt > cutoff);
      if (toPush.length > 0) {
        // Chunk into oldest-first batches (F27): store.all() is capturedAt-
        // ascending, so slicing forward keeps each batch's tip monotonic. After
        // each acked batch advance pushUpFloor to that batch's last capturedAt
        // (everything ≤ it is now on the hub); a rejected/failed batch KEEPS the
        // floor at the last acked point, warns, and stops — the untransmitted
        // tail re-pushes from that floor on the next reconnect. Push failure is
        // deliberately NOT fail(): the hub answered status+samples and is
        // polling — falling back would double-poll and churn.
        let pushOk = true;
        for (let i = 0; i < toPush.length && pushOk; i += PUSH_UP_BATCH_SIZE) {
          // Each sample as it is, its Account stamp included (ADR-0139 §8).
          const batch = toPush.slice(i, i + PUSH_UP_BATCH_SIZE);
          try {
            const pushRes = await fetchImpl(`${c.url}/api/samples`, {
              method: "POST",
              headers: { ...headers(c), "content-type": "application/json" },
              body: JSON.stringify({ samples: batch } satisfies HubSamplesPushRequest),
              signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
            });
            if (epoch !== myEpoch) return;
            if (pushRes.ok) {
              pushUpFloor = batch[batch.length - 1]!.capturedAt;
            } else {
              console.warn(
                `[usage-core] hub push-up rejected (${pushRes.status}) — retrying on next reconnect`,
              );
              pushOk = false;
            }
          } catch (err) {
            if (epoch !== myEpoch) return;
            console.warn("[usage-core] hub push-up failed — retrying on next reconnect:", err);
            pushOk = false;
          }
        }
        // Every batch acked ⇒ nothing pending; clear the floor (as before).
        if (pushOk) pushUpFloor = null;
      }
    } catch (err) {
      if (epoch !== myEpoch) return;
      console.warn("[usage-core] hub connect failed:", err);
      return fail(myEpoch, "fallback");
    }

    // Connected: the hub is the poller now. One merged patch rather than
    // setState + a second patchStatus. The stream deliberately opens AFTER
    // backfill completes — fail() doesn't bump the epoch, so an early-opened
    // stream that failed into "fallback" could be clobbered by a still-running
    // backfill flipping state back to connected.
    state = "connected";
    connection += 1;
    void deps.localPoller.stop();
    deps.localPoller.setRemoteState(remoteStateOf(hubStatus));
    emitCurrent();
    deps.liveHub.patchStatus({
      hubConnection: "connected",
      usageConnection: deps.localPoller.getCurrent().connection,
      usageLastSampleAt: deps.store.latest()?.capturedAt ?? null,
    });
    announceOwnership();
    // ADR-0041 seam: hand the event-sync engine the connection context AFTER
    // backfill settled and BEFORE the stream opens — it never opens its own.
    deps.fleet?.onConnected({ url: c.url, headers: headers(c), events: hubEvents });
    void openStream(c, myEpoch);
    requestExchange();
  }

  // The current stay in "connected" ends: its exchange stops applying.
  function leaveConnection(): void {
    connection += 1;
    exchangeAbort?.abort();
    exchangeAbort = null;
  }

  // Whether the marker differs from now (header).
  function exchangeDue(c: HubClientConfig, status: HubStatus): boolean {
    return (
      marker === null ||
      marker === undefined ||
      marker.hubUrl !== c.url ||
      marker.protocol !== HUB_PROTOCOL_VERSION ||
      marker.hubSamplesStampedAt !== status.samplesStampedAt ||
      marker.localSamplesStampedAt !== deps.store.localSamplesStampedAt()
    );
  }

  // Runs the exchange in the background when it is due, one at a time: a
  // request while one runs is taken up once it ends. Never blocks the caller.
  function requestExchange(): void {
    if (deps.sampleExchange === undefined || state !== "connected" || config === null) return;
    if (exchangeFailedOn === connection) return;
    if (exchanging !== null) {
      exchangeAgain = true;
      return;
    }
    const run = exchangeOnce(config, connection, deps.sampleExchange);
    exchanging = run;
    void run.finally(() => {
      exchanging = null;
      if (exchangeAgain) {
        exchangeAgain = false;
        requestExchange();
      }
    });
  }

  async function exchangeOnce(
    c: HubClientConfig,
    mine: number,
    markers: SampleExchangeMarkerStore,
  ): Promise<void> {
    if (marker === undefined) {
      const read = await markers.read().catch(() => null);
      if (marker === undefined) marker = read;
    }
    const status = lastStatus;
    if (mine !== connection || status === null || !exchangeDue(c, status)) return;
    // The values this exchange will record: read before anything crosses.
    const next: SampleExchangeMarker = {
      hubUrl: c.url,
      protocol: HUB_PROTOCOL_VERSION,
      hubSamplesStampedAt: status.samplesStampedAt,
      localSamplesStampedAt: deps.store.localSamplesStampedAt(),
    };
    const abort = new AbortController();
    exchangeAbort = abort;
    const failed = (why: string, err?: unknown) => {
      if (mine !== connection) return;
      exchangeFailedOn = mine;
      console.warn(
        `[usage-core] hub sample exchange failed (${why}) — retrying on next connect`,
        err ?? "",
      );
    };
    try {
      const res = await fetchImpl(`${c.url}/api/samples`, {
        headers: headers(c),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(EXCHANGE_FETCH_TIMEOUT_MS)]),
      });
      if (mine !== connection) return;
      if (!res.ok) return failed(String(res.status));
      const pulled = hubSamplesResponseSchema.safeParse(await res.json());
      if (mine !== connection) return;
      if (!pulled.success) return failed("unparseable history");
      if (deps.store.merge(pulled.data.samples).changed > 0) {
        deps.liveHub.patchStatus({ usageLastSampleAt: deps.store.latest()?.capturedAt ?? null });
      }
      // The whole history, oldest first, batched as the push-up is.
      const all = deps.store.all().slice();
      for (let i = 0; i < all.length; i += PUSH_UP_BATCH_SIZE) {
        const batch = all.slice(i, i + PUSH_UP_BATCH_SIZE);
        const pushRes = await fetchImpl(`${c.url}/api/samples`, {
          method: "POST",
          headers: { ...headers(c), "content-type": "application/json" },
          body: JSON.stringify({ samples: batch } satisfies HubSamplesPushRequest),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
        });
        if (mine !== connection) return;
        if (!pushRes.ok) return failed(String(pushRes.status));
      }
      marker = next;
      try {
        await markers.write(next);
      } catch (err) {
        // Kept in memory: this process does not repeat it; the next one may.
        console.warn("[usage-core] hub sample exchange marker write failed:", err);
      }
    } catch (err) {
      failed("unreachable", err);
    } finally {
      if (exchangeAbort === abort) exchangeAbort = null;
    }
  }

  async function openStream(c: HubClientConfig, myEpoch: number): Promise<void> {
    const abort = new AbortController();
    streamAbort = abort;
    // No-bytes read deadline ([[HubClientDeps.streamIdleTimeoutMs]]): a
    // half-open connection blocks read() forever while the local poller stays
    // stopped, so every read() resolution re-arms a deadline. Its callback
    // only calls fail() — which aborts the stream (the parked read() then
    // rejects, and the catch's abort.signal.aborted guard returns without
    // double-failing), resumes the local poller, and arms the retry. It never
    // bumps the epoch, and fail() guards the epoch, so a stale deadline is a
    // no-op. The finally below clears the timer on every exit path.
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdleDeadline = () => {
      if (idleTimer !== null) clearTimeoutImpl(idleTimer);
      idleTimer = setTimeoutImpl(() => {
        idleTimer = null;
        fail(myEpoch, "fallback");
      }, streamIdleTimeoutMs);
    };
    // Supplemental backfill on first frame (F7). connect() opens this stream
    // only AFTER the main backfill snapshot; a sample the hub's poller emits
    // BETWEEN that snapshot and this subscription is delivered by neither, and
    // the next reconnect's since-cursor skips past it — a permanent silent hole.
    // The hub's fanout delivers an initial hub:status frame synchronously at
    // subscription, so the FIRST frame ⇒ we are provably subscribed: re-run one
    // /api/samples GET now to sweep up anything captured in that gap. merge()
    // dedup makes the overlap with the main backfill harmless. Fire-and-forget
    // and epoch-guarded; it NEVER fail()s the live stream (401 / parse failures
    // are logged, non-fatal) — a transient re-backfill error must not tear down
    // a healthy connection.
    let supplementalDone = false;
    const supplementalBackfill = async (): Promise<void> => {
      try {
        const since = deps.store.latest()?.capturedAt;
        const url = `${c.url}/api/samples${since === undefined ? "" : `?since=${encodeURIComponent(since)}`}`;
        const res = await fetchImpl(url, {
          headers: headers(c),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
        });
        if (epoch !== myEpoch) return;
        if (!res.ok) {
          console.warn(`[usage-core] hub supplemental backfill failed (${res.status})`);
          return;
        }
        const batch = hubSamplesResponseSchema.safeParse(await res.json());
        if (epoch !== myEpoch) return;
        if (!batch.success) return;
        // Backfill is durable history only. The exact live value rides HubStatus
        // and must never be overwritten by the archive's latest timestamp.
        deps.store.merge(batch.data.samples);
      } catch (err) {
        if (epoch !== myEpoch) return;
        console.warn("[usage-core] hub supplemental backfill failed:", err);
      }
    };
    try {
      // Armed before the fetch: the headers phase has no AbortSignal.timeout
      // (unlike the status/samples fetches), so the deadline covers it too.
      armIdleDeadline();
      const res = await fetchImpl(`${c.url}/api/stream`, {
        headers: headers(c),
        signal: abort.signal,
      });
      if (epoch !== myEpoch) return;
      // A 401 on the stream is a rejected credential (ADR-0037), same as the
      // connect-phase fetches — surface it as "unauthorized", not "fallback".
      if (res.status === 401) return fail(myEpoch, "unauthorized");
      if (!res.ok || res.body === null) return fail(myEpoch, "fallback");
      armIdleDeadline(); // headers arrived — restart the clock for the body
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        armIdleDeadline(); // the wire produced bytes (or a close) — re-arm
        // The abort check mirrors the catch path: an abort (teardown or a
        // fail() that already scheduled a retry) may surface as a clean close
        // rather than a rejection — it must never re-enter fail().
        if (epoch !== myEpoch || abort.signal.aborted) return;
        if (done) break;
        const decoded = decoder.decode(value, { stream: true });
        // Spec-correct SSE framing via the shared CRLF-aware framer (F37): it
        // splits on the blank-line separator, extracts event/data (joining
        // multiple data: lines with \n per spec), and returns the trailing
        // partial block as `remainder` — fed back as the next read's carry.
        // On the real wire (Hono streamSSE: LF, single-line JSON data) this is
        // byte-identical to the old hand-rolled parser.
        const { frames, remainder } = splitSseFrames(buffer, decoded);
        buffer = remainder;
        for (const f of frames) {
          if (epoch !== myEpoch || abort.signal.aborted) return;
          handleFrame(f, myEpoch, abort.signal);
          // A terminal frame can abort the stream mid-batch. Remaining frames
          // belong to that dead stream and must not disturb local fallback.
          if (epoch !== myEpoch || abort.signal.aborted) return;
          // First frame ⇒ subscribed (F7): sweep the snapshot→subscription gap
          // once, while this stream still owns the connection.
          if (!supplementalDone) {
            supplementalDone = true;
            void supplementalBackfill();
          }
        }
        // After consuming every complete frame, a `remainder` still over the cap
        // is a hub streaming bytes that never frame (f7): every read() above
        // re-armed the idle deadline, so it would never surface this. fail()
        // aborts the stream + arms the retry; the finally clears the idle timer.
        if (buffer.length > MAX_FRAME_BYTES) return fail(myEpoch, "fallback");
      }
      // Server closed the stream — treat as a connection loss.
      if (epoch === myEpoch) fail(myEpoch, "fallback");
    } catch (err) {
      if (epoch !== myEpoch || abort.signal.aborted) return;
      console.warn("[usage-core] hub stream failed:", err);
      fail(myEpoch, "fallback");
    } finally {
      // All exits converge here — epoch-dead returns, the done-break path,
      // the catch, and the post-fire re-arm after our own abort unparks
      // read(). stop()/configure() teardown therefore never leaks a timer.
      if (idleTimer !== null) {
        clearTimeoutImpl(idleTimer);
        idleTimer = null;
      }
    }
  }

  // myEpoch is the calling openStream attempt's epoch — handleFrame is only
  // ever called from its read loop, so a dead-credential frame can fail() the
  // attempt it arrived on (never a later one). The frame is already parsed into
  // event/data by the shared splitSseFrames framer (F37); heartbeats and
  // comment-only blocks are dropped there and never reach here.
  function handleFrame(frame: SseFrame, myEpoch: number, signal: AbortSignal): void {
    const { event, data } = frame;
    if (data === "") return;
    try {
      if (event === HUB_SSE_EVENT.sample) {
        const parsed = usageSampleSchema.safeParse(JSON.parse(data));
        if (!parsed.success) return;
        // Carried as it is, its Account stamp included (ADR-0139 §8).
        const { changed } = deps.store.merge([parsed.data]);
        // hub:sample replicates ALL history. Live state rides hub:status.
        if (changed > 0) {
          deps.liveHub.patchStatus({ usageLastSampleAt: deps.store.latest()?.capturedAt ?? null });
        }
      } else if (event === HUB_SSE_EVENT.status) {
        const parsed = hubStatusSchema.safeParse(JSON.parse(data));
        if (!parsed.success) return;
        recordStatus(parsed.data);
        deps.localPoller.setRemoteState(remoteStateOf(parsed.data));
        emitCurrent();
        deps.liveHub.patchStatus({ usageConnection: deps.localPoller.getCurrent().connection });
        // ADR-0041 seam: forward the hub's live event-sync watermark.
        deps.fleet?.onStatusEvents(parsed.data.events ?? null);
        // The Hub's last working key died mid-stream — same policy as
        // connect(): fall back so the local poller keeps samples accruing (a
        // pending or `error` key stays connected there too), and the heal
        // rides the retry. fail() aborts OUR stream from inside its own read
        // loop; the loop's abort.signal.aborted guards unwind it cleanly
        // without double-failing. A partial gap heals in the background.
        if (hubKeyless(parsed.data)) {
          fail(myEpoch, "keyless");
        } else if (config !== null) {
          healFromFrame(config, myEpoch, parsed.data, signal);
          // The Hub's `samplesStampedAt` may have moved (header).
          requestExchange();
        }
      } else if (event === HUB_SSE_EVENT.events) {
        // ADR-0041 poke: the post-fsync durable watermark { seq }. Malformed
        // payloads are dropped (safeParse / the outer catch), never fatal.
        const parsed = hubEventsPokeSchema.safeParse(JSON.parse(data));
        if (parsed.success) deps.fleet?.onEventsPoke(parsed.data.seq);
      } else if (event === HUB_SSE_EVENT.machines) {
        // ADR-0041 poke: a directory-changed signal (empty payload).
        deps.fleet?.onMachinesPoke();
      } else if (event === HUB_SSE_EVENT.labels) {
        // ADR-0105 §8, ADR-0139 §7 poke: the Label directory's union changed
        // (empty payload) — the fleet pulls it.
        deps.fleet?.onLabelsPoke();
      } else if (event === HUB_SSE_EVENT.membershipAssertions) {
        // ADR-0107 §11, ADR-0139 §7 poke: the Membership assertion
        // directory's union changed (empty payload) — the fleet pulls it.
        deps.fleet?.onMembershipAssertionsPoke();
      } else if (event === HUB_SSE_EVENT.gatewayRecords) {
        // ADR-0141 §5 poke: the Gateway record feed grew (empty payload) —
        // the Gateway relay pulls it from its cursor.
        deps.fleet?.onGatewayRecordsPoke?.();
      }
    } catch {
      // an unparseable frame is dropped, never fatal
    }
  }

  function teardownCurrent(): void {
    // Epoch bump FIRST: the aborts below reject any in-flight connect/stream
    // await, and the catch handlers' `epoch !== myEpoch` guards must already
    // see the new epoch to exit cleanly instead of calling fail().
    epoch += 1;
    clearRetry();
    streamAbort?.abort();
    streamAbort = null;
    leaveConnection();
    connectAbort?.abort();
    connectAbort = null;
  }

  return {
    configure: (next) => {
      teardownCurrent();
      deps.fleet?.onDisconnected();
      // A different hub is a different relationship — heal damping resets
      // ([[pushedKeys]]), and its Accounts are not this one's. A reconfigure
      // to the same Hub (the renderer re-pushes its config at every launch)
      // keeps the Accounts it last read: clearing them would blank the Hub's
      // Accounts in /api/accounts and announce them twice (`onHubAccounts`)
      // until the reconnect read them again. The reconnect leaves the Hub
      // owning live state (`hubOwnsLiveState`), so /api/accounts reads them
      // throughout (#685).
      pushedKeys.clear();
      if (next === null || config === null || next.url !== config.url) recordStatus(null);
      config = next;
      if (next === null) {
        setState("off");
        // No hub ⇒ the pre-hub app: local poller on duty.
        deps.localPoller.setRemoteState(null);
        deps.localPoller.start();
        return;
      }
      inFlight = connect().catch((err) => {
        console.warn("[usage-core] hub configure failed:", err);
      });
    },
    getState: () => state,
    hubAccounts: () => lastStatus?.accounts ?? null,
    hubOwnsLiveState: ownsLiveState,
    hubGateways: () => (lastStatus === null ? null : (lastStatus.gateways ?? [])),
    homeAccountChanged: () => {
      if (state !== "connected" || lastStatus === null) return;
      deps.localPoller.setRemoteState(remoteStateOf(lastStatus));
      emitCurrent();
      deps.liveHub.patchStatus({ usageConnection: deps.localPoller.getCurrent().connection });
    },
    samplesStamped: () => requestExchange(),
    stop: async () => {
      // Shutdown path: sever everything WITHOUT toggling the poller (the
      // caller is tearing the whole process down).
      teardownCurrent();
      deps.fleet?.onDisconnected();
      config = null;
      state = "off";
      await (inFlight ?? Promise.resolve());
    },
  };
}
