import { join } from "node:path";
import {
  HUB_PROTOCOL_VERSION,
  isValidHubPassword,
  type HubStatus,
  type UsageCredential,
  type UsageSample,
} from "@maxprice/shared";
import {
  createFleetEventStore,
  createIdentityDirectory,
  createSampleStore,
  createUsagePoller,
  installParentWatchdog,
  installStdinWatchdog,
  libcGetppid,
  type FleetEventStore,
  type IdentityDirectory,
  type SampleStore,
} from "@maxprice/usage-core";
import { defaultDataDir, loadOrInitConfig, savePasswordHash } from "./config";
import { createMachineDirectory } from "./machine-directory";
import { createHubAuth, mintOperatorSecret } from "./auth";
import { resolveBindHosts } from "./bind";
import { createClientRegistry } from "./clients";
import { createHubFanout, type HubFanout } from "./fanout";
import { buildHubApp, fleetEventsStatus } from "./server";
import {
  createCredstore,
  createMemoryCredstore,
  resolveCredstorePath,
  type Credstore,
} from "./credstore";

// maxprice-hub (ADR-0035): the standalone always-on usage poller. Subcommands:
//   (none) / serve                      → run the daemon
//   password set [value]                → set the hub password (ADR-0037)
//   password clear                      → clear the hub password (open the hub)
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
// so serve()'s status-patch wiring lives in one testable place.
export function createEmitUsageSample(
  store: Pick<SampleStore, "all">,
  fanout: Pick<HubFanout, "emitSample" | "patchStatus">,
): (sample: UsageSample | null) => void {
  return (sample) => {
    if (sample !== null) fanout.emitSample(sample);
    fanout.patchStatus({ sampleCount: store.all().length, usageCurrentSample: sample });
  };
}

// Boot-readiness sequence (F1): load the on-disk history, load the fleet-event
// archive, seed the persisted credential, and start the poller — everything
// every /api/* route gates on. Exported as a factory for the same reason
// createMergeSamples is: the test drives THIS closure rather than a hand-copied
// double.
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
  sampleStore: Pick<SampleStore, "loadHistory" | "all" | "latest">;
  fleetEvents: FleetEventStore;
  credstore: Pick<Credstore, "get">;
  poller: {
    setCredential: (c: UsageCredential | null) => void;
    pollOnce: () => Promise<void>;
    start: () => void;
  };
  fanout: Pick<HubFanout, "patchStatus">;
  // Fired when the archive load throws. serve() flips its `eventsUsable` flag,
  // which makes the event + archive-mutation routes 503 (F3) — the on-disk log
  // must not be rewritten from a RAM image we failed to read.
  onEventsUnusable: () => void;
};

export async function runReadySequence(deps: ReadySequenceDeps): Promise<void> {
  const { sampleStore, fleetEvents, credstore, poller, fanout } = deps;
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
    const cred = await credstore.get();
    if (cred !== null) {
      poller.setCredential(cred);
      // Seed orgId from the stored credential (non-secret) — the console SHOWS
      // it and prefills the replace form. The session key itself is never read
      // back out (write-only).
      fanout.patchStatus({ credentialPresent: true, orgId: cred.orgId });
      void poller.pollOnce();
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
// parent-death watchdog; headless `serve` (Linux) leaves it unset (ADR-0035/0036).
export function isEmbedded(env: Record<string, string | undefined> = process.env): boolean {
  return env.MAXPRICE_HUB_EMBEDDED === "1";
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

async function serve(): Promise<void> {
  const dataDir = defaultDataDir();
  const config = loadOrInitConfig(dataDir);

  // Per-launch operator secret (ADR-0037): minted only when embedded — the tray
  // shell captures it from stdout and the console authenticates with it, so the
  // console works whatever the password state. Headless serve mints none.
  const operatorSecret = isEmbedded() ? mintOperatorSecret() : null;
  const auth = createHubAuth({ passwordHash: config.passwordHash, operatorSecret });

  // createSampleStore returns OwnedSampleStore (SampleStore + flush); type as
  // the return type directly so shutdown can call flush().
  const sampleStore = createSampleStore({ path: join(dataDir, "usage-history.jsonl") });

  // Fleet event archive + machine directory (ADR-0041, M4). The directory
  // loads synchronously (small file); the event store's load runs inside
  // `ready` below so no /api/* route can observe a half-loaded archive.
  const fleetEvents = createFleetEventStore({
    path: join(dataDir, "events.jsonl"),
    mode: "hub",
  });
  const machineDirectory = createMachineDirectory({
    path: join(dataDir, "machine-directory.json"),
  });

  // Identity directory (ADR-0062): the fleet union of "which repo is this
  // machine's project directory a checkout of". Loads synchronously beside the
  // machine directory — a small file, and the routes it backs are additive.
  const identityStore = createIdentityDirectory({
    path: join(dataDir, "identity-directory.json"),
  });
  identityStore.load();
  const identityDirectory = resolveIdentityDirectory(identityStore);

  // Resolved BEFORE the initial status so the fanout can carry what we are
  // about to bind (ADR-0038): the console's Listening row and its Windows
  // firewall warning both key off the real bound hosts, fell-back-to-loopback
  // included. Resolution is pure (config + interfaces); the actual binds
  // happen below, after the app is built.
  const { hosts, warning } = resolveBindHosts(config.bind);
  if (warning !== null) console.warn(`[hub] ${warning}`);

  const initialStatus: HubStatus = {
    service: "maxprice-hub",
    protocolVersion: HUB_PROTOCOL_VERSION,
    usageConnection: "disconnected",
    usageLastSampleAt: null,
    usageCurrentSample: null,
    sampleCount: 0,
    credentialPresent: false,
    bindHosts: hosts,
    // The resolution's diagnosis rides the wire too (ADR-0049) — the console
    // needs it to tell a chosen loopback bind from a failed tailnet one.
    bindWarning: warning,
    // ADR-0037: reflect the persisted gate at boot; POST /api/password patches
    // it live so the console's Access card re-renders on set/clear.
    passwordProtected: config.passwordHash !== null,
    // Provenance/display start empty (ADR-0036). POST /api/credential fills
    // credentialUpdatedAt/credentialSource/orgId; the credstore seed below
    // backfills orgId on boot. `startedAt` is stamped ONCE here — this is daemon
    // runtime, not pure tested logic, so a direct new Date() is fine — and the
    // console renders real uptime from it.
    credentialUpdatedAt: null,
    credentialSource: null,
    orgId: null,
    startedAt: new Date().toISOString(),
  };
  const fanout = createHubFanout({ initialStatus });

  // PollerHub adapter: poller broadcasts → fanout; sampleCount rides along.
  const poller = createUsagePoller({
    store: sampleStore,
    liveHub: {
      emitUsageSample: createEmitUsageSample(sampleStore, fanout),
      patchStatus: (partial) => fanout.patchStatus(partial),
    },
    // Fake-claude seam (ADR-0035); unset in production → real claude.ai.
    baseUrl: process.env.MAXPRICE_CLAUDE_BASE_URL,
  });

  const credstorePath = resolveCredstorePath();
  if (credstorePath === null) {
    console.warn(
      "[hub] no credstore helper found — credential will be memory-only (set MAXPRICE_CREDSTORE_PATH or build credstore/)",
    );
  }
  const credstore =
    credstorePath === null ? createMemoryCredstore() : createCredstore(credstorePath);

  const registry = createClientRegistry();

  // Browser CORS allowlist (ADR-0036, overview §9). Populated ONLY when the tray
  // shell embedded us (it sets MAXPRICE_HUB_EMBEDDED=1): the Tauri webview origins
  // always, plus a dev renderer origin via MAXPRICE_HUB_ALLOWED_ORIGIN (the shell
  // sets it in dev, mirroring VITE_SIDECAR_ORIGIN). Headless serve ⇒ [] ⇒ no CORS.
  const allowedOrigins = isEmbedded()
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
  // awaits (below, in buildHubApp). Bun.serve still binds immediately (the
  // LISTENING handshake can't wait), but no data route answers until this
  // resolves, so a client never observes a half-loaded store (a backfill hole
  // its since-cursor then skips forever; a re-append of samples the unloaded
  // file already holds) nor a not-yet-seeded credential (an auto-heal POST
  // overwriting a healthy keychain key before the hub's own seed reads it).
  // Started ONCE, fire-and-forget from serve()'s main line — the route
  // middleware awaits it. runReadySequence NEVER rejects (see its comment).
  // Because it's off serve()'s synchronous path, a hung credstore.get() can no
  // longer stop the SIGINT/SIGTERM handlers below from registering (F26).
  const ready = runReadySequence({
    sampleStore,
    fleetEvents,
    credstore,
    poller,
    fanout,
    onEventsUnusable: () => {
      eventsUsable = false;
    },
  });

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
    usage: { setCredential: poller.setCredential, pollOnce: poller.pollOnce },
    persistCredential: (cred) => credstore.set(cred),
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
    allowedOrigins,
    ready,
  });

  // Deliberately UNGUARDED binds: a throw here (port in use — e.g. a second
  // hub instance — or a stale bind IP) is a fatal unhandled rejection, loud
  // exit 1, no zombie. Any future try/catch MUST server.stop() the
  // already-bound servers, or a partial bind leaves a half-listening daemon.
  const servers = hosts.map((hostname) =>
    Bun.serve({ hostname, port: config.port, fetch: app.fetch, idleTimeout: 0 }),
  );
  // Stdout handshake (ADR-0036; mirrors the sidecar's ADR-0002). Phase 2's Rust
  // shell reads `LISTENING <port>` to learn the port (get_hub_url) and captures
  // `OPERATOR_TOKEN` for the webview's Authorization header WITHOUT echoing it.
  // Every bind shares config.port, so the first LISTENING is canonical.
  for (const server of servers) {
    await writeLine(`LISTENING ${server.port}\n`);
  }
  // OPERATOR_TOKEN: the per-launch operator secret, for the embedding parent
  // ONLY (ADR-0037). Gated on MAXPRICE_HUB_EMBEDDED so headless `serve` never
  // prints a secret to its journal.
  if (isEmbedded() && operatorSecret !== null) {
    await writeLine(`OPERATOR_TOKEN ${operatorSecret}\n`);
  }
  // Human-readable logs (unchanged — preserved from the original block).
  for (const server of servers) {
    console.log(`[hub] listening on http://${server.hostname}:${server.port}`);
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
        await poller.stop();
        await sampleStore.flush();
        await fleetEvents.close();
        fanout.close();
        for (const server of servers) await server.stop(true);
      } catch (err) {
        console.error("[hub] shutdown teardown error:", err);
      }
      process.exit(exitCode);
    })();
    return shutdownPromise;
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("unhandledRejection", (err) => {
    console.error("[hub] unhandled rejection:", err);
    void shutdown(1);
  });
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
  if (isEmbedded()) {
    installStdinWatchdog({
      onOrphaned: () => {
        void shutdown();
      },
    });
    if (process.platform !== "win32") {
      const getPpid = libcGetppid();
      installParentWatchdog({
        getPpid,
        initialPpid: getPpid(),
        label: "hub",
        onOrphaned: () => {
          void shutdown();
        },
      });
    }
  }
}

// Set the hub password from the CLI (headless Linux; ADR-0037). The value may
// ride argv or be prompted. Writes the argon2id hash to hub.json — a RUNNING
// daemon holds config in memory, so restart it to apply.
async function passwordSet(value: string | undefined): Promise<void> {
  const pw = value ?? prompt("New hub password:") ?? "";
  if (!isValidHubPassword(pw)) {
    console.error("invalid password: printable ASCII, no spaces, 1-128 chars");
    process.exit(2);
  }
  savePasswordHash(defaultDataDir(), await Bun.password.hash(pw));
  console.log("password set — restart the hub daemon to apply");
}

function passwordClear(): void {
  savePasswordHash(defaultDataDir(), null);
  console.log("password cleared — restart the hub daemon to apply");
}

// ── M7 operator CLI verbs (ADR-0041): headless parity for the console's
// rename / merge / purge / compact. They mutate the DATA FILES directly —
// the password set|clear pattern; file access is the authority — so they
// require the daemon stopped: two writers on events.jsonl would corrupt it
// (and Windows blocks the rewrite's rename over the daemon's open handle).
// Each returns a success line; failures throw (the dispatcher exits 1/2).

// Manual timeout (NOT AbortSignal.timeout — the bun/win32 parked-loop bug,
// commit 199c284): probe the configured port for a responding daemon.
export async function daemonRunning(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1_500);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function openDirectory(dataDir: string) {
  return createMachineDirectory({ path: join(dataDir, "machine-directory.json") });
}

export async function cliRenameMachine(
  dataDir: string,
  machineId: string,
  name: string,
): Promise<string> {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 63) throw new Error("invalid name (1-63 chars)");
  const result = openDirectory(dataDir).rename(machineId, trimmed);
  if (result === "unknown") throw new Error(`unknown machine: ${machineId}`);
  if (result === "collision") throw new Error(`name already in use: ${trimmed}`);
  return `renamed ${machineId} to "${trimmed}"`;
}

export async function cliMergeMachine(
  dataDir: string,
  sourceId: string,
  targetId: string,
): Promise<string> {
  const result = openDirectory(dataDir).merge(sourceId, targetId);
  if (result === "unknown-source") throw new Error(`unknown machine: ${sourceId}`);
  if (result === "unknown-target") throw new Error(`unknown machine: ${targetId}`);
  if (result === "self") throw new Error("cannot merge a machine into itself");
  if (result === "cycle") throw new Error("merge would create an alias cycle");
  return `merged ${sourceId} into ${targetId} (alias only — no events rewritten)`;
}

export async function cliPurgeMachine(
  dataDir: string,
  machineId: string,
  confirmName: (expected: string) => boolean,
): Promise<string> {
  const directory = openDirectory(dataDir);
  const entry = directory.list().find((m) => m.machineId === machineId);
  if (entry === undefined) throw new Error(`unknown machine: ${machineId}`);
  if (!confirmName(entry.name)) throw new Error("confirmation did not match — aborted");
  const store = createFleetEventStore({ path: join(dataDir, "events.jsonl"), mode: "hub" });
  try {
    await store.load();
    const { droppedRows } = await store.rewrite({
      keep: (r) => r.machineId !== machineId,
      newEpoch: true,
    });
    directory.remove(machineId);
    // ADR-0062 §4: the purge cascades to identity rows here too, so the offline
    // CLI leaves the same state behind as the console's DELETE.
    const identityDirectory = createIdentityDirectory({
      path: join(dataDir, "identity-directory.json"),
    });
    identityDirectory.load();
    if (identityDirectory.usable()) {
      identityDirectory.removeMachine(machineId);
    } else {
      // A removal against a store that did not fully load is RAM-only and
      // evaporates when this process exits — and it can never be re-issued,
      // since the machine is now gone from the directory that BOTH purge paths
      // resolve against, so a repeat run answers "unknown machine" while the
      // stale rows keep serving. Tell the operator that, rather than leaving a
      // purge that silently un-purges itself (or suggesting a re-run that
      // cannot succeed).
      console.error(
        `identity rows for ${machineId} were NOT purged: identity-directory.json could not be read or was corrupt (a .bak was kept if so). Re-running this purge will NOT help — ${machineId} is already gone from the machine directory. Fix or remove the file, then remove those rows by hand.`,
      );
    }
    return `purged "${entry.name}" (${machineId}): ${droppedRows} event(s) dropped; epoch re-minted — every client reseeds on next contact`;
  } finally {
    await store.close();
  }
}

export async function cliCompact(dataDir: string): Promise<string> {
  const store = createFleetEventStore({ path: join(dataDir, "events.jsonl"), mode: "hub" });
  try {
    await store.load();
    const { droppedLines } = await store.rewrite({ newEpoch: false });
    return `compacted: ${droppedLines} stale line(s) removed (epoch preserved — cursors survive)`;
  } finally {
    await store.close();
  }
}

if (import.meta.main) {
  const [, , command, sub, value] = process.argv;
  if (command === "password" && sub === "set") {
    void passwordSet(value);
  } else if (command === "password" && sub === "clear") {
    passwordClear();
  } else if (command === undefined || command === "serve") {
    void serve();
  } else if (
    command === "rename" ||
    command === "merge" ||
    command === "purge-machine" ||
    command === "compact"
  ) {
    void (async () => {
      const dataDir = defaultDataDir();
      const config = loadOrInitConfig(dataDir);
      if (await daemonRunning(config.port)) {
        console.error(
          `a hub daemon is responding on port ${config.port} — stop it first (these commands edit the data files directly)`,
        );
        process.exit(1);
      }
      try {
        if (command === "rename") {
          if (sub === undefined || value === undefined)
            throw new Error("usage: maxprice-hub rename <machineId> <newName>");
          console.log(await cliRenameMachine(dataDir, sub, value));
        } else if (command === "merge") {
          if (sub === undefined || value === undefined)
            throw new Error("usage: maxprice-hub merge <sourceId> <targetId>");
          console.log(await cliMergeMachine(dataDir, sub, value));
        } else if (command === "purge-machine") {
          if (sub === undefined) throw new Error("usage: maxprice-hub purge-machine <machineId>");
          console.log(
            await cliPurgeMachine(dataDir, sub, (expected) => {
              const typed =
                prompt(`Type the machine's name ("${expected}") to confirm purge:`) ?? "";
              return typed === expected;
            }),
          );
        } else {
          console.log(await cliCompact(dataDir));
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    })();
  } else {
    console.error(
      `unknown command: ${command}\nusage: maxprice-hub [serve | password set [value] | password clear | rename <id> <name> | merge <sourceId> <targetId> | purge-machine <id> | compact]`,
    );
    process.exit(2);
  }
}
