import { realpathSync } from "node:fs";
import { hubPageViewSchema } from "@maxprice/shared";
import { displayPath, type Env, home } from "@maxprice/usage-core/home-path";
import {
  checkForUpdate,
  installUpdate,
  SelfUpdateError,
  type SelfUpdateProduct,
  type UpdateCheck,
} from "@maxprice/usage-core/self-update";
import { type ReadCgroup, readServeLockHolder } from "@maxprice/usage-core/serve-lock";
import {
  parseExecStart,
  parseProperties,
  property,
  reason,
  runTool,
  unitDataDir,
} from "@maxprice/usage-core/systemctl";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { CliError, EXIT, type Hint, type Io, usageError } from "./cli";
import { defaultDataDir } from "./config";
import { loopbackRequest } from "./loopback-http";
import { serveLockPath, UNIT } from "./serve-lock";
import { serveDataDir } from "./service";
import { PRODUCT } from "./update-channel";
import { VERSION } from "./version";

// `maxprice-hub update [--check [--json]]` (ADR-0129 §4–§5, ADR-0127 §10):
// the Headless client's `maxprice update` (ADR-0123 §4–§7, as its amendments
// built it, apps/cli/src/commands/update.ts) for the Headless Hub. It installs
// the newest release on the Hub's own channel, headless-hub-latest.json
// (update-channel.ts), over this binary, then restarts the unit that runs it
// and waits for the new Hub to report the new version. The five checks, the
// directory lock and the swap are the shared core's
// (`@maxprice/usage-core/self-update`); this command decides whether to run it
// and what to restart after. It never downgrades, keeps no previous binary and
// never escalates (ADR-0123 §6–§7): a directory this user cannot read, write
// and search is the core's refusal. `--check` only reports, exiting 100 when
// there is something to install, and writes nothing; the daemon's own check
// is a Headless `serve`'s (ADR-0129 §6).
//
// Linux only, every form: the channel's one entry is linux-x86_64, and the
// hub tray app's embedded binary, which runs the same verbs elsewhere, is
// updated by Tauri's updater with the app.

// What a test replaces; production passes none.
export type UpdateDeps = {
  // The channel: the build's PRODUCT by default.
  product?: SelfUpdateProduct;
  // The binary to replace: process.execPath, read before anything else.
  execPath?: string;
  // Whether this maxprice-hub is the compiled binary, not bun running
  // index.ts.
  compiled?: boolean;
  uid?: number;
  readCgroup?: ReadCgroup;
  // How long to wait for the restarted Hub to report the new version
  // (ADR-0129 §5), how often to ask, and the bound on each request.
  waitMs?: number;
  pollMs?: number;
  requestMs?: number;
  // The core's bound on each `--version` probe.
  versionTimeoutMs?: number;
  platform?: NodeJS.Platform;
};

const HELP = "maxprice-hub update --help";
// The wait for the restarted Hub (ADR-0129 §5), the help's "30 s", and how
// often it asks.
export const WAIT_MS = 30_000;
export const POLL_MS = 250;
// The bound on one /page/view request, within what is left of the wait. The
// route awaits the Hub's `ready`, so an answer means the new Hub has booted,
// not just started (ADR-0129 §5), and a booting Hub holds the request; a
// fresh one is sent each poll rather than one held for the whole wait.
export const REQUEST_MS = 3_000;

// The unit states a restart is for, the Headless client's: `systemctl
// is-active`'s success states, and `activating`, whose start (an
// auto-restart's included) may have run the old binary just before the swap.
// Not `deactivating`: someone is stopping the unit, and a restart would start
// it again. `failed` and `inactive` run nothing to restart.
const RESTARTABLE = new Set(["active", "reloading", "refreshing", "activating"]);

const WHY: Hint[] = [{ label: "Why:", command: "maxprice-hub service logs" }];

// Only the version, as the Headless client reads only `engineVersion`: the
// rest of the new Hub's view need not match this maxprice-hub's schema.
const versionSchema = hubPageViewSchema.pick({ version: true });

type Context = {
  io: Io;
  env: Env;
  execPath: string;
  uid: number;
  readCgroup: ReadCgroup | undefined;
  waitMs: number;
  pollMs: number;
  requestMs: number;
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
        ? `maxprice-hub ${latest} is available (this is ${VERSION}); run 'maxprice-hub update'.`
        : `maxprice-hub ${VERSION} is current.`,
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

// The version the Hub at `port` reports on /page/view, or null for any
// answer that is not one yet: a refused connect, a timeout, an error status
// or a body that does not name a version. Through loopbackRequest, never
// fetch, which sends even 127.0.0.1 through HTTP_PROXY (loopback-http.ts); it
// sends `Host: 127.0.0.1:<port>`, a loopback authority page.ts's `/page/*`
// guard admits.
async function pageViewVersion(port: number, timeoutMs: number): Promise<string | null> {
  try {
    const answer = await loopbackRequest({
      port,
      method: "GET",
      path: "/page/view",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (answer.status < 200 || answer.status >= 300) return null;
    const parsed = versionSchema.safeParse(JSON.parse(answer.body));
    return parsed.success ? parsed.data.version : null;
  } catch {
    return null;
  }
}

// Asks every `pollMs` until the Hub serving `dir` reports `version` or
// `waitMs` has passed. The port is read from dir's serve.lock at each poll,
// unlocked, as `service status` reads it. The new serve rewrites the record
// with its pid alone once it has the lock, then adds hub.json's port before
// it binds (ADR-0127 §3). That port is usually the old Hub's too, so a record
// the old Hub left can name the port the new Hub answers on: the record says
// where to ask, and only the answer says which Hub it is. No port, a refused
// connect and the old version are "not yet"; the new version is done,
// whichever record named the port (ADR-0129 §5). Reading the record at each
// poll follows a hub.json whose port changed across the restart. Each
// request is bounded by the time left, and by `requestMs`.
async function reportsVersion(ctx: Context, dir: string, version: string): Promise<boolean> {
  const deadline = Date.now() + ctx.waitMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    const { port } = readServeLockHolder(serveLockPath(dir), UNIT, ctx.readCgroup);
    if (port !== null && (await pageViewVersion(port, Math.min(left, ctx.requestMs))) === version) {
      return true;
    }
    const rest = deadline - Date.now();
    if (rest <= 0) return false;
    await Bun.sleep(Math.min(ctx.pollMs, rest));
  }
}

// ADR-0127 §10, after a swap from `from` to `to`: restart the unit that runs
// this binary, or say what still runs `from`. Run from a shell, `update` is
// outside the unit's cgroup, so restarting the unit never kills it.
async function restart(ctx: Context, from: string, to: string): Promise<number> {
  const { io, env, execPath } = ctx;
  // ADR-0123 §6: root's user manager does not run the users' units, so a
  // shared install's swap restarts nothing, and asks systemctl nothing. Until
  // each user restarts their own, their commands meet the old Hub, and exit 4
  // once the protocol differs (ADR-0127 §7).
  if (ctx.uid === 0) {
    say(
      io,
      `Running as root, so nothing was restarted: each user who runs ${UNIT} restarts their own with 'systemctl --user restart maxprice-hub'.`,
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
          ? "an ExecStart this maxprice-hub cannot read"
          : displayPath(command.path, env);
      say(
        io,
        `${UNIT} runs ${other}, not this maxprice-hub, so it was not restarted; 'maxprice-hub service install' points it here.`,
      );
      return EXIT.OK;
    }
    const ran = await runTool("systemctl", ["--user", "restart", UNIT], env);
    if (ran.code !== 0) {
      throw new CliError(
        EXIT.FAILURE,
        `maxprice-hub is ${to} now, but 'systemctl --user restart ${UNIT}' failed: ${reason(ran)}`,
        WHY,
      );
    }
    // The unit's own data dir, which its Environment may set apart from this
    // shell's (ADR-0127 §5): `service`'s descriptor reads it the same way.
    if (!(await reportsVersion(ctx, unitDataDir(serveDataDir, props, env), to))) {
      throw new CliError(
        EXIT.FAILURE,
        `${UNIT} did not report ${to} within ${ctx.waitMs / 1000} s`,
        WHY,
      );
    }
    say(io, `Restarted ${UNIT}, which now runs ${to}.`);
    return EXIT.OK;
  }

  // A `serve` outside the unit, on this shell's data dir, is not this
  // command's to restart. The holder comes from serve.lock's record and
  // /proc, read without the lock, as `service status` finds it (ADR-0127 §6),
  // so a pid the kernel has since given to another process can print this
  // line spuriously, and a `serve` that has taken the lock but not yet written
  // its pid is missed (ADR-0120 §7's note, which the Headless client's
  // `update` shares). A residual the Hub alone has, since only the Hub's
  // other commands take its lock: the operator verbs, password and key
  // set|clear and restore hold serve.lock and record their pid while they
  // edit the data files with no Hub running (ADR-0127 §7, ADR-0130 §5), so
  // one at work just then is named here as a 'maxprice-hub serve' still
  // running the old version. It runs no Hub, and finishes on its own.
  const holder = readServeLockHolder(
    serveLockPath(defaultDataDir(env, "linux", home(env))),
    UNIT,
    ctx.readCgroup,
  );
  if (holder.running && !holder.service) {
    say(
      io,
      `A 'maxprice-hub serve' (pid ${holder.pid}) still runs ${from}: restart it to finish the update.`,
    );
  }
  return EXIT.OK;
}

export async function hubUpdate(
  checkOnly: boolean,
  json: boolean,
  io: Io,
  env: Env = process.env,
  deps: UpdateDeps = {},
): Promise<number> {
  // First, before any await: Bun memoizes process.execPath on its first read,
  // from /proc/self/exe, and read after the swap it would name the unlinked
  // file, `…/maxprice-hub (deleted)` (self-update.ts's header).
  const execPath = deps.execPath ?? process.execPath;
  if ((deps.platform ?? process.platform) !== "linux") {
    throw new CliError(EXIT.USAGE, "maxprice-hub update is Linux only");
  }
  if (json && !checkOnly) throw usageError("--json goes with --check", HELP);
  const product = deps.product ?? PRODUCT;
  if (checkOnly) return await report(io, product, json);

  // From source execPath is bun itself. Refused before any request.
  const compiled = deps.compiled ?? Bun.main.startsWith("/$bunfs/");
  if (!compiled) {
    throw new CliError(
      EXIT.FAILURE,
      "update replaces the compiled maxprice-hub binary, but this one runs from source " +
        `(${displayPath(execPath, env)} ${displayPath(Bun.main, env)})`,
      [{ label: "Build the binary:", command: "bun apps/hub/scripts/build-binaries.ts linux-x64" }],
    );
  }

  const found = await check(product);
  // Not newer, an older channel included: there is no downgrade (ADR-0123 §4).
  if (!found.available) {
    say(io, `maxprice-hub ${VERSION} is current.`);
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
  say(io, `maxprice-hub ${change.from} → ${change.to} (${where})`);

  return await restart(
    {
      io,
      env,
      execPath,
      uid: deps.uid ?? process.getuid?.() ?? 0,
      readCgroup: deps.readCgroup,
      waitMs: deps.waitMs ?? WAIT_MS,
      pollMs: deps.pollMs ?? POLL_MS,
      requestMs: deps.requestMs ?? REQUEST_MS,
    },
    change.from,
    change.to,
  );
}
