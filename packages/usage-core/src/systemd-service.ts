// A headless product's `service install|uninstall|status|logs` (ADR-0120
// §4–5, ADR-0127 §6, §11): its daemon as a systemd user unit. Every verb uses
// the user scope (`systemctl --user`), never a system unit, sudo or another
// init. Each starts with a `systemctl --user show`, which fails only when the
// user manager cannot be asked: there is none, or it does not answer. There
// is no start, stop or restart verb: `systemctl --user` does those.
//
// The Headless Hub's setup (ADR-0128) reads the same unit and logind through
// readUnit and readLinger, asks dataDirOnInstall which data dir a unit it
// installs would serve, and runs install with its linger advice withheld
// (`adviseLinger`), since its ending lists that step itself.
//
// Every name, exit, note, lock file and health probe is the product's
// descriptor's, but for two strings both products share: the data dir keeps
// a secrets.json (ADR-0121, ADR-0126), and the no-manager line points at the
// README's unit for other inits, which each product's README documents in
// its Other inits section (ADR-0120 §5, ADR-0127 §6). The core prints
// through the product's `out` and refuses with a ServiceError, whose kind
// the product turns into its exit code.
//
// Reachable only via the "./systemd-service" subpath, never index.ts.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { displayPath, type Env, home } from "./home-path";
import { type ReadCgroup, readServeLockHolder } from "./serve-lock";
import {
  CLD_EXITED,
  describeExit,
  execTool,
  parseExecStart,
  parseProperties,
  persistentUserUnitDir,
  property,
  type Ran,
  reason,
  runTool,
  unitDataDir,
} from "./systemctl";
import {
  bakedEnvironment,
  defaultUnitPath,
  environmentLine,
  preventedExits,
  serveCommand,
  unitStem,
  unitText,
  type UserUnit,
} from "./systemd-unit";

/** One headless product's unit, and what its `service` verbs read. */
export interface HeadlessService extends UserUnit {
  /**
   * The data dir an environment resolves to, the shell's or the unit's
   * (from its Environment), with `cwd` the directory a relative path in it
   * is read against: this shell's working directory for the shell's
   * environment, and the home directory for the unit's, where the user
   * manager runs a unit that sets no WorkingDirectory=.
   */
  dataDir(env: Env, cwd: string): string;
  /** The lock file in a data dir. */
  lockPath(dir: string): string;
  /** status's row for whether the daemon answers: "Socket:" for maxprice. */
  health: { label: string; answers(dir: string): Promise<boolean> };
}

// A line under an error: free text, or a label and the command it names.
export type ServiceHint = string | { label: string; command: string };

// A refusal the product maps to its exit: "usage", "failure" (1) or
// "not-running" (3, ADR-0119 §6's code, which is LSB's).
export class ServiceError extends Error {
  constructor(
    readonly kind: "usage" | "failure" | "not-running",
    message: string,
    readonly hints: readonly ServiceHint[] = [],
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

// install and uninstall are "ok"; status is "ok" while the unit is active,
// else "not-running"; logs is journalctl's own exit code.
export type ServiceResult =
  | { kind: "ok" }
  | { kind: "not-running" }
  | { kind: "exited"; code: number };

export type ServiceArgs = {
  positionals: readonly string[];
  // `-f`, and `-n`'s value: logs' flags.
  follow: boolean;
  lines: string | undefined;
};

export type ServiceContext = {
  env: Env;
  // One write per call, of these lines, each ending "\n" in the product's
  // writer. The lines carry outside text (the unit's path, the manager's and
  // logind's answers, the shell's environment), so each product's `out`
  // makes each inert with `./terminal-text`'s terminalText; journalctl's own
  // output in `logs` is journalctl's.
  out: (lines: readonly string[]) => void;
  // Whether install prints its linger advice when logind reads `Linger=no`;
  // true when unset. The Headless Hub's setup passes false: it collects the
  // linger line into its ending's sudo block (ADR-0128 §3, §5), reading it
  // with readLinger. install asks logind either way.
  adviseLinger?: boolean;
  // What a test replaces; production passes none. `self` is the command
  // that starts this product, which ExecStart runs with its arguments.
  // `cwd` is the installing shell's working directory, which install bakes
  // a relative path against, and status reads this shell's data dir against.
  self?: readonly string[];
  cwd?: string;
  uid?: number;
  readCgroup?: ReadCgroup;
};

const VERBS = ["install", "uninstall", "status", "logs"] as const;
type Verb = (typeof VERBS)[number];

// The compiled binary carries its entry inside it, under `/$bunfs/`, so the
// binary alone starts it; from source it is bun and the entry script.
function selfCommand(): string[] {
  return Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main];
}

type Context = {
  product: HeadlessService;
  env: Env;
  out: (lines: readonly string[]) => void;
  adviseLinger: boolean;
  self: readonly string[];
  cwd: string;
  uid: number;
  readCgroup: ReadCgroup | undefined;
};

function usage(message: string): ServiceError {
  return new ServiceError("usage", message);
}

function isVerb(word: string): word is Verb {
  return (VERBS as readonly string[]).includes(word);
}

// "5", "5 or 6", "5, 6 or 7".
function orList(items: readonly number[]): string {
  const words = items.map(String);
  if (words.length < 2) return words.join("");
  return `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

// ADR-0120 §5: one line, and no fallback to anything else.
function noManager(product: HeadlessService, ran: Ran): ServiceError {
  return new ServiceError(
    "failure",
    `no systemd user manager here (systemctl --user failed: ${reason(ran)}); ` +
      `run '${serveCommand(product)}' under your init, restarting it after exit 1 ` +
      `but not after exit ${orList(preventedExits(product))} ` +
      "(the README's unit for other inits shows one)",
  );
}

type Inspected = { props: Map<string, string[]>; file: string; unitFileEnv: Env };

// Keep the unit-state probe first: when it fails nothing else runs, and the
// failed run is returned for the no-manager line. UnitPath belongs to the
// manager, not the unit; an unavailable property after a successful probe
// uses the default path.
async function showUnit(
  product: HeadlessService,
  env: Env,
  properties: readonly string[],
): Promise<Inspected | { failed: Ran }> {
  const ran = await runTool(
    "systemctl",
    ["--user", "show", product.unit, `--property=${properties.join(",")}`],
    env,
  );
  if (ran.code !== 0) return { failed: ran };
  const paths = await runTool("systemctl", ["--user", "show", "--property=UnitPath"], env);
  const dir =
    paths.code === 0
      ? persistentUserUnitDir(property(parseProperties(paths.stdout), "UnitPath"))
      : null;
  return {
    props: parseProperties(ran.stdout),
    file: dir === null ? defaultUnitPath(product.unit, env) : join(dir, product.unit),
    // enable/disable can resolve unit files and write/remove their symlinks
    // client-side. Align their config home with the manager's systemd/user
    // directory, retaining the caller's other variables and fallback behavior.
    unitFileEnv: dir === null ? env : { ...env, XDG_CONFIG_HOME: dirname(dirname(dir)) },
  };
}

// showUnit for a verb: a failed probe refuses with the no-manager line alone.
async function inspectUnit(ctx: Context, properties: readonly string[]): Promise<Inspected> {
  const shown = await showUnit(ctx.product, ctx.env, properties);
  if ("failed" in shown) throw noManager(ctx.product, shown.failed);
  return shown;
}

// The states in which the unit has a process or a job, whatever its
// LoadState.
const RUNNING = new Set(["active", "reloading", "refreshing", "activating", "deactivating"]);

// Whether the user manager still has the unit. A unit whose file was deleted
// by hand stays loaded until a daemon-reload, and one that was running keeps
// running after it, with LoadState `not-found`.
function isKnown(props: Map<string, string[]>): boolean {
  const load = property(props, "LoadState");
  return (load !== "" && load !== "not-found") || RUNNING.has(property(props, "ActiveState"));
}

function why(product: HeadlessService): ServiceHint[] {
  return [{ label: "Why:", command: `${product.name} service logs` }];
}

async function systemctl(
  env: Env,
  args: readonly string[],
  hints: ServiceHint[] = [],
): Promise<void> {
  const ran = await runTool("systemctl", ["--user", ...args], env);
  if (ran.code !== 0) {
    throw new ServiceError(
      "failure",
      `systemctl --user ${args.join(" ")} failed: ${reason(ran)}`,
      hints,
    );
  }
}

// `systemctl is-active`'s success states.
function isActive(state: string): boolean {
  return state === "active" || state === "reloading" || state === "refreshing";
}

export type Linger = { value: string } | { unknown: string };

// `Linger` from logind for `uid`, or why it is unknown: install's advice and
// status's row, and the Headless Hub's setup, whose ending lists
// `sudo loginctl enable-linger` among its sudo steps while it reads `no`
// (ADR-0128 §5), and reads it again on each Enter.
export async function readLinger(env: Env, uid: number): Promise<Linger> {
  const ran = await runTool("loginctl", ["show-user", String(uid), "--property=Linger"], env);
  if (ran.code !== 0) return { unknown: `loginctl failed: ${reason(ran)}` };
  const value = property(parseProperties(ran.stdout), "Linger");
  return value === "" ? { unknown: "loginctl names none" } : { value };
}

// Whether logind reads linger as off, which is when install advises turning
// it on and setup's ending lists `sudo loginctl enable-linger` (ADR-0128 §5).
// A Linger that cannot be read is not off: neither says anything then.
export function lingerOff(state: Linger): boolean {
  return "value" in state && state.value === "no";
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Written beside the unit and renamed over it, so the manager never reads a
// half-written file. The temporary name has no unit suffix, so the manager
// never loads it either.
function writeUnit(unit: string, path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${unit}.${process.pid}.tmp`);
  writeFileSync(temporary, text, { mode: 0o644 });
  renameSync(temporary, path);
}

// Every stdout line, through the product's writer.
function say(ctx: Context, ...lines: string[]): void {
  ctx.out(lines);
}

// install rewrites the generated file, never its drop-ins, then reloads,
// clears a failed state and its start limit, enables and starts the unit,
// and restarts a daemon that is running the previous file.
async function install(ctx: Context): Promise<ServiceResult> {
  const { env, product } = ctx;
  const { unit } = product;
  const { props, file, unitFileEnv } = await inspectUnit(ctx, ["ActiveState"]);
  const wasRunning = RUNNING.has(property(props, "ActiveState"));
  const text = unitText(product, ctx.self, env, ctx.cwd);
  const changed = readOrNull(file) !== text;
  if (changed) writeUnit(unit, file, text);
  say(
    ctx,
    `${unit} ${changed ? "updated" : "unchanged"}: ${displayPath(file, env)}`,
    ...bakedEnvironment(product, env, ctx.cwd).map(
      ([name, value]) => `  ${environmentLine(name, value)}`,
    ),
  );

  await systemctl(env, ["daemon-reload"]);
  // A unit the manager has not loaded has no failed state to clear, and
  // reset-failed answers nonzero for it; enable --now, next, fails on
  // anything real.
  await runTool("systemctl", ["--user", "reset-failed", unit], env);
  await systemctl(unitFileEnv, ["enable", "--now", unit], why(product));
  // enable --now leaves an active or already-starting daemon on its old
  // command. Include every state with a process or job, even auto-restart.
  if (wasRunning && changed) {
    await systemctl(env, ["restart", unit], why(product));
    say(ctx, `Restarted ${unit}, which was running the previous file.`);
  }
  say(ctx, `${unit} is enabled and started.`);

  // logind is asked whether or not the advice is withheld (adviseLinger).
  const off = lingerOff(await readLinger(env, ctx.uid));
  if (ctx.adviseLinger && off) {
    say(
      ctx,
      `Linger is off, so ${unit} stops when your last login session ends. To keep it running:`,
      "  loginctl enable-linger",
    );
  }
  return { kind: "ok" };
}

// uninstall stops, disables and removes the unit. The data dir, its
// secrets.json, the drop-ins and linger stay, and it says so.
async function uninstall(ctx: Context): Promise<ServiceResult> {
  const { env, product } = ctx;
  const { unit } = product;
  const { props, file, unitFileEnv } = await inspectUnit(ctx, [
    "LoadState",
    "ActiveState",
    "Environment",
  ]);
  if (!existsSync(file)) {
    if (isKnown(props)) {
      // Only a stop and a daemon-reload make the manager let go of it.
      const load = property(props, "LoadState");
      const active = property(props, "ActiveState");
      throw new ServiceError(
        "failure",
        `${displayPath(file, env)} is gone, but the user manager still has ${unit} (${load}, ${active}).`,
        [
          { label: "Stop it:", command: `systemctl --user stop ${unitStem(product)}` },
          { label: "Then forget it:", command: "systemctl --user daemon-reload" },
        ],
      );
    }
    say(ctx, `${unit} is not installed; nothing to remove.`);
    return { kind: "ok" };
  }
  await systemctl(unitFileEnv, ["disable", "--now", unit]);
  rmSync(file, { force: true });
  await systemctl(env, ["daemon-reload"]);
  say(
    ctx,
    `${unit} is stopped and disabled, and ${displayPath(file, env)} is removed.`,
    `Kept: the data dir ${displayPath(unitDataDir(product.dataDir, props, env), env)} with its secrets.json, ` +
      `any drop-ins in ${displayPath(file + ".d", env)}, and linger.`,
  );
  return { kind: "ok" };
}

const STATUS_PROPERTIES = [
  "LoadState",
  "ActiveState",
  "SubState",
  "MainPID",
  "ExecMainStartTimestamp",
  "NRestarts",
  "ExecMainCode",
  "ExecMainStatus",
  "ExecStart",
  "Environment",
];

const HEALTHZ_TIMEOUT_MS = 3000;

// Whether `url` answers 2xx within 3 s, over the Unix socket `unix` when one
// is given; any error is no.
export async function answersHealthz(url: string, unix?: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      unix,
      signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS),
    });
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}

// Whether the unit runs this product: exactly one ExecStart, which is this
// binary with its arguments.
function execStartRow(
  product: HeadlessService,
  values: readonly string[],
  self: readonly string[],
): string {
  const commands = values.map(parseExecStart);
  const first = commands[0];
  if (first == null) return "–";
  const ours = [...self, ...product.execArgs].join(" ");
  if (commands.length === 1 && first.path === self[0] && first.argv === ours) {
    return `${first.argv} (this ${product.name})`;
  }
  return `${first.argv} (not this ${product.name}, ${ours}; '${product.name} service install' points it here)`;
}

// The lock file's row for a unit that stopped on the lock's exit. The file
// keeps the last holder's pid, so whether that process still runs says
// whether it is the holder now.
function lockRow(dir: string, ctx: Context): string {
  const { product } = ctx;
  const path = product.lockPath(dir);
  const holder = readServeLockHolder(path, product.unit, ctx.readCgroup);
  if (holder.pid === null) return `${basename(path)} names no pid`;
  if (!holder.running) {
    return `pid ${holder.pid}, which held it, has exited; 'systemctl --user restart ${unitStem(product)}' starts the unit`;
  }
  return `held by pid ${holder.pid}${holder.service ? ` (${product.unit})` : ""}`;
}

// status describes the unit, not the daemon; the product's own `status`
// describes the daemon. It is "ok" while the unit is active and
// "not-running" when it is not, not installed included.
async function status(ctx: Context): Promise<ServiceResult> {
  const { env, product } = ctx;
  const { props, file } = await inspectUnit(ctx, STATUS_PROPERTIES);
  const hasFile = existsSync(file);
  if (!hasFile && !isKnown(props)) {
    throw new ServiceError("not-running", `${product.unit} is not installed.`, [
      { label: "Install it:", command: `${product.name} service install` },
    ]);
  }

  const active = property(props, "ActiveState");
  const mainPid = Number(property(props, "MainPID")) || 0;
  const code = Number(property(props, "ExecMainCode")) || 0;
  const exitStatus = Number(property(props, "ExecMainStatus")) || 0;
  const unitDir = unitDataDir(product.dataDir, props, env);
  const shellDir = product.dataDir(env, ctx.cwd);
  // The exits systemd does not retry (RestartPreventExitStatus).
  const stoppedOn = (exit: number) =>
    !isActive(active) && code === CLD_EXITED && exitStatus === exit;
  const lostLock = stoppedOn(product.lockedExit);
  const refused = product.refusedExits.find(({ exit }) => stoppedOn(exit));

  const notes: string[] = [];
  if (!hasFile) {
    notes.push(
      `its file ${displayPath(file, env)} is gone; '${product.name} service install' writes it`,
    );
  }
  if (lostLock) {
    notes.push(
      product.lockedNote ??
        `another '${serveCommand(product)}' held the data dir, so the unit stopped without a retry`,
    );
  } else if (refused !== undefined) {
    notes.push(refused.note);
  } else if (active === "failed") {
    notes.push(`stopped after repeated crashes; see '${product.name} service logs'`);
  } else if (active === "inactive") {
    notes.push(`not running; start it with 'systemctl --user start ${unitStem(product)}'`);
  }

  const rows: [string, string][] = [
    ["Started:", property(props, "ExecMainStartTimestamp") || "–"],
    ["Main PID:", mainPid > 0 ? String(mainPid) : "–"],
    ["Restarts:", property(props, "NRestarts") || "–"],
    ["Last exit:", describeExit(code, exitStatus) ?? "–"],
    ["ExecStart:", execStartRow(product, props.get("ExecStart") ?? [], ctx.self)],
    [
      "Data dir:",
      displayPath(unitDir, env) +
        (unitDir === shellDir ? "" : `, not this shell's ${displayPath(shellDir, env)}`),
    ],
  ];
  const state = await readLinger(env, ctx.uid);
  rows.push(["Linger:", "value" in state ? state.value : `unknown (${state.unknown})`]);
  const answers = await product.health.answers(unitDir);
  rows.push([product.health.label, answers ? "answers /healthz" : "does not answer /healthz"]);
  if (lostLock) rows.push(["Lock:", lockRow(unitDir, ctx)]);

  const width = Math.max(...rows.map(([label]) => label.length));
  say(
    ctx,
    `${product.unit}: ${active} (${property(props, "SubState")})`,
    ...notes.map((note) => `  ${note}`),
    ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`),
  );
  return isActive(active) ? { kind: "ok" } : { kind: "not-running" };
}

// logs selects the current user's journal and explicitly matches the user
// unit, since systemd 249 does not reinterpret -u under --user. -f and -n
// pass through on this terminal, as do journalctl's output and exit code.
async function logs(
  ctx: Context,
  follow: boolean,
  lines: string | undefined,
): Promise<ServiceResult> {
  const { env, product } = ctx;
  const { props, file } = await inspectUnit(ctx, ["LoadState", "ActiveState"]);
  if (!existsSync(file) && !isKnown(props)) {
    throw new ServiceError(
      "not-running",
      `${product.unit} is not installed; a '${serveCommand(product)}' run in a terminal logs to its stderr.`,
    );
  }
  const args = ["--user", `--user-unit=${product.unit}`];
  if (follow) args.push("-f");
  if (lines !== undefined) args.push("-n", lines);
  const code = await execTool("journalctl", args, env);
  if (code === null) throw new ServiceError("failure", "journalctl is not on PATH");
  return { kind: "exited", code };
}

// The unit as the Headless Hub's setup reads it: no user manager, with the
// line every verb refuses with then (ADR-0120 §5); or whether the unit is
// installed, by status's rule (its file, or a manager that still has it), its
// ActiveState, its main pid (0 for none) and the data dir it serves, resolved
// as status resolves it, which means something only while it is installed.
export type UnitReading =
  | { kind: "no-manager"; message: string }
  | { kind: "unit"; installed: boolean; activeState: string; mainPid: number; dataDir: string };

const READ_PROPERTIES = ["LoadState", "ActiveState", "MainPID", "Environment"];

// Setup reads the unit at its gate and at step 4 (ADR-0128). The gate
// refuses an installed unit that serves another data dir than this shell's
// (§2). Step 4 prints the no-manager line in place of installing, asks before
// installing a unit that is not installed, and reports the state install
// left (§3). So no manager is a reading, never a refusal: setup skips the
// step and goes on.
export async function readUnit(
  product: HeadlessService,
  context: { env: Env },
): Promise<UnitReading> {
  const { env } = context;
  const shown = await showUnit(product, env, READ_PROPERTIES);
  if ("failed" in shown) {
    return { kind: "no-manager", message: noManager(product, shown.failed).message };
  }
  const { props, file } = shown;
  return {
    kind: "unit",
    installed: existsSync(file) || isKnown(props),
    activeState: property(props, "ActiveState"),
    mainPid: Number(property(props, "MainPID")) || 0,
    dataDir: unitDataDir(product.dataDir, props, env),
  };
}

// The data dir a unit installed from this shell, in `cwd`, would serve: the
// environment install bakes into it (bakedEnvironment), and HOME, read as
// unitDataDir reads an installed unit's. A variable the product does not
// bake never reaches the unit: a shell whose XDG_DATA_HOME alone moves the
// Headless Hub's data dir installs a unit serving the default one (ADR-0127
// §5), and the Hub's setup refuses that shell at its gate, before anything
// is created or installed (ADR-0128 §2).
export function dataDirOnInstall(
  product: Omit<HeadlessService, "health">,
  env: Env,
  cwd: string,
): string {
  return product.dataDir(
    { ...Object.fromEntries(bakedEnvironment(product, env, cwd)), HOME: env.HOME },
    home(env),
  );
}

export async function runService(
  product: HeadlessService,
  args: ServiceArgs,
  context: ServiceContext,
): Promise<ServiceResult> {
  const [verb, ...extra] = args.positionals;
  if (verb === undefined) throw usage("service needs a verb: install, uninstall, status or logs");
  if (!isVerb(verb)) throw usage(`unknown service verb '${verb}'`);
  if (extra.length > 0) throw usage(`service ${verb} takes no arguments`);
  const { follow, lines } = args;
  if (verb !== "logs" && (follow || lines !== undefined)) {
    throw usage(`-f and -n belong to service logs, not service ${verb}`);
  }
  if (lines !== undefined && !/^\d+$/.test(lines)) {
    throw usage(`-n takes a whole number of lines, not '${lines}'`);
  }

  const ctx: Context = {
    product,
    env: context.env,
    out: context.out,
    adviseLinger: context.adviseLinger ?? true,
    self: context.self ?? selfCommand(),
    cwd: context.cwd ?? process.cwd(),
    uid: context.uid ?? process.getuid?.() ?? 0,
    readCgroup: context.readCgroup,
  };
  switch (verb) {
    case "install":
      return await install(ctx);
    case "uninstall":
      return await uninstall(ctx);
    case "status":
      return await status(ctx);
    case "logs":
      return await logs(ctx, follow, lines);
  }
}
