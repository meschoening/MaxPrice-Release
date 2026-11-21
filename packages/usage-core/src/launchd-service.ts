// A headless product's `service install|uninstall|status|logs` on macOS
// (ADR-0143 §4, §7, §10): its daemon as a LaunchAgent in the user's GUI
// domain, `gui/<uid>`, never a LaunchDaemon, sudo or the system domain. Each
// verb starts with `launchctl print gui/<uid>`, which fails only when the
// user has no GUI session here to load an agent into. There is no start, stop
// or restart verb: `launchctl kickstart` and `bootout` do those.
//
// The verbs share their arguments, results and refusals with the systemd
// ones (./systemd-service), so a product maps both to its exits alike; every
// name, note, lock file, log, ledger and health probe is the product's
// descriptor's.
//
// Reachable only via the "./launchd-service" subpath, never index.ts.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { displayPath, type Env, home } from "./home-path";
import { type AgentPrint, NO_SUCH_SERVICE, readAgent } from "./launchctl";
import {
  agentEnvironment,
  agentPlistPath,
  agentServeCommand,
  agentTarget,
  guiDomain,
  type LaunchAgent,
  plistEnvironment,
  plistText,
  shellTarget,
  SUPERVISOR,
} from "./launchd-agent";
import {
  clearLedger,
  readLedger,
  recentStarts,
  START_LIMIT,
  type StopCause,
  WINDOW_MS,
} from "./relaunch-ledger";
import { readServeLockHolder } from "./serve-lock";
import { execTool, type Ran, reason, runTool } from "./systemctl";
import { bakedEnvironment } from "./systemd-unit";
import {
  selfCommand,
  type ServiceArgs,
  ServiceError,
  type ServiceResult,
  serviceVerb,
} from "./systemd-service";

/** One headless product's agent, and what its `service` verbs read. */
export interface HeadlessAgent extends LaunchAgent {
  /**
   * The data dir an environment resolves to, the shell's or the agent's
   * (from its EnvironmentVariables), with `cwd` the directory a relative
   * path in it is read against: this shell's working directory for the
   * shell's environment, and the home directory for the agent's, where
   * launchd runs a job that sets no WorkingDirectory.
   */
  dataDir(env: Env, cwd: string): string;
  /** The lock file in a data dir. */
  lockPath(dir: string): string;
  /** The agent's log in a data dir: StandardOutPath and StandardErrorPath. */
  logPath(dir: string): string;
  /** The relaunch ledger in a data dir (./relaunch-ledger). */
  ledgerPath(dir: string): string;
  /** status's row for whether the daemon answers: "Socket:" for maxprice. */
  health: { label: string; answers(dir: string): Promise<boolean> };
  /**
   * The line `service status` prints for each refusal the ledger records by
   * its exit, a refused settings.json for maxprice.
   */
  refusedExits: readonly { exit: number; note: string }[];
}

export type AgentServiceContext = {
  env: Env;
  // One write per call, of these lines, each ending "\n" in the product's
  // writer, which makes each inert with ./terminal-text's terminalText: the
  // lines carry the plist's path, launchctl's answers and the shell's
  // environment. tail's own output in `logs` is tail's.
  out: (lines: readonly string[]) => void;
  // What a test replaces; production passes none. `self` is the command
  // that starts this product, which ProgramArguments runs with its
  // arguments; `cwd` is the installing shell's working directory.
  self?: readonly string[];
  cwd?: string;
  uid?: number;
};

type Context = {
  product: HeadlessAgent;
  env: Env;
  out: (lines: readonly string[]) => void;
  self: readonly string[];
  cwd: string;
  uid: number;
};

function say(ctx: Context, ...lines: string[]): void {
  ctx.out(lines);
}

// ADR-0143 §7: one line, and no fallback to sudo or a system domain.
function noSession(ctx: Context, ran: Ran): ServiceError {
  return new ServiceError(
    "failure",
    `no launchd GUI session for this user here (launchctl print ${guiDomain(ctx.uid)} failed: ${reason(ran)}); ` +
      `log in to this Mac, or run '${agentServeCommand(ctx.product)}' under a LaunchDaemon (the README shows one)`,
  );
}

// The job as launchd has it, and its plist on disk: a verb's first step.
// No GUI session refuses with its one line.
async function inspect(ctx: Context): Promise<{ print: AgentPrint | null; file: string }> {
  const reading = await readAgent(ctx.product, ctx.uid, ctx.env);
  if (reading.kind === "no-session") throw noSession(ctx, reading.ran);
  if (reading.kind === "unreadable") {
    throw new ServiceError(
      "failure",
      `launchctl print ${agentTarget(ctx.product, ctx.uid)} failed: ${reason(reading.ran)}`,
    );
  }
  return {
    print: reading.kind === "loaded" ? reading.print : null,
    file: agentPlistPath(ctx.product, ctx.env),
  };
}

async function launchctl(ctx: Context, args: readonly string[]): Promise<void> {
  const ran = await runTool("launchctl", args, ctx.env);
  if (ran.code !== 0) {
    throw new ServiceError("failure", `launchctl ${args.join(" ")} failed: ${reason(ran)}`, [
      { label: "Why:", command: `${ctx.product.name} service logs` },
    ]);
  }
}

// How long `bootOut` waits for launchd to let go of the job: past the
// job's exit timeout (5 s, launchd's default) with room to spare.
const BOOTOUT_WAIT_MS = 15_000;
const BOOTOUT_POLL_MS = 100;

// `launchctl bootout` returns while launchd is still tearing the job down,
// and a `bootstrap` then fails with "5: Input/output error" (seen on the
// mini), so this waits until launchd no longer has the job.
async function bootOut(ctx: Context): Promise<void> {
  const target = agentTarget(ctx.product, ctx.uid);
  await launchctl(ctx, ["bootout", target]);
  const deadline = Date.now() + BOOTOUT_WAIT_MS;
  for (;;) {
    const ran = await runTool("launchctl", ["print", target], ctx.env);
    if (ran.code === NO_SUCH_SERVICE) return;
    if (Date.now() >= deadline) {
      throw new ServiceError(
        "failure",
        `launchctl bootout ${target} left the agent loaded after ${BOOTOUT_WAIT_MS / 1000} s`,
        [{ label: "Why:", command: `${ctx.product.name} service logs` }],
      );
    }
    await Bun.sleep(BOOTOUT_POLL_MS);
  }
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Written beside the plist and renamed over it, so launchd never reads a
// half-written file. The temporary name does not end in `.plist`, so launchd
// never loads it at a login either. Returns the rename, which install runs
// once a loaded job is booted out: a write that fails stops install before
// it touches the running agent.
function stagePlist(path: string, text: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, text, { mode: 0o644 });
  return () => renameSync(temporary, path);
}

// ADR-0119 §2's 0700 data dir, made before the plist loads: launchd cannot
// open a log in a directory that does not exist (ADR-0143 §6). An existing
// one is left as it is; tightening it is `serve`'s job.
function ensureDataDir(dir: string): void {
  if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) chmodSync(dir, 0o700);
}

// The data dir the agent serves, from its environment, under this user's
// home: a variable the agent does not set is unset there, so the product's
// default fills it in, never the shell's value.
function agentDataDir(
  product: HeadlessAgent,
  environment: Record<string, string>,
  env: Env,
): string {
  return product.dataDir({ ...environment, HOME: env.HOME }, home(env));
}

// The agent's environment: launchd's own reading while it is loaded, else
// the plist's, else none (the default data dir).
function environmentOf(print: AgentPrint | null, file: string): Record<string, string> {
  if (print !== null) return print.environment;
  const text = readOrNull(file);
  return text === null ? {} : plistEnvironment(text);
}

// The data dir an agent installed from this shell, in `cwd`, would serve:
// the environment install bakes, and HOME.
function dataDirOnInstall(ctx: Context): string {
  const { product, env, cwd } = ctx;
  return product.dataDir(
    { ...Object.fromEntries(bakedEnvironment(product, env, cwd)), HOME: env.HOME },
    home(env),
  );
}

// install clears the ledger, writes the plist when its text changed, makes
// the data dir, and loads the agent: a changed plist already loaded is booted
// out first, before the file is replaced, so a failed bootout leaves the old
// file and the next install sees the change again; then it is enabled (a
// disabled job refuses bootstrap) and bootstrapped, which starts it
// (RunAtLoad). An unchanged plist already
// loaded is enabled and kickstarted, which starts it when it is not running
// and leaves a running one be, as `enable --now` does on Linux.
async function install(ctx: Context): Promise<ServiceResult> {
  const { env, product, uid } = ctx;
  const { print, file } = await inspect(ctx);
  const dir = dataDirOnInstall(ctx);
  ensureDataDir(dir);
  clearLedger(product.ledgerPath(dir));
  const text = plistText(product, ctx.self, env, ctx.cwd, product.logPath(dir));
  const changed = readOrNull(file) !== text;
  const replace = changed ? stagePlist(file, text) : null;
  if (print !== null && changed) await bootOut(ctx);
  replace?.();
  say(
    ctx,
    `${product.label} ${changed ? "updated" : "unchanged"}: ${displayPath(file, env)}`,
    ...agentEnvironment(product, env, ctx.cwd)
      .filter(([name]) => name !== SUPERVISOR.name)
      .map(([name, value]) => `  ${name}=${value}`),
  );

  const target = agentTarget(product, uid);
  const wasRunning = print?.pid != null;
  await launchctl(ctx, ["enable", target]);
  if (print === null || changed) {
    await launchctl(ctx, ["bootstrap", guiDomain(uid), file]);
  } else {
    await launchctl(ctx, ["kickstart", target]);
  }
  if (wasRunning && changed) {
    say(ctx, `Restarted ${product.label}, which was running the previous file.`);
  }
  say(
    ctx,
    `${product.label} is loaded and started; it logs to ${displayPath(product.logPath(dir), env)}.`,
    "It runs while you are logged in to this Mac, and starts again at your next login.",
  );
  return { kind: "ok" };
}

// uninstall boots the agent out, which stops it, and removes its plist. The
// data dir, its secrets.json, serve.log and the ledger stay, and it says so.
async function uninstall(ctx: Context): Promise<ServiceResult> {
  const { env, product } = ctx;
  const { print, file } = await inspect(ctx);
  const hasFile = existsSync(file);
  if (print === null && !hasFile) {
    say(ctx, `${product.label} is not installed; nothing to remove.`);
    return { kind: "ok" };
  }
  const dir = agentDataDir(product, environmentOf(print, file), env);
  if (print !== null) await bootOut(ctx);
  rmSync(file, { force: true });
  say(
    ctx,
    `${product.label} is stopped and unloaded, and ${displayPath(file, env)} is removed.`,
    `Kept: the data dir ${displayPath(dir, env)} with its secrets.json, ` +
      `${basename(product.logPath(dir))} and ${basename(product.ledgerPath(dir))}.`,
  );
  return { kind: "ok" };
}

// Whether ProgramArguments runs this product: this binary with its arguments.
function programRow(
  product: HeadlessAgent,
  args: readonly string[],
  self: readonly string[],
): string {
  if (args.length === 0) return "–";
  const shown = args.join(" ");
  const ours = [...self, ...product.execArgs];
  if (args.length === ours.length && args.every((word, at) => word === ours[at])) {
    return `${shown} (this ${product.name})`;
  }
  return `${shown} (not this ${product.name}, ${ours.join(" ")}; '${product.name} service install' points it here)`;
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

// The ledger's cause, as the line `status` prints for a stopped agent.
function causeNote(ctx: Context, cause: StopCause): string {
  const { product } = ctx;
  switch (cause.kind) {
    case "crashes":
      return (
        `stopped after repeated crashes (more than ${START_LIMIT} starts in ${minutes(WINDOW_MS)} minutes); ` +
        `see '${product.name} service logs', and '${product.name} service install' clears the count`
      );
    case "locked":
      return `another '${agentServeCommand(product)}' held the data dir, so the agent stopped without a retry`;
    case "refused":
      return (
        product.refusedExits.find(({ exit }) => exit === cause.exit)?.note ??
        `'${agentServeCommand(product)}' refused to start (exit ${cause.exit}), so the agent stopped without a retry`
      );
  }
}

// The lock file's row for an agent that stopped on the lock. The file keeps
// the last holder's pid, so whether that process still runs says whether it
// is the holder now.
function lockRow(ctx: Context, dir: string, agentPid: number | null): string {
  const { product } = ctx;
  const path = product.lockPath(dir);
  const holder = readServeLockHolder(path, product.label);
  if (holder.pid === null) return `${basename(path)} names no pid`;
  if (!holder.running) {
    return `pid ${holder.pid}, which held it, has exited; 'launchctl kickstart ${shellTarget(product)}' starts the agent`;
  }
  return `held by pid ${holder.pid}${holder.pid === agentPid ? ` (${product.label})` : ""}`;
}

// status describes the agent, not the daemon; the product's own `status`
// describes the daemon. It is "ok" while the agent runs and "not-running"
// when it does not, not installed included. A stopped agent's launchd exit
// status reads 0 whatever stopped it, so the ledger's cause is what it
// reports (ADR-0143 §7).
async function status(ctx: Context, now: Date): Promise<ServiceResult> {
  const { env, product } = ctx;
  const { print, file } = await inspect(ctx);
  const hasFile = existsSync(file);
  if (print === null && !hasFile) {
    throw new ServiceError("not-running", `${product.label} is not installed.`, [
      { label: "Install it:", command: `${product.name} service install` },
    ]);
  }

  const dir = agentDataDir(product, environmentOf(print, file), env);
  const shellDir = product.dataDir(env, ctx.cwd);
  const running = print?.state === "running";
  const ledger = readLedger(product.ledgerPath(dir));
  const cause = running ? null : ledger.cause;

  const notes: string[] = [];
  if (!hasFile) {
    notes.push(
      `its file ${displayPath(file, env)} is gone; '${product.name} service install' writes it`,
    );
  }
  if (print === null) {
    notes.push(`its plist is not loaded; '${product.name} service install' loads it`);
  } else if (cause !== null) {
    notes.push(causeNote(ctx, cause));
  } else if (!running) {
    notes.push(`not running; start it with 'launchctl kickstart ${shellTarget(product)}'`);
  }

  const starts = recentStarts(ledger, now).length;
  const rows: [string, string][] = [
    ["PID:", print?.pid != null ? String(print.pid) : "–"],
    ["Runs:", print?.runs != null ? String(print.runs) : "–"],
    ["Last exit:", print?.lastExit ?? "–"],
    ["Starts:", `${starts} in the last ${minutes(WINDOW_MS)} minutes`],
    ["Program:", programRow(product, print?.arguments ?? [], ctx.self)],
    [
      "Data dir:",
      displayPath(dir, env) +
        (dir === shellDir ? "" : `, not this shell's ${displayPath(shellDir, env)}`),
    ],
    ["Log:", displayPath(product.logPath(dir), env)],
  ];
  const answers = await product.health.answers(dir);
  rows.push([product.health.label, answers ? "answers /healthz" : "does not answer /healthz"]);
  if (cause?.kind === "locked") rows.push(["Lock:", lockRow(ctx, dir, print?.pid ?? null)]);

  const width = Math.max(...rows.map(([label]) => label.length));
  say(
    ctx,
    `${product.label}: ${print === null ? "not loaded" : print.state || "unknown"}`,
    ...notes.map((note) => `  ${note}`),
    ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`),
  );
  return running ? { kind: "ok" } : { kind: "not-running" };
}

// logs runs `tail -n N [-f]` on the agent's serve.log, on this terminal, and
// exits with tail's code.
async function logs(
  ctx: Context,
  follow: boolean,
  lines: string | undefined,
): Promise<ServiceResult> {
  const { env, product } = ctx;
  const { print, file } = await inspect(ctx);
  if (print === null && !existsSync(file)) {
    throw new ServiceError(
      "not-running",
      `${product.label} is not installed; a '${agentServeCommand(product)}' run in a terminal logs to its stderr.`,
    );
  }
  const log = product.logPath(agentDataDir(product, environmentOf(print, file), env));
  const args: string[] = [];
  if (lines !== undefined) args.push("-n", lines);
  if (follow) args.push("-f");
  args.push(log);
  const code = await execTool("tail", args, env);
  if (code === null) throw new ServiceError("failure", "tail is not on PATH");
  return { kind: "exited", code };
}

export async function runAgentService(
  product: HeadlessAgent,
  args: ServiceArgs,
  context: AgentServiceContext,
  now: () => Date = () => new Date(),
): Promise<ServiceResult> {
  const verb = serviceVerb(args);
  const { follow, lines } = args;

  const ctx: Context = {
    product,
    env: context.env,
    out: context.out,
    self: context.self ?? selfCommand(),
    cwd: context.cwd ?? process.cwd(),
    uid: context.uid ?? process.getuid?.() ?? 0,
  };
  switch (verb) {
    case "install":
      return await install(ctx);
    case "uninstall":
      return await uninstall(ctx);
    case "status":
      return await status(ctx, now());
    case "logs":
      return await logs(ctx, follow, lines);
  }
}
