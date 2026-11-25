import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { displayPath, type Env, home } from "@maxprice/usage-core/home-path";
import type { LaunchAgent } from "@maxprice/usage-core/launchd-agent";
import {
  type HeadlessAgent,
  readAgentService,
  runAgentService,
} from "@maxprice/usage-core/launchd-service";
import { type ReadCgroup, readServeLockHolder } from "@maxprice/usage-core/serve-lock";
import {
  dataDirOnInstall,
  type HeadlessService,
  readUnit,
  runService,
  type ServiceArgs,
  type ServiceContext,
  ServiceError,
  type ServiceResult,
  serviceVerb,
  type UnitReading,
} from "@maxprice/usage-core/systemd-service";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { CliError, EXIT, type Io, usageError } from "./cli";
import { defaultDataDir } from "./config";
import { LABEL, serveLockPath, UNIT } from "./serve-lock";

// `maxprice-hub service install|uninstall|status|logs` (ADR-0127 §5–6): the
// Hub as the systemd user unit `maxprice-hub.service`, through
// `@maxprice/usage-core/systemd-service`'s verbs, which the Headless client
// shares (§11); this is the Hub's descriptor, its stdout and its exits:
// status exits 0 while the unit is active and 3 when it is not, not
// installed included (ADR-0119 §6's "not running" code), and logs exits with
// journalctl's code. On macOS the same four verbs run the Hub as the
// LaunchAgent `com.maxprice.headless-hub` in the user's GUI domain (ADR-0146
// §5–§7), through `@maxprice/usage-core/launchd-service`, with the same
// exits: status 0 while the agent runs and 3 when it does not, logs tail's
// code.

// Whether a Hub answers /healthz at 127.0.0.1 on that port: index.ts's
// `hubAnswersAt`.
export type HubAnswers = (port: number) => Promise<boolean>;

// What a test replaces; production passes only `hubAnswers`, and setup's
// step 4 `adviseLinger: false`, since its ending lists the linger step
// itself (ADR-0128 §3, §5), and `warnTrayHub: false`, since setup gives the
// tray app's warning once, at its start (ADR-0146 §13).
export type HubServiceOptions = Pick<
  ServiceContext,
  "self" | "cwd" | "uid" | "readCgroup" | "adviseLinger"
> & {
  env?: Env;
  platform?: NodeJS.Platform;
  hubAnswers: HubAnswers;
  warnTrayHub?: boolean;
};

// The data dir a Headless `serve` started with `env` in `cwd` serves: the
// unit's and the agent's below, and the one `update` waits on for the unit it
// restarted (update.ts), over the unit's own Environment (unitDataDir). The
// Hub reads a relative MAXPRICE_HUB_DATA_DIR against its working directory.
// Linux's rule is a Headless Hub's on macOS too (ADR-0146 §2): neither the
// unit nor the agent sets MAXPRICE_HUB_EMBEDDED.
export function serveDataDir(env: Env, cwd: string): string {
  return posix.resolve(cwd, defaultDataDir(env, "linux", home(env)));
}

// The Hub's unit, all but the health row, which asks a running Hub: what
// install writes and bakes, and the data dir it serves. Exported for
// readme.test.ts, which holds the README's generated unit to it.
export const HUB_UNIT: Omit<HeadlessService, "health"> = {
  name: "maxprice-hub",
  unit: UNIT,
  description: "MaxPrice Headless Hub",
  execArgs: ["serve"],
  baked: [{ name: "MAXPRICE_HUB_DATA_DIR", path: "one" }],
  lockedExit: EXIT.ALREADY_RUNNING,
  // On Linux the commands that edit the data files, restore's included,
  // hold serve.lock while they work, so a serve starting then exits 5 too,
  // once the 500 ms its take asks again for run out (ADR-0127 §2); the
  // instant `status` holds a free lock it waits out (§8). So would a
  // `status` stalled past the bound, which "another maxprice-hub" names:
  // status edits nothing.
  lockedNote:
    "another maxprice-hub, a 'maxprice-hub serve' or a command that edits the data files, " +
    "held the data dir, so the unit stopped without a retry",
  // serve's other refusals, a held lock aside, exit 1, which the unit
  // retries within its bound.
  refusedExits: [],
  dataDir: serveDataDir,
  lockPath: serveLockPath,
};

// The Hub's LaunchAgent on macOS (ADR-0146 §5): the unit's command and baked
// variable, under the label `update` restarts too (§8). Exported for
// readme.test.ts, which holds the README's generated plist to it.
export const HUB_AGENT: LaunchAgent = {
  name: HUB_UNIT.name,
  label: LABEL,
  execArgs: HUB_UNIT.execArgs,
  baked: HUB_UNIT.baked,
};

// Whether the Hub the service's data dir holds answers. The lock records the
// running daemon's port; hub.json's may have changed under it (ADR-0127 §3),
// and a pid that no longer runs left its port to whoever binds it next.
// Reading never locks or creates the file: a lock it held, even a shared
// one, would stand for that instant against a starting serve, which waits a
// hold that brief out (serve-lock.ts) but need not meet one.
function hubHealth(hubAnswers: HubAnswers, readCgroup?: ReadCgroup): HeadlessService["health"] {
  return {
    label: "Daemon:",
    answers: async (dir) => {
      const holder = readServeLockHolder(serveLockPath(dir), UNIT, readCgroup);
      return holder.running && holder.port !== null && (await hubAnswers(holder.port));
    },
  };
}

function hubServiceDescriptor(hubAnswers: HubAnswers, readCgroup?: ReadCgroup): HeadlessService {
  return { ...HUB_UNIT, health: hubHealth(hubAnswers, readCgroup) };
}

// The agent's descriptor for usage-core's launchd verbs: the unit's data
// dir and lock, the agent's log and ledger in the data dir (ADR-0146
// §6–§7). serve's refusals other than a held lock exit 1, which launchd
// relaunches within the ledger's bound, so none is recorded by exit.
function hubAgentDescriptor(hubAnswers: HubAnswers): HeadlessAgent {
  return {
    ...HUB_AGENT,
    dataDir: serveDataDir,
    lockPath: serveLockPath,
    logPath: serveLogPath,
    ledgerPath: relaunchLedgerPath,
    health: hubHealth(hubAnswers),
    refusedExits: [],
    lockedNote:
      "another maxprice-hub, a 'maxprice-hub serve' or a command that edits the data files, " +
      "held the data dir, so the agent stopped without a retry",
  };
}

// The LaunchAgent's log, its stdout and stderr both (ADR-0146 §5, §7).
export function serveLogPath(dataDir: string): string {
  return join(dataDir, "serve.log");
}

// The relaunch ledger `serve` keeps under launchd (ADR-0146 §6).
export function relaunchLedgerPath(dataDir: string): string {
  return join(dataDir, "relaunch.json");
}

// One Hub per Mac (ADR-0146 §13): the hub tray app's data dir, which its
// embedded daemon keeps in ~/Library/Application Support, holds a Hub when
// it holds a hub.json. No lock spans the two dirs, so this warns, and never
// blocks; the port is what keeps a second Hub from starting. Null where none
// is there, and off macOS.
export function trayHubWarning(env: Env, platform: NodeJS.Platform): string | null {
  if (platform !== "darwin") return null;
  const tray = defaultDataDir({ MAXPRICE_HUB_EMBEDDED: "1" }, "darwin", home(env));
  if (!existsSync(join(tray, "hub.json"))) return null;
  return (
    `the hub tray app on this Mac keeps a Hub too, in ${displayPath(tray, env)}; ` +
    "run one Hub per Mac: on one port, whichever starts second fails its bind"
  );
}

// `maxprice-hub.service` as setup reads it (ADR-0128 §2, §3), through the
// shared module's readUnit and the descriptor `service` runs: no systemd user
// manager, with the line every `service` verb refuses with then; or whether
// the unit is installed, its state and main pid, and the data dir it serves,
// by `service status`'s rules. On macOS the same reading of the LaunchAgent
// (ADR-0146 §10), whose no-manager line is its no-GUI-session line. Setup's
// gate refuses an installed service that serves another data dir than this
// shell's, and its step 4 reads the rest. Linux and macOS only, as `service`
// is; the caller checks.
export async function hubUnit(options: {
  env?: Env;
  platform?: NodeJS.Platform;
  uid?: number;
  hubAnswers: HubAnswers;
  readCgroup?: ReadCgroup;
}): Promise<UnitReading> {
  const { hubAnswers, readCgroup, uid } = options;
  const env = options.env ?? process.env;
  if ((options.platform ?? process.platform) === "darwin") {
    return await readAgentService(hubAgentDescriptor(hubAnswers), { env, uid });
  }
  return await readUnit(hubServiceDescriptor(hubAnswers, readCgroup), { env });
}

// The data dir `maxprice-hub service install`, run from this shell in
// `cwd`, would give the unit, by the shared module's own rules
// (dataDirOnInstall): MAXPRICE_HUB_DATA_DIR as install bakes it, else the
// default under HOME, never this shell's XDG_DATA_HOME, which the unit never
// sees (ADR-0127 §5). Setup's gate refuses a shell whose own data dir differs
// (ADR-0128 §2), since its step 4 installs that unit. The LaunchAgent bakes
// the same variable by the same rule (ADR-0146 §5), so this is its data dir
// on macOS too.
export function hubDataDirOnInstall(options: { env?: Env; cwd?: string } = {}): string {
  return dataDirOnInstall(HUB_UNIT, options.env ?? process.env, options.cwd ?? process.cwd());
}

export async function hubService(
  args: ServiceArgs,
  io: Io,
  options: HubServiceOptions,
): Promise<number> {
  const { platform, hubAnswers, warnTrayHub = true, ...deps } = options;
  const env = options.env ?? process.env;
  const on = platform ?? process.platform;
  if (on !== "linux" && on !== "darwin") {
    throw new CliError(EXIT.USAGE, "maxprice-hub service is Linux and macOS only");
  }
  // The unit's or plist's path, launchd's, the manager's and logind's
  // answers and the shell's environment ride these lines, so each goes
  // through `terminalText`.
  const out = (lines: readonly string[]) =>
    io.stdout.write(lines.map((line) => terminalText(line) + "\n").join(""));
  try {
    let result: ServiceResult;
    if (on === "darwin") {
      // §13's warning, before install loads the agent; serviceVerb refuses
      // a bad verb or option first, as runAgentService would.
      const tray = warnTrayHub && serviceVerb(args) === "install" ? trayHubWarning(env, on) : null;
      if (tray !== null) io.stderr.write(`maxprice-hub: ${terminalText(tray)}\n`);
      const { self, cwd, uid } = deps;
      result = await runAgentService(hubAgentDescriptor(hubAnswers), args, {
        env,
        out,
        self,
        cwd,
        uid,
      });
    } else {
      result = await runService(hubServiceDescriptor(hubAnswers, deps.readCgroup), args, {
        env,
        out,
        ...deps,
      });
    }
    switch (result.kind) {
      case "ok":
        return EXIT.OK;
      case "not-running":
        return EXIT.NOT_RUNNING;
      case "exited":
        return result.code;
    }
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    switch (error.kind) {
      case "usage":
        throw usageError(error.message, "maxprice-hub service --help");
      case "failure":
        throw new CliError(EXIT.FAILURE, error.message, error.hints);
      case "not-running":
        throw new CliError(EXIT.NOT_RUNNING, error.message, error.hints);
    }
  }
}
