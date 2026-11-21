import { type HeadlessAgent, runAgentService } from "@maxprice/usage-core/launchd-service";
import {
  answersHealthz,
  type HeadlessService,
  runService,
  type ServiceArgs,
  type ServiceContext,
  ServiceError,
  type ServiceResult,
} from "@maxprice/usage-core/systemd-service";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { CliError, EXIT, usageError } from "../exit";
import type { Io, Parsed } from "../main";
import {
  dataDir,
  type Env,
  relaunchLedgerPath,
  serveLockPath,
  serveLogPath,
  socketPath,
} from "../paths";
import { AGENT_REFUSALS, MAXPRICE_AGENT } from "../service/agent";
import { MAXPRICE_UNIT } from "../service/unit";

// `maxprice service install|uninstall|status|logs` (ADR-0120 §4–5): the
// daemon as a systemd user unit. Every verb uses the user scope
// (`systemctl --user`), never a system unit, sudo or another init. The verbs
// are `@maxprice/usage-core/systemd-service`'s, which the Headless Hub
// shares (ADR-0127 §6, §11); this is maxprice's descriptor, its stdout and its exit
// codes: status exits 0 while the unit is active and 3 when it is not
// running, not installed included (ADR-0119 §6's "not running" code, which is
// LSB's), and logs exits with journalctl's code.
//
// On macOS the same four verbs run the daemon as a LaunchAgent in the user's
// GUI domain (ADR-0143 §4, §7), through `@maxprice/usage-core/launchd-service`,
// with the same exits: status 0 while the agent runs and 3 when it does not,
// logs tail's code.

const MAXPRICE_SERVICE: HeadlessService = {
  ...MAXPRICE_UNIT,
  dataDir,
  lockPath: serveLockPath,
  // Whether the unit's data dir's socket answers /healthz.
  health: {
    label: "Socket:",
    answers: (dir) => answersHealthz("http://localhost/healthz", socketPath(dir)),
  },
};

const MAXPRICE_SERVICE_AGENT: HeadlessAgent = {
  ...MAXPRICE_AGENT,
  dataDir,
  lockPath: serveLockPath,
  logPath: serveLogPath,
  ledgerPath: relaunchLedgerPath,
  health: MAXPRICE_SERVICE.health,
  refusedExits: AGENT_REFUSALS,
};

// What a test replaces; production passes none.
export type ServiceDeps = Pick<ServiceContext, "self" | "uid" | "readCgroup"> & {
  platform?: NodeJS.Platform;
};

export async function service(
  parsed: Parsed,
  io: Io,
  env: Env = process.env,
  { platform = process.platform, ...deps }: ServiceDeps = {},
): Promise<number> {
  try {
    const result = await runFor(
      platform,
      {
        positionals: parsed.positionals,
        follow: parsed.values.follow === true,
        lines: parsed.values.lines as string | undefined,
      },
      {
        env,
        // The unit's or plist's path, launchd's, the manager's and logind's
        // answers and the shell's environment ride these lines, so each goes
        // through `terminalText`.
        out: (lines) => io.stdout.write(lines.map((line) => terminalText(line) + "\n").join("")),
        ...deps,
      },
    );
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
        throw usageError(error.message, "maxprice service --help");
      case "failure":
        throw new CliError(EXIT.FAILURE, error.message, error.hints);
      case "not-running":
        throw new CliError(EXIT.NOT_RUNNING, error.message, error.hints);
    }
  }
}

// The platform's verbs: a LaunchAgent on macOS, a systemd user unit elsewhere.
async function runFor(
  platform: NodeJS.Platform,
  args: ServiceArgs,
  context: ServiceContext,
): Promise<ServiceResult> {
  if (platform === "darwin") {
    const { env, out, self, cwd, uid } = context;
    return await runAgentService(MAXPRICE_SERVICE_AGENT, args, { env, out, self, cwd, uid });
  }
  return await runService(MAXPRICE_SERVICE, args, context);
}
