import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  HUB_PROTOCOL_VERSION,
  type HubStatus,
  type UsageCredential,
  type UsageSample,
  type UsageReading,
} from "@maxprice/shared";
import {
  createDeferredShutdown,
  createFleetEventStore,
  createIdentityDirectory,
  createSampleStore,
  createUsagePoller,
  discoverOrg,
  installParentWatchdog,
  installStdinWatchdog,
  libcGetppid,
  type FleetEventStore,
  type IdentityDirectory,
  type SampleStore,
} from "@maxprice/usage-core";
import type { Env } from "@maxprice/usage-core/home-path";
import { EXIT_INTERRUPTED } from "@maxprice/usage-core/secret-input";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { startUpdateChecks } from "@maxprice/usage-core/update-check";
import { CliError, EXIT, runHubCli, type Writer } from "./cli";
import { defaultDataDir, loadOrInitConfig, requireHub, savePasswordHash } from "./config";
import { prepareDataDir } from "./data-dir";
import { RESTORE_STAGING, restoreHub, unfinishedRestore } from "./restore";
import { hubStatus } from "./status";
import { createMachineDirectory } from "./machine-directory";
import { createOrganizationAssertionDirectory } from "./organization-assertion-directory";
import { createOrganizationDirectory } from "./organization-directory";
import { createHubAuth, mintOperatorSecret } from "./auth";
import { FirstBindError, hostAndPort, startBindReconciler, type BindReconciler } from "./rebind";
import { createClientRegistry } from "./clients";
import { createHubFanout, type HubFanout } from "./fanout";
import { createHubPollSet, type HubPollSet } from "./poll-set";
import { findPortHolder, type PortHolder } from "./port-holder";
import { createOrganizationRoster, type OrganizationRoster } from "./organization-roster";
import { PAGE_MANIFEST } from "#page-manifest";
import { cliPage, cliPageClear, cliPageSet, cliPageSnippet } from "./page-publish";
import type { HubPageDeps } from "./page";
import type { PageManifest } from "./page-manifest";
import { buildHubApp, fleetEventsStatus } from "./server";
import { takeServeLock, type ServeLock } from "./serve-lock";
import { hubService } from "./service";
import { runSetup, type SetupDeps } from "./setup";
import { createSetupTerminal } from "./setup-terminal";
import { hubUpdate } from "./update";
import { createHubUsageStatus } from "./usage-status";
import { PRODUCT } from "./update-channel";
import { VERSION } from "./version";
import { openCredstore, type Credstore } from "./credstore";
import { operatorTokenPath, removeOperatorToken, writeOperatorToken } from "./secrets";
import { reachHub, type ReachOptions, type RunningHub } from "./operator-client";
import {
  keyClear,
  keySet,
  liveCompact,
  liveMergeMachine,
  livePasswordClear,
  livePasswordSet,
  livePurgeMachine,
  liveRenameMachine,
  readNewPassword,
  type SecretDeps,
} from "./operator";

// maxprice-hub (ADR-0035): the standalone always-on usage poller. Its command
// line is cli.ts's (ADR-0127 §2): no command, or `serve`, runs the daemon;
// `status` (ADR-0127 §8, status.ts) describes the running daemon on Linux;
// `password set|clear` (ADR-0037, ADR-0128 §6), `key set|clear` (ADR-0126 §6,
// §7) and the operator verbs `rename`, `merge`, `purge-machine` and `compact`
// (ADR-0041) act on the Hub at the data dir: on Linux through the running
// daemon's own routes while one holds the data dir, else on its files
// (ADR-0127 §7; operator.ts); `restore` (ADR-0130, restore.ts) fills an empty
// data dir from a backup; `service install|uninstall|status|logs` (ADR-0127
// §5–6, service.ts) runs serve as a systemd user unit on Linux; `update`
// (ADR-0129 §4–§5, update.ts) installs the newest release over this binary on
// Linux and restarts the unit that runs it; `page` and
// `page set|clear|snippet` (ADR-0125, page-publish.ts) report and set the Hub
// page URL beside a running Hub; `setup` (ADR-0128 §1–§5, setup.ts) walks
// key set, password set|clear, page set|clear and service install on a
// terminal, making the data dir first. The work behind each is this
// module's, status.ts's, operator.ts's, restore.ts's, service.ts's,
// page-publish.ts's, setup.ts's or update.ts's, handed to cli.ts by the
// entry block at the bottom, so `--version` and `--help` run none of it.
//
// Parent watchdog: installed ONLY when embedded (MAXPRICE_HUB_EMBEDDED=1, the
// tray shell — ADR-0036). Headless `serve` has none — it must OUTLIVE whatever
// spawned it (Linux systemd; ADR-0035), the inverse of the sidecar's
// dies-with-the-app invariant.

// Push-up merge wiring (ADR-0035 M2): set-union the incoming samples into the
// hub's store and, when any were new, patch the fanout status so SSE
// subscribers see the store grow. Exported as a factory so the integration
// test exercises this exact closure rather than a hand-copied double.
export function createMergeSamples(
  store: SampleStore,
  fanout: HubFanout,
): (incoming: UsageSample[]) => number {
  return (incoming) => {
    const added = store.merge(incoming);
    if (added > 0) {
      fanout.patchStatus({
        sampleCount: store.all().length,
        usageLastSampleAt: store.latest()?.capturedAt ?? null,
      });
    }
    return added;
  };
}

// Poller→fanout sample adapter: broadcast each fresh sample live and ride the
// running sampleCount along on the status. Exported alongside createMergeSamples
// so serve()'s status-patch wiring lives in one testable place. The poller
// hands over the sample it appended to history, so the stream carries exactly
// what the store kept, an Enterprise organization's five-hour-only line
// included (#384).
export function createEmitUsageSample(
  store: Pick<SampleStore, "all">,
  fanout: Pick<HubFanout, "emitSample" | "patchStatus" | "getStatus">,
): (organization: string, sample: UsageReading | null, historical: UsageSample | null) => void {
  return (organization, sample, historical) => {
    if (historical !== null) fanout.emitSample(historical);
    fanout.patchStatus({
      sampleCount: store.all().length,
      usageWeeklyResetAt: {
        ...fanout.getStatus().usageWeeklyResetAt,
        ...(sample?.weekly ? { [organization]: sample.weekly.resetAt } : {}),
      },
      usageCurrent: { ...fanout.getStatus().usageCurrent, [organization]: sample },
    });
  };
}

// Bind reconciler → status adapter (ADR-0074). The reconciler reports a changed
// bind set; the console reads it off HubStatus. Exported as a factory for the
// same reason createMergeSamples is: the test drives THIS closure rather than a
// hand-copied double — a reconciler that binds Tailscale correctly but never
// reaches the fanout would leave the console asserting a stale "Local only"
// forever, which is the half of the fix a user actually sees.
export function createBindStatusPatcher(
  fanout: Pick<HubFanout, "patchStatus">,
  warn: (message: string) => void = (message) => console.warn(message),
): (patch: { bindHosts: string[]; bindWarning: string | null }) => void {
  return (patch) => {
    fanout.patchStatus(patch);
    if (patch.bindWarning !== null) warn(`[hub] ${patch.bindWarning}`);
  };
}

// Boot-readiness sequence (F1): load the on-disk history, load the fleet-event
// archive, seed the persisted credential, and start the poller — everything
// every /api/* route gates on. Exported as a factory for the same reason
// createMergeSamples is: the test drives THIS closure rather than a hand-copied
// double.
//
// The seed restores what the status says about the key with it: present, and,
// where the store keeps them (secrets.json, on Linux), when it was set and by
// whom (ADR-0126 §3), so a restart no longer resets them to null. A keychain
// entry keeps neither, so they stay null.
//
// Boot is also where the Hub stamps its usage history (#279): a credstore entry
// written before #283 still carries the orgId this Hub polled with, the
// Organization of every unstamped (legacy) line. The same orgId enters the
// Hub's roster (#284), so this boot polls it even if the listing fails. Only a
// successful stamp AND roster write let the entry lose that evidence — it is
// then rewritten `{ sessionKey }`, so a failure of either retries on the next
// boot (ADR-0104). Boot only — POST /api/credential never stamps: its body is
// the key alone, and a heal is no evidence of this Hub's history.
//
// FOUR INDEPENDENT STEPS, each with its OWN try (F20). They used to be nested
// inside one outer try, which made an early failure skip every later step: a
// usage-history read error suppressed the `events` status patch — and the
// operator console reads a MISSING `events` as "Fleet event archive failed to
// load", a confidently wrong cause — as well as the credential seed and
// poller.start(), costing the hub its M1 duty over an unrelated fault. Flattened,
// the archive load is the only thing that can drop `events` from the status, which
// makes that console copy honest by construction.
//
// NEVER rejects: every step swallows its own error, because the route gate
// (`ready` in buildHubApp) awaits this promise and a rejection would 500 every
// /api/* request for the daemon's lifetime.
export type ReadySequenceDeps = {
  sampleStore: Pick<SampleStore, "loadHistory" | "all" | "latest" | "stampUnstamped">;
  fleetEvents: FleetEventStore;
  credstore: Pick<Credstore, "get" | "set">;
  poller: {
    setCredential: (c: UsageCredential | null) => void;
    start: () => void;
  };
  roster: Pick<OrganizationRoster, "remember">;
  pollSet: Pick<HubPollSet, "boot">;
  fanout: Pick<HubFanout, "patchStatus">;
  // Fired when the archive load throws. serve() flips its `eventsUsable` flag,
  // which makes the event + archive-mutation routes 503 (F3) — the on-disk log
  // must not be rewritten from a RAM image we failed to read.
  onEventsUnusable: () => void;
};

export async function runReadySequence(deps: ReadySequenceDeps): Promise<void> {
  const { sampleStore, fleetEvents, credstore, poller, roster, pollSet, fanout } = deps;
  try {
    // Resolves the store's own `ready` too (F6) — harmless overlap.
    await sampleStore.loadHistory();
    fanout.patchStatus({
      sampleCount: sampleStore.all().length,
      usageLastSampleAt: sampleStore.latest()?.capturedAt ?? null,
    });
  } catch (err) {
    console.error("[hub] usage-history load failed:", err);
  }
  // Event-sync capability is status-advertised (ADR-0041): presence of `events`
  // on HubStatus ⇔ this hub speaks event sync. Patched only once the archive is
  // loaded, so epoch/watermark are never half-derived; the route gate (`ready`)
  // keeps /api/status unanswerable until then.
  try {
    await fleetEvents.load();
    fanout.patchStatus({ events: fleetEventsStatus(fleetEvents) });
  } catch (err) {
    // An event-archive load/repair failure degrades the EVENT surface only. Two
    // independent brakes, and neither is the old (wrong) "pushes 500":
    //   - no `events` on the status ⇒ the CLIENT's capability gate never arms
    //     (event-sync.ts's connect() degrades on `events === null`), so a
    //     well-behaved client stops pushing on its own;
    //   - onEventsUnusable ⇒ the SERVER 503s /api/events and the archive
    //     mutations, so an ill-behaved client, a curl, or an operator hitting
    //     Compact cannot write RAM's survivors over the log we failed to read.
    // It must never cost the hub its M1 duty: the credential seed and the
    // usage-limit poller below still run.
    deps.onEventsUnusable();
    console.warn("[hub] fleet-event archive load failed:", err);
  }
  try {
    const stored = await credstore.get();
    if (stored !== null) {
      const cred: UsageCredential = { sessionKey: stored.sessionKey };
      if (stored.orgId !== undefined) {
        // A pre-#283 entry: its orgId is what this Hub polled with. It stamps
        // the legacy lines (#279) and enters the roster (#284) BEFORE the seed,
        // so boot polls it even if the listing fails — whatever the stamp's
        // outcome; only when both landed may the entry lose that evidence.
        // Each in its own try — none may cost the seed, the listing or
        // poller.start() (F20). A failed roster write throws after memory holds
        // the id, so this boot still polls it; only the rewrite waits for a
        // later boot.
        let stamped = false;
        try {
          await sampleStore.stampUnstamped(stored.orgId);
          stamped = true;
        } catch (err) {
          console.warn("[hub] usage-history stamp failed:", err);
        }
        let remembered = false;
        try {
          roster.remember(stored.orgId);
          remembered = true;
        } catch (err) {
          console.warn("[hub] organization roster write failed:", err);
        }
        if (stamped && remembered) {
          try {
            await credstore.set(cred);
          } catch (err) {
            console.warn("[hub] credstore rewrite failed:", err);
          }
        }
      }
      poller.setCredential(cred);
      fanout.patchStatus({
        credentialPresent: true,
        credentialUpdatedAt: stored.provenance?.setAt ?? null,
        credentialSource: stored.provenance?.source ?? null,
      });
      // Boot polls the persisted roster at once and lists in the background
      // (#284): each minute while the listing fails and nothing is polled,
      // hourly otherwise. A listing that refuses the key expires it and
      // schedules nothing. Not awaited: neither `ready` nor poller.start()
      // waits on the network.
      void pollSet.boot(cred.sessionKey);
    }
  } catch (err) {
    console.warn("[hub] credstore read failed:", err);
  }
  // UNCONDITIONAL — the hub's M1 duty outranks every step above. Its own try
  // only preserves the never-rejects contract.
  try {
    poller.start();
  } catch (err) {
    console.error("[hub] poller start failed:", err);
  }
}

// True when the tray shell (Phase 2) spawned us as its sidecar — it sets
// MAXPRICE_HUB_EMBEDDED=1. Gates the OPERATOR_TOKEN stdout emit and the
// parent-death watchdog; headless `serve` (Linux) leaves it unset (ADR-0035/0036)
// and, on Linux, keeps its operator secret in a file instead (ADR-0126 §8).
export function isEmbedded(env: Record<string, string | undefined> = process.env): boolean {
  return env.MAXPRICE_HUB_EMBEDDED === "1";
}

// Whether `serve` owns its data dir through serve.lock (ADR-0127 §3): a
// Headless Hub on Linux, where the Headless Hub runs and where flock binds
// glibc's libc.so.6. An embedded daemon never does: the tray app's daemon is
// unchanged, with no lock and no 0700 tightening.
export function isLockable(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return !isEmbedded(env) && platform === "linux";
}

// Whether `serve` checks the update channel (ADR-0129 §6): a Headless Hub on
// Linux, the one `maxprice-hub update` can update, since the channel's one
// entry is linux-x86_64 and `update` is Linux only. An embedded daemon never
// does: the tray app has Tauri's updater, which reads `hub-latest.json`.
// The same test as isLockable's today, kept apart because it answers
// another question.
export function checksForUpdates(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return !isEmbedded(env) && platform === "linux";
}

// Who mints the per-launch operator secret (ADR-0037's first lane) and where
// it goes. An embedded daemon prints it for the tray shell (`OPERATOR_TOKEN`,
// bootAnnouncement). A Headless Hub on Linux writes it to
// `<data dir>/operator-token`, 0600, for the commands on its own machine,
// and never prints it, so it stays out of the journal (ADR-0126 §8). A
// Headless Hub elsewhere mints none.
export function operatorSecretCustody(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): "stdout" | "file" | null {
  if (isEmbedded(env)) return "stdout";
  return isLockable(env, platform) ? "file" : null;
}

// The Hub page dep buildHubApp mounts /page/ from (ADR-0124 §1): a Headless
// Hub always gets it, whether or not a Hub page URL is set, so an SSH tunnel to
// the Hub's port reaches the page with no web server. An embedded daemon gets
// none: the tray app's routes are unchanged. `manifest` is the build's own
// (`#page-manifest`, empty in every build but the linux-x64 compile).
export function hubPageDeps(
  env: Record<string, string | undefined>,
  manifest: PageManifest,
  version: string,
): HubPageDeps | undefined {
  return isEmbedded(env) ? undefined : { manifest, version };
}

// A Headless Hub's boot lines for its page (ADR-0125 §5): the loopback URL a
// web server proxies to, with the Hub page URL it is published at when one is
// set, as read at boot (a later `page set` needs no restart, and leaves this
// line stale until the next start), and, when this build carries no page
// files (a source run, or a non-linux build run headless), a warning that
// /page/ will 404 while /page/view still answers.
export function hubPageBootLines(
  port: number,
  manifest: PageManifest,
  pageUrl: string | null,
): { log: string; warn: string | null } {
  return {
    log: `[hub] Hub page: http://127.0.0.1:${port}/page/ (loopback only)${pageUrl === null ? "" : `, published at ${pageUrl}`}`,
    warn: Object.hasOwn(manifest, "index.html")
      ? null
      : "[hub] this build embeds no Hub page files, so /page/ answers 404; the linux-x64 build embeds them (bun apps/hub/scripts/build-binaries.ts linux-x64)",
  };
}

// What serve prints once its first bind holds. An embedded daemon keeps the
// stdout handshake (ADR-0036; mirrors the sidecar's ADR-0002): the tray app's
// Rust shell reads `LISTENING <port>` to learn the port (get_hub_url) and
// captures `OPERATOR_TOKEN`, the per-launch operator secret (ADR-0037), for
// the webview's Authorization header WITHOUT echoing it. Every bind shares
// config.port, and the set of bound hosts changes over the daemon's life, so
// the port is announced exactly once, from the config. A Headless Hub prints
// neither: nothing reads them, and its journal must never hold a secret
// (ADR-0127 §9). Its `listening on` lines bracket an IPv6 host, as a URL
// does; the embedded daemon's stay as they were.
export function bootAnnouncement(boot: {
  embedded: boolean;
  port: number;
  hosts: readonly string[];
  operatorSecret: string | null;
}): { handshake: string[]; listening: string[] } {
  const { embedded, port, hosts, operatorSecret } = boot;
  return {
    handshake: embedded
      ? [
          `LISTENING ${port}\n`,
          ...(operatorSecret === null ? [] : [`OPERATOR_TOKEN ${operatorSecret}\n`]),
        ]
      : [],
    listening: hosts.map(
      (host) =>
        `[hub] listening on http://${embedded ? `${host}:${port}` : hostAndPort(host, port)}`,
    ),
  };
}

// GET /healthz with a manual timeout (NOT AbortSignal.timeout — the bun/win32
// parked-loop bug, commit 199c284): whether it answered 2xx and the service
// its body names, or null when nothing answered in time.
async function getHealthz(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; service: unknown } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1_500);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    const body = (await res.json().catch(() => null)) as { service?: unknown } | null;
    return { ok: res.ok, service: body?.service };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// After a failed first bind (ADR-0127 §2): whether a Hub answers /healthz
// where the bind failed, which its body says by naming the service
// `maxprice-hub` (a sidecar's names `maxprice-sidecar`). A wildcard is asked
// on its own loopback.
export async function hubAnswersAt(
  host: string,
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const at = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const answer = await getHealthz(`http://${hostAndPort(at, port)}/healthz`, fetchImpl);
  return answer?.ok === true && answer.service === "maxprice-hub";
}

// serve's one line for a failed first bind (ADR-0127 §2). A port in use says
// what holds it, a Hub or not, and the holder's pid and command when /proc
// shows them (`findPortHolder`); any other failure is the listen error's own
// message.
export function bindFailureLine(
  error: FirstBindError,
  hubAnswers: boolean,
  holder: PortHolder | null = null,
): string {
  const at = `[hub] cannot bind ${hostAndPort(error.host, error.port)}`;
  if (error.code === "EADDRINUSE") {
    const who = holder === null ? "" : ` (pid ${holder.pid}, ${holder.command})`;
    return hubAnswers
      ? `${at}: a Hub already answers /healthz there${who} (EADDRINUSE)`
      : `${at}: something that is not a Hub holds it${who} (EADDRINUSE)`;
  }
  const cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
  return error.code === undefined ? `${at}: ${cause}` : `${at}: ${cause} (${error.code})`;
}

// Backpressure-aware single-line stdout write — the handshake lines must land
// intact (mirrors the sidecar's writeLine, ADR-0002).
async function writeLine(line: string): Promise<void> {
  if (!process.stdout.write(line)) {
    await new Promise<void>((resolve) => process.stdout.once("drain", () => resolve()));
  }
}

// The sole enforcement of IdentityDirectory.usable()'s CALLER OBLIGATION on the
// serve path (ADR-0062) — extracted from serve() so it is reachable by a test at
// all, since serve() binds ports, opens the credstore and starts the poller.
//
// An identity file that did not FULLY LOAD — unreadable, or read but corrupt —
// must withhold the whole route surface, not serve a fragment as the union: RAM
// then holds at most what has been probed since boot, and a client's pull reads
// a missing row as a purge instruction (adoptUnion), wiping every offline
// machine's mirrored rows fleet-wide. Returning `undefined` is the
// already-tested pre-identity degrade: clients 404-probe, latch
// identityUnsupported, and stay safely local for this run. The events archive
// solves the same shape with eventsUsable(); identity can answer it at build
// time because nothing re-attempts the load. Restart is the cure — so say so.
export function resolveIdentityDirectory(store: IdentityDirectory): IdentityDirectory | undefined {
  if (store.usable()) return store;
  console.warn(
    "[hub] identity-directory.json could not be read or was corrupt (a .bak was kept if so) — identity sync is DISABLED this run (clients stay local-only); fix or remove the file and restart the hub",
  );
  return undefined;
}

// The lock's descriptor, held for the process's whole life (ADR-0127 §3).
let serveLock: ServeLock | null = null;

async function serve(): Promise<number> {
  const env = process.env;
  const embedded = isEmbedded(env);
  const dataDir = defaultDataDir(env);
  // ADR-0127 §3: a Headless Hub on Linux makes its data dir 0700 and takes
  // serve.lock before loadOrInitConfig can rewrite hub.json, so a second
  // serve on this dir exits 5 having changed nothing, once the take's bounded
  // retry has run out (serve-lock.ts). Everywhere else the dir
  // is made as it always was, with no lock. Only serve makes a data dir, and
  // setup, which makes it as this does before its first step (ADR-0128 §2),
  // and restore, which fills it from a backup (§4, ADR-0130).
  if (isLockable(env)) {
    prepareDataDir(dataDir);
    serveLock = await takeServeLock(dataDir, env);
  } else {
    mkdirSync(dataDir, { recursive: true });
  }
  // ADR-0130: a restore killed while it placed its files left its staging
  // dir beside them, maybe with no hub.json yet. Refused under the lock, so a
  // restore still running is exit 5 first, and before loadOrInitConfig, which
  // would write a default hub.json beside a half-placed archive and boot it.
  // On every platform: a data dir may be copied to one.
  if (existsSync(join(dataDir, RESTORE_STAGING))) throw unfinishedRestore(dataDir, env);
  const config = loadOrInitConfig(dataDir);
  // The port joins the pid in the record, for the commands that will reach a
  // running Hub through it (ADR-0127 §7).
  serveLock?.recordPort(config.port);

  // Per-launch operator secret (ADR-0037's first lane), which passes the gate
  // whatever the password state (operatorSecretCustody). Embedded, the tray
  // shell captures it from stdout for the console. A Headless Hub on Linux
  // keeps it in `operator-token`, written just before the first bind below and
  // removed at the teardown, so whatever answers /healthz has it on disk
  // (ADR-0126 §8). A Headless Hub elsewhere mints none.
  const custody = operatorSecretCustody(env);
  const operatorSecret = custody === null ? null : mintOperatorSecret();
  const operatorToken = custody === "file" ? operatorTokenPath(dataDir) : null;
  const auth = createHubAuth({ passwordHash: config.passwordHash, operatorSecret });

  // createSampleStore returns OwnedSampleStore (SampleStore + flush); type as
  // the return type directly so shutdown can call flush().
  const sampleStore = createSampleStore({ path: join(dataDir, "usage-history.jsonl") });

  // Fleet event archive + machine directory (ADR-0041, M4). The directory
  // loads synchronously (small file); the event store's load runs inside
  // `ready` below so no /api/* route can observe a half-loaded archive.
  const fleetEvents = createFleetEventStore({
    path: join(dataDir, "events.sqlite"),
    mode: "hub",
  });
  const machineDirectory = createMachineDirectory({
    path: join(dataDir, "machine-directory.json"),
  });
  // Organization directory (#288): the fleet union of Organization labels.
  // Loads synchronously beside the machine directory, a small file too.
  const organizationDirectory = createOrganizationDirectory({
    path: join(dataDir, "organization-directory.json"),
  });
  // Organization assertion directory (#310): the fleet union of Organization
  // assertions. Loads synchronously beside the Organization directory — one
  // read, at its 20,000-session cap ~2.7 MB with UUID session ids and ~5.1 MB
  // with every key at its schema limit.
  const organizationAssertionDirectory = createOrganizationAssertionDirectory({
    path: join(dataDir, "organization-assertion-directory.json"),
  });

  // Identity directory (ADR-0062): the fleet union of "which repo is this
  // machine's project directory a checkout of". Loads synchronously beside the
  // machine directory — a small file, and the routes it backs are additive.
  const identityStore = createIdentityDirectory({
    path: join(dataDir, "identity-directory.json"),
  });
  identityStore.load();
  const identityDirectory = resolveIdentityDirectory(identityStore);

  const initialStatus: HubStatus = {
    service: "maxprice-hub",
    protocolVersion: HUB_PROTOCOL_VERSION,
    usageConnection: "disconnected",
    usageLastSampleAt: null,
    usageWeeklyResetAt: {},
    usageCurrent: {},
    organizations: {},
    sampleCount: 0,
    credentialPresent: false,
    // Seeded EMPTY on purpose (ADR-0074). The bind reconciler's first pass runs
    // synchronously below and patches both of these before any socket can
    // accept a request, so nothing ever observes the empty seed. Resolving the
    // interface table a second time here to pre-fill them was the bug: if the
    // tailnet appeared between that read and the reconciler's own (the login
    // boot, with the credstore probes and all of buildHubApp in between), the
    // reconciler bound everything, saw its state already equal to this snapshot,
    // and never patched — leaving HubStatus asserting "loopback only, no tailnet
    // interface" for the daemon's whole life while the log below printed the
    // real tailnet address. One resolution, one report.
    bindHosts: [],
    // The bind's diagnosis rides the wire too (ADR-0049) — the console needs it
    // to tell a chosen loopback bind from a failed tailnet one.
    bindWarning: null,
    // ADR-0037: reflect the persisted gate at boot; POST /api/password patches
    // it live so the console's Access card re-renders on set/clear.
    passwordProtected: config.passwordHash !== null,
    // Provenance/display start empty (ADR-0036). POST /api/credential fills
    // credentialUpdatedAt/credentialSource, and on Linux the boot's credential
    // seed restores them from secrets.json (ADR-0126 §3). `startedAt` is
    // stamped ONCE here — this is daemon runtime, not pure tested logic, so a
    // direct new Date() is fine — and the console renders real uptime from it.
    credentialUpdatedAt: null,
    credentialSource: null,
    startedAt: new Date().toISOString(),
  };
  const fanout = createHubFanout({ initialStatus });

  // The Hub's discovered roster (#284): what its key last listed.
  const roster = createOrganizationRoster({ path: join(dataDir, "organization-roster.json") });
  // The key-level usageConnection (#267 item 2); each poller publish records
  // its Limits answers in the roster.
  const usageStatus = createHubUsageStatus(fanout, { roster });

  // PollerHub adapter: poller broadcasts → fanout; sampleCount rides along.
  const poller = createUsagePoller({
    store: sampleStore,
    liveHub: {
      emitUsageSample: createEmitUsageSample(sampleStore, fanout),
      patchStatus: usageStatus.patchStatus,
    },
    // Fake-claude seam (ADR-0035); unset in production → real claude.ai.
    baseUrl: process.env.MAXPRICE_CLAUDE_BASE_URL,
  });
  // The Organizations the poller reads: whatever the key lists (#283), booted
  // from the roster (#284).
  const pollSet = createHubPollSet({
    list: (sessionKey) =>
      discoverOrg({ sessionKey, baseUrl: process.env.MAXPRICE_CLAUDE_BASE_URL }),
    poller,
    roster,
    onDiscoveryFailed: usageStatus.setDiscoveryFailed,
  });

  // The key's store, by platform (ADR-0126 §1): on Linux
  // `<data dir>/secrets.json`, read once by the boot's credential seed;
  // elsewhere the keychain helper, else memory.
  const credstore = openCredstore(dataDir, {
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
  });

  const registry = createClientRegistry();

  // Browser CORS allowlist (ADR-0036, overview §9). Populated ONLY when the tray
  // shell embedded us (it sets MAXPRICE_HUB_EMBEDDED=1): the Tauri webview origins
  // always, plus a dev renderer origin via MAXPRICE_HUB_ALLOWED_ORIGIN (the shell
  // sets it in dev, mirroring VITE_SIDECAR_ORIGIN). Headless serve ⇒ [] ⇒ no CORS.
  const allowedOrigins = embedded
    ? [
        "tauri://localhost",
        "http://tauri.localhost",
        ...(process.env.MAXPRICE_HUB_ALLOWED_ORIGIN
          ? [process.env.MAXPRICE_HUB_ALLOWED_ORIGIN]
          : []),
      ]
    : [];

  // Archive health (F3). buildHubApp runs BELOW but `ready` resolves LATER, so
  // the load outcome cannot be expressed by withholding the `fleetEvents` dep at
  // build time — the server reads this through a request-time predicate instead.
  let eventsUsable = true;

  // Boot-readiness gate (F1): the history load, the archive load, the credential
  // seed, and poller.start() — all BEHIND a single promise every /api/* route
  // awaits (below, in buildHubApp). Bun.serve still binds before it resolves
  // (the tray's LISTENING handshake can't wait), but no data route answers
  // until it does, so a client never observes a half-loaded store (a backfill
  // hole its since-cursor then skips forever; a re-append of samples the
  // unloaded file already holds) nor a not-yet-seeded credential (an auto-heal
  // POST overwriting a healthy stored key before the hub's own seed reads
  // it). Started ONCE, fire-and-forget, by startReadySequence the moment the
  // first bind holds, with no await between the two: a failed first bind then
  // exits before the history and the archive load, the credential is read or
  // anything is polled (ADR-0127 §2). The route middleware awaits it.
  // runReadySequence NEVER rejects (see its comment). Because it's off
  // serve()'s synchronous path, a hung credstore.get() can no longer stop the
  // signal handlers below from registering (F26).
  let startReadySequence = (): void => {};
  const ready = new Promise<void>((resolve) => {
    startReadySequence = () =>
      resolve(
        runReadySequence({
          sampleStore,
          fleetEvents,
          credstore,
          poller,
          roster,
          pollSet,
          fanout,
          onEventsUnusable: () => {
            eventsUsable = false;
          },
        }),
      );
  });

  // A Headless Hub's page (ADR-0124 §1), decided once: what mounts /page/ is
  // also what logs it below.
  const page = hubPageDeps(process.env, PAGE_MANIFEST, VERSION);

  const app = buildHubApp({
    auth,
    // Password set/clear (ADR-0037): hash → persist → swap the live gate →
    // patch status so the console's Access card re-renders.
    setPassword: async (password) => {
      const hash = password === null ? null : await Bun.password.hash(password);
      savePasswordHash(dataDir, hash);
      auth.setPasswordHash(hash);
      fanout.patchStatus({ passwordProtected: hash !== null });
    },
    fanout,
    samples: () => sampleStore.all(),
    mergeSamples: createMergeSamples(sampleStore, fanout),
    usage: {
      setCredential: poller.setCredential,
      pollOnce: poller.pollOnce,
    },
    pollSet,
    persistCredential: (cred, provenance) => credstore.set(cred, provenance),
    registry,
    fleetEvents,
    // Request-time archive health (F3): false once the load above threw, which
    // 503s the event routes and every archive mutation until a restart.
    eventsUsable: () => eventsUsable,
    machineDirectory,
    identityDirectory,
    // Why the dep above may be absent: withholding it is overloaded (a hub with
    // no identity capability withholds it too), and the machine-purge cascade
    // must be able to tell a capability-free hub from a broken one so it can say
    // out loud that the identity half of the purge did not happen.
    identityDegraded: () => !identityStore.usable(),
    organizationDirectory,
    organizationAssertionDirectory,
    // The console's roster route and the operator rename read it as it stands.
    organizationRoster: () => roster.list(),
    allowedOrigins,
    ready,
    page,
  });

  // ADR-0126 §8: on disk before the first bind, over any a crash left, so
  // the daemon that answers /healthz has its secret there. A failure is
  // exit 1.
  if (operatorToken !== null && operatorSecret !== null) {
    writeOperatorToken(operatorToken, operatorSecret);
  }

  // The bind reconciler owns every bind from here on (ADR-0074). Its FIRST pass
  // runs synchronously, inside this call, and a throw from it is fatal: one
  // line saying what holds the port, exit 1, no zombie (ADR-0127 §2). With
  // presence gating in front of it that throw means another process owns the
  // port, because an address the machine doesn't have is never attempted: a
  // second hub instance on another data dir (serve.lock stops one on this dir,
  // on Linux), or something that is no Hub at all, which a /healthz probe
  // tells apart. Every LATER pass is guarded and retries, which is what stops a
  // hub launched at login from being stranded on loopback when it beats
  // Tailscale to the interface.
  let binds: BindReconciler;
  try {
    binds = startBindReconciler({
      bind: config.bind,
      port: config.port,
      fetch: app.fetch,
      onBoundChange: createBindStatusPatcher(fanout),
      log: (line) => console.log(line),
    });
  } catch (error) {
    // No daemon came of this launch, so its secret goes before the exit.
    if (operatorToken !== null) removeOperatorToken(operatorToken, (line) => console.error(line));
    if (!(error instanceof FirstBindError)) throw error;
    const inUse = error.code === "EADDRINUSE";
    const hub = inUse && (await hubAnswersAt(error.host, error.port));
    const holder = inUse ? findPortHolder(error.host, error.port) : null;
    throw new CliError(EXIT.FAILURE, bindFailureLine(error, hub, holder));
  }
  startReadySequence();

  const announced = bootAnnouncement({
    embedded,
    port: config.port,
    hosts: binds.hosts(),
    operatorSecret,
  });
  for (const line of announced.handshake) await writeLine(line);
  // Human-readable logs. This is the boot snapshot only; the reconciler logs
  // every later bind and drop.
  for (const line of announced.listening) console.log(line);
  if (page !== undefined) {
    const pageLines = hubPageBootLines(config.port, page.manifest, config.pageUrl ?? null);
    console.log(pageLines.log);
    if (pageLines.warn !== null) console.warn(pageLines.warn);
  }
  console.log(
    config.passwordHash === null
      ? "[hub] no password set — open on the tailnet (set one from the console or `maxprice-hub password set`)"
      : "[hub] password protected",
  );
  console.log(`[hub] data dir: ${dataDir}`);

  // History load + credential seed + poller.start() already run inside `ready`
  // (created above, before the app was built) so every /api/* route can gate on
  // them. Shutdown + signal handlers are registered HERE — after the bind, on
  // serve()'s synchronous path — and are therefore reached even if `ready`'s
  // credstore.get() is wedged behind a locked keychain (F26): the seed is off
  // this line, so it can never leave the daemon HTTP-serving yet
  // signal-handler-less.
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (exitCode = 0): Promise<void> => {
    shutdownPromise ??= (async () => {
      try {
        // First, so no late listing or retry installs a set behind the stop.
        pollSet.stop();
        await poller.stop();
        await sampleStore.flush();
        await fleetEvents.close();
        fanout.close();
        // Stops the reconcile timer first, then every bind it owns (ADR-0074).
        await binds.stop();
      } catch (err) {
        console.error("[hub] shutdown teardown error:", err);
      }
      // ADR-0126 §8: the secret goes with the daemon that minted it. Its own
      // step, after the teardown, so a teardown error still removes it and a
      // failed removal (one line) still exits.
      if (operatorToken !== null) {
        removeOperatorToken(operatorToken, (line) => console.error(line));
      }
      process.exit(exitCode);
    })();
    return shutdownPromise;
  };
  // Hand the real teardown to the watchdogs armed at module scope, before
  // `serve()` was ever called (ADR-0078 — see `armHubWatchdogs`). Until this
  // line lands, an orphaning exits immediately instead.
  deferredShutdown.set(() => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  // ADR-0127 §2: closing a foreground serve's terminal stops a Headless Hub as
  // SIGTERM does, through the teardown above, so the archive is closed and its
  // WAL checkpointed. The tray app's daemon registers none.
  if (!embedded) {
    process.on("SIGHUP", () => {
      console.log("[hub] SIGHUP: stopping as on SIGTERM");
      void shutdown();
    });
  }
  process.on("unhandledRejection", (err) => {
    console.error("[hub] unhandled rejection:", err);
    void shutdown(1);
  });
  // ADR-0129 §6: a Headless Hub on Linux checks its channel at boot and
  // every 6 h, in this process, writes update-check.json for `status`'s
  // Update row, and logs a newer version once, after the boot lines above.
  // It never installs anything (only `maxprice-hub update` does), and never
  // throws: a failed check is recorded, a failed write logged. Its timers are
  // unref'd, so they never keep a stopping daemon alive. An embedded daemon
  // never checks (checksForUpdates).
  if (checksForUpdates(env)) {
    startUpdateChecks({
      product: PRODUCT,
      currentVersion: VERSION,
      dataDir,
      log: (line) => console.log(`[hub] ${line}`),
    });
  }
  return EXIT.OK;
}

// Whether an offline password change applies: on Linux the verb held
// serve.lock, so no Hub runs and the next one to start reads it; elsewhere a
// running daemon holds its config in memory until it restarts. A Hub running
// on Linux was sent the change live instead (livePasswordSet).
function passwordApplies(locked: boolean): string {
  return locked ? "the Hub applies it when it starts" : "restart the hub daemon to apply";
}

// `maxprice-hub password set`, offline (ADR-0037): hub.json gets the
// password's argon2id hash. The password was read, never from argv, and
// checked by readNewPassword (operator.ts, ADR-0128 §6) before the Hub was
// reached, so an invalid one never gets here.
export async function cliPasswordSet(
  dataDir: string,
  password: string,
  locked: boolean,
): Promise<string> {
  savePasswordHash(dataDir, await Bun.password.hash(password));
  return `password set — ${passwordApplies(locked)}`;
}

// `maxprice-hub password clear`, offline: the Hub opens.
export async function cliPasswordClear(dataDir: string, locked: boolean): Promise<string> {
  savePasswordHash(dataDir, null);
  return `password cleared — ${passwordApplies(locked)}`;
}

// ── M7 operator CLI verbs (ADR-0041): headless parity for the console's
// rename / merge / purge / compact. Two writers on the data files would
// corrupt them (and Windows blocks a rewrite's rename over the daemon's open
// handle), so a running daemon stays their only writer: on Linux, while one
// holds serve.lock, runOperatorVerb sends each verb to that daemon's own
// route, the console's, and the change applies at once (ADR-0127 §7,
// operator.ts's live twins). With the lock free, or off Linux once no daemon
// answers on hub.json's port, the cli* functions below mutate the DATA FILES
// directly, as the password verbs do: file access is the authority. Each
// returns a success line; failures throw, and exit 2.

// Off Linux, where there is no serve.lock, the archive verbs' only check:
// whether a daemon answers on hub.json's port, which may have changed under
// it.
export async function daemonRunning(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  return (await getHealthz(`http://127.0.0.1:${port}/healthz`, fetchImpl))?.ok === true;
}

// One command that acts on a Hub's data, both ways.
export type OperatorVerb = {
  // The edit of the data files, told whether it holds serve.lock.
  offline: (dataDir: string, locked: boolean) => Promise<string>;
  // The same operation through the running daemon's own route.
  live: (hub: RunningHub) => Promise<string>;
};

export type OperatorVerbOptions = {
  env?: Env;
  platform?: NodeJS.Platform;
  // rename, merge, purge-machine and compact, which open the fleet event
  // archive: off Linux they first probe for a running daemon, and any failure
  // of their offline edit exits 2. The password verbs keep no check there,
  // and fail with their own codes.
  opensArchive?: boolean;
  // reachHub's, for a test: a short bound on the reach and each request, a
  // holder's cgroup.
  reach?: ReachOptions;
  // Where the success line goes, console.log's stdout when unset. Setup's
  // step 2 runs `password set|clear` with a writer that indents their lines
  // under its own (ADR-0128 §3).
  out?: Writer;
};

// The frame of every command that acts on a Hub's data. It refuses a data dir
// with no hub.json before it creates anything: only serve or setup makes a
// Hub, or restore brings one back from a backup (ADR-0127 §4, ADR-0128 §2,
// ADR-0130). On Linux it asks reachHub (operator-client.ts, ADR-0127 §7): a
// daemon holding serve.lock is sent the command `live`, through its own
// route, whose refusals are the live function's CliErrors, and nothing here
// touches a file; with the lock free the command runs `offline` under it, so
// neither a serve nor another such command runs beside it (§3). Off Linux
// there is no lock, and `offline` runs as it always has, after the archive
// verbs' /healthz probe. Either returns the success line, printed here
// through `terminalText` (ADR-0127 §11), as cli.ts prints an error: it
// carries values from outside this process, a machine id from argv and a name
// from the Machine directory, which clients register from their hostnames and
// nothing strips of control characters. It goes to `out` when one is given,
// else to console.log.
export async function runOperatorVerb(
  { offline, live }: OperatorVerb,
  {
    env = process.env,
    platform = process.platform,
    opensArchive = false,
    reach,
    out,
  }: OperatorVerbOptions = {},
): Promise<number> {
  const print = (line: string): void => {
    if (out === undefined) console.log(terminalText(line));
    else out.write(`${terminalText(line)}\n`);
  };
  const dataDir = requireHub(env, platform);
  let lock: ServeLock | null = null;
  if (platform === "linux") {
    const reached = await reachHub(dataDir, env, reach);
    if (reached.kind === "live") {
      print(await live(reached.hub));
      return EXIT.OK;
    }
    lock = reached.lock;
  }
  try {
    if (lock === null && opensArchive) {
      const { port } = loadOrInitConfig(dataDir);
      if (await daemonRunning(port)) {
        throw new CliError(
          EXIT.FAILURE,
          `a hub daemon is responding on port ${port} — stop it first (these commands edit the data files directly)`,
        );
      }
    }
    let line: string;
    try {
      line = await offline(dataDir, lock !== null);
    } catch (error) {
      if (!opensArchive || error instanceof CliError) throw error;
      throw new CliError(EXIT.USAGE, error instanceof Error ? error.message : String(error));
    }
    print(line);
    return EXIT.OK;
  } finally {
    lock?.release();
  }
}

// `maxprice-hub password set` (ADR-0128 §6, ADR-0127 §7): the data dir
// first, so a mistyped one costs no typing; then the password, read and
// checked before the Hub is reached, so no prompt holds serve.lock, which a
// `serve` starting meanwhile would lose with exit 5; then the change, live or
// offline, its line printed as `options` say. Ctrl-C at a prompt is exit 130,
// with nothing written.
export async function runPasswordSet(
  options: OperatorVerbOptions = {},
  secret: SecretDeps = {},
): Promise<number> {
  requireHub(options.env, options.platform);
  const password = await readNewPassword(secret);
  if (password === null) return EXIT_INTERRUPTED;
  return await runOperatorVerb(
    {
      offline: (dataDir, locked) => cliPasswordSet(dataDir, password, locked),
      live: (hub) => livePasswordSet(hub, password),
    },
    options,
  );
}

// `maxprice-hub password clear`, both ways: the command's, and setup's step
// 2's (setupPasswordSteps).
const PASSWORD_CLEAR: OperatorVerb = {
  offline: (dataDir, locked) => cliPasswordClear(dataDir, locked),
  live: (hub) => livePasswordClear(hub),
};

// Setup's step 2 (ADR-0128 §3): `password set` and `password clear`, this
// module's code, which setup cannot import, since this module imports setup.
// Each prints its line to the writer setup hands it, indented under the step,
// and `password set` reads through setup's own prompts, as on a terminal.
// `options` are a test's environment, platform and reach; production's
// wiring passes none.
export function setupPasswordSteps(
  options: OperatorVerbOptions = {},
): Pick<SetupDeps, "passwordSet" | "passwordClear"> {
  return {
    passwordSet: (read, out) =>
      runPasswordSet({ ...options, out }, { readSecret: read, interactive: true }),
    passwordClear: (out) => runOperatorVerb(PASSWORD_CLEAR, { ...options, out }),
  };
}

// `purge-machine`'s typed name, asked on either path. The prompt shows the
// name through `terminalText`, as runOperatorVerb prints its line, and the
// typed answer is compared with the name as the Machine directory holds it.
export function confirmPurge(
  expected: string,
  ask: (message: string) => string | null = prompt,
): boolean {
  const typed =
    ask(`Type the machine's name ("${terminalText(expected)}") to confirm purge:`) ?? "";
  return typed === expected;
}

function openDirectory(dataDir: string) {
  return createMachineDirectory({ path: join(dataDir, "machine-directory.json") });
}

export async function cliRenameMachine(
  dataDir: string,
  machineId: string,
  name: string,
): Promise<string> {
  const store = createFleetEventStore({ path: join(dataDir, "events.sqlite"), mode: "hub" });
  try {
    await store.load();
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > 63) throw new Error("invalid name (1-63 chars)");
    const result = openDirectory(dataDir).rename(machineId, trimmed);
    if (result === "unknown") throw new Error(`unknown machine: ${machineId}`);
    if (result === "collision") throw new Error(`name already in use: ${trimmed}`);
    return `renamed ${machineId} to "${trimmed}"`;
  } finally {
    await store.close();
  }
}

export async function cliMergeMachine(
  dataDir: string,
  sourceId: string,
  targetId: string,
): Promise<string> {
  const store = createFleetEventStore({ path: join(dataDir, "events.sqlite"), mode: "hub" });
  try {
    await store.load();
    const result = openDirectory(dataDir).merge(sourceId, targetId);
    if (result === "unknown-source") throw new Error(`unknown machine: ${sourceId}`);
    if (result === "unknown-target") throw new Error(`unknown machine: ${targetId}`);
    if (result === "self") throw new Error("cannot merge a machine into itself");
    if (result === "cycle") throw new Error("merge would create an alias cycle");
    return `merged ${sourceId} into ${targetId} (alias only — no events rewritten)`;
  } finally {
    await store.close();
  }
}

export async function cliPurgeMachine(
  dataDir: string,
  machineId: string,
  confirmName: (expected: string) => boolean,
): Promise<string> {
  const store = createFleetEventStore({ path: join(dataDir, "events.sqlite"), mode: "hub" });
  try {
    // The database's exclusive connection lock also protects directory work
    // from a daemon or another offline command owning this archive.
    await store.load();
    const directory = openDirectory(dataDir);
    const scope = `machine:${machineId}`;
    const pending = store.pendingOperations().find((operation) => operation.scope === scope);
    const entry = directory.list().find((machine) => machine.machineId === machineId);
    if (entry === undefined && pending === undefined)
      throw new Error(`unknown machine: ${machineId}`);
    if (!confirmName(entry?.name ?? machineId))
      throw new Error("confirmation did not match - aborted");
    const identity = createIdentityDirectory({ path: join(dataDir, "identity-directory.json") });
    identity.load();
    if (!identity.usable()) throw new Error("identity directory unavailable; purge is incomplete");
    const operationId = pending?.id ?? crypto.randomUUID();
    const receipt = await store.remove(operationId, scope, (row) => row.machineId === machineId);
    identity.removeMachine(machineId);
    if (entry !== undefined) directory.remove(machineId);
    store.completeOperation(operationId);
    return `purged "${entry?.name ?? machineId}" (${machineId}): ${receipt.removed} event(s) dropped; clients receive an incremental deletion`;
  } finally {
    await store.close();
  }
}

export async function cliCompact(dataDir: string): Promise<string> {
  const store = createFleetEventStore({ path: join(dataDir, "events.sqlite"), mode: "hub" });
  try {
    await store.load();
    const { freedBytes } = await store.compact();
    return `compacted: ${freedBytes} bytes reclaimed; usage and incremental history preserved`;
  } finally {
    await store.close();
  }
}

// The watchdogs' late-bound teardown (ADR-0078). Module scope, because the
// watchdogs are armed at module scope; `serve()` calls `.set(shutdown)` once it
// has a teardown to give.
const deferredShutdown = createDeferredShutdown({ label: "hub" });

// Embedded-mode parent-death watchdogs (ADR-0036 / F8): when spawned by the
// tray shell, couple our lifetime to the parent so an orphaned daemon
// self-exits instead of holding the port — a Task-Manager-killed tray shell
// would otherwise leave the daemon bound (port 47100), failing the NEXT
// launch's bind. Gated on MAXPRICE_HUB_EMBEDDED so headless `serve` keeps its
// no-watchdog "must outlive its spawner" contract (ADR-0035). Two mechanisms:
//   - stdin EOF (ALL platforms): the tray shell spawns us with a PIPED stdin,
//     so its death closes the pipe's write end and Bun fires 'end'. This is
//     the ONLY watchdog on win32, where bun:ffi has no libc to dlopen;
//     belt-and-braces alongside getppid elsewhere.
//   - getppid(2) poll (macOS/Linux only): fires on reparent-to-init; win32
//     has no libc.<suffix> to dlopen (libcGetppid() would throw there).
//
// Armed BEFORE `serve()` rather than at the end of it (ADR-0078). The hub's own
// heavy loads already sit off the synchronous path in `runReadySequence`, so
// this is not the #182 bug the sidecar had — it is the same discipline applied
// to the same shared module, so that a future `await` added anywhere in
// `serve()` cannot silently disarm the daemon's lifetime the way one did there.
// The `dlopen` guard matters more here than in the sidecar: an unarmed daemon
// must still serve.
function armHubWatchdogs(): void {
  if (!isEmbedded()) return;
  installStdinWatchdog({ onOrphaned: () => deferredShutdown.fire() });
  if (process.platform === "win32") return;
  try {
    const getPpid = libcGetppid();
    const initialPpid = getPpid();
    installParentWatchdog({
      getPpid,
      initialPpid,
      label: "hub",
      onOrphaned: () => deferredShutdown.fire(),
    });
    console.log(`[hub] parent watchdog armed (ppid ${initialPpid})`);
  } catch (err) {
    console.error("[hub] parent watchdog unavailable — stdin watchdog only:", err);
  }
}

if (import.meta.main) {
  const archive = { opensArchive: true };
  const code = await runHubCli(process.argv.slice(2), {
    serve: async () => {
      armHubWatchdogs();
      return await serve();
    },
    // Its steps are the commands' own code; the two password commands are
    // this module's, handed in with setup's reader and writer (ADR-0128 §3).
    setup: (io) =>
      runSetup(io, {
        terminal: createSetupTerminal({ stdin: process.stdin, out: process.stdout }),
        ...setupPasswordSteps(),
        service: { hubAnswers: (port) => hubAnswersAt("127.0.0.1", port) },
      }),
    status: (json, io) => hubStatus(json, io),
    passwordSet: () => runPasswordSet(),
    passwordClear: () => runOperatorVerb(PASSWORD_CLEAR),
    keySet: (io) => keySet(io),
    keyClear: (io) => keyClear(io),
    rename: (machineId, newName) =>
      runOperatorVerb(
        {
          offline: (dataDir) => cliRenameMachine(dataDir, machineId, newName),
          live: (hub) => liveRenameMachine(hub, machineId, newName),
        },
        archive,
      ),
    merge: (sourceId, targetId) =>
      runOperatorVerb(
        {
          offline: (dataDir) => cliMergeMachine(dataDir, sourceId, targetId),
          live: (hub) => liveMergeMachine(hub, sourceId, targetId),
        },
        archive,
      ),
    purgeMachine: (machineId) =>
      runOperatorVerb(
        {
          offline: (dataDir) => cliPurgeMachine(dataDir, machineId, confirmPurge),
          live: (hub) => livePurgeMachine(hub, machineId, confirmPurge),
        },
        archive,
      ),
    compact: () =>
      runOperatorVerb(
        { offline: (dataDir) => cliCompact(dataDir), live: (hub) => liveCompact(hub) },
        archive,
      ),
    // Not runOperatorVerb's: restore wants a data dir with no Hub in it, and
    // never runs beside one (ADR-0130 §5).
    restore: (dir, samples) => restoreHub(dir, samples),
    service: (args, io) =>
      hubService(args, io, { hubAnswers: (port) => hubAnswersAt("127.0.0.1", port) }),
    // Not runOperatorVerb's: it edits no data file, and reaches the restarted
    // Hub's /page/view alone (ADR-0129 §5).
    update: (check, json, io) => hubUpdate(check, json, io),
    // Not runOperatorVerb's: none edits through the running Hub's operator
    // routes or takes the lock, since the Hub reads pageUrl only at boot
    // (ADR-0125 §3); `page` asks its /healthz alone.
    page: (io) => cliPage({ io }),
    pageSet: (url, io) => cliPageSet(url, { io }),
    pageClear: (io) => cliPageClear({ io }),
    pageSnippet: (io) => cliPageSnippet({ io }),
  });
  // serve returns 0 once the daemon is up, and the server it started keeps
  // the process running; a command that finished lets the empty loop end it.
  // Any other code ends the process now, whatever a serve that failed partway
  // had started (the embedded stdin watchdog keeps a process alive).
  if (code === EXIT.OK) process.exitCode = code;
  else process.exit(code);
}
