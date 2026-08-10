import {
  HUB_PROTOCOL_VERSION,
  HUB_SSE_EVENT,
  hubEventsPokeSchema,
  hubSamplesResponseSchema,
  hubStatusPreambleSchema,
  hubStatusSchema,
  splitSseFrames,
  usageSampleSchema,
  type HubConnection,
  type HubSamplesPushRequest,
  type SseFrame,
  type UsageConnection,
  type UsageCredential,
  type UsageSample,
} from "@maxprice/shared";
import type { SampleStore } from "./sample-store";

// The sidecar's hub connection (ADR-0035/0037): connect → verify
// HUB_PROTOCOL_VERSION (exact match; mismatch is a terminal-per-attempt state,
// never a shim) → backfill missed samples (since=latest local capturedAt) →
// live SSE. The password is OPTIONAL (ADR-0037): none configured ⇒ no
// Authorization header (an open hub ignores credentials; a protected hub 401s
// → the `unauthorized` state). While connected the LOCAL poller is stopped —
// the hub is the fleet's single poller; any failure — including the hub
// reporting its own credential disconnected/expired, or rejecting our password
// (401 → `unauthorized`) — resumes it ([[Fallback polling]]) and retries on a
// timer. Epoch-guarded like the poller (poller.ts f1/f19): configure() bumps
// the epoch so an in-flight connect/stream from a previous config can never
// apply its results.

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
    events: { epoch: string; seq: number } | null;
  }) => void;
  // Any transition off "connected": fail() of every kind, configure(), stop().
  // Idempotent on the receiving side.
  onDisconnected: () => void;
  onEventsPoke: (seq: number) => void; // hub:events SSE frame
  onMachinesPoke: () => void; // hub:machines SSE frame
  onStatusEvents: (events: { epoch: string; seq: number } | null) => void; // hub:status frames
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
    emitUsageSample: (sample: UsageSample | null) => void;
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
    setCurrentSample: (sample: UsageSample | null) => void;
  };
  machineId: string;
  // Friendly per-machine label for the hub roster (ADR-0036). Emitted as
  // x-maxprice-hostname when non-empty; an empty string (or absent) omits the
  // header — best-effort, additive under v1 when introduced.
  hostname?: string;
  // Auto-heal read seam (ADR-0035 M2): this machine's own claude.ai
  // credential, if the renderer has pushed one (the poller holds it).
  getLocalCredential: () => UsageCredential | null;
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
};

export type HubClientHandle = {
  configure: (config: HubClientConfig | null) => void;
  getState: () => HubConnection;
  stop: () => Promise<void>;
};

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
  // Auto-heal damping (ADR-0035 M2): the exact credential this client last
  // successfully POSTed to the hub. A key we already gave the hub is never
  // re-pushed — if the hub still reports dead with it, the key is bad
  // everywhere, and re-pushing every retry would hit claude.ai (the hub polls
  // inside the credential POST) 4×/min. A NEW local key (fresh paste in
  // Settings) compares unequal and un-damps — "one paste into any machine
  // heals the fleet". Reset on configure(): a different hub is a different
  // relationship.
  let lastPushedCredential: UsageCredential | null = null;
  // fail()'s "transition INTO fallback/mismatch" check must see through the
  // "connecting" state: connect() flips state to "connecting" at the top of
  // EVERY attempt — including the retry-timer attempts fired FROM fallback —
  // so by the time a connect-phase failure lands, the live `state` alone
  // can't tell a fresh transition from a repeat failure inside an episode.
  // connect() records what the machine was doing before it flipped; fail()
  // reads through it.
  let stateBeforeConnecting: HubConnection = "off";

  function headers(c: HubClientConfig): Record<string, string> {
    const h: Record<string, string> = { "x-maxprice-machine": deps.machineId };
    // No password configured ⇒ no Authorization header at all (ADR-0037): an
    // open hub ignores credentials; a protected hub 401s → "unauthorized".
    if (c.password !== null) h.authorization = `Bearer ${c.password}`;
    if (deps.hostname !== undefined && deps.hostname !== "") {
      h["x-maxprice-hostname"] = deps.hostname;
    }
    return h;
  }

  function setState(next: HubConnection): void {
    state = next;
    deps.liveHub.patchStatus({ hubConnection: next });
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

  // The most recent local credential the hub doesn't have yet, or null when
  // healing is off / there's nothing local / the value is damped.
  function healCandidate(c: HubClientConfig): UsageCredential | null {
    if (!c.autoHeal) return null;
    const cred = deps.getLocalCredential();
    if (cred === null) return null;
    if (
      lastPushedCredential !== null &&
      lastPushedCredential.sessionKey === cred.sessionKey &&
      lastPushedCredential.orgId === cred.orgId
    ) {
      return null;
    }
    return cred;
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
    let hubUsageConnection: UsageConnection;
    let hubCurrentSample: UsageSample | null = null;
    // The hub's event-sync watermark, captured near the status parse (below) so
    // it survives the block-scoped `status` const out to the connected block
    // where onConnected fires — the ADR-0041 seam ([[HubFleetHooks]]). null ⇒ a
    // pre-event-sync hub (no `events` on its status).
    let hubEvents: { epoch: string; seq: number } | null = null;
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
      hubCurrentSample = status.data.usageCurrentSample;
      // Capture the event-sync watermark before the block-scoped `status` const
      // falls out of scope at the connected block ([[hubEvents]]).
      hubEvents = status.data.events ?? null;
      // A hub that reports its own credential dead can't accrue samples for
      // anyone — staying "connected" with the local poller paused would halt
      // fleet-wide accrual, so fall back under the distinct `keyless` state
      // (ADR-0039; ADR-0035: "unreachable OR reports itself
      // disconnected/expired"). Checked BEFORE the backfill: a keyless
      // hub's history will sync when it's re-keyed and the retry reconnects.
      // "error" does NOT trigger fallback — a transient claude.ai outage would
      // fail the local poll identically (churn for nothing).
      //
      // BOOT-WINDOW EXCEPTION (F16): "disconnected" WITH credentialPresent:true
      // is the transient window between a just-restarted hub's bind and its
      // first poll completing — provably NOT a steady-state dead key (a real
      // dead key reports "expired"; a credential CLEAR sets disconnected +
      // credentialPresent:FALSE together). Treat it like "error": skip the heal
      // and proceed to connected, so a hub restart doesn't trigger a thundering
      // herd of redundant keychain writes + upstream polls as every client's
      // retry lands here. If the boot poll then reveals the key expired, the
      // mid-stream hub:status frame fails over (pinned by an existing test).
      // The skip is keyed on credentialPresent===true so disconnected +
      // credentialPresent:false (a hub with NO key — incl. the Windows
      // credstore-read-failure case) still heals below.
      const bootWindow =
        status.data.usageConnection === "disconnected" && status.data.credentialPresent === true;
      if (
        !bootWindow &&
        (status.data.usageConnection === "disconnected" ||
          status.data.usageConnection === "expired")
      ) {
        // Mirror the hub's state for visibility while we decide.
        deps.liveHub.patchStatus({ usageConnection: status.data.usageConnection });
        // Auto-heal (ADR-0035 M2): before failing over, a client holding a key
        // the hub hasn't seen pushes it and re-runs the attempt — the hub
        // polls once inside POST /api/credential before acking, so the
        // re-check reads the healed truth, not a race. One heal per attempt
        // (healBudget): if the pushed key is also dead the re-check lands
        // here again, damped, and falls through to fallback. The frame-time
        // dead-credential path deliberately does NOT heal — it fails to
        // fallback and the heal rides this retry (see the M2 plan's design
        // notes for why in-stream healing was rejected).
        const cred = healBudget > 0 ? healCandidate(c) : null;
        if (cred !== null) {
          console.warn(
            "[usage-core] hub credential dead (" +
              status.data.usageConnection +
              ") — pushing this machine's key to heal it",
          );
          const healRes = await fetchImpl(`${c.url}/api/credential`, {
            method: "POST",
            headers: { ...headers(c), "content-type": "application/json" },
            body: JSON.stringify(cred),
            // The hub polls claude.ai before acking — this is the slow lane.
            // Politeness edge: if the hub's persist+pollOnce reliably exceeds
            // this 30s deadline (a claude.ai brown-out where requests hang
            // rather than fail), the upstream poll still completes hub-side
            // but the client sees a throw and never damps (damping is
            // success-only below) — each ~30s timed-out attempt plus the
            // retry interval sustains ~1.3 claude.ai polls/min until
            // claude.ai recovers. Self-limiting (it requires claude.ai to
            // already be hanging >30s per request), and damping-on-send would
            // mis-damp transient hub 500s — the accepted trade.
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
          });
          if (epoch !== myEpoch) return;
          // Password changed between the status GET and this POST: a rejected
          // credential is not an unreachable hub (ADR-0037).
          if (healRes.status === 401) return fail(myEpoch, "unauthorized");
          if (healRes.ok) {
            // Damped only on success: a transient hub-side 500 (the keychain
            // write fails BEFORE the hub's upstream poll) retries next cycle.
            lastPushedCredential = cred;
            return connect(healBudget - 1);
          }
          console.warn(`[usage-core] hub credential heal rejected (${healRes.status})`);
        }
        console.warn(
          "[usage-core] hub has no usable credential (" +
            status.data.usageConnection +
            ") — falling back to local polling",
        );
        // A reachable hub with no working key is `keyless`, visibly not "Hub
        // unreachable" (ADR-0039, the ADR-0037 precedent).
        return fail(myEpoch, "keyless");
      }
      hubUsageConnection = status.data.usageConnection;

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
    deps.localPoller.setCurrentSample(hubCurrentSample);
    deps.liveHub.emitUsageSample(hubCurrentSample);
    deps.liveHub.patchStatus({
      hubConnection: "connected",
      usageConnection: hubUsageConnection,
      usageLastSampleAt: deps.store.latest()?.capturedAt ?? null,
    });
    // ADR-0041 seam: hand the event-sync engine the connection context AFTER
    // backfill settled and BEFORE the stream opens — it never opens its own.
    deps.fleet?.onConnected({ url: c.url, headers: headers(c), events: hubEvents });
    void deps.localPoller.stop();
    void openStream(c, myEpoch);
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
          handleFrame(f, myEpoch);
          // First frame ⇒ subscribed (F7): sweep the snapshot→subscription gap
          // once. Skip if this frame's handleFrame already fail()ed/aborted the
          // stream (the fetch would abort immediately and log a spurious error).
          if (!supplementalDone && epoch === myEpoch && !abort.signal.aborted) {
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
  function handleFrame(frame: SseFrame, myEpoch: number): void {
    const { event, data } = frame;
    if (data === "") return;
    try {
      if (event === HUB_SSE_EVENT.sample) {
        const parsed = usageSampleSchema.safeParse(JSON.parse(data));
        if (!parsed.success) return;
        const added = deps.store.merge([parsed.data]);
        deps.localPoller.setCurrentSample(parsed.data);
        deps.liveHub.emitUsageSample(parsed.data);
        if (added > 0) {
          deps.liveHub.patchStatus({ usageLastSampleAt: parsed.data.capturedAt });
        }
      } else if (event === HUB_SSE_EVENT.status) {
        const parsed = hubStatusSchema.safeParse(JSON.parse(data));
        if (!parsed.success) return;
        deps.localPoller.setCurrentSample(parsed.data.usageCurrentSample);
        deps.liveHub.emitUsageSample(parsed.data.usageCurrentSample);
        deps.liveHub.patchStatus({ usageConnection: parsed.data.usageConnection });
        // ADR-0041 seam: forward the hub's live event-sync watermark.
        deps.fleet?.onStatusEvents(parsed.data.events ?? null);
        // The hub's credential died mid-stream — same policy as connect():
        // fall back so the local poller keeps samples accruing ("error" stays
        // connected there too). fail() aborts OUR stream from inside its own
        // read loop; the loop's abort.signal.aborted guards unwind it cleanly
        // without double-failing.
        if (
          parsed.data.usageConnection === "disconnected" ||
          parsed.data.usageConnection === "expired"
        ) {
          fail(myEpoch, "keyless");
        }
      } else if (event === HUB_SSE_EVENT.events) {
        // ADR-0041 poke: the post-fsync durable watermark { seq }. Malformed
        // payloads are dropped (safeParse / the outer catch), never fatal.
        const parsed = hubEventsPokeSchema.safeParse(JSON.parse(data));
        if (parsed.success) deps.fleet?.onEventsPoke(parsed.data.seq);
      } else if (event === HUB_SSE_EVENT.machines) {
        // ADR-0041 poke: a directory-changed signal (empty payload).
        deps.fleet?.onMachinesPoke();
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
    connectAbort?.abort();
    connectAbort = null;
  }

  return {
    configure: (next) => {
      teardownCurrent();
      deps.fleet?.onDisconnected();
      // A different hub is a different relationship — heal damping resets
      // ([[lastPushedCredential]]).
      lastPushedCredential = null;
      config = next;
      if (next === null) {
        setState("off");
        // No hub ⇒ the pre-hub app: local poller on duty.
        deps.localPoller.start();
        return;
      }
      inFlight = connect().catch((err) => {
        console.warn("[usage-core] hub configure failed:", err);
      });
    },
    getState: () => state,
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
