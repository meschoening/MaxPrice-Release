import { z } from "zod";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { stream, streamSSE } from "hono/streaming";
import {
  ALL_ORGANIZATIONS,
  costModeSchema,
  displayOrganizationLabels,
  hubConfigSchema,
  MAX_INTRADAY_BUCKETS,
  nativeBucketMs,
  ORGANIZATION_ASSERTIONS_PATH,
  ORGANIZATION_LABEL_MAX,
  ORGANIZATIONS_PATH,
  organizationAssertRequestSchema,
  organizationRenameRequestSchema,
  PROJECT_IDENTITY_PATH,
  PROJECT_MERGE_PATH,
  projectMergeMutationRequestSchema,
  resolveOrganizationLabel,
  resolveOrganizationScope,
  spanSchema,
  SPAN_WINDOW_MS,
  WEEK_BUCKET_MS,
  SSE_EVENT,
  activePricingSnapshot,
  PRICING_REFRESH_PATH,
  RESCAN_PATH,
  STORAGE_CLEAN_PATH,
  STORAGE_FORGET_PATH,
  STORAGE_PATH,
  storageForgetRequestSchema,
  storedUsageCredentialSchema,
  type CostMode,
  type CredentialAck,
  type DiscoveredOrg,
  type DiscoverOrgsResponse,
  type ErrorResponse,
  type ForgetSessionRef,
  type IntradayResponse,
  type OrganizationAssertionsResponse,
  type OrganizationAssertResponse,
  type OrganizationsResponse,
  type PricingRefreshResponse,
  type ProjectMergeMutationRequest,
  type ProjectMergeMutationResponse,
  type ReadoutResponse,
  type RescanResponse,
  type StorageCleanResponse,
  type StorageForgetResponse,
  type SessionErrorFrame,
  type SessionEventFrame,
  type SidecarMachinesResponse,
  type SidecarProjectIdentityResponse,
  type UsageCredential,
  type UsageSample,
} from "@maxprice/shared";
import { aggregateSessionEvents, type SessionEventsAggregate } from "./engine/session-events";
// The entry block's boot. `boot.ts` imports `buildApp` back from this module;
// its header says why that cycle is safe.
import { bootOptionsFromEnv, bootSidecar, logMonotonicClock } from "./boot";
import type { LiveHub } from "./live-hub";
import type { FleetForgetResult, FleetSync } from "./fleet";
import type { StorageSnapshot } from "./storage";
import type { OrganizationRenameResult } from "./organizations";
import type { OrganizationAssertResult } from "./organization-assertions";
import {
  quotaOrganization,
  quotaSampleScope,
  scopeOrganizations,
  type OrganizationScopeState,
} from "./organization-scope";
import { mintRescanWalkKey, scanGate } from "./scan-gate";
import type { ScanCache } from "./engine/scan-cache";
import type { EventStore, ScanProgress } from "./engine/store";
import {
  constantTimeEqual,
  installParentWatchdog,
  libcGetppid,
  streamSSEPump,
  type DiscoverOrgResult,
  type SampleScope,
  type UsagePollerCurrent,
} from "@maxprice/usage-core";
import type { SaturationSnapshot } from "./saturation";
import type { BootProgressReporter } from "./boot-progress";
import { deferredShutdown } from "./sidecar-shutdown";
import { defaultTimeZone, isValidTimeZone } from "./engine/timezone";
import { localDateUncached } from "./engine/local-date";
import { isInstantBound, parseRangeBound } from "./engine/range";
import { aggregateDaily, aggregateDailyByMachine, aggregateDailyByProject } from "./engine/daily";
import { aggregateIntraday } from "./engine/intraday";
import { createReportCache } from "./engine/report-cache";
import { createBlockReports } from "./engine/block-formation-cache";

export type BuildAppDeps = {
  allowedOrigins: string[];
  // Returns true if the Host header is acceptable (defeats DNS rebinding).
  isAllowedHost: (host: string | undefined) => boolean;
  // Pub/sub hub backing the SSE channel and the /api/status snapshot.
  liveHub: LiveHub;
  // The usage engine, as LIVE accessors (ADR-0041): the fleet resync path
  // rebuilds the store in-session (fresh store → local rescan + replica
  // reseed → swap), so handlers must read it per-request. engineReady gates on
  // BOTH local sources — the initial scan AND the replica file load — never
  // the network (the hub pull is background).
  store: () => EventStore;
  // A populated report view held through an automatic fleet reseed. Mutating
  // actions (rescan) always use `store`, never this temporary view.
  reportStore?: () => EventStore;
  engineReady: () => Promise<void>;
  // Loopback machine directory (ADR-0041): the fleet's cached directory + this
  // machine's own id, so the renderer names machines offline. M6 consumes it.
  machines: () => SidecarMachinesResponse;
  // Loopback Identity directory (ADR-0062): this machine's id + every known
  // (machineId, projectSlug) → repoId row, own and fleet-mirrored alike. The
  // renderer folds checkouts of one repo together from it.
  projectIdentity: () => SidecarProjectIdentityResponse;
  projectMerge: (request: ProjectMergeMutationRequest) => ProjectMergeMutationResponse;
  // The currently-watched JSONL roots, as a live accessor (NOT a snapshot):
  // the settings watcher reassigns `watchRoots` on a `claudePaths` edit
  // (ADR-0014), and POST /api/rescan must scan whatever is watched *now*
  // (ADR-0019). Returns the same array the watcher uses, so a manual rescan
  // and the live pipeline never diverge on which roots they read.
  getRoots: () => string[];
  // Wall clock for the time-windowed handlers (currently only `/api/intraday`,
  // whose span window ends at "now"). Injected so tests can pin a deterministic
  // instant rather than depending on `Date.now()` at run time.
  now: () => number;
  // Usage-limits (ADR-0023/0024). The renderer pushes a credential via
  // POST /api/usage/credential; GET /api/usage/current returns last-known state;
  // POST /api/usage/discover-orgs proxies org discovery (CORS workaround).
  usage: {
    // INTERNAL poller state — the WIRE shape of GET /api/usage/current is
    // narrower (`{ sample, weeklyResetAt }`, f10): the handler projects those
    // off this. `connection` / `lastSampleAt` stay on the internal type for the
    // poller's own bookkeeping and the status snapshot. One Organization's
    // state: the handlers pass the Quota organization, and `null` (no Home) is
    // the answer that names none.
    getCurrent: (organization?: string | null) => UsagePollerCurrent;
    setCredential: (c: UsageCredential | null) => void;
    pollOnce: () => Promise<void>;
    discoverOrgs: (sessionKey: string) => Promise<DiscoverOrgResult>;
    // Stamps every unstamped usage-history line with a legacy pushed blob's
    // `orgId` (#279) — the sample store's stampUnstamped: resolves the
    // number stamped (0, with no file I/O, once nothing is left), rejects when
    // the rewrite fails.
    stampHistory: (organizationUuid: string) => Promise<number>;
  };
  // Bearer token EVERY POST endpoint enforces when present (f22) — the two
  // usage endpoints, the hub config, and the manual rescan: a request must
  // carry a matching `x-maxprice-auth` header. Null in standalone dev
  // (MAXPRICE_AUTH_TOKEN unset) → no auth enforced, preserving the
  // Vite/standalone path; set to the env var at construction otherwise.
  authToken: string | null;
  // The usage-history samples — /api/blocks and the `block` span read them for
  // observed-window formation + the 5h limit % (ADR-0028). No scope is every
  // sample held (no Home); a scope is the Quota organization's, unstamped lines
  // counting as its `home`'s — the sample store's `all(scope)`. An accessor
  // (not a snapshot) so the handler reads whatever the poller has appended at
  // request time.
  samples: (scope?: SampleScope) => readonly UsageSample[];
  // Hub opt-in (ADR-0035/0037): the renderer pushes {url, password} (password
  // nullable — open hub) or url:null (hub off) via POST /api/hub/config;
  // `bootSidecar` wires this to the hub-client.
  hub: {
    configure: (config: { url: string; password: string | null; autoHeal: boolean } | null) => void;
  };
  // The fleet's two manual triggers (ADR-0041, ADR-0055).
  //
  // `notifyLocalChange` — the PUSH trigger: any ingest path that lands local
  // rows outside the watcher must poke it, or the rows sit unpushed until the
  // next watcher flush / 5-min sweep. Four sites hold that invariant — the boot
  // scan and the settings-change (roots edit) scan, both through the shared
  // `scanAndPoke` helper; the watcher's own `onRecords` flush; and POST
  // /api/rescan, the one that reaches it through THIS dep.
  //
  // `kickPull` — the PULL trigger, reached only from POST /api/rescan
  // (ADR-0055). Without it the refresh gesture was structurally local-only: it
  // re-walked this machine's disk and pushed the result, and had no way to ask
  // the hub what this machine had missed.
  //
  // Both are gated inside event-sync (share / replica / connection); a hub-less
  // client no-ops on either.
  fleetSync: {
    notifyLocalChange: () => void;
    kickPull: () => void;
  };
  // The manual pricing refresh (ADR-0085): POST /api/pricing/refresh runs (or
  // joins) one attempt of the same best-effort upstream fetch the startup arm
  // and the ~24h ticker use, and answers with the rebuilt `pricing` status plus
  // the count of models the attempt made priceable. Wired in `bootSidecar` to the
  // `wirePricingRefresh` handle; a thunk because that handle is created AFTER
  // the LISTENING handshake, and `buildApp` before it.
  pricing: {
    refreshNow: () => Promise<PricingRefreshResponse>;
  };
  // Fired (fire-and-forget) once POST /api/rescan's walk has landed — the
  // Identity directory's re-probe trigger (ADR-0062). Optional and deliberately
  // NOT part of `fleetSync`: `buildApp` stays engine-pure, and this is the boot's
  // side channel for "the corpus was just re-read on the user's say-so", the
  // one gesture that can surface a project whose directory appeared (or moved)
  // since boot.
  // Returns a promise since #183 made the probe asynchronous, and the rescan
  // handler deliberately does NOT await it — see the call site.
  onRescan?: () => Promise<void>;
  // The Settings › Storage report (map #124). A dedicated accessor rather than
  // a field on the status snapshot: status is patch-merged and broadcast ~1/min
  // to every client, so putting a directory walk behind it would mean paying
  // that walk forever, on every install, for a number read on one page (#126
  // §1). Built in `bootSidecar` because it needs the app-data paths, the fleet
  // replica, and the Rust-resolved webview path — `buildApp` stays engine-pure.
  // The wire carries `report`; `forgetSessions` rides along for the action
  // endpoints (#132), which need the list measured at the same instant as the
  // guard verdict that authorised it.
  storage: () => Promise<StorageSnapshot>;
  // The two Settings › Storage actions (#132), beside the report they move.
  //
  // `clean` is the safe half — it drops the parse cache and compacts the
  // replica's superseded lines, both rebuilt from files the user already has.
  //
  // `forget` is the destructive half, and it takes the ALREADY-CLASSIFIED
  // session list rather than doing its own classification: the route re-runs
  // `storage()` for a fresh walk, fresh guards and a fresh list in one call, and
  // hands the list straight over. That is deliberate — it keeps the guard
  // verdict and the rows it authorised measured at the same instant, which two
  // separate passes could not promise.
  storageActions: {
    clean: () => Promise<StorageCleanResponse>;
    forget: (sessions: readonly ForgetSessionRef[]) => Promise<FleetForgetResult>;
  };
  // ADR-0098 / #287: the Settings roster, which the Home organization select
  // also reads. `rename` applies PUT /api/organizations/:uuid's rules
  // (`createOrganizationRename`) and answers the fresh roster or a refusal.
  // `recordDiscovery` seeds the roster with what Connect's discovery answered
  // (#283) — POST /api/usage/discover-orgs calls it on every success.
  // `rememberOrganization` keeps one Organization in that roster: POST
  // /api/usage/credential records a legacy blob's `orgId` there (#283). It is
  // the Organization the history was stamped with, which the key may no longer
  // list. The key's other Organizations arrive by `learnFromKey` on a client
  // with no Hub, or by the Hub's roster on a hub-connected one (#366).
  organizations: {
    list: () => Promise<OrganizationsResponse>;
    rename: (uuid: string, label: string | null) => Promise<OrganizationRenameResult>;
    recordDiscovery: (orgs: readonly DiscoveredOrg[]) => Promise<void>;
    rememberOrganization: (uuid: string) => Promise<void>;
    // #366: a key arrived; a client with no Hub lists that key's Organizations
    // into the roster (key-listing.ts). Fire-and-forget: never gates the ack.
    learnFromKey?: (sessionKey: string) => void;
  };
  // What the `organization` query param resolves against (#278): the effective
  // Home and the resolved tracked set, as a LIVE accessor — a settings edit
  // moves either in-session, and the next request must resolve under it.
  // `scopeOrganizations` turns the param plus this into the store's
  // `organizations` axis; `{ home: null, tracked: null }` narrows nothing.
  organizationScope: () => OrganizationScopeState;
  // #310: the Organization assertions. GET /api/organization-assertions reads
  // this machine's resolved claims; PUT sets or clears them in bulk under
  // `createOrganizationAssert`'s rules. Optional: absent ⇒ neither route is
  // mounted (the test apps that wire no assertion store).
  organizationAssertions?: {
    list: () => Promise<OrganizationAssertionsResponse>;
    assert: (
      sessionIds: readonly string[],
      organizationUuid: string | null,
    ) => Promise<OrganizationAssertResult>;
  };
  // Live Loop-lag summary (issue #116 / F4). GET /api/status composes this
  // over the hub-held snapshot: verdict-edge frames + the saturated heartbeat
  // keep the hub's copy only flip-fresh, but one status read must answer "is
  // the loop healthy?" with CURRENT numbers (the F1–F3 cold-start check).
  getSaturation: () => SaturationSnapshot;
};

/**
 * Walk `roots` into the live store, then push local changes and invalidate
 * local reports. Shared by roots changes and watch recovery (ADR-0113).
 *
 * The invariant this owns (ADR-0041): any ingest that lands local rows OUTSIDE
 * the watcher path must poke the fleet, or those rows sit unpushed until the
 * next watcher flush / 5-min sweep. The watcher itself pokes from `onRecords`,
 * but it runs `ignoreInitial: true`, so nothing it does covers a full walk —
 * hence watcher restarts route their walk through here.
 * The poke is share- and connection-gated inside event-sync, so it costs a
 * hub-less client nothing.
 *
 * A failed scan pushes and invalidates NOTHING — note the `return` in the
 * catch. Do not "simplify" this to `.catch(...).then(poke)`: a handler that returns
 * undefined yields a RESOLVED promise, so the poke would fire after a failure.
 *
 * `label` names the failing path in the log ("watch recovery scan failed" vs
 * "root change scan failed").
 *
 * POST /api/rescan deliberately does NOT use this helper: it needs `scan`'s
 * return value for the response's `added` count and owns its invalidation in
 * the renderer (ADR-0019).
 *
 * The walk runs through the shared `scanGate` (ADR-0059), so it never overlaps
 * the rescan endpoint's walk or the fleet's rebuild walk on the single JS
 * thread. Read the store accessor INSIDE that gate. A rebuild can still swap
 * it while this walk awaits I/O (its archive/replica seed follows its gated
 * walk), so repeat on the replacement before announcing completion. This
 * stays inside the gate: no corpus walks overlap, including the retry.
 */
export async function scanAndPoke(
  getStore: () => EventStore,
  fleetPush: Pick<FleetSync, "notifyLocalChange" | "invalidateReports">,
  roots: string[],
  label: string,
  onProgress?: (p: ScanProgress) => void,
): Promise<void> {
  try {
    await scanGate.run(async () => {
      let store: EventStore;
      do {
        store = getStore();
        await store.scan(roots, onProgress);
      } while (store !== getStore());
    });
  } catch (err) {
    console.error(`[sidecar] ${label} scan failed:`, err);
    return;
  }
  fleetPush.notifyLocalChange();
  fleetPush.invalidateReports();
}

/**
 * Patch `ready: true` into the live status once `engineReady` SETTLES — the
 * boot readiness signal (ADR-0047). Extracted from the boot (like `scanAndPoke`)
 * so the semantic is testable.
 *
 * Settle, not resolve: a constituent rarely rejects (the store's scan skips
 * an unreadable root or file rather than throwing; the replica load
 * self-heals a corrupt cache), but a boot walk that throws rejects
 * `localReady` (#340), and leaving `ready: false` would hold the boot splash
 * forever on a perfectly healthy SSE connection. The app's per-endpoint error
 * surfaces own the failure story once revealed — the splash owns only
 * pre-ready sidecar/stream failures.
 *
 * `ready` is never cleared afterwards: a rescan (manual ⇧R, a claudePaths
 * edit) is a data update on a live app, not a boot.
 *
 * Returns the settled chain so tests can await the patch deterministically;
 * `bootSidecar` `void`s it.
 */
export function wireReadySignal(
  engineReady: Promise<void>,
  liveHub: Pick<LiveHub, "patchStatus">,
  bootProgress?: Pick<BootProgressReporter, "finish">,
): Promise<void> {
  return engineReady
    .catch((err: unknown) => {
      console.error("[sidecar] engine boot readiness failed:", err);
    })
    .then(() => {
      // ONE patch, both facts (ADR-0067). `ready: true` and the terminal
      // `bootProgress` describe the same instant, and the renderer handles a
      // status frame whole — patching them separately would put a frame on the
      // wire that says the boot is finished beside progress still claiming work
      // in flight, which is exactly the self-contradiction the reporter's
      // patch-whole rule exists to prevent.
      liveHub.patchStatus({
        ready: true,
        ...(bootProgress && { bootProgress: bootProgress.finish() }),
      });
    });
}

/**
 * The scan cache's ONE write (ADR-0048): persist the boot scan's parsed
 * records after `engineReady` settles. Extracted from the boot (like
 * `wireReadySignal`) so the timing semantic is testable.
 *
 * After ready, never before: serialization is ~100–200ms of synchronous
 * JSON.stringify, and running it while the boot gate is still pending would
 * steal the thread from the ready patch and delay the splash reveal. The
 * macrotask yield below lets the `status:changed` frame flush first even
 * though save() is queued on the same settled promise. Settle, not resolve —
 * a boot whose replica load rejected still ran its scan, and those parses are
 * worth keeping (wireReadySignal already logs the rejection; no double log).
 *
 * A failed save is logged and dropped: the cache is an optimization — the
 * next boot simply parses cold.
 *
 * Returns the settled chain so tests can await the write deterministically;
 * `bootSidecar` `void`s it.
 */
export function wireScanCachePersist(
  engineReady: Promise<void>,
  cache: Pick<ScanCache, "save">,
): Promise<void> {
  return engineReady
    .catch(() => {
      // Logged by wireReadySignal; the write cares only that the boot settled.
    })
    .then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        await cache.save();
      } catch (err) {
        console.error("[sidecar] scan-cache save failed:", err);
      }
    });
}

/**
 * The Identity directory's boot probe (ADR-0062 §2): probe every locally
 * resolvable project once `engineReady` SETTLES. Extracted from the boot (like
 * `wireScanCachePersist`) so the timing semantic is testable.
 *
 * After ready, never before: the prober reads the store's cwd captures to
 * decide what to probe, so running it against a half-scanned corpus would
 * simply see fewer projects. The macrotask yield lets the `status:changed`
 * ready frame flush first, exactly as the scan-cache write does. Settle, not
 * resolve — a boot whose replica load rejected still scanned local disk, and
 * those projects are all this probes (`wireReadySignal` already logged the
 * rejection; no double log).
 *
 * A failed probe round is logged and dropped: the directory is additive, the
 * next probe event (rescan, a new slug) re-covers it, and a persisted row is
 * never harmed by a probe that didn't happen.
 *
 * `onSettled` releases the initial Identity directory readiness hold even on
 * failure, independently of the Desktop's `ready` signal. Returns the settled
 * chain so tests can await it deterministically; `bootSidecar` `void`s it.
 */
export function wireIdentityProbe(
  engineReady: Promise<void>,
  runAll: () => Promise<void>,
  onSettled: () => void,
): Promise<void> {
  return engineReady
    .catch(() => {
      // Logged by wireReadySignal; the probe cares only that the boot settled.
    })
    .then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        await runAll();
      } catch (err) {
        console.error("[sidecar] boot identity probe failed:", err);
      } finally {
        onSettled();
      }
    });
}

type CommonQuery = {
  since?: string;
  until?: string;
  mode: CostMode;
  // The IANA zone every report buckets local calendar days into (ADR-0015).
  // Carried as the `tz` query param; defaults to the host zone when omitted
  // (a direct sidecar call, an older client). Threaded into the store query
  // and every aggregator so day grouping honours the user's Timezone setting.
  tz: string;
  // Multi-value as of Part 4 — the filter rail passes its full project / model
  // multi-selects through. An empty array means "no filter".
  projects: string[];
  models: string[];
  // Machine ids to include (ADR-0041 M5) — repeated `machine=` params, exact
  // match on the event's machineId. An empty array means "no filter".
  machines: string[];
  // The Organization scope (#278) — the one `organization=` param resolved by
  // `scopeOrganizations`: Home's uuid when the param is absent or stale, the
  // tracked set under `all`, and `[]` (no narrowing) on a machine with no Home.
  organizations: string[];
};

// Parse + validate the shared `mode` query param. Returns the parsed CostMode,
// or a Response carrying the pinned 400 envelope (packages/shared/src/error.ts)
// so callers can early-return. Defaults to "auto" when omitted.
function parseMode(c: Context): CostMode | Response {
  const modeParam = c.req.query("mode") ?? "auto";
  const mode = costModeSchema.safeParse(modeParam);
  if (!mode.success) {
    const body: ErrorResponse = { error: `invalid mode: ${modeParam}` };
    return c.json(body, 400);
  }
  return mode.data;
}

// Parse + validate the shared `tz` query param (the IANA zone for local-day
// bucketing, ADR-0015). Returns the validated zone, or a Response carrying the
// pinned 400 envelope (packages/shared/src/error.ts) so callers can
// early-return. An omitted `tz` defaults to the host zone. Used by both
// `parseCommonQuery` and the `/api/intraday` handler (where `today` needs it).
function parseTz(c: Context): string | Response {
  const tzParam = c.req.query("tz");
  if (tzParam !== undefined && !isValidTimeZone(tzParam)) {
    const body: ErrorResponse = { error: `invalid tz (expected IANA zone): ${tzParam}` };
    return c.json(body, 400);
  }
  return tzParam ?? defaultTimeZone();
}

// The multi-value project / model / machine filters every report endpoint
// reads. Repeated params: ?project=a&project=b, ?machine=m1&machine=m2. Hono's
// queries() returns every value; an empty array means "no filter". The machine
// axis (ADR-0041 M5) is exact-match on the event's machineId.
function readFilters(c: Context): { projects: string[]; models: string[]; machines: string[] } {
  return {
    projects: c.req.queries("project") ?? [],
    models: c.req.queries("model") ?? [],
    machines: c.req.queries("machine") ?? [],
  };
}

// Wrap a handler's body in the shared try/catch + pinned 500 envelope. Used by
// every report GET (default `errorMessage`) and the rescan POST (which passes
// "rescan failed"). The thrown error is logged server-side only; the renderer
// sees the fixed `errorMessage` so a filesystem path in the cause never leaks.
// Validation that returns a 400 Response short-circuits inside `handler` before
// it awaits `store.ready`, so a bad query still 400s without waiting on the
// initial scan (the ordering the un-wrapped handlers relied on).
function withEngineErrors(
  name: string,
  handler: (c: Context) => Promise<Response>,
  errorMessage = "usage engine failed",
): (c: Context) => Promise<Response> {
  return async (c) => {
    try {
      return await handler(c);
    } catch (err) {
      console.error(`[sidecar] ${name} failed:`, err);
      const error: ErrorResponse = { error: errorMessage };
      return c.json(error, 500);
    }
  };
}

// Validate the query params every report endpoint accepts. Returns a Response
// on validation failure so handlers can early-return. The shape matches the
// pinned ErrorResponse envelope from packages/shared/src/error.ts.
//
// `scope` is the live Organization scope state (`deps.organizationScope()`),
// read once per request. The `organization` param never 400s: a value that
// names nothing tracked resolves to Home (#262 items 2 and 11) — a scope left
// stale by an exclusion or a shrunken set is answered as Home, the same rule
// the renderer's `parseSettings` applies, rather than refused.
function parseCommonQuery(c: Context, scope: OrganizationScopeState): CommonQuery | Response {
  // Empty since/until (?until=) coerce to absent — an empty bound must not
  // reach the store, where `date.ymd > ""` is true for every date (a silent
  // empty report). Consistent with the empty-array-means-no-filter convention.
  const since = c.req.query("since") || undefined;
  const until = c.req.query("until") || undefined;
  const { projects, models, machines } = readFilters(c);

  const mode = parseMode(c);
  if (mode instanceof Response) return mode;
  // The IANA zone for local-day bucketing (ADR-0015). User-derived, so an
  // unconstructable zone is rejected before any aggregator sees it; an omitted
  // `tz` defaults to the host zone (preserving the pre-Part-6 behaviour).
  const tz = parseTz(c);
  if (tz instanceof Response) return tz;
  // Each bound is a `YYYYMMDD` local date or an ISO instant (ADR-0083); the
  // two must share a form, since the store decides the window's semantics
  // once per query from whichever bound is present.
  const sinceB = since ? parseRangeBound(since) : undefined;
  const untilB = until ? parseRangeBound(until) : undefined;
  if (since && !sinceB) {
    const body: ErrorResponse = {
      error: `invalid since (expected YYYYMMDD or an ISO instant): ${since}`,
    };
    return c.json(body, 400);
  }
  if (until && !untilB) {
    const body: ErrorResponse = {
      error: `invalid until (expected YYYYMMDD or an ISO instant): ${until}`,
    };
    return c.json(body, 400);
  }
  if (sinceB && untilB && sinceB.kind !== untilB.kind) {
    const body: ErrorResponse = { error: `invalid range: since and until must share a form` };
    return c.json(body, 400);
  }
  if (
    sinceB &&
    untilB &&
    (sinceB.kind === "ymd"
      ? untilB.kind === "ymd" && untilB.ymd < sinceB.ymd
      : untilB.kind === "instant" && untilB.ms < sinceB.ms)
  ) {
    const body: ErrorResponse = { error: `invalid range: until ${until} precedes since ${since}` };
    return c.json(body, 400);
  }

  const organizations = scopeOrganizations(c.req.query("organization"), scope);
  return { since, until, mode, tz, projects, models, machines, organizations };
}

// Whether the report cache can answer an `/api/daily` window (#423, ADR-0116):
// none at all, or `YYYYMMDD` local dates, which a date bucket is cut at. An
// instant bound (ADR-0083) is a half-open window on each event's own timestamp
// that falls inside a local date, so it takes the direct path. The two bounds
// share a form (`parseCommonQuery`), so one instant decides.
function windowIsLocalDates(q: CommonQuery): boolean {
  return !(
    (q.since !== undefined && isInstantBound(q.since)) ||
    (q.until !== undefined && isInstantBound(q.until))
  );
}

export function buildApp(deps: BuildAppDeps): Hono {
  const app = new Hono();

  // This app's own rescan coalescing slot on the shared gate (ADR-0059). The
  // gate's `run` serialization stays process-wide — that is the invariant —
  // but coalescing identifies the WORK, and a rescan's walk closes over THIS
  // app's store + roots and its result IS the response body. A shared key would
  // answer a second app's gesture with the first app's `changed`/`total`.
  const rescanWalkKey = mintRescanWalkKey();

  // The dirty-bucket report cache (#113 / ADR-0057) — serves /api/sessions,
  // /api/projects, the UNBOUNDED /api/daily family, and a local-date-bounded
  // /api/daily as a slice of its unbounded entry (#423 / ADR-0116).
  //
  // Built HERE, not injected: the cache MUST wrap the same live store accessor
  // the handlers read, and a dep is a thing a call site can get wrong (ADR-0057's
  // two-handle invariant, made unrepresentable). It follows store swaps by
  // itself — it holds `deps.store` and rebinds per call — so nothing else is
  // needed to keep the two handles in step.
  //
  // Constructing it this early — before the store's boot scan has even been
  // kicked off — costs nothing: the cache subscribes to the change feed lazily,
  // at the first query's rebind, and that rebind pre-stamps the store's FULL
  // snapshot in sort order, so events that landed before it subscribed are
  // stamped anyway. That is exactly what makes construction at build time safe.
  //
  // `getPricing` is the cache's second rebind trigger (THE PRICING RULE in
  // report-cache.ts): every acc is priced at fold time from the active
  // snapshot, so the ADR-0085 swap must drop them. Passed explicitly — it is
  // the module default too — so the dependency is visible where it is wired.
  const reportStore = deps.reportStore ?? deps.store;
  const reportCache = createReportCache({
    getStore: reportStore,
    getPricing: activePricingSnapshot,
  });
  const blockReports = createBlockReports({ getStore: reportStore, getSamples: deps.samples });

  // Host-header allowlist. The renderer always reaches us via the loopback
  // address it discovered through get_sidecar_url, and the Headless client's
  // commands through its Unix socket as a bare `localhost` (ADR-0119 §3), so
  // any other Host means the request came through a DNS-rebinding-style
  // attack and should be rejected before any handler runs.
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (!deps.isAllowedHost(host)) {
      const body: ErrorResponse = { error: "host mismatch" };
      return c.json(body, 403);
    }
    return next();
  });

  app.use(
    "*",
    cors({
      origin: (origin) => (deps.allowedOrigins.includes(origin) ? origin : null),
    }),
  );

  // CSRF Origin guard (#72). Every state-changing route below ALSO calls
  // `usageAuthGuard`, whose `x-maxprice-auth` header is non-simple and so
  // preflight-shields those routes incidentally — but only while a token
  // exists: `deps.authToken === null` (standalone dev, the test rigs, the
  // Headless client's socket, ADR-0119 §3) makes
  // that guard a no-op, and a future route that forgets the call has nothing at
  // all. The host allowlist above is no help here: a browser sets `Host`
  // correctly when POSTing to the loopback URL. So reject any STATE-CHANGING
  // request carrying a browser `Origin` outside the allowlist — once, for every
  // current and future route. Mirrors the hub daemon's guard
  // (`apps/hub/src/server.ts`); ADR-0086 records why both layers stay.
  //
  // A request with NO Origin passes: CSRF is a browser threat and a browser
  // always sets Origin on a POST, so a missing one means a non-browser caller
  // (curl against a dev sidecar, a test rig) that already has loopback access.
  // GET/HEAD/OPTIONS are never guarded — OPTIONS is the CORS preflight handled
  // above, and reads carry no side effect. Mounted on `/api/*` so `/healthz`
  // stays reachable from anywhere.
  const STATE_CHANGING = new Set(["POST", "PUT", "DELETE", "PATCH"]);
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (
      origin !== undefined &&
      STATE_CHANGING.has(c.req.method) &&
      !deps.allowedOrigins.includes(origin)
    ) {
      const body: ErrorResponse = { error: "cross-origin request rejected" };
      return c.json(body, 403);
    }
    return next();
  });

  app.onError((err, c) => {
    console.error("[sidecar] route error:", err);
    const body: ErrorResponse = { error: "internal" };
    return c.json(body, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true, service: "maxprice-sidecar" }));

  // --- /api/daily ---------------------------------------------------------
  //
  // Every filter axis — date window, project, AND model — is a store-query
  // axis (ADR-0017): the aggregator receives already-filtered events, so every
  // row total and the `totals` block are model-scoped. The Organization scope
  // (#278, `parseCommonQuery`) is one more such axis on every money endpoint,
  // the readout's `todayCost` included. The quota-shaped reads —
  // /api/usage/current, the readout's utilization half, /api/blocks and the
  // intraday `block` span — answer the Quota organization alone
  // (`quotaOrganization`): Blocks form from that one Organization's events and
  // samples.
  // `aggregateDaily` does the date grouping and returns `{ daily, totals? }` —
  // `totals` is omitted on the 2+-project path per the E1 golden.
  //
  // Unbounded and local-date-bounded queries serve from the dirty-bucket cache
  // (#113 / ADR-0057; bounded since #423 / ADR-0116): per-date buckets, only
  // the touched dates refolded, a bounded window answered as the unbounded
  // entry's buckets inside it — so a moving `until` (today) churns no key.
  // `projectFilterCount` is the RAW repeated-param count — duplicates NOT
  // deduped, because the `>=2 omits totals` rule counts raw params
  // (`project=A&project=A` omits).
  app.get(
    "/api/daily",
    withEngineErrors("/api/daily", async (c) => {
      const q = parseCommonQuery(c, deps.organizationScope());
      if (q instanceof Response) return q;
      await deps.engineReady();
      if (windowIsLocalDates(q)) {
        const body = await reportCache.daily({
          mode: q.mode,
          timeZone: q.tz,
          projects: q.projects,
          models: q.models,
          machines: q.machines,
          organizations: q.organizations,
          since: q.since,
          until: q.until,
          projectFilterCount: q.projects.length,
        });
        return c.json(body);
      }
      // An instant-bounded window (ADR-0083, the anchored week) stays on the
      // direct path: no local-date bucket can be cut at an instant. The
      // Organization scope narrows here too (#278).
      const events = reportStore().query({
        since: q.since,
        until: q.until,
        timeZone: q.tz,
        projects: q.projects,
        models: q.models,
        machines: q.machines,
        organizations: q.organizations,
      });
      const body = aggregateDaily(events, q.mode, {
        projectFilterCount: q.projects.length,
        timeZone: q.tz,
      });
      return c.json(body);
    }),
  );

  // --- /api/daily-by-project ---------------------------------------------
  //
  // The per-project daily series behind the cost chart's `by project`
  // group-by. Same store query as /api/daily — the model filter is a
  // store-query axis (ADR-0017); `aggregateDailyByProject` returns the
  // per-slug instances map (each entry widened with the project's real `path`,
  // ADR-0009). An empty window yields `{ projects: {} }` — the aggregator
  // never 502s (this is the fix for the pre-existing 502-on-empty bug noted in
  // fixtures/README.md).
  //
  // Unbounded ⇒ the dirty-bucket cache (#113 / ADR-0057), bucketed per slug.
  // Bounded stays direct — unlike /api/daily since #423 — because this
  // family's cache bucket is the WHOLE slug: answering a window from it would
  // refold the slug's whole history on every append, and resolve `path` from
  // captures the bucket does not keep per date (ADR-0116).
  app.get(
    "/api/daily-by-project",
    withEngineErrors("/api/daily-by-project", async (c) => {
      const q = parseCommonQuery(c, deps.organizationScope());
      if (q instanceof Response) return q;
      await deps.engineReady();
      if (q.since === undefined && q.until === undefined) {
        const body = await reportCache.dailyByProject({
          mode: q.mode,
          timeZone: q.tz,
          projects: q.projects,
          models: q.models,
          machines: q.machines,
          organizations: q.organizations,
        });
        return c.json(body);
      }
      // Bounded queries stay on the direct path: a store query with the
      // window, then the pure aggregator over exactly the window's events.
      const events = reportStore().query({
        since: q.since,
        until: q.until,
        timeZone: q.tz,
        projects: q.projects,
        models: q.models,
        machines: q.machines,
        organizations: q.organizations,
      });
      return c.json(aggregateDailyByProject(events, q.mode, q.tz));
    }),
  );

  // --- /api/daily-by-machine -----------------------------------------------
  //
  // The per-machine daily series behind the cost chart's machine group-by on
  // the daily spans (ADR-0041 M6) — /api/daily-by-project's counterpart. Same
  // store query as /api/daily (every filter is a store axis, ADR-0017);
  // `byProject=1` nests each machine's own per-project sub-map for the
  // machine × project cross. An empty window yields { machines: {} }.
  //
  // Unbounded ⇒ the dirty-bucket cache (#113 / ADR-0057), bucketed per machine
  // (`includeProjects` is a KEY axis there — it changes the fold shape, not
  // just the assembly). Bounded stays direct, like /api/daily-by-project and
  // for the same reason: the bucket is the WHOLE machine, so a cached window
  // would refold that machine's whole history — for this machine's own
  // events, most of the corpus — on every append (ADR-0116).
  app.get(
    "/api/daily-by-machine",
    withEngineErrors("/api/daily-by-machine", async (c) => {
      const q = parseCommonQuery(c, deps.organizationScope());
      if (q instanceof Response) return q;
      const includeProjects = c.req.query("byProject") === "1";
      await deps.engineReady();
      if (q.since === undefined && q.until === undefined) {
        const body = await reportCache.dailyByMachine({
          mode: q.mode,
          timeZone: q.tz,
          projects: q.projects,
          models: q.models,
          machines: q.machines,
          organizations: q.organizations,
          includeProjects,
        });
        return c.json(body);
      }
      // Bounded queries stay on the direct path, as /api/daily-by-project's.
      const events = reportStore().query({
        since: q.since,
        until: q.until,
        timeZone: q.tz,
        projects: q.projects,
        models: q.models,
        machines: q.machines,
        organizations: q.organizations,
      });
      return c.json(aggregateDailyByMachine(events, q.mode, q.tz, includeProjects));
    }),
  );

  // --- /api/intraday ------------------------------------------------------
  //
  // The cost-chart time-series behind the span tabs. Originally sub-day-only
  // (`15m / 1h / 6h / 24h`, Part 5; `24h` was later renamed `today` — ADR-0020);
  // since ADR-0018 it serves ALL six spans at
  // a caller-supplied bucket size, for the line chart styles' fixed 15-min
  // granularity. The `span` query param (required; `spanSchema` — all six)
  // picks the window length from `SPAN_WINDOW_MS`; the optional `bucketMs` picks
  // the bucket duration (default: the span's native bars granularity from
  // `INTRADAY_SPANS`, which exists only for the three native-rung spans
  // (15m / 1h / today) — `block` and `week` pin sidecar-side constants
  // (`BLOCK_BUCKET_MS`, ADR-0031/0046; `WEEK_BUCKET_MS`, ADR-0083), and `30d`
  // has no intraday native; so only `30d` REQUIRES an explicit `bucketMs`).
  // `bucketMs` must divide the window evenly. The optional `prev` / `byProject`
  // flags (default `1`) toggle the ghost `previousBuckets` and the per-project
  // map for the lean line payload.
  // `mode` is optional and defaults to `"auto"`; any invalid param is HTTP 400.
  //
  // `span=block` (ADR-0031): the active 5-hour quota block's growing frame
  // (`[block start → now]`). The handler resolves the frame server-side via
  // `blockReports.span` over the Quota organization's formation (never
  // project/model/machine-filtered — ADR-0017/0028; every row with no Home —
  // ADR-0108) and passes it to the engine. No active block ⇒ 200 with empty
  // buckets and `blockWindow: null`. `bucketMs` is optional for `block` — the
  // engine picks the adaptive block-dividing rung (ADR-0031) when omitted.
  //
  // `span=week` (ADR-0083): the anchored Week's growing frame
  // (`[weekStart → now]`). The renderer resolves the anchor (`resolveWeekWindow`
  // is the only resolver) and passes it as the REQUIRED `weekStart` ISO instant
  // — absent, unparseable, or in the future is a 400. `bucketMs` defaults to
  // `WEEK_BUCKET_MS` (one anchor-aligned day); `blockWindow` is `null`.
  //
  // Store-query strategy — both the project AND the model filter are store-
  // query axes, the same as every report (ADR-0017). NO `since`/`until`
  // reaches the store — the window is `now`-relative and the store's date
  // filter is day-granular; `aggregateIntraday` does the precise windowing
  // from event timestamps.
  app.get(
    "/api/intraday",
    withEngineErrors("/api/intraday", async (c) => {
      const spanParam = c.req.query("span");
      const spanResult = spanSchema.safeParse(spanParam);
      if (!spanResult.success) {
        const body: ErrorResponse = { error: `invalid span: ${spanParam ?? "(missing)"}` };
        return c.json(body, 400);
      }
      const span = spanResult.data;

      // span=week (ADR-0083): the anchor is required and must be a past (or
      // present) instant — a future anchor would frame an empty, negative
      // window, and the engine clamps rather than reports it. It is the same
      // kind of bound as an instant `since`, so it passes the same gate
      // (`isInstantBound`): a zone-less time or a bare date is refused rather
      // than resolved in the sidecar host's zone by a bare `Date.parse`.
      let weekStartMs: number | undefined;
      if (span === "week") {
        const weekStartParam = c.req.query("weekStart");
        const parsed =
          weekStartParam !== undefined && isInstantBound(weekStartParam)
            ? Date.parse(weekStartParam)
            : Number.NaN;
        if (Number.isNaN(parsed)) {
          const body: ErrorResponse = {
            error: `weekStart is required for span week: ${weekStartParam ?? "(missing)"}`,
          };
          return c.json(body, 400);
        }
        if (parsed > deps.now()) {
          const body: ErrorResponse = { error: `weekStart is in the future: ${weekStartParam}` };
          return c.json(body, 400);
        }
        weekStartMs = parsed;
      }

      // Resolve the bucket size: explicit `bucketMs`, else the span's native
      // bars granularity (`week`'s is the sidecar-pinned `WEEK_BUCKET_MS`).
      // `30d` has no native size, so an absent `bucketMs` there is a 400 rather
      // than a 500 from the engine.
      const bucketMsParam = c.req.query("bucketMs");
      let bucketMs: number | undefined;
      if (bucketMsParam !== undefined) {
        const parsed = Number(bucketMsParam);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          const body: ErrorResponse = { error: `invalid bucketMs: ${bucketMsParam}` };
          return c.json(body, 400);
        }
        bucketMs = parsed;
      } else {
        bucketMs = span === "week" ? WEEK_BUCKET_MS : nativeBucketMs(span);
      }
      // `30d` has no native size, so an absent `bucketMs` there is a 400.
      // `block` is the exception (ADR-0031): an absent `bucketMs` means the
      // engine picks the adaptive block-dividing rung.
      if (bucketMs === undefined && span !== "block") {
        const body: ErrorResponse = { error: `bucketMs is required for span ${span}` };
        return c.json(body, 400);
      }
      if (bucketMs !== undefined) {
        if (SPAN_WINDOW_MS[span] % bucketMs !== 0) {
          const body: ErrorResponse = {
            error: `bucketMs ${bucketMs} does not divide the ${span} window`,
          };
          return c.json(body, 400);
        }
        // Reject a pathological bucket count before it reaches the engine — a
        // tiny `bucketMs` over a long window would otherwise allocate millions of
        // densified buckets (the engine guards this too; ADR-0018 / MAX ceiling).
        if (SPAN_WINDOW_MS[span] / bucketMs > MAX_INTRADAY_BUCKETS) {
          const body: ErrorResponse = {
            error: `bucketMs ${bucketMs} yields more than ${MAX_INTRADAY_BUCKETS} buckets for the ${span} window`,
          };
          return c.json(body, 400);
        }
      }

      const mode = parseMode(c);
      if (mode instanceof Response) return mode;
      const { projects, models, machines } = readFilters(c);
      // The Organization scope (#278), resolved exactly as `parseCommonQuery`
      // resolves it. Every span but `block` narrows by it; `block` answers the
      // Quota organization instead (see the block branch).
      const organizations = scopeOrganizations(
        c.req.query("organization"),
        deps.organizationScope(),
      );
      // The IANA zone — REQUIRED for the `today` calendar-day span (ADR-0020),
      // which anchors its window to local midnight in this zone; the other
      // spans ignore it. Same validation + host-zone default as
      // `parseCommonQuery`, so a Timezone-setting change re-buckets `today`.
      const tz = parseTz(c);
      if (tz instanceof Response) return tz;
      // Lean-payload flags — `prev=0` / `byProject=0` skip those sections.
      const includePrevious = c.req.query("prev") !== "0";
      const includeByProject = c.req.query("byProject") !== "0";
      // ADR-0041 (M6): the machine group-by's per-machine map. Default OFF —
      // absent means the pre-M6, byte-identical payload (the two-bit sourcing
      // rule); `byMachine=1` turns it on, and byProject then switches the
      // NESTED per-machine project sub-maps (see aggregateIntraday).
      const includeByMachine = c.req.query("byMachine") === "1";

      await deps.engineReady();

      // span=block (ADR-0031): resolve the active block's frame from the Quota
      // organization's formation — its events and samples alone, never
      // project/model/machine-filtered (the ADR-0017/0028 invariant) — then
      // aggregate that Organization's FILTERED events inside it. One `now` for
      // both so the frame and the rung can't disagree.
      if (span === "block") {
        // ACCEPTED now() skew (ADR-0031): the block frame's active state is
        // sampled from `deps.now()` per request, and `/api/blocks` samples its
        // own `now` on its own request — so right at a 5h reset boundary the two
        // can transiently disagree on isActive / blockWindow for the round-trip
        // gap. Benign: boundaries are reset-aligned, and it self-heals on the
        // next `block:tick` refetch (which re-frames both to the new block or
        // the empty state).
        const now = deps.now();
        // Resolved after the engine is ready, from one scope read, right before
        // the synchronous formation: the Home that picks Q is the Home that
        // presumes the store's owner-less rows and Q's unstamped samples.
        const quota = quotaSampleScope(c.req.query("organization"), deps.organizationScope());
        const resolved = blockReports.span(now, quota);
        if (resolved === null) {
          const body: IntradayResponse = {
            buckets: [],
            previousBuckets: [],
            byProject: {},
            ...(includeByMachine ? { byMachine: {} } : {}),
            blockWindow: null,
          };
          return c.json(body);
        }
        // The series describes the frame's Organization: Q's events, never the
        // money scope's (All sums Organizations; a quota cannot). Frame and
        // series then both describe Q, the ADR-0031 parity with `/api/blocks`
        // under the same param. No Home is no scope: every event.
        const events = reportStore().query({
          projects,
          models,
          machines,
          organizations: quota === null ? undefined : [quota.organization],
        });
        return c.json(
          aggregateIntraday(events, mode, {
            span: "block",
            blockWindow: resolved,
            bucketMs,
            now,
            includePrevious,
            includeByProject,
            includeByMachine,
          }),
        );
      }

      const events = reportStore().query({ projects, models, machines, organizations });
      if (span === "week") {
        if (weekStartMs === undefined) throw new Error("intraday: span week without weekStart");
        return c.json(
          aggregateIntraday(events, mode, {
            span: "week",
            weekStartMs,
            bucketMs,
            now: deps.now(),
            includePrevious,
            includeByProject,
            includeByMachine,
          }),
        );
      }
      const body = aggregateIntraday(events, mode, {
        span,
        bucketMs,
        now: deps.now(),
        tz,
        includePrevious,
        includeByProject,
        includeByMachine,
      });
      return c.json(body);
    }),
  );

  // --- /api/sessions ------------------------------------------------------
  //
  // Whole-session windowing: each session's totals are summed over EVERY event
  // in the session, then sessions are dropped by `lastActivity` (see
  // `engine/sessions.ts`). So the store query must NOT carry the date window —
  // only the project and model filters (both exact store axes; the project
  // axis applies correctly for any project count — the engine fixes the golden
  // oracle's `session --project` no-op, see the corrected `proj-alpha` golden
  // cells).
  // The date window is an aggregator post-filter; the model filter is a
  // store-query axis (ADR-0017).
  //
  // ALWAYS through the dirty-bucket cache (#113 / ADR-0057) — every query is
  // unbounded at the STORE level, and because the window is a whole-session
  // post-filter applied at assembly, one cache entry serves every window:
  // changing the date range costs zero refolds.
  app.get(
    "/api/sessions",
    withEngineErrors("/api/sessions", async (c) => {
      const q = parseCommonQuery(c, deps.organizationScope());
      if (q instanceof Response) return q;
      await deps.engineReady();
      const body = await reportCache.sessions({
        mode: q.mode,
        timeZone: q.tz,
        projects: q.projects,
        models: q.models,
        machines: q.machines,
        organizations: q.organizations,
        since: q.since,
        until: q.until,
      });
      return c.json(body);
    }),
  );

  // --- /api/projects ------------------------------------------------------
  //
  // Each `ProjectRow` carries both a windowed rollup and an all-time rollup,
  // so the store query is UNFILTERED on the date axis — the project AND model
  // filters go to the store (both exact axes). `foldProjectEvent` partitions
  // each project's events by the window for the range columns and folds every
  // event for the all-time columns; because the model filter is a store-query
  // axis (ADR-0017), the range AND all-time columns are both model-scoped.
  //
  // ALWAYS through the dirty-bucket cache (#113 / ADR-0057) — unbounded at the
  // STORE level like /api/sessions, but here the window rides the cache key:
  // the range/all-time partition happens per event inside the fold, so an
  // accumulator is only valid for the window it was folded under.
  app.get(
    "/api/projects",
    withEngineErrors("/api/projects", async (c) => {
      const q = parseCommonQuery(c, deps.organizationScope());
      if (q instanceof Response) return q;
      await deps.engineReady();
      const body = await reportCache.projects({
        mode: q.mode,
        timeZone: q.tz,
        projects: q.projects,
        models: q.models,
        machines: q.machines,
        organizations: q.organizations,
        since: q.since,
        until: q.until,
      });
      return c.json(body);
    }),
  );

  // --- /api/blocks --------------------------------------------------------
  //
  // Blocks describe the Quota organization — the one axis that shapes
  // formation: its events and samples alone form the windows, annulment,
  // grace evidence, burn rate, projection and limit %, so two Organizations'
  // overlapping quota windows never meet. Cross-project by design — the 5-hour
  // quota window is inherently cross-project, so the project filter never
  // reaches it. The MODEL and MACHINE filters (ADR-0017, ADR-0041) are honoured
  // as sum-narrowing options inside that formation: boundaries, isActive and
  // projection stay all-model and all-machine, but each block's
  // cost/token/model sums count only matching events.
  app.get(
    "/api/blocks",
    withEngineErrors("/api/blocks", async (c) => {
      const q = parseCommonQuery(c, deps.organizationScope());
      if (q instanceof Response) return q;
      await deps.engineReady();
      // `q.organizations` is the money scope and never reaches formation: All
      // sums Organizations, a quota cannot. The Quota organization is resolved
      // here instead — after the engine is ready, from one scope read, right
      // before the synchronous formation — so the Home that picks Q is the
      // Home that presumes the store's owner-less rows and Q's unstamped
      // samples.
      const quota = quotaSampleScope(c.req.query("organization"), deps.organizationScope());
      // One pass (ADR-0028): observed reset windows from the usage history
      // partition block formation; the heuristic survives only in history
      // holes; fiveHourLimitPct fills from the same samples. With an empty
      // history this is the pure heuristic port.
      return c.json(
        blockReports.blocks(
          q.mode,
          {
            since: q.since,
            until: q.until,
            timeZone: q.tz,
            models: q.models,
            machines: q.machines,
            now: deps.now(),
          },
          quota,
        ),
      );
    }),
  );

  // --- /api/session/:id/events -------------------------------------------
  //
  // NDJSON stream — one `summary` frame followed by one `event` frame per
  // stored event, timestamp-ascending. The `:id` path param is the sessionId
  // (JSONL filename without `.jsonl`). The `?mode=` query param drives cost
  // computation; an invalid mode → 400 before streaming starts.
  //
  // The `sessions` filter and the model filter (ADR-0017) are both store axes
  // applied at query time (`store.query({ sessions: [id], models })`); there
  // are no post-filters — every queried event contributes to the summary and
  // gets its own frame.
  //
  // An unknown or empty session id is NOT a 404 (the store only knows events,
  // not whether a session ever existed): an empty result yields HTTP 200 with
  // a zero-totals `summary` and no `event` frames. The renderer handles the
  // empty state from that.
  //
  // Mid-stream failures emit a synthetic `{ "type": "error", "error": "…" }`
  // NDJSON frame then end the stream cleanly — the HTTP 200 header has already
  // been written at that point, so the error envelope path is not available.
  app.get("/api/session/:id/events", async (c) => {
    const id = c.req.param("id");
    const mode = parseMode(c);
    if (mode instanceof Response) return mode;

    // The model filter (ADR-0017) — repeated `model=` params, same as every
    // report endpoint. A store-query axis: only matching events stream, and
    // the summary frame's totals/breakdowns cover exactly the streamed frames.
    const models = c.req.queries("model") ?? [];
    // The machine filter (ADR-0041 M5) — repeated `machine=` params, likewise a
    // store-query axis: only matching events stream, and the summary's
    // `machines` covers exactly the streamed frames.
    const machines = c.req.queries("machine") ?? [];
    // The Organization scope (#278), resolved as every report resolves it — a
    // store-query axis too, so a mixed session streams only the scope's events
    // and the summary covers exactly those.
    const organizations = scopeOrganizations(c.req.query("organization"), deps.organizationScope());

    // The pre-stream phase — the `store.query` + `aggregateSessionEvents` fold
    // — runs before the HTTP 200 header is committed, so a throw here still
    // produces a clean 500 with the pinned ErrorResponse envelope, exactly like
    // every other `/api/*` data handler. A failure *after* the stream opens is
    // a different path: the `error` NDJSON frame inside the `stream()` callback
    // below handles it, because the 200 header is already on the wire.
    let aggregate: SessionEventsAggregate;
    try {
      await deps.engineReady();
      aggregate = aggregateSessionEvents(
        reportStore().query({ sessions: [id], models, machines, organizations }),
        mode,
        id,
      );
    } catch (err) {
      console.error("[sidecar] /api/session/:id/events failed:", err);
      const error: ErrorResponse = { error: "usage engine failed" };
      return c.json(error, 500);
    }
    // `events` is the timestamp-ordered, parseable-timestamp-only event list;
    // `eventCosts[i]` is the cost of `events[i]`, reused in event `i`'s frame.
    const { summary, events, eventCosts } = aggregate;

    c.header("Content-Type", "application/x-ndjson");
    return stream(c, async (s) => {
      try {
        await s.write(JSON.stringify(summary) + "\n");
        for (let i = 0; i < events.length; i += 1) {
          const event = events[i];
          if (event === undefined) continue;
          const frame: SessionEventFrame = {
            type: "event",
            timestamp: event.timestamp,
            messageId: event.messageId,
            model: event.model,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheCreationTokens: event.cacheCreationTokens,
            cacheReadTokens: event.cacheReadTokens,
            cost: eventCosts[i] ?? 0,
          };
          await s.write(JSON.stringify(frame) + "\n");
        }
      } catch (err) {
        console.error("[sidecar] /api/session/:id/events stream error:", err);
        const errFrame: SessionErrorFrame = {
          type: "error",
          error: err instanceof Error ? err.message : "stream failed",
        };
        try {
          await s.write(JSON.stringify(errFrame) + "\n");
        } catch {
          // Client disconnected before we could write the error frame — nothing to do.
        }
      }
    });
  });

  // Server-Sent Events channel — the renderer's live data pipeline (ADR-0007).
  // The hub fans file-watch / block-tick / status messages here through the
  // bounded write-chain SSE pump (shared with the hub's /api/stream; see
  // packages/usage-core/src/sse-pump.ts): writes are serialized so frames never
  // interleave, the backlog is bounded, and the subscription is dropped when the
  // client disconnects.
  app.get("/api/stream", (c) => {
    return streamSSE(c, (stream) =>
      streamSSEPump(stream, deps.liveHub.subscribe, SSE_EVENT.heartbeat),
    );
  });

  // Point-in-time status snapshot — the renderer fetches this on boot and on
  // every SSE reconnect to recover anything that changed during a gap. The
  // saturation field is read LIVE off the sampler (see BuildAppDeps) rather
  // than from the hub-held copy, which only refreshes on verdict edges.
  app.get("/api/status", (c) =>
    c.json({ ...deps.liveHub.getStatus(), saturation: deps.getSaturation() }),
  );

  // Cached machine directory + self id (ADR-0041 M5) — loopback-only, no
  // auth (read-only, like /api/status); names render offline from the cache.
  app.get("/api/machines", (c) => c.json(deps.machines()));

  // The Identity directory (ADR-0062) — loopback-only, no auth, same shape of
  // read as /api/machines above: served from RAM, so it answers offline and
  // before any hub connect. The renderer refetches it on identity:changed.
  app.get(PROJECT_IDENTITY_PATH, (c) => c.json(deps.projectIdentity()));

  // The Settings › Storage report (map #124) — loopback-only, no auth, like the
  // two reads above; unlike them it WALKS THE DISK, which is why it is its own
  // endpoint rather than a status field (#126 §1). Single-flight and untimed
  // inside `deps.storage`: concurrent callers share one walk, and a caller
  // arriving after it settles measures again, because an action must be
  // followed by numbers that visibly moved.
  app.get(
    STORAGE_PATH,
    withEngineErrors(
      STORAGE_PATH,
      async (c) => {
        const snapshot = await deps.storage();
        return c.json(snapshot.report);
      },
      "storage report failed",
    ),
  );

  // --- /api/usage/current ---  (ADR-0023) last-known sample for the rings'
  // first paint; live updates arrive via the usage:sample SSE event. The WIRE
  // shape is the projected `{ sample }` (f10) — `connection` / `lastSampleAt`
  // are poller-internal bookkeeping surfaced via the status snapshot, not here.
  // `weeklyResetAt` rides beside `sample` (ADR-0083): the Week resolver needs
  // the weekly window even while a poll legitimately reports `sample: null`.
  //
  // Both describe ONE Organization, the Quota organization the `organization`
  // param resolves to (`quotaOrganization`): the scoped Organization, or Home
  // when the param is absent, `all`, or names nothing tracked — never a 400.
  // With no live reading yet, the poller answers from that Organization's own
  // persisted history (unstamped legacy lines count as Home's), so the Week
  // anchor never borrows another Organization's reset. No Home answers no
  // Organization. The sample's `organizationUuid` stamp (#279) is stripped: the
  // request names the Organization, the response does not repeat it, so a
  // single-Organization machine answers exactly what it did before stamping.
  // The usage:sample SSE payload carries the stamp.
  app.get("/api/usage/current", (c) => {
    const cur = deps.usage.getCurrent(
      quotaOrganization(c.req.query("organization"), deps.organizationScope()),
    );
    let sample = cur.sample;
    if (sample?.organizationUuid !== undefined) {
      // A copy: the poller's live sample is shared with the SSE payload.
      sample = { ...sample };
      delete sample.organizationUuid;
    }
    return c.json({ sample, weeklyResetAt: cur.weeklyResetAt });
  });

  // --- /api/organizations ---  (ADR-0098, #287) the Settings roster: every
  // Organization this machine knows about, with its resolved label and the
  // facts Settings shows beside it; the Home organization select reads it too.
  // Labels and ids only — never the upstream name, and no count of what is
  // hidden ever rides here. The rename PUT is below, behind the auth guard.
  app.get(ORGANIZATIONS_PATH, async (c) => c.json(await deps.organizations.list()));

  // --- /api/readout ---  (map #168 T5/M3; ADR-0076) the tray readout's one
  // wire: the desktop shell's Rust ambient writer polls this ~1/min and renders
  // the Windows tray tooltip / macOS menu-bar title from it. Composed here, not
  // in Rust, so the tray is penny-exact with Live: `todayCost` is the direct
  // store query + `aggregateDaily` fold of the Today tile's window (bounded to
  // today's local date in the requested zone, and narrowed by the
  // `organization` scope as the tile is — #278). The tile itself reads that
  // window as a slice of the report cache's daily entry since #423, equal to
  // this fold byte for byte (ADR-0116, pinned by test). And `blockLive`
  // mirrors the renderer's usage-ring rule — a current sample whose
  // fiveHour.resetAt is still ahead (NaN-guarded, like usageRingState). The
  // shell supplies `mode`/`tz` from settings.json per poll, and `organization`
  // when the `organizationScope` it resolves there names a tracked Organization
  // other than Home, or All (absent means Home); the sidecar keeps its
  // no-ambient-params invariant. GET, unauthenticated like every report.
  //
  // The one `organization` param answers the two halves by two rules, read off
  // ONE scope state so they never disagree about Home: `todayCost` is money
  // and sums the scope (`scopeOrganizations`, so All is every tracked
  // Organization's today), while `blockLive`, `utilizationPct` and
  // `hasModelWindow` are quota and describe the Quota organization alone
  // (`quotaOrganization`, so All is Home's sample), the same Organization
  // /api/usage/current answers for that param.
  //
  // The optional `organizations` field (#291) names that Quota organization by
  // its roster display label and says whether the scope resolved to All; it is
  // filled from the roster only on a multi-Organization machine, so a
  // single-Organization poll reads no roster and its body is unchanged. A
  // failed roster read falls back to the short-id label, never to a 500.
  app.get(
    "/api/readout",
    withEngineErrors("/api/readout", async (c) => {
      const mode = parseMode(c);
      if (mode instanceof Response) return mode;
      const tz = parseTz(c);
      if (tz instanceof Response) return tz;
      await deps.engineReady();

      const organization = c.req.query("organization");
      const scope = deps.organizationScope();
      const now = deps.now();
      const quota = quotaOrganization(organization, scope);
      const sample = deps.usage.getCurrent(quota).sample;
      const resetMs = sample?.fiveHour == null ? Number.NaN : Date.parse(sample.fiveHour.resetAt);
      const blockLive = !Number.isNaN(resetMs) && resetMs > now;

      // `localDateUncached`, not `localDate`: `now` is a wall-clock reading, so
      // the memoized form would mint one permanently-retained entry per call —
      // and the ADR-0079 tray polls this endpoint every 60s for the life of a
      // process it deliberately keeps alive (≥1440 entries/day). The memo is
      // keyed by immutable corpus timestamps by design; this is the documented
      // uncached entry point for a synthetic instant, and it takes the epoch-ms
      // directly rather than round-tripping through an ISO string.
      // Null only for an unparseable timestamp; the injected clock always
      // parses, so the fallback is theoretical.
      const today = localDateUncached(now, tz);
      let todayCost = 0;
      if (today !== null) {
        // Money, so the scope narrows it as it narrows `/api/daily` (#278):
        // absent is Home, which keeps the tray on the Today tile's number.
        const events = reportStore().query({
          since: today.ymd,
          until: today.ymd,
          timeZone: tz,
          organizations: scopeOrganizations(organization, scope),
        });
        const daily = aggregateDaily(events, mode, { projectFilterCount: 0, timeZone: tz });
        todayCost = daily.daily.find((row) => row.date === today.dashed)?.totalCost ?? 0;
      }

      const body: ReadoutResponse = {
        blockLive,
        utilizationPct: blockLive ? (sample?.fiveHour?.utilizationPct ?? null) : null,
        todayCost,
        hasData: deps.liveHub.getStatus().hasData,
        hasModelWindow: sample?.weeklyModel !== undefined,
      };
      const tracked = scope.tracked ?? [];
      const multi =
        scope.home !== null &&
        resolveOrganizationScope(ALL_ORGANIZATIONS, scope.home, tracked) === ALL_ORGANIZATIONS;
      if (multi && quota !== null) {
        // The label is display only: a roster read that fails (a registry
        // write's temp-file rename, say) degrades it to the short id rather
        // than failing the readout, which would take the tray's numbers with
        // it (ADR-0076). The key stays, so the shell still names the
        // Organization.
        let roster: OrganizationsResponse["organizations"] = [];
        try {
          roster = (await deps.organizations.list()).organizations;
        } catch (err) {
          console.warn("[sidecar] readout roster read failed:", err);
        }
        body.organizations = {
          quotaLabel:
            displayOrganizationLabels(roster).get(quota) ??
            resolveOrganizationLabel({
              uuid: quota,
              rename: null,
              organizationType: null,
              hints: null,
            }).label,
          all: resolveOrganizationScope(organization, scope.home, tracked) === ALL_ORGANIZATIONS,
        };
      }
      return c.json(body);
    }),
  );

  // Bearer-token guard for EVERY POST endpoint (f22) — the two usage endpoints,
  // /api/hub/config, POST /api/rescan, and POST /api/pricing/refresh — and for
  // the Organization rename PUT (#287). Enforced ONLY when `deps.authToken` is
  // set (the Tauri shell passes MAXPRICE_AUTH_TOKEN); null (standalone dev /
  // tests) means no auth. Returns a 401 Response carrying the pinned error
  // envelope on a missing/mismatched `x-maxprice-auth` header, else null so the
  // caller proceeds.
  const usageAuthGuard = (c: Context): Response | null => {
    if (deps.authToken === null) return null;
    const presented = c.req.header("x-maxprice-auth");
    if (presented === undefined || !constantTimeEqual(presented, deps.authToken)) {
      const body: ErrorResponse = { error: "unauthorized" };
      return c.json(body, 401);
    }
    return null;
  };

  // --- PUT /api/organizations/:uuid ---  (#287) rename one Organization, or
  // clear its rename (`label: null`) back to the resolved default. The rules —
  // trimmed, 1 to 40 code points, unique case-insensitively against every
  // other Organization's resolved label, one rename at a time — are
  // `deps.organizations.rename`'s (`createOrganizationRename`); this maps its
  // answer onto HTTP. 200 carries the fresh roster, so the caller renders the
  // result without a second read. A label is presentation: it moves no number.
  app.put(
    `${ORGANIZATIONS_PATH}/:uuid`,
    withEngineErrors(
      "PUT /api/organizations/:uuid",
      async (c) => {
        const unauthorized = usageAuthGuard(c);
        if (unauthorized) return unauthorized;
        const parsed = organizationRenameRequestSchema.safeParse(
          await c.req.json().catch(() => null),
        );
        if (!parsed.success) {
          const body: ErrorResponse = {
            error: "invalid organization rename",
            issues: parsed.error.issues.map(({ code, path, message }) => ({ code, path, message })),
          };
          return c.json(body, 400);
        }
        // Always present on this route; `Context` is untyped for path params.
        const uuid = c.req.param("uuid") ?? "";
        const result = await deps.organizations.rename(uuid, parsed.data.label);
        switch (result.kind) {
          case "ok":
            return c.json(result.body);
          case "unknown": {
            const body: ErrorResponse = { error: "unknown organization" };
            return c.json(body, 404);
          }
          case "invalid": {
            const body: ErrorResponse = {
              error:
                result.reason === "empty"
                  ? "label is empty"
                  : `label is longer than ${ORGANIZATION_LABEL_MAX} characters`,
            };
            return c.json(body, 400);
          }
          case "duplicate": {
            const body: ErrorResponse = { error: "another organization already uses that label" };
            return c.json(body, 409);
          }
        }
      },
      "organization rename failed",
    ),
  );

  // --- /api/organization-assertions ---  (#310, ADR-0107 §11) the user's
  // Organization assertions. GET answers the resolved claims: live entries
  // only, no tombstone, no edit time. PUT claims every listed session for one
  // Organization, or clears each claim (`organizationUuid: null`), in one
  // request, behind the auth guard; the rules are `createOrganizationAssert`'s
  // and this maps its answer onto HTTP. Sessions are opaque: an id need not be
  // one this machine holds.
  const organizationAssertions = deps.organizationAssertions;
  if (organizationAssertions !== undefined) {
    app.get(ORGANIZATION_ASSERTIONS_PATH, async (c) => c.json(await organizationAssertions.list()));
    app.put(
      ORGANIZATION_ASSERTIONS_PATH,
      withEngineErrors(
        "PUT /api/organization-assertions",
        async (c) => {
          const unauthorized = usageAuthGuard(c);
          if (unauthorized) return unauthorized;
          const parsed = organizationAssertRequestSchema.safeParse(
            await c.req.json().catch(() => null),
          );
          if (!parsed.success) {
            const body: ErrorResponse = {
              error: "invalid organization assertion",
              issues: parsed.error.issues.map(({ code, path, message }) => ({
                code,
                path,
                message,
              })),
            };
            return c.json(body, 400);
          }
          const result = await organizationAssertions.assert(
            parsed.data.sessionIds,
            parsed.data.organizationUuid,
          );
          switch (result.kind) {
            case "ok": {
              const body: OrganizationAssertResponse = { changed: result.changed };
              return c.json(body);
            }
            case "unknown": {
              const body: ErrorResponse = { error: "unknown organization" };
              return c.json(body, 404);
            }
            case "full": {
              const body: ErrorResponse = { error: "organization assertions are full" };
              return c.json(body, 409);
            }
          }
        },
        "organization assertions write failed",
      ),
    );
  }

  // A local-first identity edit (ADR-0064). The sidecar owns authorship,
  // monotonic version stamping, cycle validation and the durable write; the
  // renderer submits only source/target snapshots.
  app.post(PROJECT_MERGE_PATH, async (c) => {
    const unauthorized = usageAuthGuard(c);
    if (unauthorized) return unauthorized;
    const parsed = projectMergeMutationRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      const body: ErrorResponse = { error: "invalid project merge request" };
      return c.json(body, 400);
    }
    try {
      return c.json(deps.projectMerge(parsed.data));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const body: ErrorResponse = { error: detail };
      return c.json(body, detail.includes("cycle") ? 409 : 500);
    }
  });

  // --- /api/usage/credential ---  the renderer pushes the keychain blob here,
  // verbatim, so the poller can run (in memory only; never persisted). A
  // literal `null` body clears it; an UNPARSEABLE body (an empty body
  // included) is a 400, NOT a clear — the only shipped caller sends the
  // literal "null" (F4). On a valid blob we arm its key alone (ADR-0104: the
  // tracked set decides what is polled) AND poll immediately so the rings
  // populate without waiting for the next interval tick. The key then goes to
  // the key listing (#366), which lists its Organizations into the roster on a
  // client with no Hub; it is never awaited, so a claude.ai failure or hang
  // never reaches the ack. A legacy blob also carries `orgId`, the Organization
  // the pre-#283 poller read: it stamps the usage history's unstamped (legacy)
  // lines (#279), the only record of which Organization they were read for. It
  // is then remembered in the roster, so Settings still offers it once the
  // keychain forgets it: the key may no longer list it, and the key's other
  // Organizations arrive by the listing (no Hub) or the Hub's roster (#366).
  // The ack means the stamp and the record both landed, and it is what lets the
  // renderer drop that `orgId` from the keychain: a failed stamp or roster
  // record is a 500, and the credential stays armed either way. When a push
  // finds nothing unstamped, the stamp does no file I/O. A key-only blob and a
  // clear stamp and remember nothing, and a clear lists nothing.
  app.post(
    "/api/usage/credential",
    withEngineErrors("/api/usage/credential", async (c) => {
      const unauthorized = usageAuthGuard(c);
      if (unauthorized) return unauthorized;
      // Parse explicitly so a mangled body can't be folded into the clear path
      // (F4). Memory-only here — less destructive than the hub's keychain — but
      // the same bug class, fixed the same way.
      let raw: unknown;
      try {
        raw = JSON.parse(await c.req.text());
      } catch {
        const body: ErrorResponse = { error: "invalid credential" };
        return c.json(body, 400);
      }
      if (raw === null) {
        deps.usage.setCredential(null);
        const body = { ok: true } satisfies CredentialAck;
        return c.json(body);
      }
      const parsed = storedUsageCredentialSchema.safeParse(raw);
      if (!parsed.success) {
        const body: ErrorResponse = { error: "invalid credential" };
        return c.json(body, 400);
      }
      const { sessionKey, orgId } = parsed.data;
      deps.usage.setCredential({ sessionKey });
      await deps.usage.pollOnce();
      // #366: list this key's Organizations into the roster (a client with no
      // Hub only — `bootSidecar` decides). Never awaited: claude.ai can fail or hang
      // and the ack must not.
      deps.organizations.learnFromKey?.(sessionKey);
      if (orgId !== undefined) {
        try {
          await deps.usage.stampHistory(orgId);
        } catch (err) {
          // Logged server-side only; the fixed message keeps the history path
          // out of the response, as withEngineErrors does.
          console.error("[sidecar] usage history stamp failed:", err);
          const body: ErrorResponse = { error: "usage history stamp failed" };
          return c.json(body, 500);
        }
        try {
          await deps.organizations.rememberOrganization(orgId);
        } catch (err) {
          // Same posture as the stamp: no ack, so the keychain keeps the
          // `orgId` and the next push retries.
          console.error("[sidecar] roster record failed:", err);
          const body: ErrorResponse = { error: "roster record failed" };
          return c.json(body, 500);
        }
      }
      const body = { ok: true } satisfies CredentialAck;
      return c.json(body);
    }),
  );

  // --- /api/usage/discover-orgs ---  the renderer can't call claude.ai directly
  // (CORS), so org discovery routes through here. Returns the orgs, each with
  // its roster hints (never its name, #283) and what its usage endpoint
  // answered (`limits`, #270). A successful discovery also seeds the roster
  // with those same orgs (#283), so Settings lists every Organization the key
  // can see; nothing picks one (ADR-0104). The roster is disposable, so a
  // failed seed is logged and never fails Connect. On failure the
  // `failureKind` field carries the kind (`expired` vs `error`) so the
  // renderer can tell a bad session key from a transient network/shape
  // failure.
  app.post(
    "/api/usage/discover-orgs",
    withEngineErrors("/api/usage/discover-orgs", async (c) => {
      const unauthorized = usageAuthGuard(c);
      if (unauthorized) return unauthorized;
      const raw: unknown = await c.req.json().catch(() => null);
      const parsed = z.object({ sessionKey: z.string().min(1) }).safeParse(raw);
      if (!parsed.success) {
        const body: ErrorResponse = { error: "sessionKey required" };
        return c.json(body, 400);
      }
      const result = await deps.usage.discoverOrgs(parsed.data.sessionKey);
      if (result.ok) {
        try {
          await deps.organizations.recordDiscovery(result.orgs);
        } catch (err) {
          console.warn("[sidecar] roster seed failed:", err);
        }
      }
      const body: DiscoverOrgsResponse = {
        orgs: result.ok ? result.orgs : [],
        failureKind: result.ok ? null : result.kind,
      };
      return c.json(body);
    }),
  );

  // --- /api/hub/config ---  (ADR-0035/0037) the renderer pushes the hub URL +
  // optional password here (keychain-held, like the usage credential — same
  // auth-guard posture). url null ⇒ hub off, local poller resumes.
  app.post(
    "/api/hub/config",
    withEngineErrors("/api/hub/config", async (c) => {
      const unauthorized = usageAuthGuard(c);
      if (unauthorized) return unauthorized;
      const raw: unknown = await c.req.json().catch(() => null);
      const parsed = hubConfigSchema.safeParse(raw);
      if (!parsed.success) {
        const body: ErrorResponse = { error: "invalid hub config" };
        return c.json(body, 400);
      }
      const { url, password } = parsed.data;
      deps.hub.configure(url !== null ? { url, password, autoHeal: parsed.data.autoHeal } : null);
      const body = { ok: true } satisfies CredentialAck;
      return c.json(body);
    }),
  );

  // Manual rescan (ADR-0019) — the sidecar's one *report-affecting* action
  // endpoint (the other three POSTs configure credentials/hub). ⇧R / the
  // topbar refresh pill POSTs here to force a full re-walk of every JSONL under
  // the currently-watched roots into the event store, catching anything the
  // watcher's incremental tail-read missed (events while the machine slept, a
  // root that changed under it). `store.scan` is the same idempotent full walk
  // the boot scan and a watcher restart's rescan use; its `(messageId,
  // requestId)` dedup makes re-walking safe and merge-only — the store gains
  // missed events but never shrinks. The response carries the walk's own
  // changed-row count (`added` — rows new OR replaced by a fuller version) so
  // the pill can say "refreshed · +N" vs "up to date". A rescan
  // emits no SSE; the renderer invalidates its report caches off this response.
  app.post(
    RESCAN_PATH,
    withEngineErrors(
      RESCAN_PATH,
      async (c) => {
        // Same guard as every other POST (f22): this one triggers unbounded
        // disk work on the engine's single thread, so it is exactly the kind of
        // endpoint an unauthenticated local caller should not be able to reach.
        // Null `authToken` (standalone dev) ⇒ no-op, like the other three.
        const unauthorized = usageAuthGuard(c);
        if (unauthorized) return unauthorized;
        // Await `ready` before scanning, mirroring the GET handlers, so a
        // rescan racing the initial boot scan can't count the boot scan's
        // events as its own `added` count.
        await deps.engineReady();
        // The walk runs through the shared gate (ADR-0059): serialized against
        // the boot / roots-change / fleet-rebuild walks, and coalesced against
        // other rescans — a second gesture arriving while this one is queued
        // joins it rather than putting a third walk on the loop. A gesture
        // arriving once this walk has STARTED gets its own follow-up walk, so
        // nobody is ever told about a disk read that predates their keypress.
        const { changed, total } = await scanGate.runCoalesced(rescanWalkKey, async () => {
          // Bind the live store ONCE per walk (ADR-0041): a concurrent fleet
          // rebuild could swap `deps.store()` between the scan and the size
          // read, and reporting one store's `total` beside another store's
          // scan would describe a store this response never touched. Bound
          // HERE rather than at request arrival so a queued walk uses the
          // store that is live when it actually runs.
          const store = deps.store();
          const walked = await store.scan(deps.getRoots());
          return { changed: walked, total: store.size() };
        });
        // A manual rescan can be the first to surface data for a first-launch
        // user whose session the watcher hadn't ingested yet — flip `hasData`
        // so the renderer's empty state clears. Mirrors `bootSidecar`'s
        // `markHasData`; the guard makes it a no-op once already `true`.
        if (total > 0 && !deps.liveHub.getStatus().hasData) {
          deps.liveHub.patchStatus({ hasData: true });
        }
        // Rows landed outside the watcher path, so its onRecords poke never
        // fired — poke the fleet here or they wait for the next watcher flush /
        // 5-min sweep before reaching the hub. Gate on the scan's own
        // changed-row count, not a `size()` delta: `changed` counts rows
        // REPLACED by a fuller version (same key, larger token total) as well as
        // new ones, and a replacement leaves `size()` flat. That case — a
        // partial row the watcher tailed mid-write and then slept through — is
        // precisely the repair a manual rescan exists for, and the old delta
        // gate silently skipped the push for it.
        if (changed > 0) deps.fleetSync.notifyLocalChange();
        // …and ask the hub for anything this machine missed (ADR-0055). A
        // rescan is the user saying "make my numbers right", but before this
        // the gesture only ever re-read local disk — so the one failure it
        // could not repair was a peer's rows never arriving, which is exactly
        // the failure a user reaches for it to repair. UNGATED by `changed`:
        // the local walk finding nothing says nothing about what the hub holds.
        //
        // Fire-and-forget by design: the pull is an unbounded multi-page
        // network drain, and this response is bounded by the renderer's rescan
        // ceiling (120s, ADR-0059) — a first-attach seed on a large fleet can
        // exceed ANY ceiling, so awaiting it would let a pull that in fact
        // succeeded report "refresh failed". The pulled rows announce
        // themselves the same way every other engine feeder does — the fleet's
        // debounced usage:new poke — so `added`/`total` below keep their one
        // meaning: what the LOCAL disk walk found.
        //
        // The honesty gap this leaves, stated out loud (ADR-0059 kept it
        // deliberately): the pill can say "up to date" while a peer's rows are
        // still draining behind it. The gesture's contract is "re-read local
        // disk now, and ask the hub for anything I'm missing", and the pill
        // reports on the first half only. The second half lands moments later
        // through usage:new, which is what the pill's normal live label is for.
        deps.fleetSync.kickPull();
        // …and re-probe the Repo identity of every locally-resolvable project
        // (ADR-0062). The refresh gesture is the one moment a user asserts "my
        // world changed" — a repo cloned, a remote re-pointed, a directory
        // restored — none of which the watcher can see, since they touch no
        // JSONL. Synchronous, and it costs more than "a stat per project": it
        // first walks every stored event to recover which project lives where
        // (O(events), the fleet corpus included), THEN stats + reads a small
        // config per local project. Measured on the real corpus, ~18 ms over
        // 77,669 events plus ~75 ms cold / ~3 ms warm for 15 projects ≈ 95 ms
        // cold — against the ~300 ms local walk it rides behind and a
        // saturation detector that trips at 30% of a 60 s window (ADR-0056), so
        // it stays inline. Revisit if the fleet corpus or the local project
        // count grows by an order of magnitude. Logged and dropped, never
        // awaited: nothing about the identity side channel may
        // turn a rescan that in fact succeeded into a 500 (this handler's
        // errors reach the user as "refresh failed", ADR-0059).
        //
        // Since #183 the probe is asynchronous, so "never awaited" now also
        // means the refresh returns while the reads are still in flight — which
        // is the improvement: a wedged probe can no longer hold the gesture
        // open. The catch moved onto the promise for the same reason; a
        // synchronous try/catch around a promise-returning call would guard
        // nothing.
        void deps.onRescan?.().catch((err: unknown) => {
          console.error("[sidecar] rescan identity probe failed:", err);
        });
        const body: RescanResponse = { added: changed, total };
        return c.json(body);
      },
      "rescan failed",
    ),
  );

  // --- POST /api/pricing/refresh -------------------------------------------
  //
  // The sidecar's second action endpoint (ADR-0085; the first is /api/rescan,
  // ADR-0019). Always available — a newly announced model needs its prices
  // before the ~24h tick would fetch them — and never a way to stack fetches:
  // the refresher is single-flight, so a click during the boot fetch or a tick
  // joins that attempt and shares its answer. The status snapshot's `pricing`
  // is rebuilt and broadcast on every settled attempt whatever the caller, so
  // the renderer's provenance line updates over SSE; this response exists for
  // the gesture's own feedback ("Refreshed · N new models").
  app.post(
    PRICING_REFRESH_PATH,
    withEngineErrors(
      PRICING_REFRESH_PATH,
      async (c) => {
        // Same guard as every other POST (f22). Cheap to serve, but it reaches
        // the network on the user's behalf, and the rule is simpler as "every
        // POST" than as a list of exceptions.
        const unauthorized = usageAuthGuard(c);
        if (unauthorized) return unauthorized;
        return c.json(await deps.pricing.refreshNow());
      },
      "pricing refresh failed",
    ),
  );

  // --- /api/storage/clean ---  the SAFE Settings › Storage action (map #124,
  // ticket #132): drop the parse cache, compact the replica's superseded lines.
  // Both are rebuilt from files the user already has, so there is no confirm
  // anywhere in the flow and none is wanted — the cost is one slower launch and
  // the button says so.
  //
  // Behind the same auth guard as every other POST (f22). No engine-ready gate:
  // this touches two files the engine does not need, and a user cleaning up
  // during a slow boot should not be told to wait.
  app.post(
    STORAGE_CLEAN_PATH,
    withEngineErrors(
      STORAGE_CLEAN_PATH,
      async (c) => {
        const unauthorized = usageAuthGuard(c);
        if (unauthorized) return unauthorized;
        const body: StorageCleanResponse = await deps.storageActions.clean();
        return c.json(body);
      },
      "storage clean failed",
    ),
  );

  // --- /api/storage/forget ---  the DESTRUCTIVE one. Drops this machine's fleet
  // rows for sessions no surviving local transcript backs, from the hub archive
  // AND (via the reseed) from this client. Those rows are frequently the only
  // remaining copy — Claude Code deletes transcripts on its own 30-day schedule,
  // which is what makes the archive worth having — so everything below is about
  // not doing it by accident.
  //
  // THE GUARDS ARE RE-RUN HERE, never trusted from the report the button was
  // painted with. `deps.storage()` holds no cached result and no TTL, so this
  // call is a genuinely fresh walk, fresh guard verdict and fresh session list
  // in one pass — and the list it returns was classified against the same walk
  // that produced the verdict. Between paint and click a scan can complete, a
  // root can vanish and the tripwire can trip; each of those must refuse.
  app.post(
    STORAGE_FORGET_PATH,
    withEngineErrors(
      STORAGE_FORGET_PATH,
      async (c) => {
        const unauthorized = usageAuthGuard(c);
        if (unauthorized) return unauthorized;
        // The confirmed numbers, parsed BEFORE the walk: a malformed body is
        // knowable without doing any work, and ADR-0063 §1's guard order is
        // "cheapest refusal first" for exactly this reason.
        const confirmed = storageForgetRequestSchema.safeParse(
          await c.req.json().catch(() => null),
        );
        if (!confirmed.success) {
          const body: ErrorResponse = {
            error: "a forget must declare the counts it was confirmed against",
          };
          return c.json(body, 400);
        }
        const { report, forgetSessions } = await deps.storage();
        // `forget: null` is not a tripped guard — it means this client has no
        // replica at all (no hub, or the replica toggle is off), which the UI
        // renders as the action being ABSENT. Reaching it anyway is a client
        // bug or a direct caller, and 409 says "not in this state" rather than
        // pretending it worked.
        if (report.forget === null) {
          const body: ErrorResponse = {
            error: "no fleet replica on this machine — there is nothing to forget",
          };
          return c.json(body, 409);
        }
        if (report.forget.block !== null) {
          // The guard's own `detail` is the message: it is written for a human,
          // it is what the disabled button shows, and re-wording it here would
          // let the two disagree about why.
          const body: ErrorResponse = { error: report.forget.block.detail };
          return c.json(body, 409);
        }
        // The typed confirm authorises a NUMBER, and the report it was painted
        // from can be 30s stale (the query does not refetch while the dialog is
        // open). Refuse anything the user did not see. Only growth is refused:
        // fewer unbacked rows than confirmed means the act is smaller than what
        // was agreed to, which needs no fresh consent. `sessionCount` rides the
        // request for the completion line but is deliberately NOT compared — a
        // re-partition can move sessions without moving a single row, and a 409
        // on that would refuse a forget the user correctly authorised.
        //
        // Clamping to the confirmed count is not an option: truncating the
        // session set to fit a row ceiling deletes an arbitrary subset, which is
        // the silent truncation ADR-0063 §1 refuses outright.
        if (report.forget.unbackedRows > confirmed.data.unbackedRows) {
          const body: ErrorResponse = {
            error:
              `the numbers moved — ${report.forget.unbackedRows.toLocaleString()} rows are now ` +
              `unbacked, more than the ${confirmed.data.unbackedRows.toLocaleString()} you ` +
              `confirmed. Re-check before forgetting.`,
          };
          return c.json(body, 409);
        }
        const result = await deps.storageActions.forget(forgetSessions);
        if (!result.ok) {
          // `landed` rides the SENTENCE, not a field: the error envelope
          // { error, issues? } is pinned repo-wide (packages/shared/src/error.ts)
          // and widening it for one route is disproportionate. The sentence is
          // what the UI shows anyway, and "some of it happened" is the one thing
          // a reader must not have to infer.
          const body: ErrorResponse = {
            error: result.landed
              ? `${result.detail}. Some rows were forgotten before this failed — the counts will settle after the next sync.`
              : result.detail,
          };
          // 409 for "not in this state" (a forget is already running — the same
          // reading as the two 409s above); 503 for a precondition that
          // evaporated (retry as-is); 502 for a hub that was reached and did not
          // do it.
          const status =
            result.reason === "busy" ? 409 : result.reason === "unavailable" ? 503 : 502;
          return c.json(body, status);
        }
        const body: StorageForgetResponse = {
          sessionsRequested: result.sessionsRequested,
          sessionsMatched: result.sessionsMatched,
          rowsRemoved: result.rowsRemoved,
        };
        return c.json(body);
      },
      "storage forget failed",
    ),
  );

  return app;
}

// --- Entry (only when run as the entry point) ---

// Arm the parent-death watchdog BEFORE the boot — the whole point of ADR-0078.
// It used to be the last statement of the boot (then `main()`), downstream of
// the awaits, so a `createWatcher` that never resolved (chokidar's `ready`
// hanging on macOS) left a serving sidecar with no watchdog at all, forever
// (issue #182). It depends on nothing the boot produces, so nothing justifies
// it waiting. It stays HERE, in the entry, and not in `bootSidecar`: the
// Headless client's `maxprice serve` runs the same boot with no parent to
// outlive, and arms nothing (ADR-0118 §4).
//
// Windows: bun:ffi has no libc.<suffix> to dlopen, so the getppid(2) watchdog
// can't run there. We no-op rather than crash.
//
// Windows is COVERED, and not from here: ADR-0072 puts the sidecar in a Win32
// Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, created by the Rust shell
// and held for its lifetime, so the KERNEL terminates this process when the
// shell goes away by any route at all — including the updater's
// `std::process::exit(0)`, which never reaches kill_sidecar. That is strictly
// stronger than anything reachable from in here, and needs no code in this
// file.
//
// The other candidate — a stdin-'end' watchdog like the hub daemon's — stays
// declined rather than deferred (#147 Q11, re-affirmed by ADR-0078): that Bun
// on win32 emits stdin 'end' after a TerminateProcess'd parent is asserted, not
// proven (parent-watchdog.test.ts drives a fake emitter), so it would be an
// unverifiable second mechanism behind a kernel-enforced first one.
function armParentWatchdog(): void {
  if (process.platform === "win32") return;
  // Guarded because this now runs BEFORE the server exists: a `dlopen` failure
  // must leave a sidecar that boots and serves (degraded to `kill_sidecar`
  // alone, exactly the pre-ADR-0078 Windows posture), never one that dies on
  // launch. The log line is the artifact the #182 verification greps for — it
  // must appear ahead of `LISTENING`, which is what distinguishes this
  // ordering from the one that shipped the bug.
  try {
    const getPpid = libcGetppid();
    const initialPpid = getPpid();
    installParentWatchdog({
      getPpid,
      initialPpid,
      label: "sidecar",
      onOrphaned: () => deferredShutdown.fire(),
    });
    console.error(`[sidecar] parent watchdog armed (ppid ${initialPpid})`);
  } catch (err) {
    console.error("[sidecar] parent watchdog unavailable — shell teardown only:", err);
  }
}

// The boot's options come from the environment the Rust shell spawns this
// binary with (ADR-0118 §3), so nothing it passes changes.
if (import.meta.main) {
  armParentWatchdog();
  logMonotonicClock();
  void bootSidecar(bootOptionsFromEnv(process.env));
}
