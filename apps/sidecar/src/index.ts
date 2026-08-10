import { existsSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { stream, streamSSE } from "hono/streaming";
import {
  costModeSchema,
  hubConfigSchema,
  MAX_INTRADAY_BUCKETS,
  nativeBucketMs,
  PROJECT_IDENTITY_PATH,
  PROJECT_MERGE_PATH,
  projectMergeMutationRequestSchema,
  spanSchema,
  SPAN_WINDOW_MS,
  SSE_EVENT,
  RESCAN_PATH,
  STORAGE_CLEAN_PATH,
  STORAGE_FORGET_PATH,
  STORAGE_PATH,
  storageForgetRequestSchema,
  usageCredentialSchema,
  type CostMode,
  type CredentialAck,
  type DiscoverOrgsResponse,
  type ErrorResponse,
  type ForgetSessionRef,
  type IntradayResponse,
  type ProjectMergeMutationRequest,
  type ProjectMergeMutationResponse,
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
import { buildPricingStatus, wirePricingRefresh } from "./pricing-refresh";
import { createLiveHub, type LiveHub } from "./live-hub";
import { createWatcher, type CreateWatcherOptions, type Watcher } from "./watcher";
import { resolveWatchRoots } from "./watch-roots";
import { readClaudePathsFromSettings, readSettingsFile } from "./settings-file";
import { createFleetSync, type FleetForgetResult } from "./fleet";
import {
  createStorageReporter,
  parseWebviewProfileDirs,
  STORAGE_FILE,
  type StorageSnapshot,
} from "./storage";
import { createIdentityProber } from "./identity-probe";
import { createLocalArchive } from "./local-archive";
import { createSettingsWatch, type SettingsWatch } from "./settings-watch";
import { mintRescanWalkKey, scanGate } from "./scan-gate";
import { createScanCache, type ScanCache } from "./engine/scan-cache";
import { createEventStore, type EventStore, type ScanProgress } from "./engine/store";
import {
  constantTimeEqual,
  createHubClient,
  createSampleStore,
  createUsagePoller,
  discoverOrg,
  installParentWatchdog,
  libcGetppid,
  streamSSEPump,
  type DiscoverOrgResult,
  type UsagePollerCurrent,
} from "@maxprice/usage-core";
import { loadOrCreateMachineId } from "./machine-id";
import { startSaturationReporting, type SaturationSnapshot } from "./saturation";
import { createBootProgressReporter, type BootProgressReporter } from "./boot-progress";
import { defaultTimeZone, isValidTimeZone } from "./engine/timezone";
import { aggregateDaily, aggregateDailyByMachine, aggregateDailyByProject } from "./engine/daily";
import { aggregateIntraday } from "./engine/intraday";
import { createReportCache } from "./engine/report-cache";
import { aggregateBlocks, resolveBlockSpanWindow } from "./engine/blocks";
import pkg from "../package.json";

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
    // narrower (`{ sample }`, f10): the handler projects just `sample` off
    // this. `connection` / `lastSampleAt` stay on the internal type for the
    // poller's own bookkeeping and the status snapshot.
    getCurrent: () => UsagePollerCurrent;
    setCredential: (c: UsageCredential | null) => void;
    pollOnce: () => Promise<void>;
    discoverOrgs: (sessionKey: string) => Promise<DiscoverOrgResult>;
  };
  // Bearer token EVERY POST endpoint enforces when present (f22) — the two
  // usage endpoints, the hub config, and the manual rescan: a request must
  // carry a matching `x-maxprice-auth` header. Null in standalone dev
  // (MAXPRICE_AUTH_TOKEN unset) → no auth enforced, preserving the
  // Vite/standalone path; set to the env var at construction otherwise.
  authToken: string | null;
  // The usage-history samples — /api/blocks reads them for observed-window
  // formation + the 5h limit % (ADR-0028). An accessor (not a snapshot) so the
  // handler reads whatever the poller has appended at request time.
  samples: () => UsageSample[];
  // Hub opt-in (ADR-0035/0037): the renderer pushes {url, password} (password
  // nullable — open hub) or url:null (hub off) via POST /api/hub/config;
  // main() wires this to the hub-client.
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
  // Fired (fire-and-forget) once POST /api/rescan's walk has landed — the
  // Identity directory's re-probe trigger (ADR-0062). Optional and deliberately
  // NOT part of `fleetSync`: `buildApp` stays engine-pure, and this is main()'s
  // side channel for "the corpus was just re-read on the user's say-so", the
  // one gesture that can surface a project whose directory appeared (or moved)
  // since boot.
  onRescan?: () => void;
  // The Settings › Storage report (map #124). A dedicated accessor rather than
  // a field on the status snapshot: status is patch-merged and broadcast ~1/min
  // to every client, so putting a directory walk behind it would mean paying
  // that walk forever, on every install, for a number read on one page (#126
  // §1). Built in main() because it needs the app-data paths, the fleet
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
  // Live Loop-lag summary (issue #116 / F4). GET /api/status composes this
  // over the hub-held snapshot: verdict-edge frames + the saturated heartbeat
  // keep the hub's copy only flip-fresh, but one status read must answer "is
  // the loop healthy?" with CURRENT numbers (the F1–F3 cold-start check).
  getSaturation: () => SaturationSnapshot;
};

/**
 * Scan `roots` into `store` and, if the walk succeeded, poke the fleet.
 *
 * The invariant this owns (ADR-0041): any ingest that lands local rows OUTSIDE
 * the watcher path must poke the fleet, or those rows sit unpushed until the
 * next watcher flush / 5-min sweep. The watcher itself pokes from `onRecords`,
 * but it runs `ignoreInitial: true`, so nothing it does covers a full walk —
 * hence the two non-watcher scan paths (boot, roots-changed) route through here.
 * The poke is share- and connection-gated inside event-sync, so it costs a
 * hub-less client nothing.
 *
 * A failed scan pokes NOTHING — note the `return` in the catch. Do not
 * "simplify" this to `.catch(...).then(poke)`: a `.catch` handler that returns
 * undefined yields a RESOLVED promise, so the poke would fire after a failure.
 *
 * `label` names the failing path in the log ("boot scan failed" vs "root change
 * scan failed"); both sites logged the same bare "scan failed:" before.
 *
 * POST /api/rescan deliberately does NOT use this helper: it needs `scan`'s
 * return value for the response's `added` count, and binds the live store once
 * per request. Don't unify them — it would break `added`.
 *
 * The walk runs through the shared `scanGate` (ADR-0059), so it never overlaps
 * the rescan endpoint's walk or the fleet's rebuild walk on the single JS
 * thread. Serialization only — a boot/roots-change walk still always runs.
 *
 * `onProgress` is passed by the BOOT call site only (ADR-0067). The
 * roots-changed walk shares this helper and deliberately stays silent: by then
 * the splash is long gone, and a "reading session files" bar reappearing over a
 * live app because the user edited a path in Settings would be a lie about what
 * the app is doing.
 */
export async function scanAndPoke(
  store: EventStore,
  fleetPush: { notifyLocalChange: () => void },
  roots: string[],
  label: string,
  onProgress?: (p: ScanProgress) => void,
): Promise<void> {
  try {
    await scanGate.run(() => store.scan(roots, onProgress));
  } catch (err) {
    console.error(`[sidecar] ${label} scan failed:`, err);
    return;
  }
  fleetPush.notifyLocalChange();
}

/**
 * Patch `ready: true` into the live status once `engineReady` SETTLES — the
 * boot readiness signal (ADR-0047). Extracted from main() (like `scanAndPoke`)
 * so the semantic is testable.
 *
 * Settle, not resolve: neither constituent rejects in practice (the store's
 * scan resolves `ready` in its `finally`; the replica load self-heals a
 * corrupt cache), but if a rejection ever escaped, leaving `ready: false`
 * would hold the boot splash forever on a perfectly healthy SSE connection.
 * The app's per-endpoint error surfaces own the failure story once revealed —
 * the splash owns only pre-ready sidecar/stream failures.
 *
 * `ready` is never cleared afterwards: a rescan (manual ⇧R, a claudePaths
 * edit) is a data update on a live app, not a boot.
 *
 * Returns the settled chain so tests can await the patch deterministically;
 * main() `void`s it.
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
 * records after `engineReady` settles. Extracted from main() (like
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
 * main() `void`s it.
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
 * resolvable project once `engineReady` SETTLES. Extracted from main() (like
 * `wireScanCachePersist`) so the timing semantic is testable.
 *
 * After ready, never before: the prober reads the store's cwd captures to
 * decide what to probe, so running it against a half-scanned corpus would
 * simply see fewer projects — and its synchronous `stat`/config reads would
 * compete with the boot walk for the one thread. The macrotask yield lets the
 * `status:changed` ready frame flush first, exactly as the scan-cache write
 * does. Settle, not resolve — a boot whose replica load rejected still scanned
 * local disk, and those projects are all this probes (`wireReadySignal` already
 * logged the rejection; no double log).
 *
 * A failed probe round is logged and dropped: the directory is additive, the
 * next probe event (rescan, a new slug) re-covers it, and a persisted row is
 * never harmed by a probe that didn't happen.
 *
 * Returns the settled chain so tests can await the probe deterministically;
 * main() `void`s it.
 */
export function wireIdentityProbe(engineReady: Promise<void>, runAll: () => void): Promise<void> {
  return engineReady
    .catch(() => {
      // Logged by wireReadySignal; the probe cares only that the boot settled.
    })
    .then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        runAll();
      } catch (err) {
        console.error("[sidecar] boot identity probe failed:", err);
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
function parseCommonQuery(c: Context): CommonQuery | Response {
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
  if (since && !isValidYmd(since)) {
    const body: ErrorResponse = { error: `invalid since (expected YYYYMMDD): ${since}` };
    return c.json(body, 400);
  }
  if (until && !isValidYmd(until)) {
    const body: ErrorResponse = { error: `invalid until (expected YYYYMMDD): ${until}` };
    return c.json(body, 400);
  }
  if (since && until && until < since) {
    const body: ErrorResponse = { error: `invalid range: until ${until} precedes since ${since}` };
    return c.json(body, 400);
  }

  return { since, until, mode, tz, projects, models, machines };
}

// A YYYYMMDD string must be both well-formed and a real calendar date.
// `/^\d{8}$/` alone would forward 20261332 (month 13) or 20260230 (Feb 30)
// straight through as a since/until bound.
function isValidYmd(s: string): boolean {
  if (!/^\d{8}$/.test(s)) return false;
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(4, 6));
  const day = Number(s.slice(6, 8));
  if (month < 1 || month > 12) return false;
  // new Date(year, month, 0) is the last day of `month` (1-indexed here).
  const daysInMonth = new Date(year, month, 0).getDate();
  return day >= 1 && day <= daysInMonth;
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
  // /api/projects, and the UNBOUNDED /api/daily family.
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
  const reportCache = createReportCache({ getStore: deps.store });

  // Host-header allowlist. The renderer always reaches us via the loopback
  // address it discovered through get_sidecar_url, so any other Host means
  // the request came through a DNS-rebinding-style attack and should be
  // rejected before any handler runs.
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
  // row total and the `totals` block are model-scoped. `aggregateDaily` does
  // the date grouping and returns `{ daily, totals? }` — `totals` is omitted
  // on the 2+-project path per the E1 golden.
  //
  // UNBOUNDED queries serve from the dirty-bucket cache (#113 / ADR-0057):
  // per-date buckets, only the touched dates refolded. `projectFilterCount` is
  // the RAW repeated-param count — duplicates NOT deduped, because the
  // `>=2 omits totals` rule counts raw params (`project=A&project=A` omits).
  app.get(
    "/api/daily",
    withEngineErrors("/api/daily", async (c) => {
      const q = parseCommonQuery(c);
      if (q instanceof Response) return q;
      await deps.engineReady();
      if (q.since === undefined && q.until === undefined) {
        const body = await reportCache.daily({
          mode: q.mode,
          timeZone: q.tz,
          projects: q.projects,
          models: q.models,
          machines: q.machines,
          projectFilterCount: q.projects.length,
        });
        return c.json(body);
      }
      // Bounded queries stay on the direct path: the store's date filter makes
      // them O(window) already, and a moving `until` would churn cache keys.
      const events = deps.store().query({
        since: q.since,
        until: q.until,
        timeZone: q.tz,
        projects: q.projects,
        models: q.models,
        machines: q.machines,
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
  // Unbounded ⇒ the dirty-bucket cache (#113 / ADR-0057), bucketed per slug;
  // bounded stays direct, exactly like /api/daily.
  app.get(
    "/api/daily-by-project",
    withEngineErrors("/api/daily-by-project", async (c) => {
      const q = parseCommonQuery(c);
      if (q instanceof Response) return q;
      await deps.engineReady();
      if (q.since === undefined && q.until === undefined) {
        const body = await reportCache.dailyByProject({
          mode: q.mode,
          timeZone: q.tz,
          projects: q.projects,
          models: q.models,
          machines: q.machines,
        });
        return c.json(body);
      }
      // Bounded queries stay on the direct path: the store's date filter makes
      // them O(window) already, and a moving `until` would churn cache keys.
      const events = deps.store().query({
        since: q.since,
        until: q.until,
        timeZone: q.tz,
        projects: q.projects,
        models: q.models,
        machines: q.machines,
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
  // just the assembly); bounded stays direct, exactly like /api/daily.
  app.get(
    "/api/daily-by-machine",
    withEngineErrors("/api/daily-by-machine", async (c) => {
      const q = parseCommonQuery(c);
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
          includeProjects,
        });
        return c.json(body);
      }
      // Bounded queries stay on the direct path: the store's date filter makes
      // them O(window) already, and a moving `until` would churn cache keys.
      const events = deps.store().query({
        since: q.since,
        until: q.until,
        timeZone: q.tz,
        projects: q.projects,
        models: q.models,
        machines: q.machines,
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
  // (15m / 1h / today) — `block` has no native size either (its rung is
  // engine-picked, ADR-0031), and `7d` / `30d` have no intraday native; so
  // `7d` / `30d` REQUIRE an explicit `bucketMs`, and omitting `bucketMs` for
  // `block` triggers the adaptive rung). `bucketMs` must divide the window
  // evenly. The optional `prev` / `byProject` flags (default `1`) toggle the
  // ghost `previousBuckets` and the per-project map for the lean line payload.
  // `mode` is optional and defaults to `"auto"`; any invalid param is HTTP 400.
  //
  // `span=block` (ADR-0031): the active 5-hour quota block's growing frame
  // (`[block start → now]`). The handler resolves the frame server-side via
  // `resolveBlockSpanWindow` (all-model/all-project — ADR-0017/0028) and
  // passes it to the engine. No active block ⇒ 200 with empty buckets and
  // `blockWindow: null`. `bucketMs` is optional for `block` — the engine picks
  // the adaptive block-dividing rung (ADR-0031) when omitted.
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

      // Resolve the bucket size: explicit `bucketMs`, else the span's native
      // bars granularity. `7d` / `30d` have no native size, so an absent
      // `bucketMs` there is a 400 rather than a 500 from the engine.
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
        bucketMs = nativeBucketMs(span);
      }
      // `7d` / `30d` have no native size, so an absent `bucketMs` there is a
      // 400. `block` is the exception (ADR-0031): an absent `bucketMs` means
      // the engine picks the adaptive block-dividing rung.
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

      // span=block (ADR-0031): resolve the active block's frame over the
      // UNFILTERED store — boundaries are all-model/all-project, the
      // ADR-0017/0028 invariant — then aggregate the FILTERED events inside
      // it. One `now` for both so the frame and the rung can't disagree.
      if (span === "block") {
        // ACCEPTED now() skew (ADR-0031): the block frame's active state is
        // sampled from `deps.now()` per request, and `/api/blocks` samples its
        // own `now` on its own request — so right at a 5h reset boundary the two
        // can transiently disagree on isActive / blockWindow for the round-trip
        // gap. Benign: boundaries are reset-aligned, and it self-heals on the
        // next `block:tick` refetch (which re-frames both to the new block or
        // the empty state).
        const now = deps.now();
        const resolved = resolveBlockSpanWindow(deps.store().query(), deps.samples(), now);
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
        const events = deps.store().query({ projects, models, machines });
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

      const events = deps.store().query({ projects, models, machines });
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
      const q = parseCommonQuery(c);
      if (q instanceof Response) return q;
      await deps.engineReady();
      const body = await reportCache.sessions({
        mode: q.mode,
        timeZone: q.tz,
        projects: q.projects,
        models: q.models,
        machines: q.machines,
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
      const q = parseCommonQuery(c);
      if (q instanceof Response) return q;
      await deps.engineReady();
      const body = await reportCache.projects({
        mode: q.mode,
        timeZone: q.tz,
        projects: q.projects,
        models: q.models,
        machines: q.machines,
        since: q.since,
        until: q.until,
      });
      return c.json(body);
    }),
  );

  // --- /api/blocks --------------------------------------------------------
  //
  // Cross-project by design — the 5-hour quota window is inherently
  // cross-project, so the project filter never reaches it and the store query
  // is unfiltered. The MODEL filter (ADR-0017) is honoured as a sum-narrowing
  // option: blocks still form from all events (quota truth — boundaries,
  // isActive, projection are all-model), but each block's cost/token/model
  // sums count only matching events.
  app.get(
    "/api/blocks",
    withEngineErrors("/api/blocks", async (c) => {
      const q = parseCommonQuery(c);
      if (q instanceof Response) return q;
      await deps.engineReady();
      const events = deps.store().query();
      // One pass (ADR-0028): observed reset windows from the usage history
      // partition block formation; the heuristic survives only in history
      // holes; fiveHourLimitPct fills from the same samples. With an empty
      // history this is the pure heuristic port.
      return c.json(
        aggregateBlocks(events, q.mode, {
          since: q.since,
          until: q.until,
          timeZone: q.tz,
          models: q.models,
          machines: q.machines,
          samples: deps.samples(),
          now: deps.now(),
        }),
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
        deps.store().query({ sessions: [id], models, machines }),
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
  app.get("/api/usage/current", (c) => c.json({ sample: deps.usage.getCurrent().sample }));

  // Bearer-token guard for EVERY POST endpoint (f22) — the two usage endpoints,
  // /api/hub/config, and POST /api/rescan. Enforced ONLY when `deps.authToken`
  // is set (the Tauri shell passes MAXPRICE_AUTH_TOKEN); null (standalone dev /
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

  // --- /api/usage/credential ---  the renderer pushes the keychain credential
  // here so the poller can run (in memory only; never persisted). A literal
  // `null` body clears it; an UNPARSEABLE body (an empty body included) is a
  // 400, NOT a clear — the only shipped caller sends the literal "null" (F4).
  // On a valid credential we set it AND poll immediately so the rings populate
  // without waiting for the next interval tick.
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
      const parsed = usageCredentialSchema.safeParse(raw);
      if (!parsed.success) {
        const body: ErrorResponse = { error: "invalid credential" };
        return c.json(body, 400);
      }
      deps.usage.setCredential(parsed.data);
      await deps.usage.pollOnce();
      const body = { ok: true } satisfies CredentialAck;
      return c.json(body);
    }),
  );

  // --- /api/usage/discover-orgs ---  the renderer can't call claude.ai directly
  // (CORS), so org discovery routes through here. Returns the orgs (with
  // capabilities) so the renderer can pick the subscription org. On failure the
  // `failureKind` field carries the kind (`expired` vs `error`) so the renderer
  // can tell a bad session key from a transient network/shape failure.
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
  // the boot scan and the settings-change rescan use; its `(messageId,
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
        // so the renderer's empty state clears. Mirrors `main()`'s
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
        try {
          deps.onRescan?.();
        } catch (err) {
          console.error("[sidecar] rescan identity probe failed:", err);
        }
        const body: RescanResponse = { added: changed, total };
        return c.json(body);
      },
      "rescan failed",
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

// --- Bootstrap (only when run as the entry point) ---

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

async function main(): Promise<void> {
  const desiredPort = parsePort(process.env.PORT);

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
  // When MAXPRICE_SETTINGS_PATH is set (the Tauri shell passes it on spawn —
  // ADR-0014), the user's `claudePaths` from settings.json wins. Unset (a
  // standalone dev sidecar, the golden test runner) falls back to the
  // pre-existing resolveWatchRoots($CLAUDE_CONFIG_DIR) behaviour unchanged.
  const settingsPath = process.env.MAXPRICE_SETTINGS_PATH;

  function resolveRoots(): string[] {
    if (settingsPath !== undefined) {
      const fromSettings = readClaudePathsFromSettings(settingsPath);
      if (fromSettings !== null) {
        // The watcher still drops non-existent dirs at watch time.
        const existing = fromSettings.filter((p) => existsSync(p) && statSync(p).isDirectory());
        // Safety net: if settings yields no existing dir, fall through to the
        // $CLAUDE_CONFIG_DIR / standard-path resolution below. Harmless when
        // settings has valid paths; rescues a user whose data lives only at a
        // non-standard $CLAUDE_CONFIG_DIR when no standard path exists.
        if (existing.length > 0) return existing;
      }
    }
    return resolveWatchRoots({
      configDir: process.env.CLAUDE_CONFIG_DIR,
      homedir: homedir(),
      dirExists: (p) => existsSync(p) && statSync(p).isDirectory(),
    });
  }

  let watchRoots = resolveRoots();

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
  const bootHubConfigured =
    Boolean(process.env.MAXPRICE_HUB_URL) || (bootSettings?.hubUrl ?? "") !== "";

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
      pricing: buildPricingStatus(null),
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

  // The Part 4.5 usage engine's in-memory event store (E4). Created here, but
  // its initial scan is kicked off *after* the LISTENING handshake (below) so
  // a large filesystem walk can't blow the Rust shell's 5s timeout. Every
  // `/api/*` data handler queries it (E9 cutover).
  const eventStore = createEventStore({ selfMachineId: machineId, scanCache });

  // The engine store, as a mutable ref (ADR-0041): the fleet resync path
  // rebuilds it in-session (fresh store → local rescan + replica reseed → swap),
  // so everything that reads or feeds the engine goes through `getEngineStore()`,
  // never the captured `eventStore`. The `eventStore` name stays for the boot
  // scan + engineReady, which run on the original store.
  let engineStore = eventStore;
  const getEngineStore = (): EventStore => engineStore;

  // The Local archive (#140, ADR-0069): this machine's own events, durable,
  // always on. Constructed before the fleet so rebuildEngine can seed from it.
  const localArchive = createLocalArchive({
    path: join(appDataDir, STORAGE_FILE.localArchive),
    machineId,
    getStore: getEngineStore,
    onDegraded: (d) => {
      if ((liveHub.getStatus().localArchiveDegraded ?? false) !== d) {
        liveHub.patchStatus({ localArchiveDegraded: d });
      }
    },
  });
  // The change-feed subscription on the boot store; every later swap re-attaches
  // (see swapStore below).
  localArchive.attachStore(eventStore);

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
    swapStore: (next) => {
      engineStore = next;
      // Re-subscribe the archive's change feed onto the store that is now live
      // — the boot subscription points at a store nothing writes to any more.
      localArchive.attachStore(next);
    },
    seedLocalArchive: (store) => localArchive.seedInto(store),
    forgetLocalArchive: (sessions) => localArchive.forgetSessions(sessions),
    createStore: () => createEventStore({ selfMachineId: machineId, scanCache }),
    getRoots: () => watchRoots,
    emitMachinesChanged: () => liveHub.emitMachinesChanged(),
    emitIdentityChanged: () => liveHub.emitIdentityChanged(),
    initial: {
      shareEvents: bootShareEvents,
      fleetReplica: bootFleetReplica,
      hubConfigured: bootHubConfigured,
    },
  });

  // The Repo identity prober (ADR-0062 §2) — the ONE producer of this
  // machine's own directory rows. It reads the engine (which projects live at
  // which local paths) and hands stamped rows to the fleet, which persists,
  // emits identity:changed, and offers them to the hub. Three triggers, all
  // wired below: boot (off engineReady), the manual rescan, and a first-seen
  // slug in the watcher's flush.
  const identityProber = createIdentityProber({
    getStore: getEngineStore,
    machineId,
    record: (rows) => fleet.recordProbes(rows),
  });

  // The Settings › Storage report (map #124). Built here rather than inside
  // buildApp because everything it needs is main()'s: the app-data directory,
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
  });

  // engineReady gates every data handler on BOTH local sources — the initial
  // scan AND the replica file load (ADR-0041) — but never the network (the hub
  // pull is background). Both are kicked AFTER the LISTENING handshake (below);
  // until then this holds the scan's own `ready` so a request in the boot window
  // still waits on the scan, exactly as the pre-fleet app did.
  let engineReady: Promise<void> = eventStore.ready;

  // Usage-limits (ADR-0023/0024). Construction is synchronous and reads no file
  // — the on-disk history is loaded by `sampleStore.loadHistory()` *after* the
  // handshake (below), so a large read can't delay the LISTENING line past the
  // Rust shell's 5s timeout.
  const sampleStore = createSampleStore({ path: usageHistoryPath });
  const usagePoller = createUsagePoller({
    store: sampleStore,
    liveHub,
    baseUrl: process.env.MAXPRICE_CLAUDE_BASE_URL,
  });

  // Hub client (ADR-0035): connect/backfill/stream toward an optional hub;
  // pauses usagePoller while connected. machineId (computed above, beside the
  // usage history) is reused here.
  const hubClient = createHubClient({
    store: sampleStore,
    liveHub,
    localPoller: usagePoller,
    machineId,
    // Friendly roster label (ADR-0036) — the host's machine name, sent as
    // x-maxprice-hostname. Empty string ⇒ header omitted (handled in hub-client).
    hostname: hostname(),
    // Auto-heal read seam (ADR-0035 M2): the hub-client pushes this machine's
    // key to a hub whose own credential died.
    getLocalCredential: () => usagePoller.getCredential(),
    // The ADR-0041 event-sync seam: hub-client owns connection custody and
    // fires these hooks; fleet.ts drives the event-sync from them.
    fleet: fleet.hooks,
  });

  // Bind first so we know the port, then wire up host validation against it.
  const allowedHosts = new Set<string>();
  const app = buildApp({
    allowedOrigins,
    isAllowedHost: (host) => host !== undefined && allowedHosts.has(host),
    liveHub,
    // Live engine accessor (ADR-0041): a fleet rebuild swaps the store, so
    // handlers read it per-request rather than capturing one at build time.
    store: getEngineStore,
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
    // Live accessor, not a snapshot: `watchRoots` is reassigned on a settings
    // `claudePaths` edit (below), and POST /api/rescan must scan whatever is
    // watched now (ADR-0019).
    getRoots: () => watchRoots,
    now: () => Date.now(),
    usage: {
      getCurrent: usagePoller.getCurrent,
      setCredential: usagePoller.setCredential,
      pollOnce: usagePoller.pollOnce,
      discoverOrgs: (sessionKey: string) => discoverOrg({ sessionKey }),
    },
    // Every POST endpoint requires a matching `x-maxprice-auth` header when
    // this is set (f22). The Tauri shell passes MAXPRICE_AUTH_TOKEN on
    // spawn; a standalone dev sidecar leaves it unset → no auth enforced.
    authToken: process.env.MAXPRICE_AUTH_TOKEN ?? null,
    samples: () => sampleStore.all(),
    getSaturation: saturationReporting.snapshot,
    hub: {
      // Fan-out (ADR-0041): the hub-client owns the connection; the fleet's
      // hub-configured gate tracks whether a hub is set so its replica lifecycle
      // reconciles live. `c === null` ⇒ hub off.
      configure: (c) => {
        hubClient.configure(c);
        fleet.onHubConfigured(c !== null);
      },
    },
    // The rescan handler's push trigger — same poke the watcher's onRecords
    // flush fires, so manually-surfaced rows reach the hub immediately.
    fleetSync: {
      notifyLocalChange: () => fleet.notifyLocalChange(),
      kickPull: () => fleet.kickPull(),
    },
    // The rescan's identity side channel (ADR-0062): a re-probe of every
    // locally-resolvable project, so a repo cloned/moved/re-pointed since boot
    // is picked up by the one gesture that means "re-read my world".
    onRescan: () => identityProber.runAll(),
  });

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: desiredPort,
      fetch: app.fetch,
      // SSE connections (/api/stream) are long-lived and idle between events;
      // Bun's 10s default idleTimeout would sever them well before the 15s
      // heartbeat. 0 disables it — the app's own bounds still apply (the
      // parent-death watchdog).
      idleTimeout: 0,
    });
  } catch (err) {
    console.error("[sidecar] Bun.serve failed:", err);
    process.exit(1);
  }
  allowedHosts.add(`127.0.0.1:${server.port}`);
  allowedHosts.add(`localhost:${server.port}`);

  // Stdout handshake: Rust shell reads exactly this line, then exposes the URL
  // to the renderer via `get_sidecar_url`. ADR-0002.
  await writeLine(`LISTENING ${server.port}\n`);

  // The event store's initial full scan and the watcher both come up after the
  // handshake so a large initial filesystem walk can't delay the LISTENING
  // line past the Rust shell's 5s timeout. The scan runs concurrently with the
  // watcher — the store's `(messageId, requestId)` dedup makes a scan/watcher
  // overlap safe. `void`: nothing awaits the scan here; the endpoints await
  // `eventStore.ready`. Through `scanAndPoke` because the watcher runs
  // `ignoreInitial: true` — the boot corpus never replays through `onRecords`,
  // so without this poke, work done while the app was closed would sit unpushed
  // until the 5-min sweep on an otherwise-idle machine.
  void scanAndPoke(eventStore, fleet, watchRoots, "boot", bootProgress.onScanProgress);

  // Kick the replica load beside the scan (ADR-0041) and gate the data handlers
  // on BOTH: engineReady resolves once the local scan AND the replica file load
  // finish. Deferred to here so the replica's disk read can't delay the LISTENING
  // line either; NEVER the network (the hub pull is background). A hub-less
  // client's loadReplicaAtBoot resolves immediately, so this is just the scan.
  engineReady = Promise.all([
    eventStore.ready,
    fleet.loadReplicaAtBoot(),
    // The archive's disk load (never rejects — a failure degrades instead,
    // ADR-0069 §3). Local disk only, like the replica: never the network.
    localArchive.loadAtBoot(),
  ]).then(() => undefined);

  // The corpus walk's end (ADR-0067): announce the `merging` phase to anyone
  // still on the splash. Off `eventStore.ready` rather than `engineReady`,
  // because the whole point is the window BETWEEN them — the one a hub client's
  // replica load occupies and a hub-less client's does not (the reporter drops
  // this frame entirely in the latter case).
  void eventStore.ready.then(() => bootProgress.scanFinished());

  // The boot readiness signal (ADR-0047): flip `ready: true` — broadcast as a
  // status:changed frame — when the SAME local gate the data handlers await
  // settles. Never the network; never cleared again this process. Carries the
  // terminal `bootProgress` in the same patch (ADR-0067).
  void wireReadySignal(engineReady, liveHub, bootProgress);

  // The scan cache's one write (ADR-0048): after the same gate, behind a
  // macrotask yield so the ready frame's flush always beats the serialization.
  void wireScanCachePersist(engineReady, scanCache);

  // The Identity directory's boot probe (ADR-0062): after the same gate, behind
  // the same macrotask yield — the scanned corpus is what tells the prober
  // which projects exist and where.
  void wireIdentityProbe(engineReady, () => identityProber.runAll());

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
  void engineReady
    .catch(() => {
      // Logged by wireReadySignal; the sweep cares only that the boot settled.
    })
    .then(() => {
      void localArchive.sweep();
      localArchive.startSweeps();
    });

  // Load the persisted usage history after the handshake, for the same reason
  // the event-store scan is deferred — a large read mustn't gate the LISTENING
  // line. The poller (started below) reads `latest()` lazily, so an in-flight
  // load just means the first reading lands once it resolves.
  void sampleStore
    .loadHistory()
    .catch((err: unknown) => console.error("[sidecar] usage-history load failed:", err));

  // Once the initial scan settles, reflect whether it found any usage data in
  // the status snapshot — a first-launch corpus stays `hasData: false`.
  void eventStore.ready.then(markHasData).catch((err: unknown) => {
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
  // `pricingLoop.stop()` in shutdown cancels the daily timer.
  const pricingLoop = wirePricingRefresh({ patch: liveHub.patchStatus });

  // Start the 1/min usage poll. Idles until the renderer pushes a credential
  // (POST /api/usage/credential). Standalone interval (not SSE-ref-counted) so
  // history accrues on any page (ADR-0024).
  usagePoller.start();

  // Standalone/E2E hub opt-in via env (the packaged app pushes via
  // POST /api/hub/config instead). Configured AFTER start(): the hub-client
  // needs the poller/liveHub wiring live. Password optional (ADR-0037).
  if (process.env.MAXPRICE_HUB_URL) {
    hubClient.configure({
      url: process.env.MAXPRICE_HUB_URL,
      password: process.env.MAXPRICE_HUB_PASSWORD ?? null,
      // Rig seam: default on; MAXPRICE_HUB_AUTO_HEAL=0 keeps this machine's key local.
      autoHeal: !["0", "false"].includes((process.env.MAXPRICE_HUB_AUTO_HEAL ?? "").toLowerCase()),
    });
  }

  // Watcher comes up after the handshake so a large initial filesystem scan
  // can't delay the LISTENING line past the Rust shell's 5s timeout.
  let watcher: Watcher | null = null;

  // The settings.json watcher (ADR-0014) — only created when the Tauri shell
  // passed MAXPRICE_SETTINGS_PATH. Declared here so `shutdown` can tear it down.
  let settingsWatch: SettingsWatch | null = null;

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
        pricingLoop.stop();
        // Cancel the saturation sample timer + any saturated heartbeat.
        saturationReporting.stop();
        // Drain the poller (await its in-flight poll), THEN flush the sample
        // store's queued disk writes, before stopping the server / exiting —
        // otherwise a queued usage-history appendFile can be truncated by
        // process exit (f17).
        await usagePoller.stop();
        await sampleStore.flush();
        liveHub.close();
        if (settingsWatch) await settingsWatch.close();
        if (watcher) await watcher.close();
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
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("unhandledRejection", (err) => {
    console.error("[sidecar] unhandled rejection:", err);
    void shutdown(1);
  });

  // Single source of truth for the JSONL watcher's wiring — reused for the
  // initial creation below and for every settings-driven restart, so a change
  // to the store/hub plumbing can't drift between two copies.
  //
  // Append-before-emit (Part 4.5 invariant): the watcher appends the
  // freshly-parsed records to the event store *before* it calls `onEvent`, so
  // the renderer's post-invalidation refetch can never observe a store missing
  // the events that triggered it.
  const jsonlWatcherOptions = (roots: string[]): CreateWatcherOptions => ({
    roots,
    onRecords: (records, projectSlug, sessionId) => {
      // Through the live accessor (ADR-0041): a fleet rebuild swaps the store, so
      // a watcher flush must feed whatever store is current, not the boot one.
      getEngineStore().append(records, projectSlug, sessionId);
      // A project the app has not probed this process — a brand-new checkout,
      // or a new worktree — gets its Repo identity resolved now (ADR-0062),
      // AFTER the append so the flush's own cwd capture is visible to the
      // prober's query. Every later flush for the same slug is a Set hit.
      //
      // Guarded like the other two prober call sites (boot, rescan), and for a
      // sharper reason here: this one shares a `flush()` with the watcher's
      // `onEvent`, so a throw would unwind past `markHasData`,
      // `fleet.notifyLocalChange` AND the SSE `usage:new` emit for the batch —
      // the identity side channel would take the live pipeline down with it.
      // No live throw path exists today (probeRepoId, persist and broadcast all
      // catch); this is symmetry and defence against a future one, not a fix
      // for an observed crash.
      try {
        identityProber.noticeSlug(projectSlug);
      } catch (err) {
        console.error("[sidecar] watcher identity probe failed:", err);
      }
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
  });

  watcher = await createWatcher(jsonlWatcherOptions(watchRoots));

  // Watch settings.json for `claudePaths` edits (ADR-0014). The renderer is
  // the file's sole writer and writes atomically (temp + rename), so a `change`
  // is always a complete document. `add` is handled identically: on a fresh
  // install the renderer creates settings.json *after* the sidecar boots, so
  // the first observed event is an `add`. The reentrancy-safe restart
  // orchestration lives in `createSettingsWatch` (review I1/I2).
  if (settingsPath !== undefined) {
    settingsWatch = createSettingsWatch({
      settingsPath,
      resolveRoots,
      getCurrentRoots: () => watchRoots,
      createJsonlWatcher: (roots) => createWatcher(jsonlWatcherOptions(roots)),
      onRootsChanged: ({ watcher: next, roots }) => {
        const previous = watcher;
        watcher = next;
        watchRoots = roots;
        // Close the superseded watcher; a failure here is logged, not fatal.
        if (previous)
          void previous.close().catch((err: unknown) => {
            console.error("[sidecar] superseded watcher close failed:", err);
          });
        // Broadcast the new watched paths so the status bar updates live.
        liveHub.patchStatus({ watchedPaths: roots });
      },
      scan: (roots) => {
        // Through the live accessor (ADR-0041): a fleet rebuild may have swapped
        // the store since boot, so scan whatever store is current. A newly-added
        // root's history lands outside the watcher path, so `scanAndPoke` pushes
        // it now rather than on the next flush/sweep.
        void scanAndPoke(getEngineStore(), fleet, roots, "root change");
      },
      // The ADR-0041 fleet-toggle hook — fired on every settings edit (roots
      // changed or not), so a share/replica toggle applies in-session without a
      // relaunch. `settingsPath` is narrowed to string inside this block.
      onSettingsChanged: () => {
        const s = readSettingsFile(settingsPath);
        if (s !== null)
          fleet.applySettings({
            hubShareEvents: s.hubShareEvents,
            hubFleetReplica: s.hubFleetReplica,
          });
      },
    });
  }

  // Windows: bun:ffi has no libc.<suffix> to dlopen, so the getppid(2) watchdog
  // can't run here. We no-op to avoid crashing the serving sidecar
  // (libcGetppid()'s dlopen throws on win32, and this runs after the LISTENING
  // handshake — an uncaught throw would tear down the already-serving sidecar).
  //
  // This is COVERED, and not from here: ADR-0072 puts the sidecar in a Win32 Job
  // Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, created by the Rust shell
  // and held for its lifetime, so the KERNEL terminates this process when the
  // shell goes away by any route at all — including the updater's
  // `std::process::exit(0)`, which never reaches kill_sidecar. That is strictly
  // stronger than anything reachable from in here, and needs no code in this
  // file.
  //
  // The other candidate — a stdin-'end' watchdog like the hub daemon's — was
  // declined rather than deferred (#147 Q11): that Bun on win32 emits stdin
  // 'end' after a TerminateProcess'd parent is asserted, not proven
  // (parent-watchdog.test.ts drives a fake emitter), so it would be an
  // unverifiable second mechanism behind a kernel-enforced first one.
  if (process.platform !== "win32") {
    const getPpid = libcGetppid();
    installParentWatchdog({
      getPpid,
      initialPpid: getPpid(),
      label: "sidecar",
      onOrphaned: () => {
        void shutdown();
      },
    });
  }
}

if (import.meta.main) {
  void main();
}
