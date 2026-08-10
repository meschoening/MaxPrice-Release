// The client half of fleet event sync (ADR-0041 M5): the push triggers + stamp
// predicate and the ONE cursor-paged pull loop. Deliberately transport-thin —
// fleet.ts (apps/sidecar) owns wiring, debounce, and resync orchestration;
// hub-client.ts owns the connection and calls connect/disconnect/pokes.
//
// CONVERGENCE IS RECONCILED, NOT DELIVERED (ADR-0055, amending ADR-0041). The
// pull half used to be purely edge-triggered — a poke, a connect, a re-attach,
// a resync — and every failure path returns "abandon" with no retry queue. On a
// connection that stays up, that made a single dropped or failed drain terminal:
// no trigger remained, so the client sat silently behind the hub until the app
// restarted. The fix is to hold `caughtUpSeq` (the seq PROVEN drained) beside
// `hubWatermark` (the seq the hub SAYS it holds) and treat any gap between them
// as work owed — checked on the hub's own status frames, and swept on a timer as
// the floor. Pokes are now an accelerator, not the correctness mechanism.
//
// THE STAMP PREDICATE (computed, never stored): a local row is stamped ⇔ the
// replica holds its key at ≥ its token fullness, OR the in-memory
// acked-this-session map does (the ack→self-echo window; acks never write the
// replica — the pull loop stays its only writer). Contribute-only clients
// (replica() === null) have only the in-memory half: full re-push per boot,
// silent, flat forever (the local corpus is retention-capped).
import {
  EVENT_PULL_LIMIT_MAX,
  EVENT_PUSH_BATCH_MAX,
  fleetEventSchema,
  hubEventsPullEnvelopeSchema,
  hubEventsPushResponseSchema,
  type FleetEvent,
  type HubEventsPullEnvelope,
  type HubEventsPushRequest,
  type StoredEventWire,
} from "@maxprice/shared";
import { fleetEventKey, fleetTokenTotal, type FleetEventStore } from "./fleet-event-store";

export type EventSyncConnection = {
  url: string; // hub base URL, no trailing slash
  headers: Record<string, string>; // hub-client's headers(c) — auth + machine + hostname
  events: { epoch: string; seq: number } | null; // HubStatus.events; null ⇒ pre-event-sync hub ⇒ degraded
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
  applyFleetRows: (rows: FleetEvent[]) => number; // engine RAM upsert; returns changed count
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
  pullLimit?: number; // default EVENT_PULL_LIMIT_MAX
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
};

export type EventSync = {
  connect: (ctx: EventSyncConnection) => void; // trigger: (re)connect — kicks push + pull, arms the sweep
  disconnect: () => void; // hub-client fail()/teardown — disarms everything
  onEventsPoke: (seq: number) => void; // hub:events {seq} — pull trigger
  onStatusEvents: (events: { epoch: string; seq: number } | null) => void; // mid-stream hub:status echo
  notifyLocalChange: () => void; // trigger: watcher flush — push
  setShareEnabled: (on: boolean) => void; // hubShareEvents — gates every push trigger
  kickPull: () => void; // replica re-attach (toggle on) — ordinary reseed
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
  stop: () => Promise<void>;
};

export function createEventSync<Row extends StampableRow = StoredEventWire>(
  deps: EventSyncDeps<Row>,
): EventSync {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sweepMs = deps.sweepMs ?? 300_000;
  const pushBatchSize = deps.pushBatchSize ?? EVENT_PUSH_BATCH_MAX;
  const pullLimit = deps.pullLimit ?? EVENT_PULL_LIMIT_MAX;
  const setIntervalImpl =
    deps.setIntervalImpl ?? ((cb: () => void, ms: number): unknown => setInterval(cb, ms));
  const clearIntervalImpl =
    deps.clearIntervalImpl ??
    ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>));

  // Connection generation (the hub-client epoch-guard house pattern): connect /
  // disconnect / stop bump it; every await re-checks it, so a stale loop can
  // never apply its results.
  let gen = 0;
  let ctx: EventSyncConnection | null = null;
  let connected = false;
  // Sharing defaults ON; fleet.ts drives it from the hubShareEvents setting via
  // setShareEnabled. A push trigger is a no-op whenever it is off.
  let shareEnabled = true;
  let degraded = false;

  // The tracked hub epoch (null until adopted). The stamp set is the in-memory
  // ackedFullness map (key → the fullest token total the hub has acked this
  // session) UNION the replica's holdings, recomputed fresh each loop pass.
  let hubEpoch: string | null = null;
  const ackedFullness = new Map<string, number>();

  // Epoch-mismatch suspension: a data-holding replica that sees a foreign epoch
  // suspends every loop and signals fleet.ts ONCE; resync() (after fleet.ts
  // unlinks + rebuilds) lifts it.
  let suspendedForResync = false;
  let mismatchSignaled = false;

  // The highest durable watermark the hub has advertised via a poke / status
  // echo — the seed target the pull loop (Task 6) chases.
  let hubWatermark = 0;

  // The seq this client has PROVEN it is fully drained to (ADR-0055): set only
  // where a drain ends on a SHORT page, from that envelope's `seq`. The
  // asymmetry is the whole point — an abandoned drain leaves it behind, so the
  // gap between it and `hubWatermark` is standing proof that we owe a pull.
  // `hubWatermark` cannot serve here: a poke advances it BEFORE the pull it
  // triggers runs, so a failed pull would still look caught up. Epoch-scoped
  // (seq is only meaningful within one hub log), hence the resets wherever the
  // epoch is adopted or re-minted.
  let caughtUpSeq = 0;

  // Push-loop coalescing: one loop at a time; a trigger mid-loop sets pendingPush
  // so the loop re-runs once after (the settings-watch do/while pattern).
  let pushing = false;
  let pendingPush = false;
  let pushRun: Promise<void> | null = null;

  // Pull-loop coalescing: same shape as the push half — one drain at a time, a
  // poke landing mid-drain sets pendingPull for exactly one re-run.
  let pulling = false;
  let pendingPull = false;
  let pullRun: Promise<void> | null = null;

  // Pull state. `seeding` is STICKY: set when a run STARTS at derived cursor 0,
  // cleared ONLY by a short page — an interrupted seed resumes as a seed.
  // `seedTarget` only grows while seeding and resets when the seed completes.
  // `skippedPullRows` is the cumulative malformed-pulled-row count (diagnostic;
  // skip-and-count, never brick).
  let seeding = false;
  let seedTarget = 0;
  let skippedPullRows = 0;

  let sweepHandle: unknown = null;

  function canPush(): boolean {
    return connected && shareEnabled && !degraded && !suspendedForResync;
  }
  function canPull(): boolean {
    return connected && !degraded && !suspendedForResync && deps.replica() !== null;
  }

  // Computed stamp predicate (never stored). A fuller local copy un-stamps
  // automatically — the comparison is against the row's live token total.
  function stamped(row: Row): boolean {
    const total = fleetTokenTotal(row);
    const held = deps.replica()?.get(row.messageId, row.requestId);
    if (held !== undefined && fleetTokenTotal(held) >= total) return true;
    const acked = ackedFullness.get(fleetEventKey(row.messageId, row.requestId));
    return acked !== undefined && acked >= total;
  }

  // Prune the acked-fullness map of keys no longer in the local corpus — the
  // corpus is retention-capped but ackedFullness is not, so without this it
  // grows unbounded for a long-lived client's session (a key per distinct
  // pushed event, forever). A key absent from localEvents() can never be
  // queried by stamped() again, so dropping its stamp is safe. Runs once per
  // push pass against the same raw rows the stamp filter scans.
  function pruneAckedFullness(rows: readonly Row[]): void {
    if (ackedFullness.size === 0) return;
    const live = new Set<string>();
    for (const row of rows) live.add(fleetEventKey(row.messageId, row.requestId));
    for (const key of ackedFullness.keys()) {
      if (!live.has(key)) ackedFullness.delete(key);
    }
  }

  // Suspend every loop until resync() and signal fleet.ts ONCE (it unlinks +
  // rebuilds the replica, then calls resync()).
  function suspendForResync(): void {
    suspendedForResync = true;
    if (!mismatchSignaled) {
      mismatchSignaled = true;
      deps.onEpochMismatch();
    }
  }

  // Reconcile an observed epoch (push ack / pull envelope / status echo)
  // against the tracked hub epoch. "ok" ⇒ keep going; "suspend" ⇒ a
  // data-holding replica saw a foreign epoch — abandon until resync().
  // Contribute-only clients instead drop their stamps and re-push.
  function sawEpoch(epoch: string): "ok" | "suspend" {
    if (hubEpoch === null) {
      hubEpoch = epoch;
      return "ok";
    }
    if (epoch === hubEpoch) return "ok";
    const r = deps.replica();
    if (r !== null && r.size() > 0) {
      suspendForResync();
      return "suspend";
    }
    // Contribute-only (no replica data): the hub re-minted its archive; drop the
    // in-memory stamps, adopt the new epoch, and re-run the push (the
    // boot-shaped full re-push).
    ackedFullness.clear();
    hubEpoch = epoch;
    // A new epoch re-mints the seq space, so anything we had "proven drained"
    // describes a log that no longer exists (ADR-0055).
    caughtUpSeq = 0;
    pendingPush = true;
    return "ok";
  }

  async function pushBatch(
    conn: EventSyncConnection,
    batch: StoredEventWire[],
    myGen: number,
  ): Promise<"ok" | "abandon"> {
    let res: Response;
    try {
      res = await fetchImpl(`${conn.url}/api/events`, {
        method: "POST",
        headers: { ...conn.headers, "content-type": "application/json" },
        body: JSON.stringify({ events: batch } satisfies HubEventsPushRequest),
      });
    } catch (err) {
      if (gen !== myGen) return "abandon";
      console.warn("[usage-core] event push failed:", err);
      return "abandon";
    }
    if (gen !== myGen) return "abandon";
    // A 404 is a hub that predates event sync — degrade (no retry), exactly what
    // the pre-event-sync probe expects.
    if (res.status === 404) {
      if (!degraded) {
        degraded = true;
        deps.onDegraded?.(true);
      }
      return "abandon";
    }
    if (!res.ok) {
      console.warn(`[usage-core] event push rejected (${res.status})`);
      return "abandon";
    }
    let ackEpoch: string;
    try {
      const json: unknown = await res.json();
      if (gen !== myGen) return "abandon";
      const parsed = hubEventsPushResponseSchema.safeParse(json);
      if (!parsed.success) {
        console.warn("[usage-core] event push ack malformed");
        return "abandon";
      }
      ackEpoch = parsed.data.epoch;
    } catch (err) {
      if (gen !== myGen) return "abandon";
      console.warn("[usage-core] event push ack read failed:", err);
      return "abandon";
    }
    if (sawEpoch(ackEpoch) === "suspend") return "abandon";
    // Stamp every pushed row at the fuller of its existing acked total and this
    // row's total — "the hub has settled this key at least this fully".
    for (const row of batch) {
      const key = fleetEventKey(row.messageId, row.requestId);
      const total = fleetTokenTotal(row);
      const prev = ackedFullness.get(key);
      ackedFullness.set(key, prev === undefined ? total : Math.max(prev, total));
    }
    return "ok";
  }

  function runPushLoop(myGen: number): void {
    if (gen !== myGen || !canPush()) return;
    if (pushing) {
      pendingPush = true;
      return;
    }
    pushing = true;
    pushRun = pushLoopBody(myGen).catch((err) => {
      // The chain must never reject: nothing awaits pushRun in production (only
      // idle()/stop(), which are test + teardown paths), so a void-ed rejection
      // reaches the sidecar's unhandledRejection handler, which exits the
      // process (apps/sidecar/src/index.ts). Same rule fleet.ts keeps for its
      // reconcile chain. The finally in the loop body has already reset the loop
      // flags, so this degrades to an abandoned run — exactly what every other
      // failure path in this module does, and ADR-0055's reconciliation
      // (caughtUpSeq gap, status frames, the sweep) is the recovery. NOT routed
      // through onDegraded: `degraded` means "the hub predates event sync" and
      // LATCHES until a fresh connect, so one transient throw would gate every
      // push and pull while telling the user to update a healthy hub.
      console.error("[usage-core] push loop failed:", err);
    });
  }

  async function pushLoopBody(myGen: number): Promise<void> {
    try {
      do {
        pendingPush = false;
        const conn = ctx;
        if (conn === null) return;
        // Recompute the unstamped set fresh each pass (timestamp-ascending order
        // is preserved from localEvents()). A stamp landed mid-loop therefore
        // drops out on the next pass automatically. Scan the RAW store rows and
        // project ONLY the survivors onto the wire shape — no per-push
        // full-corpus wire allocation.
        const rows = deps.localEvents();
        pruneAckedFullness(rows);
        const unstamped = rows.filter((row) => !stamped(row)).map(deps.toWire);
        let abandoned = false;
        for (let i = 0; i < unstamped.length; i += pushBatchSize) {
          if (gen !== myGen) return;
          const batch = unstamped.slice(i, i + pushBatchSize);
          const outcome = await pushBatch(conn, batch, myGen);
          if (gen !== myGen) return;
          if (outcome === "abandon") {
            // ABANDON: no retry queue — the next trigger resumes where the
            // stamps left off (the failed batch is still unstamped).
            abandoned = true;
            break;
          }
        }
        if (abandoned) break;
      } while (pendingPush && canPush());
    } finally {
      // Only the loop that still owns the current generation clears the flags —
      // a stale loop (a reconnect bumped gen) must not clobber the fresh loop's
      // state (the fresh connect already reset them).
      if (gen === myGen) {
        pushing = false;
        pendingPush = false;
      }
    }
  }

  function runPullLoop(myGen: number): void {
    if (gen !== myGen || !canPull()) return;
    if (pulling) {
      pendingPull = true;
      return;
    }
    pulling = true;
    // Never let the chain reject — see the full note on runPushLoop's .catch.
    pullRun = pullLoopBody(myGen).catch((err) => {
      console.error("[usage-core] pull loop failed:", err);
    });
  }

  // One GET + one page application. "page-full" ⇒ keep draining; "done" ⇒
  // caught up (short page); "abandon" ⇒ drop this run (no retry queue — the
  // next trigger resumes from the derived cursor).
  async function pullPage(
    conn: EventSyncConnection,
    myGen: number,
  ): Promise<"page-full" | "done" | "abandon"> {
    const r = deps.replica();
    if (r === null) return "abandon";
    // The cursor is re-derived from the replica EVERY iteration — never
    // incremented — so an abandoned loop resumes for free and a crash-lowered
    // cursor only re-pulls rows that tie.
    const cursor = r.cursor();
    // seeding is sticky; only a short page completes a seed. (A run can only
    // observe cursor 0 at its start — every applied page moves it up.)
    if (cursor === 0) seeding = true;
    let res: Response;
    try {
      res = await fetchImpl(`${conn.url}/api/events?since=${cursor}&limit=${pullLimit}`, {
        headers: conn.headers,
      });
    } catch (err) {
      if (gen !== myGen) return "abandon";
      console.warn("[usage-core] event pull failed:", err);
      return "abandon";
    }
    if (gen !== myGen) return "abandon";
    // A 404 is a hub that predates event sync — degrade (no retry), the push
    // half's rule.
    if (res.status === 404) {
      if (!degraded) {
        degraded = true;
        deps.onDegraded?.(true);
      }
      return "abandon";
    }
    if (!res.ok) {
      console.warn(`[usage-core] event pull rejected (${res.status})`);
      return "abandon";
    }
    let envelope: HubEventsPullEnvelope;
    try {
      const json: unknown = await res.json();
      if (gen !== myGen) return "abandon";
      const parsed = hubEventsPullEnvelopeSchema.safeParse(json);
      if (!parsed.success) {
        console.warn("[usage-core] event pull envelope malformed");
        return "abandon";
      }
      envelope = parsed.data;
    } catch (err) {
      if (gen !== myGen) return "abandon";
      console.warn("[usage-core] event pull envelope read failed:", err);
      return "abandon";
    }
    if (sawEpoch(envelope.epoch) === "suspend") return "abandon";
    // The replica fleet.ts handed us at the top (`r`) was DETACHED (replica
    // toggled off ⇒ replica() is now null) or SWAPPED (off→on re-attached a
    // fresh store) while this page was in flight. Applying a stale page to the
    // old store would (a) write to a torn-down cache — the fire-and-forget
    // append racing its own close (an EBADF warn) — and (b) inject rows into the
    // engine that a now-local-only view must not show. Abandon; the next trigger
    // re-derives the cursor from the CURRENT replica (an off→on kickPull reseeds
    // it from 0). Identity-compare only: a resync unlinks IN PLACE (same object),
    // which correctly keeps applying against hub-mode's re-minted epoch.
    if (deps.replica() !== r) return "abandon";
    // Lenient per-row parse: malformed rows skip-and-COUNT (one warn per page)
    // and never brick the loop. A bad row at a full page's tail re-serves on
    // the next GET (the derived cursor stays below it) and re-counts —
    // termination still holds because the re-fetched page comes back short.
    const rows: FleetEvent[] = [];
    let skippedThisPage = 0;
    for (const raw of envelope.events) {
      const parsed = fleetEventSchema.safeParse(raw);
      if (parsed.success) rows.push(parsed.data);
      else skippedThisPage += 1;
    }
    if (skippedThisPage > 0) {
      skippedPullRows += skippedThisPage;
      console.warn(
        `[usage-core] event pull skipped ${skippedThisPage} malformed row(s) in one page`,
      );
    }
    if (rows.length > 0) {
      // Replica first (the pull loop is its ONLY writer), then the engine. An
      // empty parsed page applies nothing — a stale replica epoch surfaces on
      // the first page that actually carries rows.
      if (r.applyPage(rows, envelope.epoch) === "epoch-mismatch") {
        // The replica mirrors a different hub log than this envelope: the same
        // suspend path as a foreign ack epoch (a mismatching replica is
        // non-empty by construction — it has adopted an epoch header).
        suspendForResync();
        return "abandon";
      }
      deps.onPagesApplied(deps.applyFleetRows(rows));
    }
    if (seeding) {
      // target only grows; the renderer clamps (min(cursor/target, 1)) — the
      // sidecar reports honest numbers. Progress fires AFTER the page is
      // applied to replica + engine: the reported cursor is real.
      seedTarget = Math.max(seedTarget, envelope.seq, hubWatermark);
      deps.onSeedProgress({ cursor: r.cursor(), target: seedTarget });
    }
    if (envelope.events.length < pullLimit) {
      // Caught up (ADR-0055): a short page means the hub served everything it
      // had above our cursor, so `envelope.seq` — its durable watermark at
      // serve time — is now PROVEN drained. This is the ONE assignment; every
      // other exit from the drain (abandon) deliberately leaves it behind.
      // Monotonic: an older in-flight page can't walk it backwards. A page
      // whose rows were all skipped as malformed still counts as caught up,
      // matching the seed's existing rule below — re-pulling rows the parser
      // rejects would spin forever, and `skippedPullRows` is where that shows.
      if (envelope.seq > caughtUpSeq) caughtUpSeq = envelope.seq;
      if (seeding) {
        // The FIRST short page completes the seed.
        seeding = false;
        seedTarget = 0;
        deps.onSeedProgress(null);
      }
      return "done";
    }
    if (r.cursor() === cursor) {
      // A FULL page that advanced nothing — every row skipped. The log is
      // append-only and the page deterministic, so re-fetching the same
      // `since` would serve the identical page forever: warn + abandon
      // instead of spinning. The next trigger retries once, bounded.
      console.warn("[usage-core] event pull made no progress on a full page — abandoning");
      return "abandon";
    }
    return "page-full";
  }

  // ONE cursor-paged loop — seed = catch-up = live. Drains to the first short
  // page; a poke landing mid-drain re-runs it once (the do/while).
  async function pullLoopBody(myGen: number): Promise<void> {
    try {
      do {
        pendingPull = false;
        const conn = ctx;
        if (conn === null) return;
        let outcome: "page-full" | "done" | "abandon";
        do {
          if (gen !== myGen || !canPull()) return;
          outcome = await pullPage(conn, myGen);
          if (gen !== myGen) return;
        } while (outcome === "page-full");
        // ABANDON: like the push half, no retry queue — the next trigger
        // resumes from the re-derived cursor.
        if (outcome === "abandon") return;
      } while (pendingPull && canPull());
    } finally {
      if (gen === myGen) {
        pulling = false;
        pendingPull = false;
      }
    }
  }

  function clearSweep(): void {
    if (sweepHandle !== null) {
      clearIntervalImpl(sweepHandle);
      sweepHandle = null;
    }
  }

  function notifyLocalChange(): void {
    runPushLoop(gen);
  }

  function connect(next: EventSyncConnection): void {
    gen += 1;
    const myGen = gen;
    ctx = next;
    connected = true;
    // events === null ⇒ a pre-event-sync hub; degrade immediately. A fresh
    // connect always re-probes, so this also resets a prior 404 degrade.
    degraded = next.events === null;
    deps.onDegraded?.(degraded);
    hubEpoch = next.events?.epoch ?? null;
    // The status snapshot's durable watermark is a seed-target input (the pull
    // loop chases max(target, envelope.seq, this)).
    if (next.events !== null && next.events.seq > hubWatermark) hubWatermark = next.events.seq;
    // Drop the proven-drained mark on EVERY connect (ADR-0055). connect() sets
    // hubEpoch directly rather than through sawEpoch, so a reconnect against a
    // DIFFERENT hub would otherwise carry a foreign log's seq across and could
    // suppress the very pull that reconciles us to the new one. Free to reset:
    // the connect-time pull below re-establishes it on its first short page,
    // and if that pull abandons, a 0 mark is exactly the state that makes the
    // next status frame reconcile.
    caughtUpSeq = 0;
    // The new generation owns the loop flags; any stale loop bails on its gen
    // guard and its finally no-ops.
    pushing = false;
    pendingPush = false;
    pulling = false;
    pendingPull = false;
    clearSweep();
    runPushLoop(myGen);
    runPullLoop(myGen);
    // A degraded connect (events: null) skips arming the sweep — every push
    // AND pull trigger is gated anyway, so the tick would be pure noise.
    if (!degraded) {
      sweepHandle = setIntervalImpl(() => {
        notifyLocalChange();
        // The pull half sweeps too (ADR-0055). Watermark reconciliation heals
        // a missed drain within a status frame, but it can only fire while the
        // hub is still SPEAKING: its status frames ride the sample poller, so a
        // hub whose poller is wedged goes quiet and takes reconciliation with
        // it. This tick is the floor under that — unconditional, because a
        // client with nothing to fetch pays one short empty page per sweep.
        runPullLoop(gen);
      }, sweepMs);
    }
  }

  function disconnect(): void {
    gen += 1;
    connected = false;
    clearSweep();
    pushing = false;
    pendingPush = false;
    pulling = false;
    pendingPull = false;
  }

  async function idle(): Promise<void> {
    // Await actual runs only: both loop bodies consume their pending flag
    // before exiting, so a pending flag with NO loop in flight is inert until
    // the next trigger (a gated trigger can strand one) — waiting on it here
    // would spin forever.
    while (pushing || pulling) {
      await Promise.allSettled([pushRun, pullRun]);
    }
  }

  return {
    connect,
    disconnect,
    onEventsPoke: (seq) => {
      if (seq > hubWatermark) hubWatermark = seq;
      runPullLoop(gen);
    },
    onStatusEvents: (events) => {
      // null: a pre-event hub echoing status mid-stream — IGNORE; the connect
      // gate already handled capability (and a fresh connect re-probes).
      if (events === null) return;
      if (events.seq > hubWatermark) hubWatermark = events.seq;
      // Same epoch: RECONCILE (ADR-0055, amending ADR-0041's "pokes drive
      // pulls"). The hub re-broadcasts its whole status — watermark included —
      // on every sample its poller takes, so this frame arrives about once a
      // minute whether or not anything changed. Comparing it against what we
      // have PROVEN drained turns that free frame into the convergence
      // mechanism: a poke that was never delivered, or one whose drain
      // abandoned, self-heals here instead of waiting for a reconnect. Pokes
      // survive as the accelerator — they make convergence immediate — but no
      // longer carry correctness on their own. runPullLoop self-gates, so a
      // contribute-only client (no replica) still no-ops.
      if (events.epoch === hubEpoch) {
        if (events.seq > caughtUpSeq) runPullLoop(gen);
        return;
      }
      // A different epoch: the sawEpoch path. A contribute-only adopt sets
      // pendingPush (the boot-shaped re-push) — run the loop so it isn't
      // stranded until the next trigger.
      if (sawEpoch(events.epoch) === "ok") runPushLoop(gen);
    },
    notifyLocalChange,
    setShareEnabled: (on) => {
      shareEnabled = on;
    },
    kickPull: () => {
      runPullLoop(gen);
    },
    resync: () => {
      // Post-unlink (fleet.ts rebuilt the replica): drop every stamp + the epoch,
      // clear the suspension + its one-shot signal, and re-run both loops. Reset
      // the seed watermark too: after an archive-SHRINKING purge the client
      // reseeds from cursor 0, but hubWatermark is monotonic-increase-only and
      // would otherwise stay pinned at the stale pre-purge (larger) value,
      // inflating the pull loop's seed target so the "Syncing fleet history — N%"
      // line under-reports / completes before 100%. The next connect/poke/status
      // re-populates it; between here and then seedTarget falls back to the
      // honest envelope.seq.
      ackedFullness.clear();
      mismatchSignaled = false;
      suspendedForResync = false;
      hubEpoch = null;
      hubWatermark = 0;
      seedTarget = 0;
      // Same reason as hubWatermark above: the re-minted log restarts seq, so a
      // mark proven against the OLD log would suppress reconciliation against
      // the new one until the hub climbed past it (ADR-0055).
      caughtUpSeq = 0;
      runPushLoop(gen);
      runPullLoop(gen);
    },
    idle,
    getState: () => ({ degraded, seeding, skippedPullRows, caughtUpSeq }),
    stop: async () => {
      disconnect();
      await idle();
      await Promise.allSettled([pushRun, pullRun]);
    },
  };
}
