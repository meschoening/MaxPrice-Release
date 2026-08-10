import {
  createEventSync,
  createFleetEventStore,
  createIdentityDirectory,
  type EventSync,
  type FleetEventStore,
  type HubFleetHooks,
} from "@maxprice/usage-core";
import {
  EVENT_FORGET_SESSIONS_MAX,
  IDENTITY_PUSH_BATCH_MAX,
  PROJECT_IDENTITY_PATH,
  buildAutomaticProjectIdentity,
  hubEventsForgetResponseSchema,
  hubMachinesResponseSchema,
  hubProjectIdentityResponseSchema,
  projectMergeAssertionKey,
  resolveProjectMergeAssertions,
  type ForgetSessionRef,
  type ProjectIdentityRow,
  type ProjectMergeAssertion,
  type ProjectMergeMutationRequest,
  type ProjectMergeMutationResponse,
  type SidecarMachinesResponse,
  type SidecarProjectIdentityResponse,
  type StatusSnapshot,
} from "@maxprice/shared";
import type { ZodType } from "zod";
import { createMachineDirectoryCache } from "./machine-directory-cache";
import { scanGate } from "./scan-gate";
import { storedEventToWire } from "./stored-event-wire";
import type { EventStore } from "./engine/store";
import type { LiveHub } from "./live-hub";

// ADR-0041 (M5) — the sidecar's fleet-event WIRING module. This is the ONE place
// replica lifecycle, the share/replica toggles, the debounced renderer pokes +
// hubSeed status, and the epoch-resync ORDER live. The two layers below it stay
// deliberately thin so this coordination has a single home:
//   - event-sync (@maxprice/usage-core) is transport-only — the push triggers,
//     the one cursor-paged pull loop, the stamp predicate. It debounces nothing
//     and never touches the engine store or the LiveHub.
//   - hub-client (@maxprice/usage-core) owns connection CUSTODY only — it opens
//     the SSE stream, verifies the protocol, and fires the HubFleetHooks. It
//     never opens an event-sync stream of its own.
// fleet.ts composes them: it hands `hooks` to createHubClient, drives the
// event-sync from those hooks, feeds the engine store, and reconciles the
// replica store against the two toggles + the hub-configured gate.
//
// ADR-0062 adds the Identity directory's sync to the same home: push rides
// the shareEvents gate, pull rides the replica gate + the directory sweep,
// and a pre-identity hub's 404 latches per-connection. See the identity
// section below.

// { cursor, target } | null — the seed-progress shape on the status snapshot.
type HubSeed = StatusSnapshot["hubSeed"];

// The live hub connection context — everything a fleet-side request needs to
// dial the hub. Null whenever disconnected.
type Conn = { url: string; headers: Record<string, string> };

// A serialized refresh's trigger, plus the force-reset a connection edge needs.
type RefreshTrigger = { (): void; reset: () => void };

// Deadline on every fleet-side hub request, matching hub-client's own 30s. A
// tailnet peer that goes black-holed (asleep laptop, dropped route) leaves a
// signal-less fetch pending indefinitely — and the refresh serializer's
// in-flight flag is cleared only by the body that owns it, so one such fetch
// used to end this client's identity pulls for the life of the process.
const FLEET_REQUEST_TIMEOUT_MS = 30_000;

// The abort pair every fleet request arms. Manual AbortController + setTimeout
// rather than AbortSignal.timeout: that combination has a bun/win32
// parked-loop hang (see `daemonRunning` in apps/hub/src/index.ts, which cites
// it). Deliberately the REAL global setTimeout, never deps.setTimeoutImpl —
// that seam belongs to the renderer-poke debounce, and the test harness fakes
// it as ONE stashed callback, so routing a deadline through it would overwrite
// the debounce. Unref'd because a parked deadline must never be what holds the
// process open: the parent-death watchdog has to exit within ~1s.
function requestDeadline(): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FLEET_REQUEST_TIMEOUT_MS);
  timer.unref();
  return { signal: ctrl.signal, clear: (): void => clearTimeout(timer) };
}

export type FleetSyncDeps = {
  machineId: string;
  replicaPath: string; // <app-data>/fleet-events.jsonl
  directoryCachePath: string; // <app-data>/machine-directory.json
  identityDirectoryPath: string; // <app-data>/identity-directory.json (ADR-0062)
  liveHub: Pick<LiveHub, "patchStatus" | "emitUsage" | "getStatus">;
  getStore: () => EventStore;
  swapStore: (next: EventStore) => void; // main()'s storeRef assignment
  createStore: () => EventStore; // () => createEventStore({ selfMachineId: machineId })
  // The Local archive's engine feeder (ADR-0069): rebuildEngine seeds every
  // fresh store from it, exactly as it seeds from the replica — without this, a
  // replica-off toggle or an epoch resync would rebuild an engine that forgot
  // everything the corpus no longer backs.
  seedLocalArchive?: (store: EventStore) => void;
  // The forget propagation (ADR-0069 §8): rewrite the local archive to drop the
  // sessions whose hub batches LANDED, before the resync's rebuild re-seeds the
  // engine — otherwise the archive resurrects the forgotten rows immediately.
  forgetLocalArchive?: (sessions: readonly ForgetSessionRef[]) => Promise<void>;
  getRoots: () => string[];
  emitMachinesChanged: () => void; // liveHub broadcast of SSE_EVENT.machinesChanged
  emitIdentityChanged: () => void; // liveHub broadcast of SSE_EVENT.identityChanged (ADR-0062)
  initial: { shareEvents: boolean; fleetReplica: boolean; hubConfigured: boolean };
  fetchImpl?: typeof fetch;
  debounceMs?: number; // default 500 — the trailing poke/status debounce
  pokeMaxWaitMs?: number; // default 2000 — ceiling on that trailing debounce
  directorySweepMs?: number; // default 300_000 — the machine-directory refresh sweep
  nowImpl?: () => number;
  setTimeoutImpl?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (handle: ReturnType<typeof setTimeout>) => void;
  setIntervalImpl?: (cb: () => void, ms: number) => unknown; // threaded to event-sync's sweep
  clearIntervalImpl?: (handle: unknown) => void;
};

// What a forget run produced. Two failure reasons, not one, because they call
// for different words and different HTTP: `unavailable` means the precondition
// evaporated between the guard and the act (the hub disconnected, the replica
// detached) and is retryable as-is; `failed` means the hub was reached and did
// not do it. `landed` says whether ANY batch was applied before the failure —
// the difference between "nothing happened" and "some of it did", which decides
// whether the local replica still agrees with the archive.
// `busy` is a third, and is "not in this state" rather than "try again in a
// moment": a forget already running on this machine is doing the work the second
// caller wants done.
export type FleetForgetResult =
  | { ok: true; sessionsRequested: number; sessionsMatched: number; rowsRemoved: number }
  | { ok: false; reason: "unavailable" | "failed" | "busy"; detail: string; landed: boolean };

export type FleetSync = {
  hooks: HubFleetHooks; // hand to createHubClient({ fleet: ... })
  loadReplicaAtBoot: () => Promise<void>; // local disk only — part of engineReady, never network
  applySettings: (s: { hubShareEvents: boolean; hubFleetReplica: boolean }) => void;
  onHubConfigured: (configured: boolean) => void;
  notifyLocalChange: () => void; // watcher flush → push trigger
  // Manual-refresh pull trigger (ADR-0055). The rescan gesture re-walks local
  // disk and pokes the push half; without this it had no way to ask the hub
  // what it had MISSED, so the one control labelled "refresh" could not repair
  // the one failure a user would reach for it to repair. Self-gating: a
  // hub-less or replica-off client no-ops inside event-sync.
  kickPull: () => void;
  machines: () => SidecarMachinesResponse; // loopback GET /api/machines body
  // The Identity directory surface (ADR-0062). recordProbes takes rows the
  // prober already STAMPED (probedAt): a change emits identity:changed and
  // (share-gated) re-offers own rows to the hub. NOTE the store's change bit
  // means RAM changed — after a failed load the store withholds disk writes
  // (fail-closed), so a true bit is not a durability guarantee.
  recordProbes: (rows: ProjectIdentityRow[]) => void;
  identity: () => SidecarProjectIdentityResponse; // loopback GET /api/project-identity body
  setProjectMerge: (request: ProjectMergeMutationRequest) => ProjectMergeMutationResponse;
  // The destructive action's whole mechanic (map #124, ticket #132): tell the
  // hub to drop this machine's rows for `sessions`, then let the epoch bump's
  // existing unlink → rebuild → resync path rebuild the replica from the pruned
  // archive. It lives here because everything it needs already does — the hub
  // connection context, the replica, and the resync ORDER this module exists to
  // own. The caller (the route) owns only the guards.
  forget: (sessions: readonly ForgetSessionRef[]) => Promise<FleetForgetResult>;
  // Test-observability seam (ADR-0041, Task 12 convergence suite): the live
  // replica store, or null when detached (replica off / hub unconfigured). The
  // fleet fixed-point asserter reads `.all()` off it to compare the client's
  // verbatim mirror against the hub log. Read-only — callers MUST NOT mutate.
  getReplica: () => FleetEventStore | null;
  stop: () => Promise<void>;
};

function seedEqual(a: HubSeed, b: HubSeed): boolean {
  if (a === null || b === null) return a === b;
  return a.cursor === b.cursor && a.target === b.target;
}

export function createFleetSync(deps: FleetSyncDeps): FleetSync {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const debounceMs = deps.debounceMs ?? 500;
  const pokeMaxWaitMs = deps.pokeMaxWaitMs ?? 2_000;
  const directorySweepMs = deps.directorySweepMs ?? 300_000;
  const nowImpl = deps.nowImpl ?? (() => Date.now());
  const setTimeoutImpl =
    deps.setTimeoutImpl ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimeoutImpl =
    deps.clearTimeoutImpl ?? ((h: ReturnType<typeof setTimeout>) => clearTimeout(h));
  const setIntervalImpl =
    deps.setIntervalImpl ?? ((cb: () => void, ms: number): unknown => setInterval(cb, ms));
  const clearIntervalImpl =
    deps.clearIntervalImpl ??
    ((h: unknown): void => clearInterval(h as ReturnType<typeof setInterval>));

  // The disposable client-side machine directory. Loaded from disk NOW so names
  // render offline before any hub connect; refreshed on connect + every
  // hub:machines poke.
  const cache = createMachineDirectoryCache({ path: deps.directoryCachePath });
  cache.load();

  // The Identity directory (ADR-0062 §3): own probed rows + the mirrored fleet
  // union. Unlike the disposable cache above this is AUTHORITATIVE — a dead
  // directory's row is irreplaceable. Loaded now so identity() serves offline
  // and probes recorded before any connect land on a warm store.
  const identityStore = createIdentityDirectory({ path: deps.identityDirectoryPath });
  identityStore.load();
  // A load that could not reconstruct the union (unreadable file, or corrupt
  // content) leaves the store degraded for the WHOLE process — no caller
  // re-attempts the load, so identity is RAM-only until a restart. The store
  // already warns for itself, so this line is purely a second, fleet-prefixed
  // handle in sidecar.log (ADR-0056): "why is this machine's identity not
  // syncing" is a fleet question, and `[sidecar] fleet` is what an operator
  // greps for. LOG-ONLY on purpose — surfacing it on LiveStatus was weighed and
  // declined: it would put a fifth state on a UI that has no remedy to offer
  // beyond the restart this line already names.
  if (!identityStore.usable()) {
    console.warn(
      "[sidecar] fleet identity directory is degraded (load did not reconstruct the union) — identity stays RAM-only for this session; restart to recover",
    );
  }

  // The replica exists (attached) ⇔ fleetReplica AND hubConfigured. `conn` is
  // the live hub connection context (url + headers) used by the directory
  // refresh; null while disconnected.
  let replica: FleetEventStore | null = null;
  let conn: Conn | null = null;
  // Connection generation (event-sync's house pattern — see its `gen`): bumped
  // on BOTH connection edges, so every fleet-side request can ask whether its
  // answer still belongs to the connection that sent it. Without it a reply
  // that outlives its connection lands on the NEXT one's state — the identity
  // 404 latch being the sharp case (F16): onConnected clears the latch
  // precisely so an upgraded hub gets a fresh probe, and a stale 404 arriving a
  // moment later would re-latch it, silently disabling identity push and pull
  // against a hub that supports both.
  let connGen = 0;
  let shareEvents = deps.initial.shareEvents;
  let fleetReplica = deps.initial.fleetReplica;
  let hubConfigured = deps.initial.hubConfigured;

  const replicaWanted = (): boolean => fleetReplica && hubConfigured;
  // Creates the replica store, records it as the live one, AND returns the same
  // ref — callers operate on the returned ref across their awaits so a
  // concurrent detach (which nulls + wipes it) degrades to an empty `all()`
  // rather than a null deref.
  function attachReplica(): FleetEventStore {
    const store = createFleetEventStore({ path: deps.replicaPath, mode: "replica" });
    replica = store;
    return store;
  }

  // The transport-thin event-sync, created ONCE with accessor-based deps so a
  // store swap / replica re-attach is picked up live.
  const eventSync: EventSync = createEventSync({
    // RAW store rows (no per-push wire projection); event-sync stamp-filters
    // them and calls toWire only on the survivors it actually batches. Feeding
    // it the WHOLE store is correct without any provenance tracking because
    // replica-sourced rows in the engine are stamped by construction — the
    // replica holds each at exact token fullness, so the stamp predicate
    // filters them out of every push.
    localEvents: () => deps.getStore().query(),
    toWire: storedEventToWire,
    applyFleetRows: (rows) => deps.getStore().appendFleet(rows),
    replica: () => replica,
    onPagesApplied: (changed) => onPagesApplied(changed),
    onSeedProgress: (seed) => onSeedProgress(seed),
    onEpochMismatch: () => onEpochMismatch(),
    onDegraded: (d) => patchEventsDegraded(d),
    fetchImpl,
    setIntervalImpl: deps.setIntervalImpl,
    clearIntervalImpl: deps.clearIntervalImpl,
  });
  // event-sync defaults sharing ON; reflect the boot setting.
  eventSync.setShareEnabled(shareEvents);

  // ── Debounced renderer poke + hubSeed status (the 500 ms trailing debounce) ──
  // onPagesApplied/onSeedProgress accumulate; a single trailing flush emits AT
  // MOST one usage poke (accumulated engine-changed count) and one hubSeed
  // patch (only when it actually changed). Seed COMPLETION (null) flushes
  // immediately — the resting state must not linger a debounce behind the last
  // page. The rebuild poke (pokeNow) bypasses the debounce entirely.
  //
  // The debounce is CEILINGED (ADR-0055). A trailing-only debounce re-arms per
  // applied page, so a multi-page drain — a peer's first-ever push is its whole
  // corpus, tens of pages back to back — defers the ONE renderer poke for the
  // entire drain: the pull is working, the engine is filling, and the UI sits
  // frozen the whole time. Once the oldest pending frame is `pokeMaxWaitMs`
  // old, flush regardless of fresh arrivals. Exactly the ceiling the renderer's
  // own usage:new debounce already carries (USAGE_INVALIDATE_MAX_WAIT_MS in
  // apps/desktop/src/lib/live-stream.ts) — same defect, same remedy, one layer
  // down.
  let pokeTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingChanged = 0;
  let seedPending = false;
  let pendingSeed: HubSeed = null;
  // When the current pending batch's first frame landed — the maxWait clock.
  // Null whenever nothing is pending.
  let pendingSince: number | null = null;

  function clearPokeTimer(): void {
    if (pokeTimer !== null) {
      clearTimeoutImpl(pokeTimer);
      pokeTimer = null;
    }
  }
  function armDebounce(): void {
    pendingSince ??= nowImpl();
    if (nowImpl() - pendingSince >= pokeMaxWaitMs) {
      flush();
      return;
    }
    clearPokeTimer();
    pokeTimer = setTimeoutImpl(() => {
      pokeTimer = null;
      flush();
    }, debounceMs);
  }
  function flush(): void {
    clearPokeTimer();
    pendingSince = null;
    if (pendingChanged > 0) {
      deps.liveHub.emitUsage({
        project: "",
        sessionId: "",
        timestamp: new Date(nowImpl()).toISOString(),
        count: pendingChanged,
      });
      pendingChanged = 0;
    }
    if (seedPending) {
      if (!seedEqual(deps.liveHub.getStatus().hubSeed, pendingSeed)) {
        deps.liveHub.patchStatus({ hubSeed: pendingSeed });
      }
      seedPending = false;
      pendingSeed = null;
    }
  }
  function onPagesApplied(changed: number): void {
    if (changed <= 0) return; // a self-echo tie changes nothing — no poke
    pendingChanged += changed;
    armDebounce();
  }
  function onSeedProgress(seed: HubSeed): void {
    // Leading edge (M7): the FIRST progress frame of a seed flushes
    // immediately — on a fast drain the trailing debounce re-arms per pull
    // page and only the completion null would ever flush, so the percent
    // never showed (the M6 smoke's finding). Subsequent frames debounce as
    // before; completion stays immediate.
    const leading = seed !== null && !seedPending && deps.liveHub.getStatus().hubSeed === null;
    seedPending = true;
    pendingSeed = seed;
    if (seed === null || leading) flush();
    else armDebounce();
  }
  function pokeNow(): void {
    // A rebuild is a wholesale invalidation; reach the renderer immediately
    // (bypass the debounce). Any already-pending debounced poke that still fires
    // later is harmless — the renderer treats usage:new as a pure refetch
    // signal, so a redundant one just refetches.
    deps.liveHub.emitUsage({
      project: "",
      sessionId: "",
      timestamp: new Date(nowImpl()).toISOString(),
      count: 0,
    });
  }

  // ── In-session engine rebuild ──
  // Fresh store → local rescan (+ replica reseed rows when attached) → swap →
  // wholesale invalidation. Shared by the replica-off toggle and the epoch
  // resync. ACCEPTED RACE: a watcher flush landing on the OLD store between its
  // scan-read and the swap is lost until the next flush/rescan — the same class
  // as the existing scan/watcher overlap, self-healing.
  async function rebuildEngine(): Promise<void> {
    const fresh = deps.createStore();
    // Through the shared corpus-walk gate (ADR-0059). This walk is on a FRESH
    // store, so nothing scoped to a store instance could serialize it against
    // the boot / roots-change / rescan walks — yet it costs the single JS
    // thread exactly as much as they do.
    await scanGate.run(() => fresh.scan(deps.getRoots()));
    // The Local archive seeds BEFORE the replica (ADR-0069 §6): same rows either
    // way (the one merge rule dedups), but archive-first keeps the first-seen
    // tie order stable between a boot and a rebuild.
    deps.seedLocalArchive?.(fresh);
    if (replica !== null) fresh.appendFleet([...replica.all()]);
    deps.swapStore(fresh);
    pokeNow();
  }

  // ── Serialized reconcile chain ──
  // Toggle changes, the hub-configured gate, and the epoch resync all run
  // through ONE chain so they never overlap; a request landing mid-run coalesces
  // into a single follow-up that re-reads the toggle booleans fresh (last state
  // wins — the settings-watch do/while pattern).
  let reconcileChain: Promise<void> = Promise.resolve();
  let reconciling = false;
  let pendingReconcile = false;
  let pendingResync = false;

  function scheduleReconcile(): void {
    if (reconciling) {
      pendingReconcile = true;
      return;
    }
    reconciling = true;
    reconcileChain = reconcileChain
      .then(async () => {
        try {
          do {
            pendingReconcile = false;
            await reconcileOnce();
          } while (pendingReconcile);
        } finally {
          reconciling = false;
        }
      })
      // The chain must never reject — a void-ed rejection escalates to the
      // process unhandledRejection handler.
      .catch((err) => console.error("[sidecar] fleet reconcile failed:", err));
  }

  async function reconcileOnce(): Promise<void> {
    // 1. Replica lifecycle: bring the actual replica into line with the desired
    //    state (re-read fresh — last toggle state wins).
    const want = replicaWanted();
    if (want && replica === null) {
      // off→on: attach a fresh replica and reseed from 0 (an ordinary pull).
      const attached = attachReplica();
      await attached.load(); // self-heals a corrupt cache (Task 4)
      // Feed the engine from whatever the load RECOVERED, before kickPull — the
      // same second-feeder step loadReplicaAtBoot does (symmetry). A no-op on the
      // common empty-file case, but if a stale non-empty replica survived a boot
      // that saw hubConfigured=false (crash-during-clear / manual settings edit),
      // a same-epoch hub already at the replica's cursor serves a caught-up short
      // page that applies nothing — without this feed those on-disk rows would
      // never reach the engine (silent under-counting until restart).
      deps.getStore().appendFleet([...attached.all()]);
      eventSync.kickPull();
    } else if (!want && replica !== null) {
      // on→off: detach, unlink the cache, rebuild the engine local-only, and
      // rest the seed status at null immediately.
      const detached = replica;
      replica = null;
      await detached.unlink();
      seedPending = false;
      pendingSeed = null;
      await rebuildEngine();
      deps.liveHub.patchStatus({ hubSeed: null });
    }

    // 2. Epoch resync: unlink drops the cursor + stamps in one act, rebuild
    //    reseeds the engine, resync() drops the ack set and re-runs push +
    //    pull. When a concurrent replica-off / hub-unconfigure won the race,
    //    step 1 above already unlinked + rebuilt — skip only THAT half. But
    //    once pendingResync is consumed, resync() MUST run unconditionally:
    //    it is the ONLY thing that clears event-sync's mismatch suspension
    //    (connect/disconnect never touch suspendedForResync/mismatchSignaled),
    //    so dropping it would leave every push/pull trigger gated forever —
    //    contribute-only push silently dead and a later replica-on kickPull()
    //    inert until process restart. A resync with no replica is safe: it
    //    re-kicks the appropriately-gated loops (push resumes contribute-only;
    //    pull no-ops without a replica). And onEpochMismatch only fires with a
    //    replica attached at signal time, so a detached replica here means
    //    step 1's teardown already did the unlink + rebuild this resync needs.
    if (pendingResync) {
      pendingResync = false;
      if (replica !== null) {
        await replica.unlink();
        await rebuildEngine();
      }
      eventSync.resync();
    }
  }

  function onEpochMismatch(): void {
    // event-sync fired the ONE-SHOT mismatch signal and suspended every loop;
    // orchestrate unlink → rebuild → resync through the reconcile chain.
    pendingResync = true;
    scheduleReconcile();
  }

  // Drive the SAME unlink → rebuild → resync the epoch-mismatch path drives, and
  // await it (map #124, ticket #132).
  //
  // Awaited, unlike onEpochMismatch's fire-and-forget, because a user pressed a
  // button and the response is what tells them it happened. What the await
  // covers is exactly the local DELETE — unlink drops the replica file and RAM,
  // rebuildEngine re-reads local disk — and deliberately not the re-pull, which
  // `resync()` only kicks: that is an unbounded multi-page network drain, and
  // the response must not be hostage to it (ADR-0059's reasoning on the rescan's
  // fire-and-forget pull, for the same reason). So by the time the route
  // answers, the forgotten rows are gone from this machine; what refills behind
  // it is the pruned archive.
  //
  // Read `reconcileChain` AFTER scheduling: scheduleReconcile reassigns it, and
  // a request landing on an in-flight reconcile coalesces into that chain's
  // do/while rather than a new link — so the chain in hand covers our resync
  // either way.
  async function awaitResync(): Promise<void> {
    pendingResync = true;
    scheduleReconcile();
    await reconcileChain;
  }

  // Once the hub accepted a forget, the local resync is mandatory even if the
  // Local archive could not make the same deletion durable. Preserve that
  // ordering while returning the archive failure to the route instead of
  // falsely acknowledging success.
  async function forgetLocalArchiveThenResync(
    sessions: readonly ForgetSessionRef[],
  ): Promise<string | null> {
    let failure: string | null = null;
    try {
      await deps.forgetLocalArchive?.(sessions);
    } catch (err) {
      failure = `the local archive forget could not be made durable (${String(err)})`;
    }
    await awaitResync();
    return failure;
  }

  // An in-flight GUARD, deliberately not the self-chaining queue `clean` uses:
  // a queued second forget has nothing left to do, while running it anyway is
  // expensive and wrong. `deps.storage()` is single-flight, so two concurrent
  // requests classify against the SAME session list, and the hub's
  // `rewrite({ newEpoch: true })` mints a fresh epoch unconditionally — so the
  // duplicate matches zero rows and still costs the whole fleet a reseed. The
  // single-renderer path is already covered by the confirm dialog (disabled
  // while pending, no retry); this is defense-in-depth against a second renderer
  // instance (a dev Vite beside the packaged app), a direct authenticated
  // caller, or a future non-modal entry point.
  let forgetInflight: Promise<FleetForgetResult> | null = null;

  async function forget(sessions: readonly ForgetSessionRef[]): Promise<FleetForgetResult> {
    if (forgetInflight !== null) {
      return {
        ok: false,
        reason: "busy",
        detail: "a forget is already running on this machine",
        landed: false,
      };
    }
    forgetInflight = forgetInner(sessions);
    try {
      return await forgetInflight;
    } finally {
      forgetInflight = null;
    }
  }

  async function forgetInner(sessions: readonly ForgetSessionRef[]): Promise<FleetForgetResult> {
    if (sessions.length === 0) {
      return { ok: true, sessionsRequested: 0, sessionsMatched: 0, rowsRemoved: 0 };
    }
    if (conn === null || replica === null) {
      return {
        ok: false,
        reason: "unavailable",
        detail: conn === null ? "not connected to a hub" : "the fleet replica is not attached",
        landed: false,
      };
    }

    // BATCHED, not truncated. The hub caps a body at EVENT_FORGET_SESSIONS_MAX
    // pairs and 400s anything larger with nothing rewritten, precisely so a
    // caller's intent is never silently cut short (ADR-0063) — which means
    // sending only the first N here would commit the exact sin that cap exists
    // to prevent, and refusing outright would leave a machine that somehow
    // crossed it permanently unable to clean. The identity push already batches
    // for the same reason. Each batch is its own rewrite and its own epoch, and
    // that is fine: a forget is idempotent by construction (the second batch
    // names sessions the first did not), peers converge on the 5-min sweep
    // exactly as they do after a purge, and ONE local resync at the end covers
    // every epoch minted along the way. In practice this loops once — the
    // measured orphan set is 147 pairs against a 5000 cap.
    const myGen = connGen;
    let sessionsMatched = 0;
    let rowsRemoved = 0;
    let landed = false;
    // What the ARCHIVE has to drop (ADR-0069 §8) — the pairs whose batch the hub
    // actually applied, which on a partial run is a prefix of `sessions` rather
    // than the whole list. Accumulated at the 2xx, not at the receipt.
    const landedSessions: ForgetSessionRef[] = [];
    for (let i = 0; i < sessions.length; i += EVENT_FORGET_SESSIONS_MAX) {
      // Re-read the connection per batch, the pushIdentity rule: a disconnect
      // between requests must end the run rather than dial a superseded context.
      const c = conn;
      if (c === null || connGen !== myGen) {
        // Archive first, then the resync — the ordering rule the success path
        // below spells out (ADR-0069 §8) holds on every partial run too.
        let archiveFailure: string | null = null;
        if (landed) {
          archiveFailure = await forgetLocalArchiveThenResync(landedSessions);
        }
        return {
          ok: false,
          reason: archiveFailure === null ? "unavailable" : "failed",
          detail:
            archiveFailure === null
              ? "the hub connection dropped mid-forget"
              : `the hub connection dropped mid-forget; ${archiveFailure}`,
          landed,
        };
      }
      // Projected onto the declared pair, not passed through: the classifier's
      // `UnbackedSession` also carries a `rows` count, and `forgetSessionRefSchema`
      // is `.passthrough()` for forward compatibility rather than as an
      // invitation to send fields the contract does not name.
      const batch = sessions
        .slice(i, i + EVENT_FORGET_SESSIONS_MAX)
        .map(({ projectSlug, sessionId }) => ({ projectSlug, sessionId }));
      // A FRESH deadline per request — one budget stretched across N would abort
      // later batches for the sin of following earlier ones (pushIdentity's
      // reasoning, and the deadline catches a black-holed hub per-request).
      const deadline = requestDeadline();
      let failure: string | null = null;
      try {
        const res = await fetchImpl(`${c.url}/api/events/forget`, {
          method: "POST",
          headers: { ...c.headers, "content-type": "application/json" },
          body: JSON.stringify({ sessions: batch }),
          signal: deadline.signal,
        });
        if (res.status === 404) {
          // A hub that predates ADR-0063. Named rather than folded into the
          // generic rejection: it is the one failure with an action attached,
          // and it is permanent until the operator updates the hub.
          failure = "this hub is too old to forget rows — update the MaxPrice Hub app";
        } else if (!res.ok) {
          failure = `the hub rejected the request (${res.status})`;
        } else {
          // Marked landed the MOMENT the 2xx is observed, before a single byte of
          // the body is read. The rewrite has already HAPPENED by the time the hub
          // writes a receipt, so everything from here on is a receipt-read failure,
          // never a delete failure — including a body that makes `res.json()` throw
          // (malformed JSON, a socket dying mid-read), which would otherwise land in
          // the shared `catch` with the flag still false and skip the resync. The
          // dangerous outcome is a client that keeps serving rows the archive no
          // longer has.
          landed = true;
          // Same moment, same reason (ADR-0069 §8): this batch is gone from the
          // archive of record, so the local archive owes the same rewrite even
          // when the receipt read fails a line below.
          landedSessions.push(...batch);
          const parsed = hubEventsForgetResponseSchema.safeParse(await res.json());
          if (!parsed.success) {
            failure = "the hub's answer could not be read";
          } else {
            sessionsMatched += parsed.data.sessionsMatched;
            rowsRemoved += parsed.data.removed;
          }
        }
      } catch (err) {
        failure = String(err);
      } finally {
        deadline.clear();
      }
      if (failure !== null) {
        // Resync anyway when something landed: the hub has already minted a new
        // epoch, so a client that skipped this would sit on a mismatched replica
        // until its next pull noticed. Abandoning the remaining batches (rather
        // than retrying) is event-sync's posture throughout — and the user can
        // simply press the button again, which re-classifies from scratch.
        let archiveFailure: string | null = null;
        if (landed) {
          archiveFailure = await forgetLocalArchiveThenResync(landedSessions);
        }
        return {
          ok: false,
          reason: "failed",
          detail: archiveFailure === null ? failure : `${failure}; ${archiveFailure}`,
          landed,
        };
      }
    }

    // THE RESEED IS THE LOCAL DELETE (map #124). No tombstone file and no
    // separate local-durability problem: unlink drops the replica, the rebuild
    // re-reads local disk, and the re-pull refills from the pruned archive.
    //
    // And the Local archive must be pruned FIRST (ADR-0069 §8): awaitResync's
    // rebuildEngine re-seeds the engine from the archive, so a rewrite after it
    // would resurrect the rows the hub just dropped.
    //
    const archiveFailure = await forgetLocalArchiveThenResync(landedSessions);
    if (archiveFailure !== null) {
      return { ok: false, reason: "failed", detail: archiveFailure, landed: true };
    }
    return { ok: true, sessionsRequested: sessions.length, sessionsMatched, rowsRemoved };
  }

  // ── Serialized directory refresh ──
  // One GET /api/machines in flight, one pending. Failures warn-and-skip; only a
  // success updates the cache + broadcasts machines:changed.
  //
  // SWEPT while connected (ADR-0055). The refresh is otherwise edge-triggered
  // exactly like the event pull was — onConnected plus hub:machines pokes — and
  // warn-and-skip means a single failed GET strands the cached names until the
  // next rename or reconnect. Same defect class as the events bug, same remedy:
  // a periodic re-ask so a dropped edge can't be terminal. The serializer
  // collapses a sweep landing on an in-flight refresh, so it can never stack.
  //
  // Each successful sweep costs one cache write + one machines:changed poke
  // even when nothing changed, because it can't tell: the hub's rows carry
  // per-request join fields (`live`, `lastSeenAt`) that differ on every GET, so
  // there is no honest equality test to gate on. Deliberately accepted — it is
  // a ~1KB file rewrite and one loopback refetch per five minutes, and it is
  // exactly what every hub:machines poke already does.
  let directorySweep: unknown = null;

  // ── The shared refresh serializer + fetch ladder ──
  // The machine-directory pull and the identity pull (below) are the same
  // mechanism twice: one request in flight, one pending, warn-and-skip on every
  // failure, terminal action only on a completed schema-valid body. They lived
  // as near-verbatim copies; these two functions are the single copy. Identity
  // adds exactly two things on top — the replica/capability guard and the 404
  // latch — and differs only in URL, schema, and terminal action.

  // The serializer. Returns the TRIGGER: a call landing while a refresh is in
  // flight coalesces into exactly ONE follow-up pass (the settings-watch
  // do/while — last state wins), so a sweep can never stack on a poke.
  function createSerializedRefresh(
    label: string,
    once: (c: Conn, gen: number) => Promise<void>,
  ): RefreshTrigger {
    let chain: Promise<void> = Promise.resolve();
    let running = false;
    let pending = false;
    const trigger = (): void => {
      if (conn === null) return;
      if (running) {
        pending = true;
        return;
      }
      running = true;
      const myGen = connGen;
      chain = chain
        .then(async () => {
          try {
            do {
              pending = false;
              // Re-read the connection each pass: a disconnect landing mid-chain
              // ends the loop rather than dialing a superseded context, and a
              // reconnect leaves this body to the generation that queued it.
              const c = conn;
              if (c === null || connGen !== myGen) return;
              await once(c, myGen);
            } while (pending && conn !== null && connGen === myGen);
          } finally {
            // Only the body that still owns the current generation clears the
            // flags (event-sync's rule, same reason): a stale body — typically
            // one parked on a hung fetch — must not clobber the state the fresh
            // connection's reset() has already established.
            if (connGen === myGen) {
              running = false;
              pending = false;
            }
          }
        })
        // The chain must never reject — a void-ed rejection escalates to the
        // process unhandledRejection handler.
        .catch((err) => console.error(`[sidecar] fleet ${label} refresh failed:`, err));
    };
    // Force-reset, for a connection edge. Clearing the flags alone would NOT be
    // enough (F17): the real serializer is the promise CHAIN, so a `.then()`
    // appended while the previous body is parked on a black-holed fetch simply
    // never runs. The chain is dropped wholesale — the parked body is
    // gen-guarded at every resumption point, so abandoning it is safe.
    const reset = (): void => {
      running = false;
      pending = false;
      chain = Promise.resolve();
    };
    return Object.assign(trigger, { reset });
  }

  // The fetch ladder: GET → ok → json → schema, warning ONCE at whichever rung
  // fails and never handing the caller a partial result. `notFound` is reported
  // apart from `failed` because the two callers disagree about what a 404
  // MEANS: to identity it is a pre-identity hub (a capability latch), to the
  // directory it is just another rejection.
  async function fetchAndParse<T>(
    url: string,
    headers: Record<string, string>,
    schema: ZodType<T>,
    label: string,
  ): Promise<{ kind: "ok"; data: T } | { kind: "notFound" } | { kind: "failed" }> {
    // The deadline spans the body read too — a hub that answers its headers and
    // then stalls mid-stream parks the serializer exactly as a silent one does.
    const deadline = requestDeadline();
    try {
      let res: Response;
      try {
        res = await fetchImpl(url, { headers, signal: deadline.signal });
      } catch (err) {
        console.warn(`[sidecar] fleet ${label} refresh failed:`, err);
        return { kind: "failed" };
      }
      if (res.status === 404) return { kind: "notFound" };
      if (!res.ok) {
        console.warn(`[sidecar] fleet ${label} refresh rejected (${res.status})`);
        return { kind: "failed" };
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch (err) {
        console.warn(`[sidecar] fleet ${label} refresh read failed:`, err);
        return { kind: "failed" };
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        console.warn(`[sidecar] fleet ${label} refresh malformed`);
        return { kind: "failed" };
      }
      return { kind: "ok", data: parsed.data };
    } finally {
      deadline.clear();
    }
  }

  function clearDirectorySweep(): void {
    if (directorySweep !== null) {
      clearIntervalImpl(directorySweep);
      directorySweep = null;
    }
  }
  function armDirectorySweep(): void {
    clearDirectorySweep();
    // One interval, three refreshes: the identity pull rides the same 5-min
    // sweep (ADR-0062 §4 — there is no identity poke; the sweep is the
    // delivery guarantee for a peer's probe results), and so does the own-row
    // re-push: a failed push is warn-and-abandon and probe events are not
    // periodic, so without this floor one dropped POST left this machine's
    // rows out of the fleet union until reconnect — ADR-0055's defect class
    // on the push half, the same reason the event sweep pushes AND pulls. An
    // unchanged re-push is a no-op merge hub-side (newest-probedAt-wins).
    directorySweep = setIntervalImpl(() => {
      refreshDirectory();
      refreshIdentity();
      void pushIdentity();
    }, directorySweepMs);
  }

  const refreshDirectory = createSerializedRefresh("directory", refreshDirectoryOnce);

  async function refreshDirectoryOnce(c: Conn, myGen: number): Promise<void> {
    const out = await fetchAndParse(
      `${c.url}/api/machines`,
      c.headers,
      hubMachinesResponseSchema,
      "directory",
    );
    // A superseded connection's roster must not overwrite the live cache (nor
    // broadcast machines:changed for it) — the fresh connect already re-asked.
    if (connGen !== myGen) return;
    if (out.kind !== "ok") {
      // The directory has no capability latch, so a 404 is just another
      // rejection here — say so, exactly as the pre-extraction `!res.ok` arm
      // did (the identity half is the only caller for which 404 means more).
      if (out.kind === "notFound") console.warn("[sidecar] fleet directory refresh rejected (404)");
      return;
    }
    cache.update(out.data.machines);
    deps.emitMachinesChanged();
  }

  // ── Identity directory sync (ADR-0062 §4) ──
  // Push rides the shareEvents gate, pull rides the replica gate; the fold
  // itself is never gated (that lives renderer-side). Pull happens on connect,
  // on the rising replica edge, and on the directory sweep above — no
  // dedicated poke; push happens on connect, on probe change, on the rising
  // share edge, and on that same sweep (ADR-0055's retry floor — see
  // armDirectorySweep). A hub that predates the identity routes 404s: that
  // latches `identityUnsupported` for THIS connection only (an upgraded hub
  // gets a fresh probe on reconnect) — a silent skip, deliberately never
  // mirrored onto hubEventsDegraded, which is event-sync's capability verdict.
  let identityUnsupported = false;

  // The push is FULL-STATE by design (every own row, every time — the hub's
  // merge is newest-probedAt-wins, so a re-offer of unchanged rows is a no-op
  // there), and own rows only ever GROW: a dead directory's row is never pruned,
  // because it is exactly the history nothing can re-probe (ADR-0062 §3). So the
  // body is chunked at IDENTITY_PUSH_BATCH_MAX rather than posted whole — an
  // unchunked push crosses the wire schema's `.max(10_000)` on a long-lived
  // machine and the hub answers a schema miss with a flat 400, which for a
  // full-state push is PERMANENT: every subsequent attempt carries the same
  // over-cap body, so that machine's identity rows leave the fleet union for
  // good, silently.
  //
  // Splitting one push into N is semantically identical — the non-obvious part.
  // The hub's POST is a pure `mergeIdentityRows` upsert filtered to the caller's
  // machineId (apps/hub/src/server.ts): no whole-body replace, no purge
  // semantics, no ordering requirement, and per-row merge is commutative and
  // idempotent. N requests therefore reach the same union as one, and a run that
  // abandons half-way has simply delivered a prefix — which the next sweep
  // re-offers in full.
  async function pushIdentity(): Promise<void> {
    if (conn === null || !shareEvents || identityUnsupported) return;
    const ownRows = identityStore.ownRows(deps.machineId);
    const ownAssertions = identityStore.ownAssertions(deps.machineId);
    if (ownRows.length === 0 && ownAssertions.length === 0) return;
    const myGen = connGen;
    const batches: Array<{ rows?: ProjectIdentityRow[]; assertions?: ProjectMergeAssertion[] }> =
      [];
    for (let i = 0; i < ownRows.length; i += IDENTITY_PUSH_BATCH_MAX) {
      batches.push({ rows: ownRows.slice(i, i + IDENTITY_PUSH_BATCH_MAX) });
    }
    for (let i = 0; i < ownAssertions.length; i += IDENTITY_PUSH_BATCH_MAX) {
      batches.push({ assertions: ownAssertions.slice(i, i + IDENTITY_PUSH_BATCH_MAX) });
    }
    for (const batch of batches) {
      // Re-read the connection per batch: a disconnect landing between requests
      // must end the run rather than dial a superseded context (createSerializedRefresh's
      // rule, and the gen check below is why a late answer can't act either).
      const c = conn;
      if (c === null || connGen !== myGen) return;
      // A FRESH deadline per request — one 30s budget stretched across N
      // requests would abort later batches for the sin of following earlier
      // ones, and the deadline exists to catch a black-holed hub, which shows
      // up per-request.
      const deadline = requestDeadline();
      try {
        const res = await fetchImpl(`${c.url}${PROJECT_IDENTITY_PATH}`, {
          method: "POST",
          headers: { ...c.headers, "content-type": "application/json" },
          body: JSON.stringify(batch),
          signal: deadline.signal,
        });
        // Everything below belongs to the connection that ASKED (F16). A 404 from
        // a superseded hub would otherwise latch the capability flag that
        // onConnected has just cleared for the fresh one — and the whole point of
        // the per-connection reset is that an upgraded hub gets a fresh probe.
        if (connGen !== myGen) return;
        if (res.status === 404) {
          identityUnsupported = true; // pre-identity hub: silent, per-connection
          return;
        }
        if (!res.ok) {
          // ABANDON the whole run, warning once — no retry queue, exactly as
          // event-sync's runPushLoop does: the 5-min sweep's re-push is already
          // the ADR-0055 retry floor, and the remaining batches would almost
          // certainly meet the same rejection.
          //
          // Deliberately NOT a 4xx capability latch. Once the body is chunked
          // the size-cap 400 is unreachable, and the only other 4xx sources are
          // auth (the connection's own job — a 401 tears the connection down)
          // or a row the local prober cannot even produce. A latch would buy a
          // brand-new silent-disable failure mode in exchange for nothing.
          console.warn(`[sidecar] fleet identity push failed: ${res.status}`);
          return;
        }
        // The 2xx ack body ({merged}) counts ACCEPTED rows, not changed ones —
        // nothing to learn from it, so it is deliberately unread.
      } catch (err) {
        console.warn(`[sidecar] fleet identity push failed: ${String(err)}`);
        return;
      } finally {
        deadline.clear();
      }
    }
  }

  // Serialized like refreshDirectory above — the SAME serializer, so a sweep
  // landing on an in-flight pull can never stack.
  const refreshIdentity = createSerializedRefresh("identity", refreshIdentityOnce);

  async function refreshIdentityOnce(c: Conn, myGen: number): Promise<void> {
    // The two things identity adds to the shared ladder: the replica gate (the
    // pull is what feeds the mirror, so a replica-off client never asks) and
    // this connection's capability latch.
    if (!replicaWanted() || identityUnsupported) return;
    const out = await fetchAndParse(
      `${c.url}${PROJECT_IDENTITY_PATH}`,
      c.headers,
      hubProjectIdentityResponseSchema,
      "identity",
    );
    // One check covers both terminal acts (F16), because fetchAndParse's await
    // is the only suspension point between the request and either of them: a
    // superseded connection's 404 must not latch the fresh one, and a union
    // fetched from the OLD hub must not be adopted onto the new one's mirror —
    // adoptUnion is wholesale, so that would purge whatever the new hub knows.
    if (connGen !== myGen) return;
    if (out.kind === "notFound") {
      identityUnsupported = true; // pre-identity hub: silent, per-connection
      return;
    }
    if (out.kind === "failed") return;
    // An EMPTY union IS adopted, deliberately. It is tempting to refuse it —
    // `{rows: []}` from a hub that was reset or lost its data dir would purge
    // this client's mirror of every offline machine's irreplaceable rows — but
    // the same empty body is how an operator machine purge propagates: the
    // DELETE /api/machines/:id cascade empties the union, and clients dropping
    // those rows on the next pull is the purge working (ADR-0062 §4, pinned by
    // fleet-convergence's purge-propagation test). One wire signal, two
    // meanings, and refusing it silently breaks the operator-visible one. The
    // fix is to make the two distinguishable — a generation/epoch (the
    // fleet-events precedent) or an explicit purge marker — not to guess here.
    // adoptUnion ONLY here, on a completed, schema-valid union:
    // foreign rows mirror WHOLESALE, so anything less than that whole answer
    // reads as a purge — which is why every failure rung of the ladder above
    // returns `failed` WITHOUT reaching this line (#85's class, pinned by the
    // failure-ladder tests).
    if (identityStore.adoptUnion(out.data.rows, out.data.assertions ?? [], deps.machineId)) {
      deps.emitIdentityChanged();
    }
  }

  // ── FleetSync surface ──

  async function loadReplicaAtBoot(): Promise<void> {
    // Local disk only — part of engineReady, NEVER network. Not attached (the
    // toggle off OR the hub unconfigured) resolves immediately, so a hub-less
    // client is bit-for-bit the pre-hub app.
    if (!replicaWanted()) return;
    const attached = attachReplica();
    await attached.load(); // self-heals corruption (Task 4)
    // The engine's SECOND local feeder: seed it from the replica's holdings.
    deps.getStore().appendFleet([...attached.all()]);
  }

  function applySettings(s: { hubShareEvents: boolean; hubFleetReplica: boolean }): void {
    if (s.hubShareEvents !== shareEvents) {
      const rising = s.hubShareEvents && !shareEvents;
      shareEvents = s.hubShareEvents;
      eventSync.setShareEnabled(shareEvents);
      // A rising edge resumes pushing without waiting for the 5-min sweep.
      if (rising) {
        eventSync.notifyLocalChange();
        // Identity rows ride the same share gate (ADR-0062 §4): re-offer them.
        void pushIdentity();
      }
    }
    if (s.hubFleetReplica !== fleetReplica) {
      const rising = s.hubFleetReplica && !fleetReplica;
      fleetReplica = s.hubFleetReplica;
      scheduleReconcile();
      // A rising edge pulls the identity union now rather than a sweep later —
      // the same immediacy the reconcile's kickPull gives the event replica.
      if (rising) refreshIdentity();
    }
  }

  function onHubConfigured(configured: boolean): void {
    if (configured === hubConfigured) return;
    hubConfigured = configured;
    scheduleReconcile();
  }

  // Pre-event-sync degrade, display-only (ADR-0041 M6): mirror event-sync's own
  // degraded flag onto the loopback status so Settings can render the amber
  // "update MaxPrice Hub" line. Patched only on change — the hubSeed
  // no-gratuitous-frames rule. Cleared on disconnect: an unreachable hub is
  // hubConnection's story, not a capability verdict.
  function patchEventsDegraded(next: boolean): void {
    if ((deps.liveHub.getStatus().hubEventsDegraded ?? false) !== next) {
      deps.liveHub.patchStatus({ hubEventsDegraded: next });
    }
  }

  // Both refresh serializers, force-reset — run on BOTH connection edges. F17:
  // an identity GET that never settled used to leave `identityRefreshing`
  // latched true forever, because nothing cleared it (onDisconnected did not
  // touch it, and onConnected only re-called the trigger, which then took the
  // "already refreshing" branch) — so one black-holed fetch silently ended this
  // client's identity pulls until the app restarted. The directory half carried
  // the identical wedge; since the extraction they share the remedy too.
  function resetRefreshSerializers(): void {
    refreshDirectory.reset();
    refreshIdentity.reset();
  }

  const hooks: HubFleetHooks = {
    onConnected: (ctx) => {
      connGen += 1;
      conn = { url: ctx.url, headers: ctx.headers };
      resetRefreshSerializers();
      refreshDirectory();
      armDirectorySweep();
      // Identity (ADR-0062): a NEW connection gets a fresh capability probe —
      // the 404 latch is per-connection, so an upgraded hub is noticed here.
      // Then push own rows and assertions (share-gated) and pull the union
      // (replica-gated).
      identityUnsupported = false;
      void pushIdentity();
      refreshIdentity();
      // event-sync mirrors its capability verdict through onDegraded — the
      // synchronous connect verdict AND any later 404 latch (M7) both land on
      // the loopback status without waiting for a reconnect cycle.
      eventSync.connect({ url: ctx.url, headers: ctx.headers, events: ctx.events });
    },
    onDisconnected: () => {
      // Idempotent: the hub-client may fire a leading onDisconnected on configure
      // and repeat it on every retry flap.
      connGen += 1;
      conn = null;
      resetRefreshSerializers();
      clearDirectorySweep();
      eventSync.disconnect();
      // A disconnect landing MID-SEED must not strand a stuck "syncing N%" on the
      // status snapshot (M6 renders hubSeed). Clear the fleet-side display
      // accumulation and rest hubSeed at null — but only when a seed is actually
      // armed or showing, so the common already-null path emits no gratuitous
      // status frame. event-sync's OWN sticky `seeding` flag is deliberately
      // untouched: on reconnect the seed resumes and hubSeed repopulates from the
      // next onSeedProgress.
      const seedShowingOrArmed = seedPending || deps.liveHub.getStatus().hubSeed !== null;
      seedPending = false;
      pendingSeed = null;
      if (seedShowingOrArmed) deps.liveHub.patchStatus({ hubSeed: null });
      // A down hub is hubConnection's story, not a capability verdict — clear the
      // degrade so the amber "update the hub" line can't claim it while offline.
      patchEventsDegraded(false);
    },
    onEventsPoke: (seq) => eventSync.onEventsPoke(seq),
    onStatusEvents: (events) => eventSync.onStatusEvents(events),
    onMachinesPoke: () => refreshDirectory(),
  };

  return {
    hooks,
    loadReplicaAtBoot,
    applySettings,
    onHubConfigured,
    notifyLocalChange: () => eventSync.notifyLocalChange(),
    kickPull: () => eventSync.kickPull(),
    machines: () => ({ self: deps.machineId, machines: cache.list() }),
    // ADR-0062: Task 7's prober lands stamped rows here. A change is a local
    // truth worth announcing (identity:changed) and offering up (share-gated).
    // Every SUCCESSFUL probe re-stamps probedAt (ADR-0062 §2), so each probe
    // EVENT — boot, manual rescan, new-slug sighting — persists + emits +
    // pushes even when the probed RESULT is unchanged; probe events are not
    // periodic, though, so the sweep's re-push, not this path, is the
    // ADR-0055 retry floor between them.
    recordProbes: (rows) => {
      if (identityStore.upsert(rows)) {
        deps.emitIdentityChanged();
        void pushIdentity();
      }
    },
    identity: () => ({
      self: deps.machineId,
      rows: identityStore.list(),
      assertions: identityStore.listAssertions(),
    }),
    setProjectMerge: (request) => {
      if (request.target?.anchor === request.source.anchor) {
        throw new Error("a project cannot be merged into itself");
      }

      const automatic = buildAutomaticProjectIdentity(identityStore.list(), deps.machineId);
      const automaticKeyOf = (slug: string): string => automatic.keyBySlug.get(slug) ?? slug;
      const sourceKey = automaticKeyOf(request.source.anchor);

      // Make this author's new statement the newest for its resolved source
      // group even when the wall clock moved backwards. Automatic identity may
      // have joined several source anchors, and resolution elects one LWW
      // statement across that whole group.
      let updatedAtMs = nowImpl();
      for (const current of identityStore.listAssertions()) {
        if (automaticKeyOf(current.source.anchor) === sourceKey) {
          updatedAtMs = Math.max(updatedAtMs, Date.parse(current.updatedAt) + 1);
        }
      }
      const assertion: ProjectMergeAssertion = {
        authorMachineId: deps.machineId,
        source: request.source,
        target: request.target,
        updatedAt: new Date(updatedAtMs).toISOString(),
      };

      if (assertion.target !== null) {
        const resolved = resolveProjectMergeAssertions(
          [...identityStore.listAssertions(), assertion],
          automaticKeyOf,
        );
        const key = projectMergeAssertionKey(assertion);
        if (
          resolved.conflicts.some(
            (entry) =>
              projectMergeAssertionKey(entry.assertion) === key &&
              entry.assertion.updatedAt === assertion.updatedAt,
          )
        ) {
          throw new Error("project merge would create an identity cycle");
        }
      }

      identityStore.commitAssertion(assertion);
      deps.emitIdentityChanged();
      void pushIdentity();
      return { assertion };
    },
    forget,
    getReplica: () => replica,
    stop: async () => {
      clearPokeTimer();
      pendingSince = null;
      clearDirectorySweep();
      await eventSync.stop();
      await replica?.close();
    },
  };
}
