import { posix } from "node:path";
import { type Env, home } from "@maxprice/usage-core/home-path";
import { type ReadCgroup, readServeLockHolder } from "@maxprice/usage-core/serve-lock";
import {
  dataDirOnInstall,
  type HeadlessService,
  readUnit,
  runService,
  type ServiceArgs,
  type ServiceContext,
  ServiceError,
  type UnitReading,
} from "@maxprice/usage-core/systemd-service";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { CliError, EXIT, type Io, usageError } from "./cli";
import { defaultDataDir } from "./config";
import { serveLockPath, UNIT } from "./serve-lock";

// `maxprice-hub service install|uninstall|status|logs` (ADR-0127 §5–6): the
// Hub as the systemd user unit `maxprice-hub.service`, through
// `@maxprice/usage-core/systemd-service`'s verbs, which the Headless client
// shares (§11); this is the Hub's descriptor, its stdout and its exits:
// status exits 0 while the unit is active and 3 when it is not, not
// installed included (ADR-0119 §6's "not running" code), and logs exits with
// journalctl's code. Linux only.

// Whether a Hub answers /healthz at 127.0.0.1 on that port: index.ts's
// `hubAnswersAt`.
export type HubAnswers = (port: number) => Promise<boolean>;

// What a test replaces; production passes only `hubAnswers`, and setup's
// step 4 `adviseLinger: false`, since its ending lists the linger step
// itself (ADR-0128 §3, §5).
export type HubServiceOptions = Pick<
  ServiceContext,
  "self" | "cwd" | "uid" | "readCgroup" | "adviseLinger"
> & {
  env?: Env;
  platform?: NodeJS.Platform;
  hubAnswers: HubAnswers;
};

// The data dir a Linux `serve` started with `env` in `cwd` serves: the
// unit's below, and the one `update` waits on for the unit it restarted
// (update.ts), over the unit's own Environment (unitDataDir). The Hub reads a
// relative MAXPRICE_HUB_DATA_DIR against its working directory.
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

function hubServiceDescriptor(hubAnswers: HubAnswers, readCgroup?: ReadCgroup): HeadlessService {
  return {
    ...HUB_UNIT,
    // Whether the Hub the unit's data dir holds answers. The lock records the
    // running daemon's port; hub.json's may have changed under it (ADR-0127
    // §3), and a pid that no longer runs left its port to whoever binds it
    // next. Reading never locks or creates the file: a lock it held, even a
    // shared one, would stand for that instant against a starting serve,
    // which waits a hold that brief out (serve-lock.ts) but need not meet one.
    health: {
      label: "Daemon:",
      answers: async (dir) => {
        const holder = readServeLockHolder(serveLockPath(dir), UNIT, readCgroup);
        return holder.running && holder.port !== null && (await hubAnswers(holder.port));
      },
    },
  };
}

// `maxprice-hub.service` as setup reads it (ADR-0128 §2, §3), through the
// shared module's readUnit and the descriptor `service` runs: no systemd user
// manager, with the line every `service` verb refuses with then; or whether
// the unit is installed, its state and main pid, and the data dir it serves,
// by `service status`'s rules. Setup's gate refuses an installed unit that
// serves another data dir than this shell's, and its step 4 reads the rest.
// Linux only, as `service` is; the caller checks.
export async function hubUnit(options: {
  env?: Env;
  hubAnswers: HubAnswers;
  readCgroup?: ReadCgroup;
}): Promise<UnitReading> {
  const { env, hubAnswers, readCgroup } = options;
  return await readUnit(hubServiceDescriptor(hubAnswers, readCgroup), {
    env: env ?? process.env,
  });
}

// The data dir `maxprice-hub service install`, run from this shell in
// `cwd`, would give the unit, by the shared module's own rules
// (dataDirOnInstall): MAXPRICE_HUB_DATA_DIR as install bakes it, else the
// default under HOME, never this shell's XDG_DATA_HOME, which the unit never
// sees (ADR-0127 §5). Setup's gate refuses a shell whose own data dir differs
// (ADR-0128 §2), since its step 4 installs that unit. Linux only, as
// `service` is; the caller checks.
export function hubDataDirOnInstall(options: { env?: Env; cwd?: string } = {}): string {
  return dataDirOnInstall(HUB_UNIT, options.env ?? process.env, options.cwd ?? process.cwd());
}

export async function hubService(
  args: ServiceArgs,
  io: Io,
  options: HubServiceOptions,
): Promise<number> {
  const { env, platform, hubAnswers, ...deps } = options;
  if ((platform ?? process.platform) !== "linux") {
    throw new CliError(EXIT.USAGE, "maxprice-hub service is Linux only");
  }
  try {
    const result = await runService(hubServiceDescriptor(hubAnswers, deps.readCgroup), args, {
      env: env ?? process.env,
      // The unit's path, the manager's and logind's answers and the shell's
      // environment ride these lines, so each goes through `terminalText`.
      out: (lines) => io.stdout.write(lines.map((line) => terminalText(line) + "\n").join("")),
      ...deps,
    });
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
