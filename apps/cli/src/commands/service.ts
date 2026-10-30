import {
  answersHealthz,
  type HeadlessService,
  runService,
  type ServiceContext,
  ServiceError,
} from "@maxprice/usage-core/systemd-service";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { CliError, EXIT, usageError } from "../exit";
import type { Io, Parsed } from "../main";
import { dataDir, type Env, serveLockPath, socketPath } from "../paths";
import { MAXPRICE_UNIT } from "../service/unit";

// `maxprice service install|uninstall|status|logs` (ADR-0120 §4–5): the
// daemon as a systemd user unit. Every verb uses the user scope
// (`systemctl --user`), never a system unit, sudo or another init. The verbs
// are `@maxprice/usage-core/systemd-service`'s, which the Headless Hub
// shares (ADR-0127 §6, §11); this is maxprice's descriptor, its stdout and its exit
// codes: status exits 0 while the unit is active and 3 when it is not
// running, not installed included (ADR-0119 §6's "not running" code, which is
// LSB's), and logs exits with journalctl's code.

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

// What a test replaces; production passes none.
export type ServiceDeps = Pick<ServiceContext, "self" | "uid" | "readCgroup">;

export async function service(
  parsed: Parsed,
  io: Io,
  env: Env = process.env,
  deps: ServiceDeps = {},
): Promise<number> {
  try {
    const result = await runService(
      MAXPRICE_SERVICE,
      {
        positionals: parsed.positionals,
        follow: parsed.values.follow === true,
        lines: parsed.values.lines as string | undefined,
      },
      {
        env,
        // The unit's path, the manager's and logind's answers and the shell's
        // environment ride these lines, so each goes through `terminalText`.
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
