import { chmodSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import {
  isAccountUuid,
  type AccountsSeed,
  type PendingFold,
  type Settings,
  type UsageKeyset,
} from "@maxprice/shared";
import { SUPERVISOR } from "@maxprice/usage-core/launchd-agent";
import {
  clearCause,
  recordCause,
  recordStart,
  rotateLog,
  START_LIMIT,
  WINDOW_MS,
} from "@maxprice/usage-core/relaunch-ledger";
import { startUpdateChecks } from "@maxprice/usage-core/update-check";
import { desktopHubUrl, doubleJoinWarning } from "../double-join";
import { displayHubUrl } from "../hub-url";
import { CliError, EXIT } from "../exit";
import {
  dataDir,
  type Env,
  relaunchLedgerPath,
  serveLogPath,
  settingsPath,
  socketPath,
} from "../paths";
import { renderError } from "../render/error";
import {
  bootSecrets,
  editSecrets,
  keysetOf,
  gatewaysOf,
  type Secrets,
  sessionKeyCount,
  withLegacyMoved,
} from "../secrets";
import { readServeLockHolder, type ServeLock, takeServeLock } from "../serve-lock";
import {
  checkSettingsForServe,
  joinedHubUrl,
  saveAccountFolds,
  saveAccountsSeed,
  saveHomeSeed,
} from "../settings";
import { PRODUCT } from "../update-channel";
import { VERSION } from "../version";

// `maxprice serve`: the Headless client's daemon (ADR-0118 §2, ADR-0119 §2,
// ADR-0120 §2–3). It runs the sidecar's boot in this process, unparented,
// with no watchdog of any kind: its init relaunches it, and a daemon whose
// launching shell exits must keep running (ADR-0118 §4). It refuses a
// settings.json it cannot trust, and saves the Home a first boot's seed
// chose (ADR-0122 §3, §7). It reads secrets.json once, at boot, for the
// session keys and the Hub password: a loose file is tightened to 0600, and
// one it cannot use is skipped, never an exit (ADR-0121 §3, §5). Nothing
// watches that file, so a hand edit applies at the next start. It writes it
// only to move a legacy key into its Account's entry once the sidecar
// learns that Account (ADR-0138 §12, `moveLegacyKey`). Once it
// listens, it checks the update channel at boot and every 6 h, and never
// installs (ADR-0123 §8).
//
// Every `[serve]` line goes to stderr, which systemd hands to the journal.
// Secret facts omit values, and displayed Hub URLs omit userinfo (ADR-0121).
//
// Under launchd (`MAXPRICE_SUPERVISOR=launchd`, ADR-0143 §5–§6), which has no
// start limit and relaunches every nonzero exit, it bounds its own relaunches
// through its ledger, relaunch.json: a sixth start within 15 minutes, and
// what would be exit 5 or 6, record their cause and exit 0, the one exit
// launchd does not relaunch. It also rotates serve.log, where launchd sends
// its stderr, at boot. Without the marker its exits are ADR-0120 §2's.

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
  const keys = sessionKeyCount(secrets);
  const gateways = gatewaysOf(secrets).length;
  const held = [
    keys === 1 ? "a session key" : keys > 1 ? `${keys} session keys` : null,
    secrets.hubPassword && "a Hub password",
    gateways === 1 ? "a Gateway key" : gateways > 1 ? `${gateways} Gateway keys` : null,
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

// #631: the Account seed and the Pending account folds, saved as the Home
// seed is: under the settings lock, never awaited by the boot, a failure
// logged. The next boot decides the seed again; a fold is decided again at the
// next pair change or boot.
function saveAccounts(env: Env, seed: AccountsSeed): void {
  const path = settingsPath(dataDir(env));
  void saveAccountsSeed(env, seed).then(
    (outcome) =>
      console.error(
        outcome === "saved"
          ? `[serve] saved the tracked Accounts seed to ${path}`
          : "[serve] settings.json already names its tracked Accounts; the seed is not saved",
      ),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[serve] cannot save the tracked Accounts seed: ${message}; the next boot chooses it again`,
      );
    },
  );
}

function saveFolds(env: Env, folds: readonly PendingFold[]): void {
  void saveAccountFolds(env, folds).then(
    (outcome) => {
      if (outcome === "saved") console.error("[serve] saved the resolved Pending accounts");
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[serve] cannot save the resolved Pending accounts: ${message}`);
    },
  );
}

// ADR-0138 §12: the sidecar resolved the legacy key's Account, so its key
// moves into that Account's entry in secrets.json, through the commands' own
// read-modify-write, and the legacy key leaves in that same write, never
// before. Answers the keyset the file then holds, for the sidecar to apply.
// A file this cannot read or write keeps the legacy key, and the daemon runs
// on with it as the one key: logged by path and errno, never the key, and
// tried again at the next boot.
export function moveLegacyKey(
  env: Env,
  accountUuid: string,
  now: () => Date = () => new Date(),
): UsageKeyset | null | undefined {
  // Never a name for an entry the file would then refuse.
  if (!isAccountUuid(accountUuid)) {
    console.error("[serve] the session key's Account is no account uuid; the key is not moved");
    return undefined;
  }
  let next: Secrets = {};
  try {
    const moved = editSecrets(env, (secrets) => {
      next = withLegacyMoved(secrets, accountUuid, now().toISOString());
      return next;
    });
    if (moved) console.error("[serve] moved the session key into its Account's entry");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[serve] cannot move the session key into its Account's entry: ${message}; ` +
        "the next boot tries again",
    );
    return undefined;
  }
  return keysetOf(next);
}

// A stop the ledger declines (ADR-0143 §5): the refusal as `serve` would
// have printed it, then why it exits 0.
function decline(error: CliError, why: string): { kind: "declined" } {
  process.stderr.write(renderError(error));
  console.error(`[serve] ${why}; exiting 0 so launchd does not relaunch it`);
  return { kind: "declined" };
}

// A step's value, or the stop the ledger declined in its place.
type Stepped<T> = { kind: "done"; value: T } | { kind: "declined" };

// Under launchd (`supervised`), the lock and the settings check, whose exits
// 5 and 6 a relaunch cannot fix, record their cause and are declined, which
// serve turns into exit 0; elsewhere they throw as they always have.
function underLedger<T>(dir: string, supervised: boolean, step: () => T): Stepped<T> {
  try {
    return { kind: "done", value: step() };
  } catch (error) {
    if (!supervised || !(error instanceof CliError)) throw error;
    const ledger = relaunchLedgerPath(dir);
    const at = new Date().toISOString();
    if (error.code === EXIT.ALREADY_RUNNING) {
      const { pid } = readServeLockHolder(dir);
      recordCause(ledger, { kind: "locked", at, pid });
      return decline(error, "recorded another serve's hold in relaunch.json");
    }
    if (error.code === EXIT.SETTINGS_REFUSED) {
      recordCause(ledger, { kind: "refused", at, exit: error.code });
      return decline(error, "recorded the refused settings.json in relaunch.json");
    }
    throw error;
  }
}

const WINDOW_MINUTES = WINDOW_MS / 60_000;

export async function serve(env: Env = process.env, deps: ServeDeps = {}): Promise<number> {
  const chmod = deps.chmod ?? chmodSync;
  const loadBoot = deps.loadBoot ?? importBoot;
  const dir = dataDir(env);
  const supervised = env[SUPERVISOR.name] === SUPERVISOR.value;
  // ADR-0143 §6: before anything is logged, so this boot's lines start the
  // fresh file. A rotation that fails is logged and the start still counts:
  // exiting here would put launchd's relaunches past the ledger's bound.
  let rotated: boolean | Error = false;
  try {
    rotated = supervised && rotateLog(serveLogPath(dir));
  } catch (error) {
    rotated = error instanceof Error ? error : new Error(String(error));
  }
  prepareDataDir(dir);
  if (supervised) {
    if (rotated === true) console.error(`[serve] rotated ${serveLogPath(dir)} to serve.log.1`);
    if (rotated instanceof Error) {
      console.error(`[serve] could not rotate ${serveLogPath(dir)}: ${rotated.message}`);
    }
    const start = recordStart(relaunchLedgerPath(dir), new Date());
    console.error(
      `[serve] under launchd: start ${start.starts} in the last ${WINDOW_MINUTES} minutes`,
    );
    if (start.declined) {
      console.error(
        `[serve] stopped after repeated crashes: more than ${START_LIMIT} starts in ` +
          `${WINDOW_MINUTES} minutes, recorded in relaunch.json; ` +
          "'maxprice service install' clears the count. Exiting 0 so launchd does not relaunch it",
      );
      return EXIT.OK;
    }
  }
  const lock = underLedger(dir, supervised, () => takeServeLock(dir, env));
  if (lock.kind === "declined") return EXIT.OK;
  serveLock = lock.value;
  console.error(`[serve] holding ${serveLock.path} (pid ${process.pid})`);
  const socket = socketPath(dir);
  removeStaleSocket(socket);
  // ADR-0122 §7: exit 6, before the engine is even loaded, on a file that is
  // no JSON object or whose Home or tracked list the schema rejects. Booting
  // on it would admit under a null or degraded tracked set. Under the lock,
  // so two `serve`s never both get this far.
  const checked = underLedger(dir, supervised, () => checkSettingsForServe(env));
  if (checked.kind === "declined") return EXIT.OK;
  const settings = checked.value;
  // ADR-0143 §5: this start took the lock and accepted its settings, so the
  // last stop's cause no longer holds; its start time stays.
  if (supervised) clearCause(relaunchLedgerPath(dir));
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
    // Every key secrets.json holds (ADR-0138 §6): each Account's, and the
    // legacy key until it moves.
    usageKeyset: keysetOf(secrets),
    // Every Gateway secrets.json holds (ADR-0141 §7): the daemon drains them
    // in fallback and relays them through its Hub (§5).
    gateways: gatewaysOf(secrets),
    onHomeSeeded: (uuid) => saveSeed(env, uuid),
    onAccountsSeeded: (seed) => saveAccounts(env, seed),
    onAccountsFolded: (folds) => saveFolds(env, folds),
    onLegacyResolved: (uuid) => moveLegacyKey(env, uuid),
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
