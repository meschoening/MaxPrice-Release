import { join, dirname } from "node:path";
import {
  createForgetIntent,
  forgetIntentMode,
  type FleetForgetIntent,
  type FleetForgetMode,
} from "./fleet-forget-intent";
import {
  createEventSync,
  fleetTokenTotal,
  createFleetEventStore,
  createIdentityDirectory,
  type EventSync,
  type FleetReplicaStore,
  type HubFleetHooks,
} from "@maxprice/usage-core";
import {
  EVENT_FORGET_SESSIONS_MAX,
  HUB_ORGANIZATIONS_PATH,
  IDENTITY_PUSH_BATCH_MAX,
  ORGANIZATION_ASSERTION_DIRECTORY_PATH,
  ORGANIZATION_DIRECTORY_PATH,
  PROJECT_IDENTITY_PATH,
  buildAutomaticProjectIdentity,
  hubEventsForgetResponseSchema,
  hubStatusSchema,
  hubMachinesResponseSchema,
  hubOrganizationAssertionDirectorySchema,
  hubOrganizationDirectorySchema,
  hubOrganizationsResponseSchema,
  hubProjectIdentityResponseSchema,
  projectMergeAssertionKey,
  resolveProjectMergeAssertions,
  type ForgetSessionRef,
  type HubMachine,
  type OrganizationAssertionEntry,
  type OrganizationLabelEntry,
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
import { publishedHomes, samePublishedHomes } from "./engine/presumption";
import { scanGate } from "./scan-gate";
import { storedEventToWire } from "./stored-event-wire";
import type { EventStore, LocalAppend, StoredEvent } from "./engine/store";
import type { LiveHub } from "./live-hub";
import type { OrganizationAssertions } from "./organization-assertions";
import type { OrganizationLabels } from "./organization-labels";
import type { LearnedOrg } from "./organizations";

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
// section below. #288 adds the Organization directory's (ADR-0105 §8), which
// rides neither gate — see its section. #310 adds the Organization assertion
// directory's (ADR-0107 §11), which rides neither gate either — see its section.
// #366 adds the Organization roster pull, gated on neither as well.

// { cursor, target } | null — the seed-progress shape on the status snapshot.
type HubSeed = StatusSnapshot["hubSeed"];

// The live hub connection context — everything a fleet-side request needs to
// dial the hub. Null whenever disconnected.
type Conn = { url: string; headers: Record<string, string> };

// A serialized refresh's trigger, plus the force-reset a connection edge needs.
type RefreshTrigger = { (): void; reset: () => void };

// The label store as the Organization directory sync sees it (#288): what to
// push, and where to adopt the union. `ready` is main()'s `labelsReady` —
// nothing is pushed or adopted before the store has loaded, because the load
// would overwrite an entry adopted ahead of it.
type FleetOrganizationLabels = {
  ready: Promise<void>;
  entries: () => ReadonlyMap<string, Readonly<OrganizationLabelEntry>>;
  merge: OrganizationLabels["merge"];
};

// The assertion store as the Organization assertion directory sync sees it
// (#310) — the label store's shape above, for the same reason: `ready` is
// main()'s `assertionsReady`, and nothing is pushed or adopted before it.
type FleetOrganizationAssertions = {
  ready: Promise<void>;
  entries: () => ReadonlyMap<string, Readonly<OrganizationAssertionEntry>>;
  merge: OrganizationAssertions["merge"];
};

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
  replicaPath: string; // <app-data>/fleet-events.sqlite
  directoryCachePath: string; // <app-data>/machine-directory.json
  identityDirectoryPath: string; // <app-data>/identity-directory.json (ADR-0062)
  liveHub: Pick<LiveHub, "patchStatus" | "emitUsage" | "getStatus">;
  getStore: () => EventStore;
  // The private first-launch selection must settle before any outward feeder.
  ingestionReady?: Promise<void>;
  swapStore: (next: EventStore) => void; // main()'s storeRef assignment
  createStore: () => EventStore; // () => createEventStore({ selfMachineId: machineId })
  // The Local archive's engine feeder (ADR-0069): rebuildEngine seeds every
  // fresh store from it, exactly as it seeds from the replica — without this, a
  // replica-off toggle or an epoch resync would rebuild an engine that forgot
  // everything the corpus no longer backs. It reads SQLite in chunks that await
  // between them (ADR-0111 §3).
  seedLocalArchive?: (store: EventStore) => Promise<void>;
  // A user Forget's propagation (ADR-0069 §8): delete from the local archive
  // the sessions whose hub batches LANDED, before the forget takes the pairs'
  // own rows out of the engine — otherwise the archive, which every rebuild and
  // `prepareContributions` seed from, puts the forgotten rows back.
  forgetLocalArchive?: (sessions: readonly ForgetSessionRef[]) => Promise<void>;
  // The evidence repair's propagation (#375, `repairOrganizations`): drop only
  // those sessions' rows whose key the live store excludes, barring nothing, so
  // their admitted rows stay archived. Never the pair-wide forget above: absent,
  // as in a rig that wires no archive, the repair's local half does nothing.
  forgetExcludedFromLocalArchive?: (sessions: readonly ForgetSessionRef[]) => Promise<void>;
  // main()'s half of the presumption cell (`withPublishedHomes`, #281): the
  // machineId -> published Home map the Machine directory implies. The fleet
  // owns the directory, so it builds the map and decides when it CHANGED; the
  // report cache sees the swap by identity (ADR-0057's rebind trigger), and the
  // fleet's own `pokeNow` is the wholesale invalidation that follows it.
  installPublishedHomes?: (homes: ReadonlyMap<string, string>) => void;
  // The user's renames, synced with the Hub's Organization directory (#288).
  // Absent — a rig that wires no label store — and the fleet neither pushes
  // nor pulls them.
  organizationLabels?: FleetOrganizationLabels;
  // The user's Organization assertions, synced with the Hub's Organization
  // assertion directory (#310). Absent — a rig that wires no assertion store —
  // and the fleet neither pushes nor pulls them.
  organizationAssertions?: FleetOrganizationAssertions;
  // main()'s assertion writer (#310): called after an adoption that changed
  // some session's resolved Organization, BEFORE the fleet's own wholesale
  // invalidation, so every renderer's refetch already sees the new claims.
  assertionsAdopted?: () => void;
  // #366: the Hub's roster, learned into this machine's Organization registry
  // so Settings lists every Organization the Hub's key can see. Absent — a rig
  // that wires no registry — and the fleet never pulls it. Resolves true when
  // the registry changed.
  learnOrganizations?: (orgs: readonly LearnedOrg[]) => Promise<boolean>;
  getRoots: () => string[];
  emitMachinesChanged: () => void; // liveHub broadcast of SSE_EVENT.machinesChanged
  emitIdentityChanged: () => void; // liveHub broadcast of SSE_EVENT.identityChanged (ADR-0062)
  emitOrganizationsChanged?: () => void; // liveHub broadcast of SSE_EVENT.organizationsChanged (#288)
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
  | {
      ok: false;
      reason: "unavailable" | "failed" | "busy";
      detail: string;
      landed: boolean;
      retryable?: boolean;
    };

export type FleetSync = {
  hooks: HubFleetHooks; // hand to createHubClient({ fleet: ... })
  // During an automatic epoch reseed, reports keep their populated view while
  // ingestion and push acknowledgements use the rebuilding engine.
  reportStore: () => EventStore;
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
  // A durable action receipt joins Hub deletion, Local archive pruning, and
  // replica reconciliation. Retries complete the same action (ADR-0100). The
  // pruning is pair-wide and bars the pairs (ADR-0069 §8).
  forget: (sessions: readonly ForgetSessionRef[]) => Promise<FleetForgetResult>;
  // The Organization repair's forget, against its own Hub target. On the Hub it
  // is `forget`'s pair-wide deletion; its Local archive half is key-scoped
  // (#375): only the pairs' rows whose key the live store excludes go, their
  // admitted rows stay, and no pair joins the archive's `forgottenPairs`. With
  // `keepLocalArchive` (#311, ADR-0107 §12) it is lossless: the same Hub
  // deletion, replica removal and resync, but no Local archive rewrite at all.
  // Neither takes a row out of the engine (#378), where `forget` does.
  // The durable intent records the mode, so a resumed forget completes in its
  // own mode, and while one is pending a caller of any other mode is refused
  // as `busy`.
  repairOrganizations: (
    sessions: readonly ForgetSessionRef[],
    target: string,
    opts?: { keepLocalArchive?: boolean },
  ) => Promise<FleetForgetResult>;
  // ADR-0098: a full engine rebuild (fresh store → walk → archive + replica
  // seed → swap) WITHOUT unlinking the replica — for a tracked-set change and
  // the repair, where the replica is still valid but the engine's verdicts are
  // not. Serialized through the reconcile chain like everything that swaps the
  // store; resolves once the swap has happened.
  //
  // `keepRetainedView` (#276) leaves a retained report view (ADR-0099)
  // published across the walk — still showing the pre-change picture, which an
  // ADDITIVE tracked-set change leaves correct-but-incomplete rather than
  // wrong. Only such a change may ask for it — see `requestRebuild`.
  rebuildEngine: (opts?: { keepRetainedView?: boolean }) => Promise<void>;
  // Release without starting a walk; settings edits may be queued elsewhere.
  releaseRetainedView: () => void;
  // "Tell every renderer to refetch", and nothing else (#277, D8): no rebuild,
  // no store swap, no release of a retained report view. A Home organization
  // change that leaves the tracked set alone moves no row and re-walks nothing
  // — it only re-answers the Presumed organization at query time — so this poke
  // IS the whole effect. Exposed here rather than rebuilt at the call site so
  // there stays exactly one definition of the wholesale invalidation.
  invalidateReports: () => void;
  // The Home this process runs under (#281), published to the Hub's Machine
  // directory so every peer presumes this machine's owner-less rows under it.
  // Publishing starts only once this has been called; an unchanged value is a
  // no-op, and a value set while disconnected is published on the next connect.
  setHome: (home: string | null) => void;
  // A local rename wrote (#288): push the label map to the Hub's Organization
  // directory. A no-op while disconnected — the next connect pushes anyway.
  organizationLabelsChanged: () => void;
  // A local assertion edit wrote (#310): push the assertion map to the Hub's
  // Organization assertion directory. A no-op while disconnected — the next
  // connect pushes anyway.
  organizationAssertionsChanged: () => void;
  // The live replica store, or null when detached (replica off / hub
  // unconfigured). Settings › Storage reads its records; the fleet fixed-point
  // asserter (ADR-0041, Task 12 convergence suite) reads its rows to compare
  // the client's verbatim mirror against the hub log. Read-only — callers MUST
  // NOT mutate.
  getReplica: () => FleetReplicaStore | null;
  mayArchiveFleet: (row: StoredEvent) => boolean;
  stop: () => Promise<void>;
};

function seedEqual(a: HubSeed, b: HubSeed): boolean {
  if (a === null || b === null) return a === b;
  return a.cursor === b.cursor && a.target === b.target;
}

export function createFleetSync(deps: FleetSyncDeps): FleetSync {
  let ingestible = deps.ingestionReady === undefined;
  void deps.ingestionReady
    ?.then(() => {
      ingestible = true;
    })
    .catch(() => {});
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

  // The published Homes last handed to main() (#281). Starts as the empty map,
  // which is exactly what main()'s initial presumption carries.
  let installedHomes: ReadonlyMap<string, string> = publishedHomes([], deps.machineId);
  // Hand main() the presumption map a directory list implies — only when it
  // CHANGED. Every GET carries fresh `live`/`lastSeenAt` join fields, so an
  // unconditional install would mint a new presumption identity, and clear
  // every report cache in the fleet, on every 5-minute sweep.
  function adoptPublishedHomes(machines: readonly HubMachine[], poke: boolean): void {
    const next = publishedHomes(machines, deps.machineId);
    if (samePublishedHomes(installedHomes, next)) return;
    installedHomes = next;
    deps.installPublishedHomes?.(next);
    if (poke) pokeNow();
  }
  // Boot: the persisted directory presumes peers offline, before any connect.
  // No poke — there is no renderer yet to tell.
  adoptPublishedHomes(cache.list(), false);

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
  let replica: FleetReplicaStore | null = null;
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

  const forgetIntent = createForgetIntent(join(dirname(deps.replicaPath), "fleet-forget.json"));
  const replicaWanted = (): boolean => fleetReplica && hubConfigured;
  let retainedReportStore: EventStore | null = null;
  let detachReportRelay: (() => void) | null = null;
  // The fresh store a rebuild is reading the replica into, until it is swapped
  // in. The read awaits between chunks (ADR-0111 §3), so the pull can commit
  // a change after a chunk that held its row; the pull's feed reaches this
  // store too, as it reaches the live one.
  let seedingStore: EventStore | null = null;
  let seedingForgetPairs: ForgetSessionRef[] | null = null;

  function releaseReportStore(): void {
    detachReportRelay?.();
    detachReportRelay = null;
    retainedReportStore = null;
  }

  function relayLocalReports(store: EventStore): void {
    detachReportRelay?.();
    detachReportRelay = null;
    const retained = retainedReportStore;
    if (retained === null || retained === store) return;
    detachReportRelay = store.onLocalAppend(({ records, projectSlug, sessionId, isSubagent }) => {
      retained.append(records, projectSlug, sessionId, isSubagent);
    });
  }
  // Creates the replica store, records it as the live one, AND returns the same
  // ref — callers operate on the returned ref across their awaits so a
  // concurrent detach (which nulls + wipes it) ends a read at its next chunk
  // rather than a null deref.
  function attachReplica(): FleetReplicaStore {
    const store = createFleetEventStore({ path: deps.replicaPath, mode: "replica" });
    replica = store;
    return store;
  }

  // The transport-thin event-sync, created ONCE with accessor-based deps so a
  // store swap / replica re-attach is picked up live.
  const eventSync: EventSync = createEventSync({
    // Upload only independent sources; neither merged reports nor a stale
    // replica can establish source eligibility after a deletion (ADR-0100).
    localEvents: () => {
      if (!ingestible || forgetIntent.error() !== null) return [];
      const blocked = new Set(
        forgetIntent
          .read()
          ?.batches.flatMap((batch) =>
            batch.sessions.map((s) => JSON.stringify([s.projectSlug, s.sessionId])),
          ) ?? [],
      );
      const rows = deps.getStore().contributions();
      // Nothing pending is the usual case: skip a key built per row per push (#361).
      if (blocked.size === 0) return rows;
      return rows.filter((row) => !blocked.has(JSON.stringify([row.projectSlug, row.sessionId])));
    },
    prepareContributions: async () => {
      await deps.ingestionReady;
      const current = deps.getStore();
      await current.ready;
      const fresh = deps.createStore();
      const batches: LocalAppend[] = [];
      const detach = current.onLocalAppend((batch) => batches.push(batch));
      try {
        await scanGate.run(() => fresh.scan(deps.getRoots()));
        let replayed = 0;
        const replay = (): void => {
          for (; replayed < batches.length; replayed++) {
            const batch = batches[replayed]!;
            fresh.append(batch.records, batch.projectSlug, batch.sessionId, batch.isSubagent);
          }
        };
        replay();
        await deps.seedLocalArchive?.(fresh);
        // The archive's read awaits between chunks (ADR-0111 §3), and a watcher
        // flush that lands meanwhile is already in `current`'s contributions:
        // replay it too, or the replacement below would drop it.
        replay();
        if (current === deps.getStore()) {
          current.replaceContributions(fresh.contributions());
          current.appendFleet(
            fresh
              .contributions()
              .map((row) => ({ ...storedEventToWire(row), machineId: row.machineId, seq: 0 })),
          );
        }
      } finally {
        detach();
      }
    },
    applyFleetDeletes: async (rows, mayApply) => {
      await deps.ingestionReady;
      await deps.getStore().ready;
      if (!mayApply()) return;
      deps.getStore().removeFleetKeys(rows);
      retainedReportStore?.removeFleetKeys(rows);
      seedingStore?.removeFleetKeys(rows);
    },
    toWire: storedEventToWire,
    applyFleetRows: async (rows, mayApply) => {
      // ADR-0098: seed after the walk — see loadReplicaAtBoot.
      await deps.ingestionReady;
      await deps.getStore().ready;
      if (!mayApply()) return 0;
      const changed = deps.getStore().appendFleet(rows);
      // New remote usage remains live too; old rows disappear only when the
      // replacement has proved complete. This view NEVER feeds a push.
      retainedReportStore?.appendFleet(rows);
      seedingStore?.appendFleet(rows);
      return changed;
    },
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
    if (seed === null && retainedReportStore !== null) {
      releaseReportStore();
      // Even an empty replacement must remove the old rows from every report.
      pokeNow();
    }
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
  // resync. Capture local batches across the walk, including duplicates and
  // foreign evidence, so the swap cannot lose a watcher flush after scan-read.
  async function rebuildEngine(): Promise<void> {
    const fresh = deps.createStore();
    const appended: LocalAppend[] = [];
    const detach = deps.getStore().onLocalAppend((batch) => appended.push(batch));
    // Through the shared corpus-walk gate (ADR-0059). This walk is on a FRESH
    // store, so nothing scoped to a store instance could serialize it against
    // the boot / roots-change / rescan walks — yet it costs the single JS
    // thread exactly as much as they do.
    try {
      await scanGate.run(() => fresh.scan(deps.getRoots()));
      let replayed = 0;
      const replay = (): void => {
        for (; replayed < appended.length; replayed++) {
          const { records, projectSlug, sessionId, isSubagent } = appended[replayed]!;
          fresh.append(records, projectSlug, sessionId, isSubagent);
        }
      };
      replay();
      // The Local archive seeds BEFORE the replica (ADR-0069 §6): same rows either
      // way (the one merge rule dedups), but archive-first keeps the first-seen
      // tie order stable between a boot and a rebuild. Its read awaits between
      // chunks (ADR-0111 §3); an archive push committed meanwhile takes a later
      // seq, which a later chunk reads.
      await deps.seedLocalArchive?.(fresh);
      // The replica's rows, read from SQLite a chunk at a time (ADR-0111 §3).
      // Until the swap, the pull's feed reaches `fresh` as well, so a change
      // committed after the chunk that held its row is applied to it in order.
      const source = replica;
      const forgottenWhileSeeding: ForgetSessionRef[] = [];
      if (source !== null) {
        seedingStore = fresh;
        seedingForgetPairs = forgottenWhileSeeding;
        try {
          await source.readRows((rows) => fresh.appendFleet(rows));
        } finally {
          seedingStore = null;
          seedingForgetPairs = null;
        }
      }
      // A watcher flush can land while the read awaits: replay it too, after
      // the replica's rows, as the live store took it.
      replay();
      if (forgottenWhileSeeding.length > 0) {
        // The pair prune also removed scanned contributions. A completed
        // deletion-fence preparation may have re-walked surviving transcripts
        // into the live contribution view meanwhile. Keep those eligible
        // sources, without restoring any archived-only row from the old seed.
        const pairs = new Set(
          forgottenWhileSeeding.map((s) => JSON.stringify([s.projectSlug, s.sessionId])),
        );
        fresh.appendFleet(
          deps
            .getStore()
            .contributions()
            .filter((row) => pairs.has(JSON.stringify([row.projectSlug, row.sessionId])))
            .map((row) => ({ ...storedEventToWire(row), machineId: row.machineId, seq: 0 })),
          "archive",
        );
      }
      deps.swapStore(fresh);
      relayLocalReports(fresh);
      // A known forget prunes its session from the retained view immediately;
      // restore any home rows still backed by local transcripts/archive, just
      // as the ordinary rebuild does (mixed-organization sessions included).
      retainedReportStore?.appendFleet(
        fresh
          .query()
          .map((row) => ({ ...storedEventToWire(row), machineId: row.machineId, seq: 0 })),
      );
    } finally {
      detach();
    }
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
  let pendingRebuild = false;
  // Whether the coalesced rebuild requests want the retained report view
  // released. RELEASE WINS (#276): a keep is only sound for the change that
  // asked for it, so one request that did not ask decides for all of them.
  let pendingRelease = false;

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
    await deps.ingestionReady;
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
      // a same-epoch Hub already at the replica's cursor serves a complete change
      // page that applies nothing — without this feed those on-disk rows would
      // never reach the engine (silent under-counting until restart).
      // ADR-0098: seed after the walk — see loadReplicaAtBoot. The rows are
      // read from SQLite a chunk at a time (ADR-0111 §3), each into the live
      // store, which the pull's feed also reaches, so a change committed
      // between two chunks lands after the chunk that held its row.
      await deps.getStore().ready;
      await attached.readRows((rows) => deps.getStore().appendFleet(rows));
      eventSync.kickPull();
    } else if (!want && replica !== null) {
      // on→off: detach, unlink the cache, rebuild the engine local-only, and
      // rest the seed status at null immediately.
      const detached = replica;
      replica = null;
      releaseReportStore();
      await detached.discard();
      seedPending = false;
      pendingSeed = null;
      await rebuildEngine();
      deps.liveHub.patchStatus({ hubSeed: null });
    }

    // 2. Epoch resync: drop the replica if present, rebuild from local
    // transcripts and the pruned archive, then reset push acknowledgements.
    // A contribute-only organization repair still needs BOTH the rebuild and
    // the acknowledgement reset to restore a mixed session's home rows.
    // resync also clears event-sync's mismatch suspension even when a toggle
    // detached the replica while this operation was queued.
    if (pendingResync) {
      eventSync.suspend();
      pendingResync = false;
      // A rebuild request that coalesced into this resync releases the view,
      // whichever it asked for (#277, and #276's keep with it): retention here
      // is the RESYNC's, and a release is never wrong — it costs the reseed's
      // continuity and nothing else.
      // A known forget already pruned its sessions; keep all unrelated reports.
      if (replica !== null && !pendingRebuild) {
        retainedReportStore ??= deps.getStore();
      } else {
        releaseReportStore();
      }
      pendingRebuild = false; // a resync rebuilds anyway
      pendingRelease = false; // …and has just decided the view itself
      if (replica !== null) await replica.unlink();
      await rebuildEngine();
      eventSync.resync();
    } else if (pendingRebuild) {
      pendingRebuild = false;
      if (pendingRelease) releaseReportStore();
      pendingRelease = false;
      await rebuildEngine();
    }
  }

  function onEpochMismatch(): void {
    // event-sync fired the ONE-SHOT mismatch signal and suspended every loop;
    // orchestrate unlink → rebuild → resync through the reconcile chain.
    pendingResync = true;
    scheduleReconcile();
  }

  // Run the rebuild through the reconcile chain, without unlinking the
  // replica, and await it (ADR-0098): a Tracked organization change and the
  // Organization repair redo the engine's verdicts over a replica that is
  // still valid. A user's Forget never comes here; it deletes incrementally
  // and leaves the engine in place (ADR-0100, #378).
  //
  // Awaited, unlike onEpochMismatch's fire-and-forget, because the caller's
  // next step reads the rebuilt store. What the await covers is the local
  // rebuild — the walk, the archive and replica seeds, the swap — and nothing
  // on the network.
  //
  // Read `reconcileChain` AFTER scheduling: scheduleReconcile reassigns it, and
  // a request landing on an in-flight reconcile coalesces into that chain's
  // do/while rather than a new link — so the chain in hand covers our rebuild
  // either way.
  async function requestRebuild(opts?: { keepRetainedView?: boolean }): Promise<void> {
    const keep = opts?.keepRetainedView === true;
    // A RESTRICTIVE tracked-set change must never retain the preceding set's
    // view: those rows were admitted under the exclusion rule this rebuild is
    // replacing (#277, D8), so they must stop being reported AT REQUEST TIME —
    // not when the reconcile chain gets round to it, which on an in-flight
    // reseed is the only moment a retained view exists at all.
    //
    // An ADDITIVE one may keep it (#276). NOT because the view picks the new
    // rows up — it cannot: `appendFleet` refuses any row whose key that store's
    // own walk excluded, which is exactly the newly tracked Organization's.
    // Because every row it DOES hold was admitted under a SUBSET of the new
    // set, so nothing it shows is wrong, only incomplete until the reseed
    // releases it and reports fall through to the live store. The alternative
    // is dropping to a half-seeded store mid-reseed, which is worse.
    //
    // A Home change that leaves the set identical never reaches here at all —
    // it re-answers the presumption at query time and pokes.
    if (!keep) releaseReportStore();
    // …and again in the reconcile pass, because requests coalesce and a view
    // can be retained between this call and that pass: release wins.
    pendingRelease ||= !keep;
    pendingRebuild = true;
    scheduleReconcile();
    await reconcileChain;
  }

  // Once the hub accepted a forget, the local resync is mandatory even if the
  // Local archive could not make the same deletion durable. Preserve that
  // ordering while returning the archive failure to the route instead of
  // falsely acknowledging success.
  // An in-flight GUARD, deliberately not the self-chaining queue `clean` uses:
  // Concurrent actions cannot share a completion receipt. A pending durable
  // action must settle before a different selection can be accepted.
  let forgetInflight: Promise<FleetForgetResult> | null = null;

  // `mode` is a new intent's. The empty resume (connect and sweep) writes no
  // intent and compares no mode, so its default is never read.
  async function forget(
    sessions: readonly ForgetSessionRef[],
    target?: string,
    mode: FleetForgetMode = "pair",
  ): Promise<FleetForgetResult> {
    if (forgetInflight !== null) {
      return {
        ok: false,
        reason: "busy",
        detail: "a forget is already running on this machine",
        landed: false,
      };
    }
    forgetInflight = forgetInner(sessions, target, mode);
    try {
      return await forgetInflight;
    } finally {
      forgetInflight = null;
    }
  }

  async function forgetInner(
    sessions: readonly ForgetSessionRef[],
    target: string | undefined,
    mode: FleetForgetMode,
  ): Promise<FleetForgetResult> {
    await deps.ingestionReady;
    if (forgetIntent.error() !== null)
      return {
        ok: false,
        reason: "failed",
        detail: String(forgetIntent.error()),
        landed: false,
        retryable: false,
      };
    if (forgetIntent.read() === null && sessions.length === 0)
      return { ok: true, sessionsRequested: 0, sessionsMatched: 0, rowsRemoved: 0 };
    const connection = conn;
    const deletionConnection = connGen;
    if (
      connection === null ||
      (target !== undefined && connection.url.replace(/\/+$/, "") !== target.replace(/\/+$/, ""))
    )
      return {
        ok: false,
        reason: "unavailable",
        detail: "not connected to the configured hub",
        landed: false,
        retryable: true,
      };
    let intent = forgetIntent.read();
    if (intent !== null && sessions.length > 0) {
      const scope = (rows: readonly ForgetSessionRef[]) =>
        JSON.stringify(rows.map((row) => JSON.stringify([row.projectSlug, row.sessionId])).sort());
      if (scope(sessions) !== scope(intent.batches.flatMap((batch) => batch.sessions)))
        return {
          ok: false,
          reason: "busy",
          detail: "a different deletion is awaiting completion",
          landed: false,
        };
      // #311, #375: nor may a caller of another mode resume it. Every mode's
      // answer covers its own archive half only: a lossless intent never
      // rewrote the archive, a key-scoped one left the pairs' admitted rows and
      // barred nothing, and a pair-wide one dropped and barred them all. The
      // empty resume (connect and sweep) passes no sessions, so no mode is
      // compared: it completes any pending intent in that intent's own mode,
      // after which this caller's retry runs.
      if (forgetIntentMode(intent) !== mode)
        return {
          ok: false,
          reason: "busy",
          detail: "a deletion of another kind is awaiting completion",
          landed: false,
        };
    }
    if (intent !== null && intent.hub !== connection.url)
      return {
        ok: false,
        reason: "failed",
        detail: "a deletion is pending on another Hub",
        landed: false,
        retryable: false,
      };
    if (intent === null && sessions.length === 0)
      return { ok: true, sessionsRequested: 0, sessionsMatched: 0, rowsRemoved: 0 };
    let landed = intent?.batches.some((batch) => batch.receipt !== undefined) ?? false;
    let retryable = true;
    eventSync.suspend();
    try {
      if (intent === null) {
        const deadline = requestDeadline();
        const status = await (async () => {
          try {
            const response = await fetchImpl(`${connection.url}/api/status`, {
              headers: connection.headers,
              signal: deadline.signal,
            });
            if (!response.ok) throw new Error(`Cannot read Hub state (${response.status})`);
            return hubStatusSchema.parse(await response.json());
          } finally {
            deadline.clear();
          }
        })();
        if (status.events === undefined) throw new Error("Hub archive unavailable");
        intent = {
          hub: connection.url,
          epoch: status.events.epoch,
          // #311: a lossless forget has no archive half, so it is written
          // already done. A resume on connect or on the sweep reads this and
          // never rewrites the archive either (ADR-0107 §12). `lossless`
          // records the mode itself, which only a same-mode caller may resume.
          ...(mode === "lossless" ? { lossless: true, localComplete: true } : {}),
          // #375: and the evidence repair's key-scoped archive half, which a
          // resume after a restart must run in place of the pair-wide one.
          ...(mode === "excluded" ? { excludedOnly: true } : {}),
          batches: [],
        } satisfies FleetForgetIntent;
        for (let i = 0; i < sessions.length; i += EVENT_FORGET_SESSIONS_MAX)
          intent.batches.push({
            operationId: crypto.randomUUID(),
            sessions: sessions
              .slice(i, i + EVENT_FORGET_SESSIONS_MAX)
              .map(({ projectSlug, sessionId }) => ({ projectSlug, sessionId })),
          });
        forgetIntent.write(intent);
      }
      for (const batch of intent.batches) {
        if (batch.receipt !== undefined) continue;
        if (connGen !== deletionConnection || conn !== connection)
          throw new Error("Connection changed; the pending deletion will resume on reconnect");
        const deadline = requestDeadline();
        try {
          const response = await fetchImpl(`${connection.url}/api/events/forget`, {
            method: "POST",
            headers: { ...connection.headers, "content-type": "application/json" },
            signal: deadline.signal,
            body: JSON.stringify({
              epoch: intent.epoch,
              operationId: batch.operationId,
              sessions: batch.sessions,
            }),
          });
          if (!response.ok) {
            retryable =
              response.status === 408 || response.status === 429 || response.status >= 500;
            throw new Error(`Hub deletion rejected (${response.status})`);
          }
          landed = true;
          batch.receipt = hubEventsForgetResponseSchema.parse(await response.json());
          forgetIntent.write(intent);
        } finally {
          deadline.clear();
        }
      }
      const forgotten = intent.batches.flatMap((batch) => batch.sessions);
      if (!intent.localComplete) {
        // The intent's mode, not the caller's: a resume runs the half the
        // intent was written for (#375).
        const forgetLocal =
          forgetIntentMode(intent) === "excluded"
            ? deps.forgetExcludedFromLocalArchive
            : deps.forgetLocalArchive;
        await forgetLocal?.(forgotten);
        intent.localComplete = true;
        forgetIntent.write(intent);
      }
      // Only Storage's Forget takes the pairs' own rows out of the engine
      // (#378). A repair's forget leaves them: the store already refuses what
      // the repair forgets, an excluded key never being in its event map
      // (#374) and a dormant row never entering it (ADR-0107 §12), so every
      // own row a repaired pair still holds is admitted. Removing them relied
      // on the resync's push to walk them back, and with sharing off, or event
      // sync degraded, that push returns before it re-prepares anything.
      if (forgetIntentMode(intent) === "pair") {
        deps.getStore().removeMachineSessions(deps.machineId, forgotten);
        retainedReportStore?.removeMachineSessions(deps.machineId, forgotten);
        // The archive seed has already finished when a rebuild reads the
        // replica. Its archived-only rows have no replica delete to relay,
        // so Forget must prune this fresh store too, before it can be swapped.
        seedingStore?.removeMachineSessions(deps.machineId, forgotten);
        seedingForgetPairs?.push(...forgotten);
      }
      const result: FleetForgetResult = {
        ok: true,
        sessionsRequested: forgotten.length,
        sessionsMatched: intent.batches.reduce(
          (sum, batch) => sum + batch.receipt!.sessionsMatched,
          0,
        ),
        rowsRemoved: intent.batches.reduce((sum, batch) => sum + batch.receipt!.removed, 0),
      };
      // Keep the durable contribution/archive barrier until the disposable
      // replica has learned this action. A restart before this point resumes it.
      eventSync.resync();
      await eventSync.idle();
      const requiredGeneration = Math.max(
        ...intent.batches.map((batch) => batch.receipt!.deletionGeneration),
      );
      if (
        replica !== null &&
        (replica.epoch() !== intent.epoch || replica.deletionGeneration() < requiredGeneration)
      ) {
        throw new Error("Deletion committed; waiting for replica reconciliation");
      }
      if (replica !== null) {
        const pairs = new Set(
          forgotten.map((row) => JSON.stringify([row.projectSlug, row.sessionId])),
        );
        // The pairs' own rows the replica still holds, picked by their records
        // and read from SQLite a chunk at a time (ADR-0111 §3).
        await replica.readRows(
          (restored) => {
            deps.getStore().appendFleet(restored);
            retainedReportStore?.appendFleet(restored);
            seedingStore?.appendFleet(restored);
          },
          (record) =>
            record.machineId === deps.machineId &&
            pairs.has(JSON.stringify([record.projectSlug, record.sessionId])),
        );
      }
      forgetIntent.write(null);
      pokeNow();
      return result;
    } catch (error) {
      patchEventsDegraded(true);
      return { ok: false, reason: "failed", detail: String(error), landed, retryable };
    } finally {
      eventSync.resync();
    }
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
  // latch — and differs only in URL, schema, and terminal action. The
  // serializer has a third user that is no pull at all: the Home publish
  // (#281), a PUT that wants the same one-in-flight, last-value-wins shape and
  // takes no part in the fetch ladder. The Organization directory (#288) is
  // one of each: a pull that climbs the ladder, and a push (a POST) that
  // doesn't.

  // The serializer. Returns the TRIGGER: a call landing while a refresh is in
  // flight coalesces into exactly ONE follow-up pass (the settings-watch
  // do/while — last state wins), so a sweep can never stack on a poke. `label`
  // names the work in the chain's catch-all log ("directory refresh", "home
  // publish").
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
        .catch((err) => console.error(`[sidecar] fleet ${label} failed:`, err));
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
  // apart from `failed` because the three callers disagree about what a 404
  // MEANS: to identity and to the Organization directory's pull (#288) it is a
  // Hub that predates the route (a per-connection capability latch), to the
  // machine directory it is just another rejection.
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
    // unchanged re-push is a no-op merge hub-side (newest-probedAt-wins). The
    // Organization directory's push rides it for the same reason (#288), and so
    // does the Organization assertion directory's (#310); since each answer is
    // its union, it is each directory's pull floor too. So does the
    // Organization roster pull (#366): no poke announces a roster change, so
    // the sweep is how a later listing reaches this client.
    directorySweep = setIntervalImpl(() => {
      refreshDirectory();
      refreshIdentity();
      void pushIdentity();
      pushOrganizationLabels();
      pushOrganizationAssertions();
      pullOrganizationRoster();
      if (forgetIntent.read() !== null) void forget([]);
    }, directorySweepMs);
  }

  const refreshDirectory = createSerializedRefresh("directory refresh", refreshDirectoryOnce);

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
      // did (identity and the Organization directory latch on a 404 instead).
      if (out.kind === "notFound") console.warn("[sidecar] fleet directory refresh rejected (404)");
      return;
    }
    cache.update(out.data.machines);
    adoptPublishedHomes(out.data.machines, true);
    deps.emitMachinesChanged();
    // Re-publish when the directory's self entry disagrees with the Home this
    // process runs under — DAMPED. It heals only a publish this connection has
    // not landed yet (a failed PUT, a connect whose GET beat its PUT, a
    // `setHome` still in flight) or a Hub that lost the field (listed null
    // while this process runs under a Home) — on connect, on every poke and on
    // the sweep (ADR-0055's retry floor); a match, the common case, sends
    // nothing. It never fights a DIFFERENT non-null Home listed after ours
    // landed: that is another writer — two installs sharing one machine id (a
    // copied app-data directory, a roaming profile) — and fighting it loops
    // without limit, because each changing PUT makes the Hub poke every client
    // and the other install's refresh PUTs back. Every round costs an fsync'd
    // directory rewrite on the Hub and, on every peer, a presumption flip, a
    // report-cache clear and a usage poke. So the last writer wins on the Hub,
    // and this install says so once per connection.
    if (home !== undefined) {
      const self = out.data.machines.find((m) => m.machineId === deps.machineId);
      const listed = self?.homeOrganization ?? null;
      if (listed !== home) {
        if (landedHome !== home || listed === null) publishHome();
        else if (!warnedHomeConflict) {
          warnedHomeConflict = true;
          console.warn(
            "[sidecar] fleet home publish stood down: the Hub lists a different Home for this machine than the one this connection published — another install is likely publishing under the same machine id (e.g. a copied app-data directory); leaving the last writer's Home in place",
          );
        }
      }
    }
  }

  // ── The published Home (#281) ──
  // This machine's Home, written to its own Machine directory entry (PUT
  // /api/machines/:self) so every peer presumes this machine's owner-less rows
  // under it. Directory metadata only: no event row carries it, and the Hub
  // stores it verbatim. Deliberately NOT gated on `shareEvents` or the replica:
  // the directory entry exists on any authenticated contact, and rows shared
  // before sharing was switched off still need their producer's Home.
  //
  // The Home this process runs under, as main() last handed it. `undefined`
  // until the first `setHome` — a first launch's Home is not known until the
  // seed walk settles, and publishing a placeholder would only make every peer
  // drop its caches twice.
  let home: string | null | undefined;
  // The Home this CONNECTION last saw the Hub accept: the value SENT in a PUT
  // answered 2xx — not the live `home` at completion, so a `setHome` landing
  // mid-flight still counts as not landed. The heal's damper (above) reads it,
  // with `warnedHomeConflict` keeping its warning to one per connection. Both
  // are reset on every connection edge (`resetRefreshSerializers`), so a
  // reconnect — the one after a Hub restart included — publishes and heals
  // afresh.
  let landedHome: string | null | undefined;
  let warnedHomeConflict = false;
  // The SAME serializer as the pulls: one PUT in flight, and a burst of
  // `setHome` calls coalesces into one follow-up that publishes the last value.
  const publishHome = createSerializedRefresh("home publish", publishHomeOnce);

  async function publishHomeOnce(c: Conn, myGen: number): Promise<void> {
    // Read at run time, not at trigger time: last value wins.
    const value = home;
    if (value === undefined) return;
    const deadline = requestDeadline();
    try {
      const res = await fetchImpl(`${c.url}/api/machines/${encodeURIComponent(deps.machineId)}`, {
        method: "PUT",
        headers: { ...c.headers, "content-type": "application/json" },
        body: JSON.stringify({ homeOrganization: value }),
        signal: deadline.signal,
      });
      // A superseded connection's answer says nothing about the live one.
      if (connGen !== myGen) return;
      // A 2xx lands the value SENT — the damper's memory. Otherwise warn once
      // and give up — no retry queue: the next directory refresh sees the
      // stale self entry and re-publishes (above).
      if (res.ok) landedHome = value;
      else console.warn(`[sidecar] fleet home publish failed: ${res.status}`);
    } catch (err) {
      if (connGen !== myGen) return;
      console.warn(`[sidecar] fleet home publish failed: ${String(err)}`);
    } finally {
      deadline.clear();
    }
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
  const refreshIdentity = createSerializedRefresh("identity refresh", refreshIdentityOnce);

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

  // ── Organization directory sync (#288, ADR-0105 §8) ──
  // The user's renames go fleet-wide through the Hub's Organization directory.
  // The push POSTs this machine's whole label map, and the Hub answers with
  // the union after merging it — push and pull in one round trip — which is
  // adopted newest-`editedAt`-wins. It runs on connect, on a local rename that
  // wrote, and on the directory sweep; a hub:organizations poke pulls with a
  // GET. Like the published Home, and unlike the identity rows, it is gated on
  // neither `shareEvents` nor the replica: a label is user-authored
  // presentation, fleet-wide whenever a Hub is configured. A Hub that predates
  // the directory 404s, which latches `organizationDirectoryUnsupported` for
  // THIS connection (the identity precedent); any other push failure warns
  // once per connection, and the sweep retries. `onConnected` clears both. A
  // pull, poke-driven and so rare, warns at whichever ladder rung it fails.
  let organizationDirectoryUnsupported = false;
  let warnedOrganizationDirectory = false;
  function warnOrganizationDirectory(detail: string): void {
    if (warnedOrganizationDirectory) return;
    warnedOrganizationDirectory = true;
    console.warn(`[sidecar] organization directory sync failed: ${detail}`);
  }

  // Adopt a union. The pair a local rename fires — the wholesale invalidation
  // and organizations:changed — fires only when some Organization's label
  // changed: an `editedAt` that moved alone is written to disk and shown to
  // no one. A merge that rejects (a disk fault) restored the store as it was,
  // so there is nothing to announce.
  async function adoptOrganizationLabels(
    labels: FleetOrganizationLabels,
    union: Record<string, OrganizationLabelEntry>,
  ): Promise<void> {
    let merged: { wrote: boolean; labelChanged: boolean };
    try {
      merged = await labels.merge(union);
    } catch (err) {
      console.warn(`[sidecar] organization directory adopt failed: ${String(err)}`);
      return;
    }
    if (!merged.labelChanged) return;
    pokeNow();
    deps.emitOrganizationsChanged?.();
  }

  // The SAME serializer as the pulls: one push in flight, and a burst of
  // triggers coalesces into one follow-up that sends the map as it is then.
  const pushOrganizationLabels = createSerializedRefresh(
    "organization directory push",
    pushOrganizationLabelsOnce,
  );

  async function pushOrganizationLabelsOnce(c: Conn, myGen: number): Promise<void> {
    const labels = deps.organizationLabels;
    if (labels === undefined || organizationDirectoryUnsupported) return;
    await labels.ready;
    if (connGen !== myGen) return;
    let union: Record<string, OrganizationLabelEntry>;
    const deadline = requestDeadline();
    try {
      const res = await fetchImpl(`${c.url}${ORGANIZATION_DIRECTORY_PATH}`, {
        method: "POST",
        headers: { ...c.headers, "content-type": "application/json" },
        body: JSON.stringify({ labels: Object.fromEntries(labels.entries()) }),
        signal: deadline.signal,
      });
      // Everything below belongs to the connection that ASKED (F16): a
      // superseded Hub's 404 must not latch the fresh connection, nor its
      // union be adopted.
      if (connGen !== myGen) return;
      if (res.status === 404) {
        organizationDirectoryUnsupported = true; // pre-#288 Hub: silent, per-connection
        return;
      }
      if (!res.ok) {
        warnOrganizationDirectory(String(res.status));
        return;
      }
      const parsed = hubOrganizationDirectorySchema.safeParse(await res.json());
      if (connGen !== myGen) return;
      if (!parsed.success) {
        warnOrganizationDirectory("malformed answer");
        return;
      }
      union = parsed.data.labels;
    } catch (err) {
      if (connGen !== myGen) return;
      warnOrganizationDirectory(String(err));
      return;
    } finally {
      deadline.clear();
    }
    await adoptOrganizationLabels(labels, union);
  }

  const refreshOrganizationLabels = createSerializedRefresh(
    "organization directory refresh",
    refreshOrganizationLabelsOnce,
  );

  async function refreshOrganizationLabelsOnce(c: Conn, myGen: number): Promise<void> {
    const labels = deps.organizationLabels;
    if (labels === undefined || organizationDirectoryUnsupported) return;
    await labels.ready;
    if (connGen !== myGen) return;
    const out = await fetchAndParse(
      `${c.url}${ORGANIZATION_DIRECTORY_PATH}`,
      c.headers,
      hubOrganizationDirectorySchema,
      "organization directory",
    );
    // As the push: a superseded connection's answer neither latches nor lands.
    if (connGen !== myGen) return;
    if (out.kind === "notFound") {
      organizationDirectoryUnsupported = true; // pre-#288 Hub: silent, per-connection
      return;
    }
    if (out.kind === "failed") return;
    await adoptOrganizationLabels(labels, out.data.labels);
  }

  // ── Organization assertion directory sync (#310, ADR-0107 §11) ──
  // The Organization directory's sync above, copied for the user's
  // Organization assertions: the push POSTs this machine's whole assertion map
  // and adopts the union the Hub answers, on connect, on a local edit that
  // wrote, and on the directory sweep; a hub:organization-assertions poke pulls
  // with a GET. Gated on neither `shareEvents` nor the replica: any machine may
  // assert any session, and archive-only history has no living producer to
  // carry a claim (#306 item 6). A 404 latches
  // `organizationAssertionDirectoryUnsupported` for THIS connection, apart from
  // the label directory's latch — a Hub may serve one and not the other; any
  // other push failure warns once per connection, and the sweep retries.
  // `onConnected` clears both.
  let organizationAssertionDirectoryUnsupported = false;
  let warnedOrganizationAssertionDirectory = false;
  function warnOrganizationAssertionDirectory(detail: string): void {
    if (warnedOrganizationAssertionDirectory) return;
    warnedOrganizationAssertionDirectory = true;
    console.warn(`[sidecar] organization assertion directory sync failed: ${detail}`);
  }

  // Adopt a union. Only a change to some session's resolved Organization is
  // announced: main() installs the new claims (`assertionsAdopted`), then the
  // wholesale invalidation tells every renderer to refetch. An `editedAt` that
  // moved alone, or a tombstone for a session with no claim, is written to
  // disk and shown to no one. A merge that rejects restored the store, so there
  // is nothing to announce. No roster poke: a claim moves no Organization's
  // row in Settings.
  async function adoptOrganizationAssertions(
    store: FleetOrganizationAssertions,
    union: Record<string, OrganizationAssertionEntry>,
  ): Promise<void> {
    let merged: { wrote: boolean; assertionChanged: boolean };
    try {
      merged = await store.merge(union);
    } catch (err) {
      console.warn(`[sidecar] organization assertion directory adopt failed: ${String(err)}`);
      return;
    }
    if (!merged.assertionChanged) return;
    deps.assertionsAdopted?.();
    pokeNow();
  }

  const pushOrganizationAssertions = createSerializedRefresh(
    "organization assertion directory push",
    pushOrganizationAssertionsOnce,
  );

  async function pushOrganizationAssertionsOnce(c: Conn, myGen: number): Promise<void> {
    const store = deps.organizationAssertions;
    if (store === undefined || organizationAssertionDirectoryUnsupported) return;
    await store.ready;
    if (connGen !== myGen) return;
    let union: Record<string, OrganizationAssertionEntry>;
    const deadline = requestDeadline();
    try {
      const res = await fetchImpl(`${c.url}${ORGANIZATION_ASSERTION_DIRECTORY_PATH}`, {
        method: "POST",
        headers: { ...c.headers, "content-type": "application/json" },
        body: JSON.stringify({ assertions: Object.fromEntries(store.entries()) }),
        signal: deadline.signal,
      });
      // Everything below belongs to the connection that ASKED: a superseded
      // Hub's 404 must not latch the fresh connection, nor its union land.
      if (connGen !== myGen) return;
      if (res.status === 404) {
        organizationAssertionDirectoryUnsupported = true; // pre-#310 Hub: silent, per-connection
        return;
      }
      if (!res.ok) {
        warnOrganizationAssertionDirectory(String(res.status));
        return;
      }
      const parsed = hubOrganizationAssertionDirectorySchema.safeParse(await res.json());
      if (connGen !== myGen) return;
      if (!parsed.success) {
        warnOrganizationAssertionDirectory("malformed answer");
        return;
      }
      union = parsed.data.assertions;
    } catch (err) {
      if (connGen !== myGen) return;
      warnOrganizationAssertionDirectory(String(err));
      return;
    } finally {
      deadline.clear();
    }
    await adoptOrganizationAssertions(store, union);
  }

  const refreshOrganizationAssertions = createSerializedRefresh(
    "organization assertion directory refresh",
    refreshOrganizationAssertionsOnce,
  );

  async function refreshOrganizationAssertionsOnce(c: Conn, myGen: number): Promise<void> {
    const store = deps.organizationAssertions;
    if (store === undefined || organizationAssertionDirectoryUnsupported) return;
    await store.ready;
    if (connGen !== myGen) return;
    const out = await fetchAndParse(
      `${c.url}${ORGANIZATION_ASSERTION_DIRECTORY_PATH}`,
      c.headers,
      hubOrganizationAssertionDirectorySchema,
      "organization assertion directory",
    );
    // As the push: a superseded connection's answer neither latches nor lands.
    if (connGen !== myGen) return;
    if (out.kind === "notFound") {
      organizationAssertionDirectoryUnsupported = true; // pre-#310 Hub: silent, per-connection
      return;
    }
    if (out.kind === "failed") return;
    await adoptOrganizationAssertions(store, out.data.assertions);
  }

  // ── Organization roster pull (#366, #360's resolution) ──
  // A hub-connected client's roster learns every Organization the Hub's key
  // lists: the Hub polls for the fleet (ADR-0035), so this client never asks
  // claude.ai. GET /api/organizations on connect and on the directory sweep;
  // each listed row that carries hints is recorded as Connect records one
  // (hints, a first-seen time, the Hub's Limits answer, a null answer keeping a
  // recorded one). A directory-only row adds nothing, and a failed or empty pull
  // changes nothing. The learned rows go in one call, as the Hub key's complete
  // listing (every roster entry carries hints), so an Organization the Hub no
  // longer lists is marked off the account and kept (organizations.ts, #360
  // item 3). Gated on neither `shareEvents` nor the replica, like the
  // label directory. The live answers keep coming from HubStatus.organizations.
  //
  // No capability latch: the protocol is exact-match and every v5 Hub serves
  // the route, so a 404 is one more rejection — said so, as the machine
  // directory says it — and the sweep asks again. A learn that changed the
  // registry, or that rejected after the registry's in-memory update, pokes the
  // roster alone: a roster row moves no report, so there is no wholesale
  // invalidation.
  const pullOrganizationRoster = createSerializedRefresh(
    "organization roster pull",
    pullOrganizationRosterOnce,
  );

  async function pullOrganizationRosterOnce(c: Conn, myGen: number): Promise<void> {
    const learn = deps.learnOrganizations;
    if (learn === undefined) return;
    const out = await fetchAndParse(
      `${c.url}${HUB_ORGANIZATIONS_PATH}`,
      c.headers,
      hubOrganizationsResponseSchema,
      "organization roster",
    );
    // A superseded connection's roster must not land: the fresh connect re-asked.
    if (connGen !== myGen) return;
    if (out.kind !== "ok") {
      if (out.kind === "notFound") {
        console.warn("[sidecar] fleet organization roster refresh rejected (404)");
      }
      return;
    }
    const learned: LearnedOrg[] = [];
    for (const row of out.data.organizations) {
      if (!row.listed || row.hints === undefined) continue;
      learned.push({ id: row.uuid, hints: row.hints, limits: row.limits?.limits ?? null });
    }
    if (learned.length === 0) return;
    let changed: boolean;
    try {
      changed = await learn(learned);
    } catch (err) {
      console.warn(`[sidecar] organization roster learn failed: ${String(err)}`);
      // The registry updates its memory before its write, so the roster may
      // already show what this learn rejected on: announce it anyway.
      changed = true;
    }
    if (changed) deps.emitOrganizationsChanged?.();
  }

  // ── FleetSync surface ──

  async function loadReplicaAtBoot(): Promise<void> {
    await deps.ingestionReady;
    // Local disk only — part of engineReady, NEVER network. Not attached (the
    // toggle off OR the hub unconfigured) resolves immediately, so a hub-less
    // client is bit-for-bit the pre-hub app.
    if (!replicaWanted()) return;
    const attached = attachReplica();
    await attached.load(); // self-heals corruption (Task 4)
    // Seed AFTER the boot walk (ADR-0098): the walk records which dedup keys the
    // Home organization rule excluded, and `appendFleet` refuses exactly those;
    // a replica row landing first would be presumed home. `rebuildEngine`
    // already walks before it seeds — this makes boot match it. `ready`
    // resolves even on a partially failed walk, so this cannot hang. The rows
    // are read from SQLite a chunk at a time, synchronously, as the boot seed
    // may (ADR-0111 §3).
    await deps.getStore().ready;
    const store = deps.getStore();
    attached.readRowsSync((rows) => store.appendFleet(rows));
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

  // Every refresh serializer, force-reset — run on BOTH connection edges. F17:
  // an identity GET that never settled used to leave `identityRefreshing`
  // latched true forever, because nothing cleared it (onDisconnected did not
  // touch it, and onConnected only re-called the trigger, which then took the
  // "already refreshing" branch) — so one black-holed fetch silently ended this
  // client's identity pulls until the app restarted. The directory half carried
  // the identical wedge; since the extraction they share the remedy too, and
  // the Home publish (#281), which rides the same serializer, shares it again —
  // along with its per-connection memory: what this connection landed, and
  // whether its damper has warned. The Organization directory's push and pull
  // (#288) share it too, and so do the Organization assertion directory's
  // (#310) and the Organization roster pull (#366).
  function resetRefreshSerializers(): void {
    refreshDirectory.reset();
    refreshIdentity.reset();
    publishHome.reset();
    pushOrganizationLabels.reset();
    refreshOrganizationLabels.reset();
    pushOrganizationAssertions.reset();
    refreshOrganizationAssertions.reset();
    pullOrganizationRoster.reset();
    landedHome = undefined;
    warnedHomeConflict = false;
  }

  const hooks: HubFleetHooks = {
    onConnected: (ctx) => {
      connGen += 1;
      conn = { url: ctx.url, headers: ctx.headers };

      resetRefreshSerializers();
      refreshDirectory();
      // Publish the Home on EVERY successful connect (#261 item 2) — the Hub
      // answers an unchanged Home with no write and no poke. When the directory
      // GET above is answered before this PUT lands, its self entry still lacks
      // the Home and the refresh re-publishes it: two identical PUTs, harmless.
      publishHome();
      armDirectorySweep();
      // Identity (ADR-0062): a NEW connection gets a fresh capability probe —
      // the 404 latch is per-connection, so an upgraded hub is noticed here.
      // Then push own rows and assertions (share-gated) and pull the union
      // (replica-gated).
      identityUnsupported = false;
      void pushIdentity();
      refreshIdentity();
      // The Organization directory (#288): the same fresh probe, and a fresh
      // warning, for a new connection. Then push the label map; its answer is
      // the union, so there is no separate pull.
      organizationDirectoryUnsupported = false;
      warnedOrganizationDirectory = false;
      pushOrganizationLabels();
      // The Organization assertion directory (#310): the same fresh probe and
      // fresh warning, then the push, whose answer is the union.
      organizationAssertionDirectoryUnsupported = false;
      warnedOrganizationAssertionDirectory = false;
      pushOrganizationAssertions();
      // The Organization roster (#366): learn every Organization the Hub's key lists.
      pullOrganizationRoster();
      // event-sync mirrors its capability verdict through onDegraded — the
      // synchronous connect verdict AND any later 404 latch (M7) both land on
      // the loopback status without waiting for a reconnect cycle.
      eventSync.connect({ url: ctx.url, headers: ctx.headers, events: ctx.events });
      if (forgetIntent.read() !== null) void forget([], ctx.url);
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
    onOrganizationsPoke: () => refreshOrganizationLabels(),
    onOrganizationAssertionsPoke: () => refreshOrganizationAssertions(),
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
    reportStore: () => retainedReportStore ?? deps.getStore(),
    releaseRetainedView: () => {
      if (retainedReportStore === null) return;
      releaseReportStore();
      pokeNow();
    },
    forget,
    repairOrganizations: (sessions, target, opts) =>
      forget(sessions, target, opts?.keepLocalArchive === true ? "lossless" : "excluded"),
    rebuildEngine: requestRebuild,
    invalidateReports: pokeNow,
    setHome: (next) => {
      if (next === home) return;
      home = next;
      // No-ops while disconnected; `onConnected` publishes the value later.
      publishHome();
    },
    organizationLabelsChanged: () => pushOrganizationLabels(),
    organizationAssertionsChanged: () => pushOrganizationAssertions(),
    getReplica: () => replica,
    mayArchiveFleet: (row) => {
      if (
        forgetIntent.error() !== null ||
        forgetIntent.pending() ||
        conn === null ||
        replica === null ||
        !replica.seeded()
      )
        return false;
      if (!eventSync.isCaughtUp()) return false;
      // An identity test — "this row IS the replica's copy" — so it must match
      // in tag too (ADR-0103): a row fuller or emptier by Organization evidence
      // alone is a different copy. The replica's copy is its record of it
      // (ADR-0111 §2).
      const held = replica.get(row.messageId, row.requestId);
      return (
        held !== undefined &&
        held.machineId === row.machineId &&
        held.total === fleetTokenTotal(row) &&
        held.organizationUuid === row.organizationUuid
      );
    },
    stop: async () => {
      releaseReportStore();
      clearPokeTimer();
      pendingSince = null;
      clearDirectorySweep();
      await eventSync.stop();
      await replica?.close();
    },
  };
}
