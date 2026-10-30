import { realpathSync } from "node:fs";
import {
  checkForUpdate,
  installUpdate,
  SelfUpdateError,
  type SelfUpdateProduct,
  type UpdateCheck,
} from "@maxprice/usage-core/self-update";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { engineVersionSchema, PROBE_TIMEOUT_MS } from "../daemon-client";
import { CliError, EXIT, type Hint, usageError } from "../exit";
import type { Io, Parsed } from "../main";
import { dataDir, displayPath, type Env, socketPath } from "../paths";
import { type ReadCgroup, readServeLockHolder } from "../serve-lock";
import {
  parseExecStart,
  parseProperties,
  property,
  reason,
  runTool,
  unitDataDir,
} from "../service/systemctl";
import { UNIT } from "../service/unit";
import { PRODUCT } from "../update-channel";
import { VERSION } from "../version";

// `maxprice update [--check [--json]]` (ADR-0123 §4–7, ADR-0120 §7): installs
// the newest release on the Headless client's channel over this binary, then
// restarts the daemon that runs it. The five checks, the directory lock and
// the swap are the shared core's (`@maxprice/usage-core/self-update`); this
// command decides whether to run it and what to restart after. It never
// downgrades, keeps no previous binary and never escalates (§6–7): a
// directory this user cannot read, write and search is the core's refusal.
// `--check` only reports, exiting 100 when there is something to install
// (§5), and writes nothing; the daemon's own check is `serve`'s (§8).

// What a test replaces; production passes none.
export type UpdateDeps = {
  // The channel: the build's PRODUCT by default.
  product?: SelfUpdateProduct;
  // The binary to replace: process.execPath, read before anything else.
  execPath?: string;
  // Whether this maxprice is the compiled binary, not bun running main.ts.
  compiled?: boolean;
  uid?: number;
  readCgroup?: ReadCgroup;
  // How long to wait for the restarted daemon to report the new version
  // (ADR-0123 §5), and how often to ask.
  waitMs?: number;
  pollMs?: number;
  // The core's bound on each `--version` probe.
  versionTimeoutMs?: number;
};

const HELP = "maxprice update --help";
const WAIT_MS = 30_000;
const POLL_MS = 250;

// The unit states a restart is for: `systemctl is-active`'s success states,
// and `activating`, whose start (an auto-restart's included) may have run the
// old binary just before the swap. Not `deactivating`: someone is stopping
// the unit, and a restart would start it again. `failed` and `inactive` run
// nothing to restart. (`service install` restarts `deactivating` too, after
// its own `enable --now` has asked the unit to run; `update` asks nothing of
// a unit someone is stopping.)
const RESTARTABLE = new Set(["active", "reloading", "refreshing", "activating"]);

const WHY: Hint[] = [{ label: "Why:", command: "maxprice service logs" }];

type Context = {
  io: Io;
  env: Env;
  execPath: string;
  uid: number;
  readCgroup: ReadCgroup | undefined;
  waitMs: number;
  pollMs: number;
};

// Every stdout line. A path, a version from the channel and a unit's
// ExecStart ride these lines, so each goes through `terminalText`, as
// `service`'s do.
function say(io: Io, ...lines: string[]): void {
  io.stdout.write(lines.map((line) => terminalText(line) + "\n").join(""));
}

async function check(product: SelfUpdateProduct): Promise<UpdateCheck> {
  try {
    return await checkForUpdate(product, VERSION);
  } catch (error) {
    if (error instanceof SelfUpdateError) {
      throw new CliError(EXIT.FAILURE, `cannot check for an update: ${error.message}`);
    }
    throw error;
  }
}

// `--check`: the channel's answer and nothing else, so it works from source
// too. It never downloads the tarball and writes no file.
async function report(io: Io, product: SelfUpdateProduct, json: boolean): Promise<number> {
  const { current, latest, available } = await check(product);
  if (json) {
    io.stdout.write(JSON.stringify({ current, latest, available }) + "\n");
  } else {
    say(
      io,
      available
        ? `maxprice ${latest} is available (this is ${VERSION}); run 'maxprice update'.`
        : `maxprice ${VERSION} is current.`,
    );
  }
  return available ? EXIT.UPDATE_AVAILABLE : EXIT.OK;
}

// Whether two paths name one file, through any symlinks. A path that does
// not resolve, such as a unit's binary since deleted, names another file.
function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

// The daemon's engineVersion on `socket`, or null for any answer that is not
// one yet: a refused connect, a timeout, an error status or a body that does
// not name a version. Never connect(): it throws skew at the new version,
// which is the answer awaited here.
async function engineVersion(socket: string, timeoutMs: number): Promise<string | null> {
  try {
    const response = await fetch("http://localhost/api/status", {
      unix: socket,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) return null;
    // The version alone, as connect() reads it first: the rest of the new
    // daemon's status need not match this maxprice's schema.
    const parsed = engineVersionSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.engineVersion : null;
  } catch {
    return null;
  }
}

// Asks every `pollMs` until the daemon reports `version` or `waitMs` has
// passed. Each request is bounded by the time left, and by connect()'s probe.
async function reportsVersion(ctx: Context, socket: string, version: string): Promise<boolean> {
  const deadline = Date.now() + ctx.waitMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    if ((await engineVersion(socket, Math.min(left, PROBE_TIMEOUT_MS))) === version) return true;
    const rest = deadline - Date.now();
    if (rest <= 0) return false;
    await Bun.sleep(Math.min(ctx.pollMs, rest));
  }
}

// ADR-0120 §7, after a swap from `from` to `to`: restart the unit that runs
// this binary, or say what still runs `from`. Run from a shell, `update` is
// outside the unit's cgroup, so restarting the unit never kills it.
async function restart(ctx: Context, from: string, to: string): Promise<number> {
  const { io, env, execPath } = ctx;
  // ADR-0123 §6: root's user manager does not run the users' units, so a
  // shared install's swap restarts nothing. Until each user restarts their
  // own, their commands exit 4 and say how.
  if (ctx.uid === 0) {
    say(
      io,
      `Running as root, so nothing was restarted: each user who runs ${UNIT} restarts their own with 'systemctl --user restart maxprice'.`,
    );
    return EXIT.OK;
  }

  // A failed show is no user manager here, or no systemctl: no unit to
  // restart, which is no failure, since the swap is done.
  const shown = await runTool(
    "systemctl",
    ["--user", "show", UNIT, "--property=ActiveState,ExecStart,Environment"],
    env,
  );
  const props = shown.code === 0 ? parseProperties(shown.stdout) : new Map<string, string[]>();
  if (RESTARTABLE.has(property(props, "ActiveState"))) {
    const command = parseExecStart(property(props, "ExecStart"));
    if (command === null || !sameFile(command.path, execPath)) {
      const other =
        command === null
          ? "an ExecStart this maxprice cannot read"
          : displayPath(command.path, env);
      say(
        io,
        `${UNIT} runs ${other}, not this maxprice, so it was not restarted; 'maxprice service install' points it here.`,
      );
      return EXIT.OK;
    }
    const ran = await runTool("systemctl", ["--user", "restart", UNIT], env);
    if (ran.code !== 0) {
      throw new CliError(
        EXIT.FAILURE,
        `maxprice is ${to} now, but 'systemctl --user restart ${UNIT}' failed: ${reason(ran)}`,
        WHY,
      );
    }
    // The unit's own data dir, which its Environment may set apart from this
    // shell's (ADR-0120 §4).
    const socket = socketPath(unitDataDir(props, env));
    if (!(await reportsVersion(ctx, socket, to))) {
      throw new CliError(
        EXIT.FAILURE,
        `${UNIT} did not report ${to} within ${ctx.waitMs / 1000} s`,
        WHY,
      );
    }
    say(io, `Restarted ${UNIT}, which now runs ${to}.`);
    return EXIT.OK;
  }

  // A `serve` outside the unit is not this command's to restart. The holder
  // comes from serve.lock's pid and /proc, as `service status` finds it
  // (ADR-0120 §1), so a pid the kernel has since given to another process can
  // print this line spuriously, and a `serve` that has taken the lock but not
  // yet written its pid is missed (ADR-0120 §7's note).
  const holder = readServeLockHolder(dataDir(env), ctx.readCgroup);
  if (holder.running && !holder.service) {
    say(
      io,
      `A 'maxprice serve' (pid ${holder.pid}) still runs ${from}: restart it to finish the update.`,
    );
  }
  return EXIT.OK;
}

export async function update(
  parsed: Parsed,
  io: Io,
  env: Env = process.env,
  deps: UpdateDeps = {},
): Promise<number> {
  // First, before any await: Bun memoizes process.execPath on its first read,
  // from /proc/self/exe, and read after the swap it would name the unlinked
  // file, `…/maxprice (deleted)` (self-update.ts's header).
  const execPath = deps.execPath ?? process.execPath;
  const checkOnly = parsed.values.check === true;
  if (parsed.values.json === true && !checkOnly) throw usageError("--json goes with --check", HELP);
  const product = deps.product ?? PRODUCT;
  if (checkOnly) return await report(io, product, parsed.values.json === true);

  // From source execPath is bun itself. Refused before any request.
  const compiled = deps.compiled ?? Bun.main.startsWith("/$bunfs/");
  if (!compiled) {
    throw new CliError(
      EXIT.FAILURE,
      "update replaces the compiled maxprice binary, but this one runs from source " +
        `(${displayPath(execPath, env)} ${displayPath(Bun.main, env)})`,
      [{ label: "Build the binary:", command: "bun run build:cli" }],
    );
  }

  const found = await check(product);
  // Not newer, an older channel included: there is no downgrade (§4).
  if (!found.available) {
    say(io, `maxprice ${VERSION} is current.`);
    return EXIT.OK;
  }
  const where = displayPath(execPath, env);
  let change: { from: string; to: string };
  try {
    change = await installUpdate(product, found.release, {
      currentVersion: VERSION,
      execPath,
      versionTimeoutMs: deps.versionTimeoutMs,
    });
  } catch (error) {
    // The core never touches execPath on a refusal.
    if (error instanceof SelfUpdateError) {
      throw new CliError(
        EXIT.FAILURE,
        `the update failed, and ${where} is unchanged: ${error.message}`,
      );
    }
    throw error;
  }
  say(io, `maxprice ${change.from} → ${change.to} (${where})`);

  return await restart(
    {
      io,
      env,
      execPath,
      uid: deps.uid ?? process.getuid?.() ?? 0,
      readCgroup: deps.readCgroup,
      waitMs: deps.waitMs ?? WAIT_MS,
      pollMs: deps.pollMs ?? POLL_MS,
    },
    change.from,
    change.to,
  );
}
