import { chmodSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import type { Settings } from "@maxprice/shared";
import { startUpdateChecks } from "@maxprice/usage-core/update-check";
import { desktopHubUrl, doubleJoinWarning } from "../double-join";
import { displayHubUrl } from "../hub-url";
import { EXIT } from "../exit";
import { dataDir, type Env, settingsPath, socketPath } from "../paths";
import { bootSecrets, type Secrets } from "../secrets";
import { type ServeLock, takeServeLock } from "../serve-lock";
import { checkSettingsForServe, joinedHubUrl, saveHomeSeed } from "../settings";
import { PRODUCT } from "../update-channel";
import { VERSION } from "../version";

// `maxprice serve`: the Headless client's daemon (ADR-0118 §2, ADR-0119 §2,
// ADR-0120 §2–3). It runs the sidecar's boot in this process, unparented,
// with no watchdog of any kind: its init relaunches it, and a daemon whose
// launching shell exits must keep running (ADR-0118 §4). It refuses a
// settings.json it cannot trust, and saves the Home a first boot's seed
// chose (ADR-0122 §3, §7). It reads secrets.json once, at boot, for the
// session key and the Hub password: a loose file is tightened to 0600, and
// one it cannot use is skipped, never an exit (ADR-0121 §3, §5). Nothing
// watches that file, so a hand edit applies at the next start. Once it
// listens, it checks the update channel at boot and every 6 h, and never
// installs (ADR-0123 §8).
//
// Every `[serve]` line goes to stderr, which systemd hands to the journal.
// Secret facts omit values, and displayed Hub URLs omit userinfo (ADR-0121).

// The lock's descriptor, held for the process's whole life (ADR-0120 §3).
let serveLock: ServeLock | null = null;

// The only route to the engine (ADR-0118 §2): no other command loads it.
const importBoot = () => import("@maxprice/sidecar/boot");

export type Boot = Pick<
  Awaited<ReturnType<typeof importBoot>>,
  "bootSidecar" | "logMonotonicClock"
>;

type BootOptions = Parameters<Boot["bootSidecar"]>[0];

// What a test replaces; production passes none.
export type ServeDeps = {
  chmod?: (path: string, mode: number) => void;
  loadBoot?: () => Promise<Boot>;
};

function octal(mode: number): string {
  return "0" + (mode & 0o777).toString(8);
}

// ADR-0119 §2: the data dir is 0700, which also covers the moment between
// the socket's bind and its chmod.
function prepareDataDir(dir: string): void {
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined;
  if (created) {
    // mkdir's mode is subject to the umask; chmod is not.
    chmodSync(dir, 0o700);
    console.error(`[serve] created the data dir ${dir} (0700)`);
    return;
  }
  const mode = statSync(dir).mode;
  if ((mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
    console.error(`[serve] tightened the data dir ${dir} from ${octal(mode)} to 0700`);
    return;
  }
  console.error(`[serve] data dir ${dir}`);
}

// While the lock is held, a socket in the data dir is stale by definition,
// so it is removed without probing it (ADR-0120 §3). Never before the lock:
// that would delete a running daemon's socket.
function removeStaleSocket(socket: string): void {
  try {
    unlinkSync(socket);
    console.error(`[serve] removed a stale ${socket}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

// Installed only once the boot has returned, by which time it has its own
// SIGINT/SIGTERM handlers. A listener on a signal replaces its default
// action, so one installed sooner would swallow an early SIGTERM and leave a
// half-booted daemon running; before this point a signal just ends the
// process.
function installSignalLogs(): void {
  // ADR-0120 §2: closing a foreground `serve`'s terminal stops it as SIGTERM
  // does, through the boot's teardown, so the archive's write chain is not cut.
  process.on("SIGHUP", () => {
    console.error("[serve] SIGHUP: stopping as on SIGTERM");
    process.kill(process.pid, "SIGTERM");
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => console.error(`[serve] ${signal}: stopping`));
  }
  process.on("exit", (code) => console.error(`[serve] stopped (exit ${code})`));
}

// What secrets.json held, for the log: which secrets, never their values.
function secretsLine(secrets: Secrets): string {
  const held = [
    secrets.sessionKey && "a session key",
    secrets.hubPassword && "a Hub password",
  ].filter(Boolean);
  return `[serve] secrets.json: ${held.length === 0 ? "no secrets" : held.join(" and ")}`;
}

// ADR-0121 §3: the Hub settings.json names (`joinedHubUrl`), with the stored
// password, or null when it names none; a stored password with no hubUrl is
// ignored.
function hubAtBoot(settings: Settings, secrets: Secrets): BootOptions["hub"] {
  const url = joinedHubUrl(settings.hubUrl);
  if (url === null) return null;
  return { url, password: secrets.hubPassword?.value ?? null, autoHeal: settings.hubAutoHeal };
}

// ADR-0122 §3: the sidecar hands over the Home a first boot's seed chose, and
// this saves it under the settings lock, unless the file names a Home by
// then. The boot never waits on the write, and nothing it throws reaches the
// sidecar: a failed save is logged, and the next boot chooses again.
function saveSeed(env: Env, uuid: string): void {
  const path = settingsPath(dataDir(env));
  void saveHomeSeed(env, uuid).then(
    (outcome) =>
      console.error(
        outcome === "saved"
          ? `[serve] saved the Home seed to ${path}`
          : "[serve] settings.json already names a Home; the seed is not saved",
      ),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[serve] cannot save the Home seed: ${message}; the next boot chooses it again`,
      );
    },
  );
}

export async function serve(env: Env = process.env, deps: ServeDeps = {}): Promise<number> {
  const chmod = deps.chmod ?? chmodSync;
  const loadBoot = deps.loadBoot ?? importBoot;
  const dir = dataDir(env);
  prepareDataDir(dir);
  serveLock = takeServeLock(dir, env);
  console.error(`[serve] holding ${serveLock.path} (pid ${process.pid})`);
  const socket = socketPath(dir);
  removeStaleSocket(socket);
  // ADR-0122 §7: exit 6, before the engine is even loaded, on a file that is
  // no JSON object or whose Home or tracked list the schema rejects. Booting
  // on it would admit under a null or degraded tracked set. Under the lock,
  // so two `serve`s never both get this far.
  const settings = checkSettingsForServe(env);
  // ADR-0121 §3, §5: read once, under the lock too. A file it cannot use is
  // one line, and the boot goes on without its secrets: tracking needs none.
  const secrets = bootSecrets(env, (line) => console.error(`[serve] ${line}`));
  console.error(secretsLine(secrets));
  const hub = hubAtBoot(settings, secrets);
  // A hand edit can carry credentials; the log and status hide them alike.
  if (hub !== null) console.error(`[serve] joining the Hub at ${displayHubUrl(hub.url)}`);

  const boot = await loadBoot();
  // Before booting, so the clock is in the log before anything can go wrong.
  boot.logMonotonicClock();
  const hubUrl = desktopHubUrl(env);
  if (hubUrl !== null) console.error(`[serve] ${doubleJoinWarning(hubUrl)}`);

  // The boot applies the key and the Hub as their routes apply a push
  // (ADR-0121 §3); a later change arrives through those routes. A failed
  // bind exits 1 inside the boot. The socket's permissions are the
  // authority, so no token (ADR-0119 §3).
  await boot.bootSidecar({
    settingsPath: settingsPath(dir),
    listen: { unix: socket },
    authToken: null,
    hub,
    usageCredential: secrets.sessionKey ? { sessionKey: secrets.sessionKey.value } : null,
    onHomeSeeded: (uuid) => saveSeed(env, uuid),
  });

  try {
    chmod(socket, 0o600);
  } catch (error) {
    // The server is up and would keep this process running, so a throw from
    // here would leave a daemon serving on a socket it could not tighten.
    console.error(`[serve] cannot chmod ${socket}: ${(error as Error).message}`);
    process.exit(EXIT.FAILURE);
  }
  installSignalLogs();
  // Last, so the line means the daemon has fully started: the socket is 0600,
  // and the boot's signal handlers and these are in place. `/healthz` can
  // answer sooner, while the boot is still installing its handlers.
  console.error(`[serve] listening on ${socket}`);
  // ADR-0123 §8: at boot and every 6 h, in this process and outside the
  // sidecar, check the channel, write update-check.json for `status`, and log
  // a newer version once. It never installs anything, and never throws: a
  // failed check is recorded, a failed write logged. Its timers are unref'd,
  // so they never keep a stopping daemon alive.
  startUpdateChecks({
    product: PRODUCT,
    currentVersion: VERSION,
    dataDir: dir,
    log: (line) => console.error(`[serve] ${line}`),
  });
  return EXIT.OK;
}
