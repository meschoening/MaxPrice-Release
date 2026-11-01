import { stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import type { OrganizationsResponse, UsageCredential } from "@maxprice/shared";
import {
  createHubClient,
  createSampleStore,
  discoverOrgs,
  type DiscoverOrgResult,
  monotonicClock,
  type HubClientConfig,
} from "@maxprice/usage-core";
import {
  buildApp,
  scanAndPoke,
  wireIdentityProbe,
  wireReadySignal,
  wireScanCachePersist,
} from "./index";
import { createBootTrace } from "./boot-trace";
import {
  buildPricingStatus,
  watchNewModels,
  wirePricingRefresh,
  type PricingRefresher,
} from "./pricing-refresh";
import {
  PRICING_STARTUP_FETCH_ENV,
  PRICING_STARTUP_FETCH_SKIPPED_LINE,
  pricingStartupFetch,
} from "./pricing-startup-seam";
import { HOSTNAME_ENV, hostnameSeamLine, seamHostname } from "./hostname-seam";
import { createLiveHub, type LiveHub } from "./live-hub";
import { createWatcher, type CreateWatcherOptions, type Watcher } from "./watcher";
import { resolveWatchRoots } from "./watch-roots";
import {
  readClaudePathsFromSettings,
  readSettingsFile,
  resolveTrackedOrganizations,
} from "./settings-file";
import { createFleetSync } from "./fleet";
import {
  createStorageReporter,
  forgetOrganizationOf,
  parseWebviewProfileDirs,
  STORAGE_FILE,
} from "./storage";
import { createIdentityProber } from "./identity-probe";
import { createLocalArchive } from "./local-archive";
import {
  createOrganizationRegistry,
  createOrganizationRename,
  listOrganizations,
  readCurrentLogins,
  readRemoteControlAtStartup,
  type LearnedOrg,
} from "./organizations";
import { createKeyListing } from "./key-listing";
import { createOrganizationLabels } from "./organization-labels";
import {
  createOrganizationAssert,
  createOrganizationAssertions,
  presumptionWithAssertions,
} from "./organization-assertions";
import { gateOrganizationWatcher, prepareOrganizationStore } from "./organization-boot";
import { createOrganizationRepair } from "./organization-repair";
import { createOrganizationScope, quotaOrganization } from "./organization-scope";
import { createLiveUsagePoller } from "./usage-poller";
import {
  createOrganizationSettingsDriver,
  createReingestState,
  dormantChange,
} from "./organization-lifecycle";
import { createSettingsWatch, type SettingsWatch } from "./settings-watch";
import { createWatcherRestarts } from "./watcher-restarts";
import { createScanCache } from "./engine/scan-cache";
import { createEventStore, type EventStore } from "./engine/store";
import {
  createPresumption,
  dormantSessions,
  NO_DORMANT,
  withPublishedHomes,
  withSelfHome,
  type Presumption,
} from "./engine/presumption";
import { loadOrCreateMachineId } from "./machine-id";
import { startSaturationReporting } from "./saturation";
import { createBootProgressReporter } from "./boot-progress";
import { deferredShutdown } from "./sidecar-shutdown";
import { whenBootResolves } from "./when-boot-resolves";
import pkg from "../package.json";

// The sidecar's boot (ADR-0118 §3): the engine, the Local archive, the usage
// poller, the Hub client and the loopback server, wired from one options object.
// Two hosts run it. The sidecar's entry (`index.ts`) builds the options from
// the environment the Rust shell spawns it with (`bootOptionsFromEnv`) and arms
// the parent watchdog first (ADR-0078); the Headless client's `maxprice serve`
// builds them from its data dir and arms none. The boot returns nothing and
// takes no log sink: both hosts write stderr. The dev and test seams
// (`MAXPRICE_CLAUDE_BASE_URL`, `MAXPRICE_PRICING_STARTUP_FETCH`,
// `MAXPRICE_TEST_HOSTNAME`, `MAXPRICE_USAGE_HISTORY_PATH`,
// `MAXPRICE_WEBVIEW_PROFILE_DIR`, `VITE_SIDECAR_ORIGIN`) and the user's own `CLAUDE_CONFIG_DIR` stay in the
// environment, read where they are used.
//
// This module imports `buildApp` and the boot's wiring helpers from `index.ts`,
// which imports `bootSidecar` back for its entry block. That cycle is safe
// because neither module's top level reads the other's bindings: this one only
// declares, and `index.ts` calls into it only from its `import.meta.main`
// block, which runs after both have evaluated, whichever was loaded first.

export type BootOptions = {
  // settings.json (ADR-0014). Its directory is the data dir, beside which every
  // file the sidecar writes lives. `undefined` is a standalone sidecar: it
  // watches `resolveWatchRoots($CLAUDE_CONFIG_DIR)` and writes into its cwd
  // (or `MAXPRICE_USAGE_HISTORY_PATH`'s directory).
  settingsPath: string | undefined;
  // The loopback listener (ADR-0119 §4). On TCP, `port` 0 lets the OS choose,
  // and `announce` hears the bound port, which the sidecar entry writes as
  // `LISTENING <port>` (ADR-0002). On a Unix socket, the Headless client's,
  // nothing is announced, and the boot neither creates nor tightens the
  // socket's directory: its host owns that lifecycle (§2).
  listen: { port: number; announce: (port: number) => void | Promise<void> } | { unix: string };
  // The token every state-changing route requires in `x-maxprice-auth` (f22).
  // Null enforces none: standalone dev and every test rig run TCP with null.
  authToken: string | null;
  // The Hub to connect to at boot (ADR-0035/0037), or null for none. A change
  // after boot arrives through POST /api/hub/config.
  hub: HubClientConfig | null;
  // The session key to poll with from boot (ADR-0023), applied as POST
  // /api/usage/credential applies a pushed one, or null. A change after boot
  // arrives through that route.
  usageCredential: UsageCredential | null;
  // Hears the Home a first boot's seed chose (ADR-0122 §3), once, when the
  // seeded store installs, so a host with no renderer can save it. Never
  // called when a persisted Home was the boot's, nor for a later Home change.
  // The sidecar entry passes none: its renderer saves the seed (ADR-0098 §1).
  onHomeSeeded?: (uuid: string) => void;
};

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`invalid PORT: ${raw}`);
  }
  return n;
}

async function writeLine(line: string): Promise<void> {
  if (!process.stdout.write(line)) {
    await new Promise<void>((resolve) => process.stdout.once("drain", () => resolve()));
  }
}

// One line naming the clock every saturation measurement rides (#186). Each
// host logs it before booting: the sidecar's entry right after it arms the
// watchdog, and the Headless client's `serve` (ADR-0118 §4), whose Linux clock
// has never been measured. Logging it up front puts the answer in the durable
// log BEFORE anything can go wrong, and makes a Windows host that fell back to
// `performance.now()` — which counts suspended time there, and would report
// every wake as a minute of "engine catching up" — say so out loud instead of
// miscounting in silence. Cheap: the resolution is memoized for the process.
export function logMonotonicClock(): void {
  const clock = monotonicClock();
  if (clock.warning !== undefined) {
    console.error(`[sidecar] saturation clock DEGRADED: ${clock.warning}`);
    return;
  }
  console.error(`[sidecar] saturation clock: ${clock.source}`);
}

// The sidecar entry's options, from the environment the Rust shell passes on
// spawn (ADR-0118 §3), so nothing it passes changes. `MAXPRICE_HUB_URL` and its
// password are the standalone/E2E Hub opt-in; the packaged app pushes its Hub
// over POST /api/hub/config instead. No variable carries a session key
// (ADR-0121 §2): the renderer pushes it.
export function bootOptionsFromEnv(env: Record<string, string | undefined>): BootOptions {
  const hubUrl = env.MAXPRICE_HUB_URL;
  return {
    settingsPath: env.MAXPRICE_SETTINGS_PATH,
    listen: {
      port: parsePort(env.PORT),
      // Stdout handshake: the Rust shell reads exactly this line, then exposes
      // the URL to the renderer via `get_sidecar_url`. ADR-0002.
      announce: (port) => writeLine(`LISTENING ${port}\n`),
    },
    // The Tauri shell passes MAXPRICE_AUTH_TOKEN on spawn; a standalone dev
    // sidecar leaves it unset, so no auth is enforced.
    authToken: env.MAXPRICE_AUTH_TOKEN ?? null,
    hub: hubUrl
      ? {
          url: hubUrl,
          password: env.MAXPRICE_HUB_PASSWORD ?? null,
          // Rig seam: default on; MAXPRICE_HUB_AUTO_HEAL=0 keeps this machine's key local.
          autoHeal: !["0", "false"].includes((env.MAXPRICE_HUB_AUTO_HEAL ?? "").toLowerCase()),
        }
      : null,
    usageCredential: null,
  };
}

export async function bootSidecar(options: BootOptions): Promise<void> {
  const allowedOrigins = [
    "tauri://localhost",
    // Windows/Android serve bundled assets from tauri.localhost over plain
    // http unless `useHttpsScheme` is set — allow both schemes.
    "http://tauri.localhost",
    "https://tauri.localhost",
    process.env.VITE_SIDECAR_ORIGIN,
  ].filter((o): o is string => Boolean(o));

  // Resolve the JSONL roots to watch, then stand up the live data pipeline:
  // the hub fans events to SSE clients, the watcher (created after the
  // handshake) feeds the hub.
  //
  // With a settings path (the Tauri shell passes MAXPRICE_SETTINGS_PATH on
  // spawn — ADR-0014), the user's `claudePaths` from settings.json wins when
  // the file names the key. With none (a standalone dev sidecar, the golden
  // test runner), or a file without the key (ADR-0122 §5: the Headless
  // client's until a command sets one), the boot falls back to the
  // pre-existing resolveWatchRoots($CLAUDE_CONFIG_DIR) behaviour. The settings
  // watch re-resolves through the same `resolveRoots` on every event.
  const settingsPath = options.settingsPath;

  // ASYNC since issue #183's audit: every path tested below is one the USER
  // chose, and a `stat` on a dead network mount does not return. On the
  // synchronous form that wait belonged to the event loop. (The settings.json
  // read a line below stays synchronous on purpose — that path is ours, a
  // regular file in the OS app-data dir, not somewhere the user can point.)
  async function isDir(p: string): Promise<boolean> {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  }

  async function resolveRoots(): Promise<string[]> {
    if (settingsPath !== undefined) {
      const fromSettings = readClaudePathsFromSettings(settingsPath);
      if (fromSettings !== null) {
        // The watcher still drops non-existent dirs at watch time.
        const existing: string[] = [];
        for (const p of fromSettings) if (await isDir(p)) existing.push(p);
        // Safety net: if settings yields no existing dir, fall through to the
        // $CLAUDE_CONFIG_DIR / standard-path resolution below. Harmless when
        // settings has valid paths; rescues a user whose data lives only at a
        // non-standard $CLAUDE_CONFIG_DIR when no standard path exists.
        if (existing.length > 0) return existing;
      }
    }
    return await resolveWatchRoots({
      configDir: process.env.CLAUDE_CONFIG_DIR,
      homedir: homedir(),
      dirExists: isDir,
    });
  }

  // Awaited BEFORE the handshake, deliberately unchanged in that respect: the
  // roots are what the watcher and the boot scan are built from. A hang here
  // therefore delays `LISTENING` and trips the Rust shell's 5 s handshake
  // timeout — loud and specific, not the silent post-handshake wedge #183 was.
  let watchRoots = await resolveRoots();

  // Saturation self-report (issue #116 / F4): starts sampling immediately so
  // even the boot scan is measured. The patch sink is installed once `liveHub`
  // exists, a few statements below. A holder rather than a closure over a
  // `const` still in its TDZ: an await or early return inserted between these
  // statements then costs one dropped sample, not a ReferenceError.
  let patchStatus: LiveHub["patchStatus"] | null = null;
  const saturationReporting = startSaturationReporting({
    patch: (partial) => patchStatus?.(partial),
  });

  // Fleet event sync's boot config (ADR-0041), read HERE rather than beside
  // `createFleetSync` below because the boot progress reporter needs the same
  // two settings before the live hub exists: whether a fleet replica will be
  // loaded at boot decides the splash's step list, which must be complete on
  // the first frame a renderer ever sees (ADR-0067). One read, two consumers —
  // the alternative was a second copy of the same predicate.
  const bootSettings = settingsPath !== undefined ? readSettingsFile(settingsPath) : null;
  const bootShareEvents = bootSettings?.hubShareEvents ?? true;
  const bootFleetReplica = bootSettings?.hubFleetReplica ?? true;
  const bootHubConfigured = options.hub !== null || (bootSettings?.hubUrl ?? "") !== "";

  // The Home organization (GLOSSARY.md, ADR-0098): the persisted choice. A first
  // launch has none, and its boot walk runs with NO home — nothing excluded — so
  // the corpus itself can say which organization this machine works under
  // (`prepareOrganizationStore`, before public readiness). The boot login is
  // only the seed's tie-break and fallback. Label reads may refresh live; they
  // never select the home, since the login file flips whenever the
  // user signs in elsewhere. `currentHome` anchors the tracked set every store
  // this process builds is given (`trackedNow`, below); its only writers are
  // the seed and the settings watch.
  const bootLogin = (await readCurrentLogins(watchRoots))[0] ?? null;
  let currentHome: string | null = bootSettings?.homeOrganization ?? null;
  // The persisted tracked list (the #260 lifecycle decision, item 1). The SET
  // every store is built with is this list unioned with `currentHome`. The
  // union POLICY is single-sourced in `resolveTrackedOrganizations` —
  // `trackedNow()` is this file's one call of it, and `organization-boot.ts`
  // calls the same function rather than reimplementing the rule — so Home is
  // always tracked. Its only writers are the boot snapshot and the settings
  // watch.
  let currentTracked: readonly string[] = bootSettings?.trackedOrganizations ?? [];
  const trackedNow = (): ReadonlySet<string> | null =>
    resolveTrackedOrganizations(currentHome, currentTracked);
  // The persisted Organization scope (#278), raw: `null` for Home, "all", or a
  // uuid. The renderer sends it with every request; the sidecar holds it only
  // so the status's usage connection can describe its Quota organization
  // (`quotaOrganization`, resolved live, so a stale value reads as Home). Its
  // only writers are the boot snapshot and the settings watch.
  let currentScope: string | null = bootSettings?.organizationScope ?? null;
  // Which Organizations a settings edit is re-walking into the engine right now
  // (#276). Declared here, beside the set it describes; the settings driver
  // below marks it, and the roster (`organizations.list`, #287) reads it into
  // each row's `reingesting`.
  const reingest = createReingestState();
  // The Presumed organization rule in force (#277, `engine/presumption.ts`):
  // what every store answers `presumption()` with, through the `presumptionNow`
  // thunk each is built with. ONE cell, deliberately — the thunk returns THIS
  // VARIABLE and must never mint a fresh `createPresumption` per call: the
  // report cache compares presumption IDENTITY on every rebind, so a per-call
  // value would clear every entry on every single query. It has three writers,
  // one per half: the Home — the seed, and the settings driver through
  // `installHome` — via `withSelfHome`; the Machine directory — the fleet,
  // through `installPublishedHomes` — via `withPublishedHomes` (#281); and the
  // Organization assertions — `installAssertions` below, at boot once
  // organization-assertions.json has loaded, after a PUT that wrote, and after
  // the fleet adopts a union that changed a claim — via `withAssertions` (#309,
  // #310). Each swap carries the other writers' halves unchanged, so none drops
  // another's. `createPresumption` builds the initial cell only.
  let currentPresumption: Presumption = createPresumption(currentHome);
  const presumptionNow = (): Presumption => currentPresumption;
  // #278: scope and owner-less rows read the same installed presumption. A
  // requested Home may still be queued behind a tracked-set rebuild, so the
  // Home this answers is the installed one. The endpoints and the live usage
  // channel both read it.
  const organizationScope = createOrganizationScope(presumptionNow, trackedNow);
  // What a null setting falls back to once the seed has run. Null until then,
  // so a settings edit that beats the walk is never overridden.
  let seededHome: string | null = null;
  // Whether a hub is configured right now — the repair skips the hub half when
  // there is none. Boot value from settings; POST /api/hub/config updates it.
  let hubTargetNow: string | null = options.hub?.url ?? (bootSettings?.hubUrl || null);

  // The boot progress channel (ADR-0067). Created before the hub so its seed
  // can go straight into the status literal; its `patch` sink is the hub's, so
  // it is installed a few statements below alongside the saturation sampler's.
  const bootProgress = createBootProgressReporter({
    patch: (partial) => patchStatus?.(partial),
    // Exactly ADR-0041's `replicaWanted`: the toggle AND a configured hub.
    mergesFleet: bootFleetReplica && bootHubConfigured,
  });

  const liveHub = createLiveHub({
    initialStatus: {
      // Seeded so the field EXISTS on every emitted frame from the first
      // subscribe on — patchStatus merges, so an edge-triggered saturation
      // patch would otherwise leave every earlier frame without the field and
      // the renderer's replace-whole handling would drop it between edges.
      saturation: saturationReporting.snapshot(),
      watchedPaths: watchRoots,
      // The honest boot value (ADR-0053): the vendored floor, with no attempt
      // settled yet. `null` is the whole point — it says "nothing has been
      // tried", which a bare capture stamp could not, and it is the state
      // Settings' App info row renders while the startup refresh below is still
      // in flight. Built through `buildPricingStatus` rather than spelled out so
      // the boot seed cannot drift from the refresh patches; the active snapshot
      // is still the vendored one here (the refresh is kicked after the
      // handshake), so this reads `source: "vendored"`.
      pricing: buildPricingStatus(null, []),
      // The app's own version — Settings › App info's Engine row surfaces it,
      // compared against the renderer's baked `__APP_VERSION__` so a mismatch
      // names a stale `bun run build:binaries` (the sidebar foot's `engine v…`
      // line is gone; map #100 T5). The usage engine is in-process now
      // (Part 4.5), so the honest version to show is the app's, not a CLI's.
      engineVersion: pkg.version,
      // The corpus is empty until the initial scan / watcher proves otherwise
      // (see `markHasData` below). The renderer's first-launch empty state
      // keys off this — a fresh launch with no Claude data starts here.
      hasData: false,
      usageConnection: "disconnected",
      usageLastSampleAt: null,
      organizations: {},
      hubConnection: "off",
      // Not seeding a fleet replica at boot (ADR-0041 M5) — the pull loop sets
      // this only while draining from cursor 0.
      hubSeed: null,
      // Not degraded until a connected hub proves it (ADR-0041 M6).
      hubEventsDegraded: false,
      // The boot readiness signal (ADR-0047): false until the local engine
      // sources settle — `wireReadySignal` below patches it true off
      // `engineReady`. Until then, `hasData: false` means "still scanning",
      // not "no data".
      ready: false,
      identityReady: false,
      usageHistoryReady: false,
      // What that scan is doing (ADR-0067) — seeded so the splash can draw a
      // step list and a 0% bar from the first frame, rather than degrading to
      // ADR-0047's indeterminate composition until the first count arrives.
      bootProgress: bootProgress.initial,
    },
  });
  // The hub exists now — install the saturation sampler's patch sink.
  patchStatus = liveHub.patchStatus;

  // Flip the status snapshot's `hasData` to `true` the first time the engine
  // store holds any event, and broadcast it. Both the initial scan and the
  // live watcher feed the store, so this is called from both paths; the guard
  // makes the broadcast fire exactly once (on the false→true transition).
  function markHasData(): void {
    if (liveHub.getStatus().hasData) return;
    // Through the live accessor (ADR-0041): a fleet rebuild swaps the store, so
    // the size must be read from whatever store is current, not the boot one.
    if (getEngineStore().size() > 0) liveHub.patchStatus({ hasData: true });
  }

  // Usage-history path (ADR-0023/0024): app-data dir derived from the settings
  // path the Rust shell passes, overridable for the standalone sidecar. Computed
  // here — above the event store — because the machine id lives beside it and
  // the engine needs that id before it can tag any locally scanned row.
  const usageHistoryPath =
    process.env.MAXPRICE_USAGE_HISTORY_PATH ??
    (settingsPath !== undefined
      ? join(dirname(settingsPath), STORAGE_FILE.usageHistory)
      : join(process.cwd(), STORAGE_FILE.usageHistory));

  // Every MaxPrice-owned file the sidecar writes lives here — in the packaged
  // app the same directory as settings.json and `logs/`, and under the
  // standalone override the directory that carries the whole set. It is what
  // GET /api/storage walks WHOLESALE (#126 §7).
  const appDataDir = dirname(usageHistoryPath);

  // Stable per-machine identity (ADR-0035/0041): the engine tags every locally
  // scanned row with it, so it must exist before the store.
  const machineId = loadOrCreateMachineId(join(dirname(usageHistoryPath), "machine-id"));

  // The on-disk parse cache (ADR-0048), beside usage-history.jsonl so the
  // standalone-sidecar MAXPRICE_USAGE_HISTORY_PATH override carries it too.
  // Every scan — boot, rescan, fleet-resync rebuild — reads through it; its
  // one write is wired off engineReady below.
  const scanCache = createScanCache({
    path: join(appDataDir, STORAGE_FILE.scanCache),
  });

  // ADR-0098: plan words per organization, so a label survives logging out.
  const organizationRegistry = createOrganizationRegistry({
    path: join(appDataDir, STORAGE_FILE.organizations),
  });
  // Serialized, never fire-and-forget: the registry's write queue orders its
  // writes against each other but not against `load()`, and a write that ran
  // ahead of the load would persist a map missing the file's entries — so every
  // later writer (the /api/organizations handler, discovery's roster seed)
  // awaits this first.
  const registryReady: Promise<void> = organizationRegistry
    .load()
    .then(() =>
      bootLogin === null
        ? undefined
        : organizationRegistry.remember(bootLogin.organizationUuid, bootLogin.organizationType),
    )
    .catch((err: unknown) => console.error("[sidecar] organization registry load failed:", err));
  // Every listing's answer records through here, after the boot load: Connect's
  // discovery (#283), the Hub's roster and the key listing (#366).
  const recordIntoRegistry = async (orgs: readonly LearnedOrg[]): Promise<boolean> => {
    await registryReady;
    return organizationRegistry.recordDiscovery(orgs);
  };
  // #287: the user's renames — durable, unlike the registry above, and under
  // the same rule: its write queue does not order a write against `load()`, and
  // a `set` that ran ahead of the load would overwrite the user's file with a
  // map missing its entries. So every reader and writer awaits this first.
  const organizationLabels = createOrganizationLabels({
    path: join(appDataDir, STORAGE_FILE.organizationLabels),
  });
  const labelsReady: Promise<void> = organizationLabels
    .load()
    .catch((err: unknown) => console.error("[sidecar] organization labels load failed:", err));
  // #310: the user's Organization assertions — durable and user-authored like
  // the labels. Its load rides the queue every `set` and `merge` joins, so no
  // edit or adoption can write ahead of it; readers and writers here still
  // await `assertionsReady`, which also covers the boot install. `engineReady`
  // waits for it too, so the first report any reader gets already answers
  // owner-less rows through the persisted claims.
  const organizationAssertions = createOrganizationAssertions({
    path: join(appDataDir, STORAGE_FILE.organizationAssertions),
  });
  // The presumption cell's assertion writer: installs the store's resolved
  // claims when they differ from the installed ones, and says whether it
  // swapped. The PUT and the fleet's adoption follow a swap with the wholesale
  // invalidation; the boot install precedes every reader and needs none.
  const installAssertions = (): boolean => {
    const next = presumptionWithAssertions(currentPresumption, organizationAssertions.resolved());
    if (next === null) return false;
    currentPresumption = next;
    return true;
  };
  const assertionsReady: Promise<void> = organizationAssertions
    .load()
    .then(() => {
      installAssertions();
    })
    .catch((err: unknown) => console.error("[sidecar] organization assertions load failed:", err));
  // #311 (ADR-0107 §12): the sessions whose owner-less rows are dormant here —
  // asserted to an Organization outside the tracked set — read live from the
  // installed claims and the live tracked set. The placeholder and every store
  // the fleet builds take it as their snapshot at construction; the boot walk's
  // stores compute theirs against the walk's own set.
  const dormantNow = (): ReadonlySet<string> =>
    dormantSessions(currentPresumption.assertedBySession, trackedNow());
  // The dormant set the LAST queued change installs (its `nextDormant`), so a
  // queued change's `previousDormant` is its predecessor's `nextDormant`, as
  // with the tracked set. Re-anchored at the boot seed.
  let queuedDormant: ReadonlySet<string> = NO_DORMANT;
  // After an assertion install: queue a dormant-only change when the install
  // moved the dormant set. The driver (declared below) is only reached from
  // the PUT, the fleet's adoption and the seed, all after it exists.
  const admitAssertions = (): void => {
    const change = dormantChange({
      home: currentHome,
      tracked: trackedNow(),
      previousDormant: queuedDormant,
      nextDormant: dormantNow(),
    });
    if (change === null) return;
    queuedDormant = change.nextDormant;
    void organizationSettings.apply(change);
  };

  // An empty placeholder while the private selection walk runs. No source
  // feeds this store; prepareOrganizationStore installs the first live corpus
  // after LISTENING, before localReady opens any outward feeder.
  let engineStore = createEventStore({
    selfMachineId: machineId,
    scanCache,
    trackedOrganizations: trackedNow(),
    dormantSessions: dormantNow(),
    getPresumption: presumptionNow,
  });
  const getEngineStore = (): EventStore => engineStore;
  let resolveLocalReady!: () => void;
  let rejectLocalReady!: (error: unknown) => void;
  const localReady = new Promise<void>((resolve, reject) => {
    resolveLocalReady = resolve;
    rejectLocalReady = reject;
  });
  // A persisted Home is settled already. On first launch the seed stays
  // private until its store is installed; share the walk's gate so a failure
  // also settles the roster request, through the route's error envelope.
  // A separate success-only gate would hang forever after a failed walk (#340).
  const homeSettled = currentHome !== null ? Promise.resolve() : localReady;
  let detachForeignEvidence: (() => void) | null = null;
  // The pricing loop and its unpriced-model watch (#110) are assigned after the
  // handshake, but the fleet's `swapStore` (declared next) must re-attach the
  // watch — hence `let`s declared ahead of both.
  let pricingRefresher: PricingRefresher | null = null;
  let detachModelWatch: (() => void) | null = null;

  // The Local archive (#140, ADR-0069): this machine's own events, durable,
  // always on. Constructed before the fleet so rebuildEngine can seed from it.
  const localArchive = createLocalArchive({
    path: join(appDataDir, STORAGE_FILE.localArchive),
    mayArchiveFleet: (row) => fleet.mayArchiveFleet(row),
    machineId,
    getStore: getEngineStore,
    onDegraded: (d) => {
      if ((liveHub.getStatus().localArchiveDegraded ?? false) !== d) {
        liveHub.patchStatus({ localArchiveDegraded: d });
      }
    },
  });
  // Install only the home-filtered corpus. The first selection walk has no
  // archive subscription, fleet source, report readers, or watcher writes.
  function installStore(next: EventStore): void {
    engineStore = next;
    localArchive.attachStore(next);
    detachForeignEvidence?.();
    detachForeignEvidence = next.onForeignEvidence((sessions) => {
      void whenBootResolves(engineReady, () => organizationRepair.invalidate(sessions));
    });
    detachModelWatch?.();
    if (pricingRefresher) {
      detachModelWatch = watchNewModels(next, pricingRefresher.republish);
      pricingRefresher.republish();
    }
  }

  // Fleet event sync (ADR-0041). Toggles + the hub-configured gate come from
  // settings.json at boot (read above, beside the boot progress reporter that
  // shares them; the renderer ALSO pushes hub config over
  // POST /api/hub/config — onHubConfigured tracks it live); consumed
  // in-session via the settings watch below.
  const fleet = createFleetSync({
    machineId,
    replicaPath: join(appDataDir, STORAGE_FILE.fleetReplica),
    directoryCachePath: join(dirname(usageHistoryPath), "machine-directory.json"),
    // The Identity directory (ADR-0062): authoritative own + mirrored fleet rows.
    identityDirectoryPath: join(dirname(usageHistoryPath), "identity-directory.json"),
    liveHub,
    getStore: getEngineStore,
    ingestionReady: localReady,
    swapStore: installStore,
    seedLocalArchive: (store) => localArchive.seedInto(store),
    forgetLocalArchive: (sessions) => localArchive.forgetSessions(sessions),
    // #375: the evidence repair's Local archive half (`repairOrganizations`)
    // removes only the pairs' excluded keys, and bars nothing.
    forgetExcludedFromLocalArchive: (sessions) => localArchive.forgetExcludedKeys(sessions),
    // ADR-0098: a rebuild re-derives under whatever tracked set is current —
    // the settings watch's tracked-set change is exactly a rebuild — and the
    // dormant snapshot (#311), both read at construction, so every rebuild and
    // every contribution walk admits under the live pair. The presumption
    // rides the same live thunk (#277): a fresh store answers owner-less rows
    // under whatever Homes are current when it is QUERIED — this machine's and
    // its peers' published ones — not when it was built.
    createStore: () =>
      createEventStore({
        selfMachineId: machineId,
        scanCache,
        trackedOrganizations: trackedNow(),
        dormantSessions: dormantNow(),
        getPresumption: presumptionNow,
      }),
    // The directory half of the presumption cell (#281). Runs synchronously
    // INSIDE `createFleetSync` when the persisted directory cache already names
    // peer Homes — safe, because `currentPresumption` is declared above, and it
    // is how a peer's rows are presumed under its Home offline, before any
    // connect. The fleet pokes the renderers itself after a refresh's swap.
    installPublishedHomes: (homes) => {
      currentPresumption = withPublishedHomes(currentPresumption, homes);
    },
    // The user's renames (#288), synced with the Hub's Organization directory:
    // the store is built above, and nothing is pushed or adopted before its
    // load. An adopted label change pokes the roster here and the reports
    // through the fleet's own wholesale invalidation, as a local rename does.
    organizationLabels: {
      ready: labelsReady,
      entries: () => organizationLabels.entries(),
      merge: (incoming) => organizationLabels.merge(incoming),
    },
    // The user's Organization assertions (#310), synced with the Hub's
    // Organization assertion directory: nothing is pushed or adopted before
    // the boot load. An adoption that changed some session's claim installs
    // the new claims here; the fleet's own wholesale invalidation follows.
    organizationAssertions: {
      ready: assertionsReady,
      entries: () => organizationAssertions.entries(),
      merge: (incoming) => organizationAssertions.merge(incoming),
    },
    assertionsAdopted: () => {
      installAssertions();
      admitAssertions();
    },
    // #366: the Hub's roster seeds this machine's.
    learnOrganizations: recordIntoRegistry,
    getRoots: () => watchRoots,
    emitMachinesChanged: () => liveHub.emitMachinesChanged(),
    emitIdentityChanged: () => liveHub.emitIdentityChanged(),
    emitOrganizationsChanged: () => liveHub.emitOrganizationsChanged(),
    initial: {
      shareEvents: bootShareEvents,
      fleetReplica: bootFleetReplica,
      hubConfigured: bootHubConfigured,
    },
  });

  // ADR-0098: the one-shot repair of synced history. Runs after the boot gate
  // (below), after a settings edit that moved the tracked set (#277 — a Home
  // change that leaves the set alone excludes nothing new, so there is nothing
  // to repair), and on its own retry timer while a configured hub is
  // unreachable.
  const organizationRepair = createOrganizationRepair({
    markerPath: join(appDataDir, STORAGE_FILE.organizationRepair),
    trackedOrganizations: () => trackedNow(),
    foreignSessions: () => getEngineStore().foreignSessions(),
    hubTarget: () => hubTargetNow,
    hubEpoch: (target) => fleet.hubEpoch(target),
    forgetOnHub: (sessions, target) => fleet.repairOrganizations(sessions, target),
    forgetExcludedFromLocalArchive: (sessions) => localArchive.forgetExcludedKeys(sessions),
    rebuild: () => fleet.rebuildEngine(),
    // #311 (ADR-0107 §12): the dormant half, from the live engine store: its
    // snapshot (the marker's key) and its locally backed dormant pairs,
    // forgotten on the Hub losslessly.
    dormantSessions: () => getEngineStore().dormantSessions(),
    dormantPairs: () => getEngineStore().dormantPairs(),
    forgetDormantOnHub: (sessions, target) =>
      fleet.repairOrganizations(sessions, target, { keepLocalArchive: true }),
    // #368 review: a done pair whose archive rows the live store now excludes
    // is repaired again, whatever build wrote its done entry.
    archivedExcludedPairs: () => localArchive.excludedPairs(),
  });

  // The ONE driver of Organization settings edits (#276) — constructed here,
  // beside the repair it runs, because it owns the queue: the settings hook
  // below hands it a change per edit and it applies them one at a time, in
  // arrival order. A fresh driver per edit would be no queue at all.
  const organizationSettings = createOrganizationSettingsDriver({
    setPollingOrganizations: (ids, home) => usagePoller.setOrganizations([...(ids ?? [])], home),
    installHome: (home) => {
      currentPresumption = withSelfHome(currentPresumption, home);
      // The status's Quota organization follows the install.
      usagePoller.republish();
    },
    releaseRetainedView: () => fleet.releaseRetainedView(),
    rebuild: (o) => fleet.rebuildEngine(o),
    repair: () => organizationRepair.run(),
    resetRepair: () => organizationRepair.reset(),
    invalidateReports: () => fleet.invalidateReports(),
    reingest,
    rosterChanged: () => liveHub.emitOrganizationsChanged(),
    trackedNow,
    dormantNow,
  });

  // The Repo identity prober (ADR-0062 §2) — the ONE producer of this
  // machine's own directory rows. It reads the engine (which projects live at
  // which local paths) and hands stamped rows to the fleet, which persists,
  // emits identity:changed, and offers them to the hub. Three triggers, all
  // wired below: boot (off engineReady), the manual rescan, and a first-seen
  // slug in the watcher's flush.
  let initialIdentityProbeSettled = false;
  let identityProbePending = false;
  const identityProber = createIdentityProber({
    getStore: getEngineStore,
    machineId,
    record: (rows) => fleet.recordProbes(rows),
    onPendingChange: (pending) => {
      identityProbePending = pending;
      liveHub.patchStatus({ identityReady: initialIdentityProbeSettled && !pending });
    },
  });

  // The Settings › Storage report (map #124). Built here rather than inside
  // buildApp because everything it needs is the boot's: the app-data directory,
  // the live watch roots, the fleet replica (whose absence is what makes Forget
  // absent rather than disabled), this machine's id, and the webview profile
  // path the Rust shell resolved.
  //
  // MAXPRICE_WEBVIEW_PROFILE_DIR is a path LIST joined by the platform
  // delimiter, not a single path: the profile is one directory on Windows, two
  // on macOS, and nine subdirectories INSIDE our own app-data dir on Linux
  // (#125). Unset ⇒ the segment is simply absent, which the schema defines as
  // "does not apply here" — and that is what keeps the sidecar ignorant of
  // platforms.
  //
  // `engineReady` is read as the LIVE status flag rather than by awaiting the
  // promise: guard 1 wants a synchronous "has the initial scan landed", and
  // wireReadySignal below is what publishes exactly that.
  const storageReporter = createStorageReporter({
    appDataDir,
    webviewProfileDirs: parseWebviewProfileDirs(process.env.MAXPRICE_WEBVIEW_PROFILE_DIR),
    getRoots: () => watchRoots,
    getReplica: () => fleet.getReplica(),
    // The Local archive (ADR-0069), live: `null` until the boot load lands, and
    // again after a load failure — which is exactly what Clean reads as "no
    // archive to compact". The `localArchive` SEGMENT is unaffected either way
    // — it comes from the app-data walk, which measures the file whether or not
    // a store is holding it open.
    getLocalArchive: () => localArchive.store(),
    selfMachineId: machineId,
    engineReady: () => liveHub.getStatus().ready,
    // Clean goes through the cache's own `drop()` rather than unlinking the file
    // behind its back. The route has no engine-ready gate by design, so a Clean
    // during the boot window used to race wireScanCachePersist's one settle-time
    // save: bytes reported reclaimed, file back seconds later. `drop()` is sticky
    // and suppresses that pending save.
    dropScanCache: () => scanCache.drop(),
    // Withheld rows leave the Forget verdict and the archive's left edge:
    // dormant rows (#311) and Excluded-tagged own rows (#295), whether a walked
    // session's awaiting the scoped repair or a pruned session's that
    // ADR-0103's accepted departure keeps on the Hub for good.
    // The breakdown resolves each unbacked row the way every report does, minus
    // any Organization the store does not track (`forgetOrganizationOf`). Both
    // read the store PER CALL: a rebuild swaps it, and with it the tracked set
    // and the dormant snapshot. The presumption is not swapped by a rebuild —
    // `installAssertions` replaces it live, ahead of the rebuild it queues.
    withheld: (row) => getEngineStore().isWithheld(row),
    organizationOf: (row) => forgetOrganizationOf(getEngineStore(), row),
  });

  // engineReady gates every data handler on BOTH local sources — the initial
  // scan AND the replica file load (ADR-0041) — but never the network (the hub
  // pull is background). Both are kicked AFTER the LISTENING handshake (below);
  // until then this holds the scan's own `ready` so a request in the boot window
  // still waits on the scan, exactly as the pre-fleet app did — and on the
  // persisted Organization assertions' install (#310), so no report answers
  // before them.
  let engineReady: Promise<void> = Promise.all([localReady, assertionsReady]).then(() => undefined);
  // Marked handled: this boot-window value is replaced right after the
  // handshake, so when `localReady` rejects (a failed boot walk) nothing may be
  // awaiting it, and an unobserved rejection reaches the `unhandledRejection`
  // handler below, which exits(1). Whatever does await it still sees the
  // rejection.
  void engineReady.catch(() => {});

  // Usage-limits (ADR-0023/0024). Construction is synchronous and reads no file
  // — the on-disk history is loaded by `sampleStore.loadHistory()` *after* the
  // handshake (below), so a large read can't delay the LISTENING line past the
  // Rust shell's 5s timeout.
  const sampleStore = createSampleStore({ path: usageHistoryPath });
  // The first load settles even on failure or an absent file. Keep this
  // separate from engineReady: Desktop routes and splash timing stay as they
  // are; one-shot Headless reports can wait for history before reading it.
  void sampleStore.ready.then(() => liveHub.patchStatus({ usageHistoryReady: true }));
  const usagePoller = createLiveUsagePoller({
    store: sampleStore,
    liveHub,
    getQuotaOrganization: () => quotaOrganization(currentScope ?? undefined, organizationScope()),
    baseUrl: process.env.MAXPRICE_CLAUDE_BASE_URL,
  });

  usagePoller.setOrganizations([...(trackedNow() ?? [])], currentHome);

  // Connect's discovery with a session key, under the same dev/test override
  // the poller and the Hub's discovery read: what POST /api/usage/discover-orgs
  // proxies and what the key listing below runs.
  const discoverWithKey = (sessionKey: string): Promise<DiscoverOrgResult> =>
    discoverOrgs({ sessionKey, baseUrl: process.env.MAXPRICE_CLAUDE_BASE_URL });

  // #366 (#360's resolution): a client with no Hub configured lists its key's
  // Organizations into the roster itself — on every key arrival and hourly.
  // A Hub-configured client never does, even in fallback; the fleet's roster
  // pull is its source.
  const keyListing = createKeyListing({
    hubConfigured: () => hubTargetNow !== null,
    currentKey: () => usagePoller.getCredential()?.sessionKey ?? null,
    discover: discoverWithKey,
    record: recordIntoRegistry,
    changed: () => liveHub.emitOrganizationsChanged(),
  });

  // Hub client (ADR-0035): connect/backfill/stream toward an optional hub;
  // pauses usagePoller while connected. machineId (computed above, beside the
  // usage history) is reused here.
  // The User guide capture's seam (ADR-0134 §6): the roster hostname it names
  // this machine, acknowledged before the handshake below. Read once, so the
  // name acknowledged is the name sent.
  const testHostname = seamHostname(process.env[HOSTNAME_ENV]);
  const hubClient = createHubClient({
    store: sampleStore,
    liveHub,
    localPoller: usagePoller,
    machineId,
    // Friendly roster label (ADR-0036) — the host's machine name, sent as
    // x-maxprice-hostname. Empty string ⇒ header omitted (handled in hub-client).
    // The User guide capture names each machine instead (hostname-seam.ts).
    hostname: testHostname ?? hostname(),
    // Auto-heal read seam (ADR-0035 M2): the hub-client pushes this machine's
    // key to a hub whose own credential died.
    getLocalCredential: () => usagePoller.getCredential(),
    // The ADR-0041 event-sync seam: hub-client owns connection custody and
    // fires these hooks; fleet.ts drives the event-sync from them.
    fleet: {
      ...fleet.hooks,
      onConnected: (context) => {
        fleet.hooks.onConnected(context);
        void whenBootResolves(engineReady, () => organizationRepair.run());
      },
    },
  });

  // The Settings roster (ADR-0098, #287) — GET /api/organizations, and what
  // every rename checks against. A first launch lists only once the walk has
  // installed its Home, so the renderer's seed never persists a null or a
  // value about to change. A failed walk rejects the request instead.
  async function listOrganizationRoster(): Promise<OrganizationsResponse> {
    await homeSettled;
    // Every root's live login is display-only here ("(current login)"); the
    // home itself never follows one.
    const [logins, remoteControlAtStartup] = await Promise.all([
      readCurrentLogins(watchRoots),
      // ADR-0101: display-only, like the logins — the hint in Settings.
      readRemoteControlAtStartup(watchRoots),
    ]);
    // After the boot load, never beside it: the write queue does not order a
    // write against `load()` (see registryReady).
    await registryReady;
    // Every login file seen feeds the plan-word registry (labels decision 2).
    for (const login of logins) {
      await organizationRegistry.remember(login.organizationUuid, login.organizationType);
    }
    // …and every Organization seen in usage gets a first-seen time, even one
    // no login or discovery ever named.
    const seen = getEngineStore().organizationsSeen();
    await organizationRegistry.observe([...seen.machine, ...seen.fleet]);
    await labelsReady;
    return listOrganizations({
      home: currentHome,
      currentLogins: logins,
      remoteControlAtStartup,
      seen,
      tracked: trackedNow(),
      // The poller's published per-Organization answers — a hub-connected
      // client's status mirrors the Hub's map, which is the answer it shows.
      pollerOrganizations: liveHub.getStatus().organizations,
      reingesting: reingest.current(),
      registry: organizationRegistry.entries(),
      labels: organizationLabels,
    });
  }
  // PUT /api/organizations/:uuid (#287). A rename that changes the stored
  // label emits the same wholesale invalidation a Home change does (labels
  // decision 10), so every window refetches, and the roster's own
  // organizations:changed poke, so every window rereads the roster. Then it
  // pushes the label map to the Hub's Organization directory (#288), so every
  // other machine adopts it.
  const renameOrganization = createOrganizationRename({
    list: listOrganizationRoster,
    labels: {
      set: async (uuid, label) => {
        await labelsReady;
        return organizationLabels.set(uuid, label);
      },
    },
    invalidateReports: () => fleet.invalidateReports(),
    rosterChanged: () => liveHub.emitOrganizationsChanged(),
    labelsWritten: () => fleet.organizationLabelsChanged(),
  });
  // PUT /api/organization-assertions (#310). The target is checked against the
  // roster the rename reads; a set that wrote installs the claims, invalidates
  // every report when the presumption swapped, and pushes the map to the Hub's
  // Organization assertion directory.
  const assertOrganizations = createOrganizationAssert({
    roster: listOrganizationRoster,
    assertions: {
      set: async (sessionIds, organizationUuid) => {
        await assertionsReady;
        return organizationAssertions.set(sessionIds, organizationUuid);
      },
    },
    install: () => {
      const swapped = installAssertions();
      admitAssertions();
      return swapped;
    },
    invalidateReports: () => fleet.invalidateReports(),
    assertionsWritten: () => fleet.organizationAssertionsChanged(),
  });

  // Bind first so we know the port, then wire up host validation against it.
  const allowedHosts = new Set<string>();
  // Assigned after the handshake (see the wirePricingRefresh call below); the
  // route reaches it through a thunk. A request cannot precede the assignment
  // in practice — the Rust shell only learns the port from LISTENING, and the
  // refresher is wired synchronously right after that line — but the guard
  // keeps the failure a 500 rather than a TDZ ReferenceError if that order
  // ever changes.
  const app = buildApp({
    allowedOrigins,
    isAllowedHost: (host) => host !== undefined && allowedHosts.has(host),
    liveHub,
    // Live engine accessor (ADR-0041): a fleet rebuild swaps the store, so
    // handlers read it per-request rather than capturing one at build time.
    store: getEngineStore,
    reportStore: fleet.reportStore,
    // Both local sources gate the data handlers — the scan AND the replica load
    // (assigned after the handshake); `() =>` reads the live value.
    engineReady: () => engineReady,
    // The fleet's cached machine directory + self id, for GET /api/machines.
    machines: () => fleet.machines(),
    // The Identity directory + self id, for GET /api/project-identity (ADR-0062).
    projectIdentity: () => fleet.identity(),
    projectMerge: (request) => fleet.setProjectMerge(request),
    // The Settings › Storage report (map #124) — single-flight, freshly walked.
    storage: () => storageReporter.read(),
    // Its two actions (#132). `clean` acts on the same two things the report
    // previews; `forget` reaches the hub and drives the local reseed, both of
    // which live in fleet.ts because the connection, the replica and the resync
    // order do.
    storageActions: {
      clean: () => storageReporter.clean(),
      forget: (sessions) => fleet.forget(sessions),
    },
    // ADR-0098 / #287: the Settings roster and its renames.
    organizations: {
      list: listOrganizationRoster,
      rename: renameOrganization,
      // #283: Connect's discovery seeds the roster.
      recordDiscovery: async (orgs) => {
        await recordIntoRegistry(orgs);
      },
      // #283: a legacy credential push keeps its Organization in the roster.
      // `remember` never downgrades a known plan word, so a null here only
      // adds an Organization the roster did not know.
      rememberOrganization: async (uuid) => {
        await registryReady;
        await organizationRegistry.remember(uuid, null);
      },
      learnFromKey: (sessionKey) => void keyListing.keyArrived(sessionKey),
    },
    organizationScope,
    // #310: the Organization assertions, read and edited.
    organizationAssertions: {
      list: async () => {
        await assertionsReady;
        return { assertions: Object.fromEntries(organizationAssertions.resolved()) };
      },
      assert: assertOrganizations,
    },
    // Live accessor, not a snapshot: `watchRoots` is reassigned on a settings
    // `claudePaths` edit (below), and POST /api/rescan must scan whatever is
    // watched now (ADR-0019).
    getRoots: () => watchRoots,
    now: () => Date.now(),
    usage: {
      getCurrent: usagePoller.getCurrent,
      setCredential: usagePoller.setCredential,
      pollOnce: usagePoller.pollOnce,
      discoverOrgs: discoverWithKey,
      stampHistory: sampleStore.stampUnstamped,
    },
    // Every POST endpoint, and the Organization rename PUT (#287), requires a
    // matching `x-maxprice-auth` header when this is set (f22).
    authToken: options.authToken,
    samples: (scope) => (scope === undefined ? sampleStore.all() : sampleStore.all(scope)),
    getSaturation: saturationReporting.snapshot,
    hub: {
      // Fan-out (ADR-0041): the hub-client owns the connection; the fleet's
      // hub-configured gate tracks whether a hub is set so its replica lifecycle
      // reconciles live. `c === null` ⇒ hub off.
      configure: (c) => {
        hubClient.configure(c);
        // ADR-0098: the repair skips its hub half when no hub is configured.
        hubTargetNow = c?.url ?? null;
        fleet.onHubConfigured(c !== null);
        void whenBootResolves(engineReady, () => organizationRepair.run());
      },
    },
    // The rescan handler's push trigger — same poke the watcher's onRecords
    // flush fires, so manually-surfaced rows reach the hub immediately.
    fleetSync: {
      notifyLocalChange: () => fleet.notifyLocalChange(),
      kickPull: () => fleet.kickPull(),
    },
    // The manual pricing refresh (ADR-0085), through the thunk described above.
    pricing: {
      refreshNow: () => {
        if (pricingRefresher === null) throw new Error("pricing refresher not wired yet");
        return pricingRefresher.refreshNow();
      },
    },
    // The rescan's identity side channel (ADR-0062): a re-probe of every
    // locally-resolvable project, so a repo cloned/moved/re-pointed since boot
    // is picked up by the one gesture that means "re-read my world".
    onRescan: () => identityProber.runAll(),
  });

  // SSE connections (/api/stream) are long-lived and idle between events;
  // Bun's 10s default idleTimeout would sever them well before the 15s
  // heartbeat. 0 disables it — the app's own bounds still apply (the
  // parent-death watchdog, or the host's init). bun-types 1.3.14 offers
  // `idleTimeout` on TCP options only, but Bun cuts an idle Unix-socket
  // stream at 10 s too and honours 0 there (checked on the Ubuntu primary),
  // hence the cast on the socket's options.
  const listen = options.listen;
  let server: ReturnType<typeof Bun.serve>;
  try {
    server =
      "unix" in listen
        ? Bun.serve({
            unix: listen.unix,
            fetch: app.fetch,
            idleTimeout: 0,
          } as unknown as Parameters<typeof Bun.serve>[0])
        : Bun.serve({ hostname: "127.0.0.1", port: listen.port, fetch: app.fetch, idleTimeout: 0 });
  } catch (err) {
    console.error("[sidecar] Bun.serve failed:", err);
    process.exit(1);
  }
  // The Host allowlist. A Unix socket has no port, and `fetch(…, { unix })`
  // sends the URL's bare host, so it accepts `localhost` alone (ADR-0119 §3);
  // the socket's own permissions are what keep other users out. TCP accepts
  // the bound address and `localhost`, each with the port, and never a bare
  // `localhost`.
  let announce: () => void | Promise<void> = () => {};
  if ("unix" in listen) {
    allowedHosts.add("localhost");
  } else {
    // Bun types `port` as optional, for a Unix-socket server; a TCP one has it.
    const port = server.port as number;
    allowedHosts.add(`127.0.0.1:${port}`);
    allowedHosts.add(`localhost:${port}`);
    announce = () => listen.announce(port);
  }

  // The acceptance harness's seam (#353): no startup pricing fetch. Said on the
  // diagnostic stream, awaited before the one-line stdout handshake.
  const startupPricingFetch = pricingStartupFetch(process.env[PRICING_STARTUP_FETCH_ENV]);
  if (!startupPricingFetch) {
    await new Promise<void>((resolve, reject) => {
      process.stderr.write(`${PRICING_STARTUP_FETCH_SKIPPED_LINE}\n`, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  // The hostname seam's acknowledgment, on the diagnostic stream.
  if (testHostname !== null) {
    await new Promise<void>((resolve, reject) => {
      process.stderr.write(`${hostnameSeamLine(testHostname)}\n`, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  // The handshake: the sidecar entry writes `LISTENING <port>` (ADR-0002). A
  // Unix socket announces nothing; its path is its host's own (ADR-0119 §1).
  await announce();

  // Issue #183: everything below is `void`ed and says nothing until it
  // finishes, which is why a launch that answered the handshake and then went
  // silent for minutes could only be narrowed to "somewhere in here". The
  // trace stamps every phase from the handshake and heartbeats the in-flight
  // set, so a gap in the ticks localizes the block instead of merely proving
  // it happened. Constructed HERE so `+0ms` means the handshake.
  const bootTrace = createBootTrace();

  // First-launch selection stays private, including on repeated launches
  // where no settings writer has persisted the seed. Publish only after the
  // selected home's walk has established its exclusion keys.
  void prepareOrganizationStore({
    home: currentHome,
    trackedOrganizations: currentTracked,
    loginOrganization: bootLogin?.organizationUuid ?? null,
    roots: watchRoots,
    assertionsReady,
    // The dormant snapshot is the set THIS walk admits under: the claims live
    // when the store is built against the set the walk is handed. For the
    // first store those are the claims installed at `assertionsReady`; a first
    // launch's seeded second walk reads whatever claims are live by then. A
    // first launch's null set makes nothing dormant.
    createStore: (trackedOrganizations) =>
      createEventStore({
        selfMachineId: machineId,
        scanCache,
        trackedOrganizations,
        dormantSessions: dormantSessions(
          currentPresumption.assertedBySession,
          trackedOrganizations,
        ),
        getPresumption: presumptionNow,
      }),
    onProgress: (p) => {
      bootTrace.detail("scan", `${p.filesParsed}/${p.filesTotal} files`);
      bootProgress.onScanProgress(p);
    },
  }).then(({ home, store }) => {
    if (currentHome === null) seededHome = home;
    currentHome = home;
    usagePoller.setOrganizations([...(trackedNow() ?? [])], currentHome);
    // A seeded Home is a Home INSTALL, so it installs the presumption too
    // (#277): without this, a machine whose Home was just chosen from its own
    // corpus would presume nothing for the life of the process. Before
    // `installStore`, so the first store any reader ever sees already answers
    // owner-less rows under it. `withSelfHome`, never `createPresumption`:
    // the fleet may already have installed peer Homes from the persisted
    // directory, and a fresh presumption would drop them.
    const installedHome = currentPresumption.selfHome;
    currentPresumption = withSelfHome(currentPresumption, currentHome);
    // The status's Quota organization follows a Home the seed just chose; a
    // persisted Home was installed at construction.
    if (currentHome !== installedHome) usagePoller.republish();
    // The first publish of this machine's Home (#281). It waits for the seed so
    // a first launch never publishes a placeholder that every peer would then
    // presume under, and drop its caches for, only to see it replaced.
    fleet.setHome(currentHome);
    installStore(store);
    // #311: the installed store's snapshot is what the engine now admits
    // under. A claim adopted during the walk queues the change that
    // reconciles it.
    queuedDormant = store.dormantSessions();
    admitAssertions();
    resolveLocalReady();
    // ADR-0122 §3: a Home this walk chose goes to the host once its store is
    // installed. `seededHome` is set only above, and only when no persisted
    // Home was the walk's input, so a persisted Home, a seed of none and every
    // later install or Home change report nothing.
    if (seededHome !== null) options.onHomeSeeded?.(seededHome);
  }, rejectLocalReady);

  // Gate data handlers on the installed home corpus and its disk feeders.
  // Replica/archive seeding waits for localReady; network never gates reports.
  engineReady = bootTrace.track(
    "engine",
    Promise.all([
      bootTrace.track("scan", localReady),
      bootTrace.track("replica", fleet.loadReplicaAtBoot()),
      // The archive's disk load (never rejects — a failure degrades instead,
      // ADR-0069 §3). Local disk only, like the replica: never the network.
      bootTrace.track(
        "archive",
        localReady.then(() => localArchive.loadAtBoot()),
      ),
      // #310: the persisted Organization assertions, installed in the
      // presumption cell. Local disk only, and it never rejects.
      bootTrace.track("assertions", assertionsReady),
    ]).then(() => {
      fleet.notifyLocalChange();
    }),
  );

  // The corpus walk's end (ADR-0067): announce the `merging` phase to anyone
  // still on the splash. Off `localReady` rather than `engineReady`,
  // because the whole point is the window BETWEEN them — the one a hub client's
  // replica load occupies and a hub-less client's does not (the reporter drops
  // this frame entirely in the latter case). A failed walk announces nothing.
  void whenBootResolves(localReady, () => bootProgress.scanFinished());

  // The boot readiness signal (ADR-0047): flip `ready: true` — broadcast as a
  // status:changed frame — when the SAME local gate the data handlers await
  // settles. Never the network; never cleared again this process. Carries the
  // terminal `bootProgress` in the same patch (ADR-0067).
  void bootTrace.track("ready-signal", wireReadySignal(engineReady, liveHub, bootProgress));

  // The scan cache's one write (ADR-0048): after the same gate, behind a
  // macrotask yield so the ready frame's flush always beats the serialization.
  void bootTrace.track("scan-cache", wireScanCachePersist(engineReady, scanCache));

  // The Identity directory's boot probe (ADR-0062): after the same gate, behind
  // the same macrotask yield — the scanned corpus is what tells the prober
  // which projects exist and where.
  // Tracked with particular care (issue #183): a live reproduction on
  // 2026-08-26 put a 590,904 ms block's start at +2.141 s — 0.53 s after the
  // rest of the fan-out finished, which is exactly here. `runAll()`'s reads
  // are asynchronous now, so a repeat costs this phase rather than the loop;
  // the trace is what will say so, since the phase stays in flight and the
  // heartbeat keeps naming it.
  void bootTrace.track(
    "identity-probe",
    wireIdentityProbe(
      engineReady,
      () => identityProber.runAll(),
      () => {
        initialIdentityProbeSettled = true;
        liveHub.patchStatus({ identityReady: !identityProbePending });
      },
    ),
  );

  // The archive's boot sweep (ADR-0069 §5): once the corpus scan has landed,
  // reconcile engine → archive — this is the retroactive first-boot capture,
  // the crash-loss self-heal, and the deleted-file reset, all one mechanism.
  // Then the 5-min interval keeps it converged (and retries a degrade).
  //
  // Settle, not resolve — the same rationale the three wirings above carry: a
  // boot whose replica load rejected still scanned the corpus, and that corpus
  // is precisely what the retroactive capture exists to archive. Catching is
  // also what keeps the interval armed at all: an uncaught derivation of
  // `engineReady` would reach the `unhandledRejection` handler below, which
  // exits(1) — the sidecar would die moments after LISTENING and never sweep.
  void bootTrace.track(
    "archive-sweep",
    engineReady
      .catch(() => {
        // Logged by wireReadySignal; the sweep cares only that the boot settled.
      })
      .then(() => {
        void localArchive.sweep();
        localArchive.startSweeps();
      }),
  );

  // ADR-0098: the private seed has settled before the boot gate. Repair the
  // archive/hub after local sources have loaded; network never gates reports.
  void bootTrace.track(
    "organization-repair",
    engineReady
      .catch(() => {
        // The walk still ran; the seed and the repair read its verdicts.
      })
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
      .then(() => organizationRepair.run()),
  );

  // Load the persisted usage history after the handshake, for the same reason
  // the event-store scan is deferred — a large read mustn't gate the LISTENING
  // line. The poller (started below) reads `latest()` lazily, so an in-flight
  // load just means the first reading lands once it resolves.
  void bootTrace
    .track("usage-history", sampleStore.loadHistory())
    .catch((err: unknown) => console.error("[sidecar] usage-history load failed:", err));

  // `bootTrace.seal()` used to sit here. It moved DOWN to just after the
  // watcher phase is registered (issue #182) — every statement between here and
  // there is synchronous, so the trace loses no time, and the watcher was the
  // one boot phase the trace could not see.

  // Once the initial scan settles, reflect whether it found any usage data in
  // the status snapshot — a first-launch corpus stays `hasData: false`.
  void localReady
    .then(() => {
      markHasData();
      // The scan's full model set is now in the store (#110).
      pricingRefresher?.republish();
    })
    .catch((err: unknown) => {
      console.error("[sidecar] markHasData failed:", err);
    });

  // E11 + ADR-0041 (T14) — the best-effort pricing refresh: one fetch kicked
  // here, after the handshake, then a ~24h re-fetch loop. Both arms live inside
  // `wirePricingRefresh`, the single wiring site, and the startup one is `void`ed
  // in there so it never gates the handshake / scan / any endpoint: a request
  // landing before it resolves is served from the vendored snapshot. On a
  // successful upstream fetch the active snapshot is swapped; either way the
  // status's `pricing` object is rebuilt and broadcast (ADR-0053) — a `patch`
  // rather than a `setStatus` spread so a concurrent status updater can't
  // clobber it, and a nested object so the three provenance fields replace
  // whole and can never half-update into a state that lies.
  //
  // The refresh stays SILENT in the sense that matters (nothing throws, nothing
  // is gated, the vendored snapshot stands) — but a failure is no longer
  // invisible: it is recorded as `lastAttempt.failure`, which is the whole
  // reason a never-reached-upstream install can now be told apart from a
  // successful fetch of the same age.
  //
  // The same handle serves the manual endpoint; all triggers share one
  // attempt and cooldown (ADR-0085). ADR-0096 also loads/saves the pricing cache
  // here and retries unpriced model discovery; shutdown cancels both timers.
  pricingRefresher = wirePricingRefresh({
    cachePath: join(appDataDir, "pricing-cache.json"),
    patch: liveHub.patchStatus,
    models: () => getEngineStore().models(),
    startupFetch: startupPricingFetch,
  });
  // Republish `pricing.unpricedModels` the first time any raw model lands
  // (#110). The boot scan may already have emitted batches before this
  // subscription existed, so republish once now and once more when the scan
  // settles (above, beside markHasData); `swapStore` re-attaches on a fleet
  // rebuild.
  detachModelWatch = watchNewModels(getEngineStore(), pricingRefresher.republish);
  pricingRefresher.republish();

  // Start the 1/min usage poll. Idles until a credential arrives (the boot's
  // own, below, or POST /api/usage/credential). Standalone interval (not SSE-ref-counted) so
  // history accrues on any page (ADR-0024).
  usagePoller.start();
  // The hourly key listing (#366) beside it: idle on a Hub-configured client,
  // and until a key is pushed.
  keyListing.start();

  // The boot's session key (ADR-0121 §3), applied as POST
  // /api/usage/credential applies a pushed one, at the point the renderer's
  // launch push lands: after the poller and the key listing start, ahead of
  // its Hub push. The route's ack waits for the first poll before the key
  // listing; nothing waits here, so the same order runs as a chain.
  if (options.usageCredential !== null) {
    const credential = options.usageCredential;
    usagePoller.setCredential(credential);
    void usagePoller
      .pollOnce()
      .then(() => keyListing.keyArrived(credential.sessionKey))
      .catch((err: unknown) => console.error("[sidecar] boot credential poll failed:", err));
  }

  // The boot's Hub: the sidecar entry's standalone/E2E opt-in via
  // MAXPRICE_HUB_URL, or the Headless client's saved one (the packaged app
  // pushes via POST /api/hub/config instead). Configured AFTER start(): the
  // hub-client needs the poller/liveHub wiring live. Password optional
  // (ADR-0037).
  if (options.hub !== null) hubClient.configure(options.hub);

  // Watcher comes up after the handshake so a large initial filesystem scan
  // can't delay the LISTENING line past the Rust shell's 5s timeout.
  let watcher: Watcher | null = null;

  // The settings.json watcher (ADR-0014) — only created when the boot has a
  // settings path. Declared here so `shutdown` can tear it down.
  let settingsWatch: SettingsWatch | null = null;

  // The JSONL watcher's one serialized restart path (ADR-0014, ADR-0113): a
  // `claudePaths` edit (through `settingsWatch`) and a watch loss (through
  // each watcher's `onWatchLost`) both replace the watcher here, so the two
  // can never interleave. Always built, settings file or not: the standalone
  // sidecar loses watches too. `onReplaced` is the sole writer of
  // `watcher`/`watchRoots` after boot; the module closes the watcher it
  // supersedes.
  const watcherRestarts = createWatcherRestarts({
    resolveRoots,
    getCurrentRoots: () => watchRoots,
    getCurrentWatcher: () => watcher,
    createJsonlWatcher: (roots) => createWatcher(jsonlWatcherOptions(roots)),
    onReplaced: ({ watcher: next, roots }) => {
      watcher = next;
      watchRoots = roots;
      // Broadcast the watched paths so the status bar updates live: new after
      // a roots change, the same after a recovery.
      liveHub.patchStatus({ watchedPaths: roots });
      // …and the replacement's own health. UNCONDITIONAL, not
      // `if (readyTimedOut)`: this is the only writer on the restart path, so
      // it must both RAISE the flag for a replacement whose `ready` timed out
      // and HEAL it when a healthy replacement supersedes a degraded watcher,
      // a failed restart, or an exhausted recovery.
      liveHub.patchStatus({ watcherDegraded: next.readyTimedOut });
    },
    scan: (roots, reason) => {
      // Resolve the live store when the gated walk starts (ADR-0041), and
      // re-walk a replacement if a rebuild swaps during it. After a roots
      // change, a newly-added root's history lands outside the watcher path;
      // after a recovery, so do the writes the dead watches missed. Either way
      // `scanAndPoke` pushes them and invalidates local reports now.
      void scanAndPoke(
        getEngineStore,
        fleet,
        roots,
        reason === "roots" ? "root change" : "watch recovery",
      );
    },
    // A restart that failed leaves the PREVIOUS watcher installed — after a
    // roots change on the PREVIOUS roots, after a recovery closed — so file
    // watching no longer matches the configured paths, which is precisely what
    // `watcherDegraded` tells the user. This also fires for a rejecting
    // `resolveRoots()`, and that is still honest: either way the installed
    // watcher may not match the settings on disk. No self-heal here — only a
    // later successful `onReplaced` (or a late `ready`) clears it, which is the
    // correct polarity.
    onRestartFailed: () => liveHub.patchStatus({ watcherDegraded: true }),
    // Recovery hit its bound: the installed watcher keeps its dead watches.
    onRecoveryExhausted: () => liveHub.patchStatus({ watcherDegraded: true }),
  });

  // exitCode distinguishes a deliberate shutdown (0) from a crash (1) so the
  // Rust parent can tell them apart — an unhandledRejection exiting 0 would
  // look identical to a clean SIGTERM.
  // Idempotent: SIGINT, SIGTERM, unhandledRejection, and the parent-death
  // watchdog can all fire near-simultaneously. `??=` runs teardown once and the
  // first caller's exitCode wins. The try/catch guarantees process.exit still
  // runs if a teardown step rejects — otherwise the void-ed rejection would
  // re-enter shutdown via unhandledRejection and the process would never exit.
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (exitCode = 0): Promise<void> => {
    shutdownPromise ??= (async () => {
      try {
        // Sever the hub client BEFORE the poller (ADR-0035): the hub client may
        // void-call poller.stop() when it connects/fails, so tearing it down
        // first ensures nothing re-toggles the poller mid-teardown.
        await hubClient.stop();
        // Then the fleet (ADR-0041): hubClient.stop() above fires onDisconnected
        // into the fleet's hooks, so fleet.stop() runs after that has settled —
        // it stops the event-sync loops and closes the replica store.
        await fleet.stop();
        // Cancel the daily pricing-refresh timer so no tick fires post-teardown.
        pricingRefresher?.stop();
        detachModelWatch?.();
        // Cancel the saturation sample timer + any saturated heartbeat.
        saturationReporting.stop();
        // Cancel the hourly key listing (#366) so no tick fires post-teardown.
        keyListing.stop();
        // Drain the poller (await its in-flight poll), THEN flush the sample
        // store's queued disk writes, before stopping the server / exiting —
        // otherwise a queued usage-history appendFile can be truncated by
        // process exit (f17).
        await usagePoller.stop();
        await sampleStore.flush();
        liveHub.close();
        if (settingsWatch) await settingsWatch.close();
        // Drain any restart in flight before closing what it installed.
        await watcherRestarts.close();
        if (watcher) await watcher.close();
        // ADR-0098: cancel the repair's hub retry timer so no tick fires
        // post-teardown — and, since a tick reaches the archive, before the
        // archive is closed below.
        organizationRepair.stop();
        detachForeignEvidence?.();
        // The Local archive (ADR-0069) after the watcher, so no flush can
        // enqueue an append behind the barrier: `stop()` cancels the sweep
        // interval, drops the change-feed subscription, drains the write chain,
        // and closes the file handle. Best-effort like every close above — the
        // shared catch keeps a failure from skipping process.exit.
        await localArchive.stop();
        await server.stop(true);
      } catch (err) {
        console.error("[sidecar] shutdown teardown error:", err);
      }
      process.exit(exitCode);
    })();
    return shutdownPromise;
  };
  // Hand the real teardown to the parent-death watchdog, which the sidecar
  // entry armed at module scope long before this point (issue #182 — see
  // `sidecar-shutdown.ts`). Until this line lands, an orphaning exits
  // immediately instead. A host that armed no watchdog never fires it.
  deferredShutdown.set(() => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("unhandledRejection", (err) => {
    console.error("[sidecar] unhandled rejection:", err);
    void shutdown(1);
  });

  // Single source of truth for the JSONL watcher's wiring — reused for the
  // initial creation below and for every restart (a roots change or a watch
  // recovery), so a change to the store/hub plumbing can't drift between two
  // copies.
  //
  // Append-before-emit (Part 4.5 invariant): the watcher appends the
  // freshly-parsed records to the event store *before* it calls `onEvent`, so
  // the renderer's post-invalidation refetch can never observe a store missing
  // the events that triggered it.
  const jsonlWatcherOptions = (roots: string[]): CreateWatcherOptions => ({
    roots,
    onRecords: (records, projectSlug, sessionId, isSubagent) => {
      // Through the live accessor (ADR-0041): a fleet rebuild swaps the store, so
      // a watcher flush must feed whatever store is current, not the boot one.
      getEngineStore().append(records, projectSlug, sessionId, isSubagent);
      // A project the app has not probed this process — a brand-new checkout,
      // or a new worktree — gets its Repo identity resolved now (ADR-0062),
      // AFTER the append so the flush's own cwd capture is visible to the
      // prober's query. Every later flush for the same slug is a Set hit.
      // No await separates append from noticeSlug's synchronous pending
      // transition: an HTTP reader cannot see the new events between them.
      //
      // Guarded like the other two prober call sites (boot, rescan), and for a
      // sharper reason here: this one shares a `flush()` with the watcher's
      // `onEvent`, so a throw would unwind past `markHasData`,
      // `fleet.notifyLocalChange` AND the SSE `usage:new` emit for the batch —
      // the identity side channel would take the live pipeline down with it.
      // No live throw path exists today (probeRepoId, persist and broadcast all
      // catch); this is symmetry and defence against a future one, not a fix
      // for an observed crash.
      //
      // Since #183 the probe is asynchronous, and this call site is the one
      // that gains the most from it: it shares a `flush()` with the watcher's
      // `onEvent`, so a blocking read here used to stop the live pipeline for
      // as long as it lasted. The guard moved onto the promise — a synchronous
      // try/catch around a promise-returning call would guard nothing.
      void identityProber.noticeSlug(projectSlug).catch((err: unknown) => {
        console.error("[sidecar] watcher identity probe failed:", err);
      });
      // First data for a first-launch user who started a Claude session while
      // the app was open — broadcast `hasData: true` so the renderer's empty
      // state clears live. No-op once already `true`.
      markHasData();
      // Poke the fleet so the freshly-appended local rows are pushed to the hub
      // (share-gated inside the fleet); a no-op for a hub-less client.
      fleet.notifyLocalChange();
    },
    onEvent: (event) => {
      liveHub.emitUsage(event);
    },
    onError: (err) => console.error("[sidecar] watcher error:", err),
    // Self-healing degrade (issue #182): a `ready` that shows up after the
    // timeout clears the amber line, so the field means what is true now.
    // Wired for every watcher this process builds — the boot one and each
    // roots-change replacement — since either can time out.
    //
    // KNOWN GAP (pre-existing, deliberately not fixed here): this body is shared
    // by every watcher and closes over nothing identifying which one fired it,
    // so a SUPERSEDED watcher whose `ready` arrives late clears the flag for the
    // degraded replacement that took its place. Closing it needs per-watcher
    // identity in the options builder, which is a wider change than the
    // roots-change flag wiring below.
    onReadyLate: () => {
      console.log("[sidecar] watcher 'ready' arrived late — file watching confirmed");
      liveHub.patchStatus({ watcherDegraded: false });
    },
    // A watcher that lost watches it cannot get back (#338, ADR-0113) is
    // restarted through the shared restart path. Held until the engine is
    // ready, as the settings watch is: a replacement built before then would
    // skip the boot watcher's organization gate. The loss names its own
    // watcher, so one already replaced is ignored there.
    onWatchLost: (lost) => {
      void whenBootResolves(engineReady, () => watcherRestarts.recover(lost));
    },
  });

  // The watcher joins the traced fan-out rather than blocking `bootSidecar` on a
  // top-level `await` (issue #182). Two things come from that: a hung `ready`
  // now shows up as `watcher` sitting in every boot-trace tick's in-flight set
  // — in a log the Tauri shell tees to disk (ADR-0056) — instead of producing
  // ticks that look healthy right up to silence; and `bootSidecar` has NO top-level
  // await after the handshake at all, which is a far easier invariant to keep
  // than "the watchdog goes above the awaits" (ADR-0078).
  void bootTrace
    .track(
      "watcher",
      createWatcher(gateOrganizationWatcher(jsonlWatcherOptions(watchRoots), localReady)).then(
        (w) => {
          watcher = w;
          if (w.readyTimedOut) {
            bootTrace.detail("watcher", "ready timed out");
            liveHub.patchStatus({ watcherDegraded: true });
          }
          // The settings watch is built HERE, inside the watcher's `.then`, and
          // not concurrently: `onReplaced` is the sole writer of
          // `watcher`/`watchRoots` after boot, and racing it against this
          // assignment could clobber a newer watcher with the boot one —
          // leaving `watcher` on the old roots while `watchRoots` claims the new
          // ones, exactly the invariant `watcher-restarts.ts` is built around.
          // (A watch loss cannot race it either: a watcher reports one only
          // after it has been handed out, a settle window after this `.then`.)
          // The delay it costs is bounded by WATCHER_READY_TIMEOUT_MS and
          // covers nothing that worked before: the settings watcher runs
          // `ignoreInitial: true`, so an edit predating its creation was never
          // seen anyway.
          void whenBootResolves(engineReady, () => wireSettingsWatch());
        },
      ),
    )
    .catch((err: unknown) => {
      // A rejecting createWatcher leaves the sidecar serving reports from a
      // static corpus — degraded exactly as a timed-out ready does, so it says
      // the same thing rather than dying.
      console.error("[sidecar] watcher creation failed:", err);
      liveHub.patchStatus({ watcherDegraded: true });
      void whenBootResolves(engineReady, () => wireSettingsWatch());
    });

  // Every phase is registered — including the watcher above; start the
  // heartbeat. The four `engineReady` wirings are still in flight when the
  // fan-out's own phases settle, which is the point: the first version of this
  // trace declared "fan-out complete" half a second BEFORE the observed block
  // began, and would have named nothing. After this the trace is
  // self-terminating — the last phase to settle stops it, and a boot that never
  // settles stops it at the tick cap.
  bootTrace.seal();

  // Watch settings.json for `claudePaths` edits (ADR-0014). The renderer is
  // the file's sole writer and writes atomically (temp + rename), so a `change`
  // is always a complete document. `add` is handled identically: on a fresh
  // install the renderer creates settings.json *after* the sidecar boots, so
  // the first observed event is an `add`. The reentrancy-safe restart
  // orchestration lives in `watcher-restarts.ts` (review I1/I2, ADR-0113).
  function wireSettingsWatch(): void {
    if (settingsPath !== undefined) {
      settingsWatch = createSettingsWatch({
        settingsPath,
        restarts: watcherRestarts,
        // The ADR-0041 fleet-toggle hook — fired on every settings edit (roots
        // changed or not), so a share/replica toggle applies in-session without a
        // relaunch. `settingsPath` is narrowed to string inside this block.
        onSettingsChanged: () => {
          const s = readSettingsFile(settingsPath);
          if (s !== null) {
            // The resolved tracked set this edit REPLACES — captured before
            // either of its two inputs is written below, because that set, not
            // Home, is what decides whether the engine must be rebuilt (#277,
            // D8). A combined edit (Home and the list at once) is compared
            // whole, which is the only comparison that can see the two cancel.
            const previousTracked = trackedNow();
            const previousDormant = queuedDormant;
            // The tracked list (the #260 lifecycle decision, item 1) is
            // re-read on every settings edit so the NEXT store this process
            // builds uses it — the fleet's `createStore` closes over
            // `trackedNow()`, so ANY later rebuild (a replica toggle, an epoch
            // resync, a tracked-set change) picks up the new list, whatever
            // triggered it. Assigned FIRST so neither the fleet's settings hook
            // below nor the set comparison can read a stale list, and so a
            // combined edit rebuilds under both.
            currentTracked = s.trackedOrganizations;
            const scopeChanged = s.organizationScope !== currentScope;
            currentScope = s.organizationScope;
            fleet.applySettings({
              hubShareEvents: s.hubShareEvents,
              hubFleetReplica: s.hubFleetReplica,
            });
            // ADR-0098 as amended by #277 (D8) and #276: a Home change always
            // installs a new presumption, and the RESOLVED tracked set decides
            // the work — nothing, an additive re-walk, or a scoped repair. A
            // null setting falls back to the SEEDED organization, never the
            // login file. Called UNCONDITIONALLY, because a list-only edit
            // moves the set without moving Home, and that is exactly the live
            // exclude/track flow. The driver queues it behind whatever edit is
            // still being applied, so the six values captured here are the
            // ones it runs with however long it waits.
            const nextHome = s.homeOrganization ?? seededHome;
            const homeChanged = nextHome !== currentHome;
            currentHome = nextHome;
            // Publish a changed Home at ARRIVAL, not in the driver's queue
            // (#281): it is directory metadata and moves no row here, and the
            // Hub's answer is idempotent, so nothing it could race with is
            // waiting in that queue. The Hub's machines poke then carries it
            // to every peer's directory refresh.
            if (homeChanged) fleet.setHome(currentHome);
            // #311: computed after both writes, from the new tracked set and the installed claims.
            const nextDormant = dormantNow();
            queuedDormant = nextDormant;
            void organizationSettings.apply({
              home: currentHome,
              homeChanged,
              previousTracked,
              nextTracked: trackedNow(),
              previousDormant,
              nextDormant,
            });
            // A scope change moves only which Organization the status's usage
            // connection describes: one status patch, no reading.
            if (scopeChanged) usagePoller.republish();
          }
        },
      });
    }
  }
}
