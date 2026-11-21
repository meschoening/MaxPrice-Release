// The release gate's smoke of the compiled Headless client (#473; ADR-0123
// section 11; README.md beside this file).
//
//   bun scripts/acceptance/headless/smoke.ts --version <vX.Y.Z|X.Y.Z>
//       [--binary <path>]
//
// It asks one question: does the `maxprice` this release ships start, serve
// and stop? Not whether its answers are right, which the rig beside it checks
// row by row. Five rows, in order:
//
//   1. `maxprice --version` exits 0 and prints the version without its `v`,
//      trimmed, and nothing else: the bare-version contract `maxprice update`
//      checks a downloaded binary against (ADR-0123 section 4).
//   2. `maxprice serve`, in the rig's sandbox over its synthetic corpus, logs
//      `listening on` and answers `/healthz`.
//   3. `maxprice status --json` exits 0 with an empty stderr, and its stdout
//      parses with the shared `statusSnapshotSchema`.
//   4. Once `/api/status` says the scan is done (`ready`), `maxprice daily
//      --json` exits 0 with an empty stderr, its stdout parses with
//      `dailyResponseSchema`, and it holds a row: a binary that read nothing
//      would give a schema-valid empty answer.
//   5. SIGTERM ends `serve` with exit code 0, not by the signal, within a
//      deadline.
//
// The sandbox is the rig's (`apps/cli/src/test-utils.ts`): a throwaway HOME
// and XDG dirs, a synthetic CLAUDE_CONFIG_DIR, an unroutable claude.ai, no
// pricing fetch and no session bus. No settings are written, so `serve`
// boots as a fresh install does: with no Hub and no key. The smoke kills only
// the processes it spawned and removes its sandbox on every path, a thrown
// error and a SIGINT or SIGTERM to the smoke included.
//
// Exit 0 when every row passes, 1 when any fails, 2 when the run could not be
// made: a usage error, no binary, or a `serve` that never served.
//
// `smokeBinary` is the core, for the release rehearsal to run on the binary
// it installed. A caller that handles SIGINT or SIGTERM itself calls
// `abandonSmokes()` from its handler, as this file's entry does. The
// rehearsal's rows have a smoke row's shape, and it judges and tabulates them
// with this file's helpers: `abnormal`, `firstLine`, `within`, `exitCodeOf`
// and `smokeTable`. The Headless Hub's smoke (`../headless-hub/smoke.ts`)
// uses them too, with `versionVerdict` under its own updater's name.
import { existsSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type DailyResponse,
  dailyResponseSchema,
  type StatusSnapshot,
  statusSnapshotSchema,
} from "../../../packages/shared/src/index";
import { writeCorpus } from "../../../apps/cli/src/test-corpus";
import { makeSandbox, type Sandbox, until } from "../../../apps/cli/src/test-utils";
import { normalizeVersion } from "../../version-files";

const REPO = resolve(import.meta.dir, "..", "..", "..");
export const DEFAULT_BINARY = join(REPO, "apps", "cli", "binaries", "maxprice");

// `maxprice update`'s own deadline for a binary's `--version` (ADR-0123
// section 4, check 5).
const VERSION_MS = 15_000;
// The rig's deadline for `serve` to come up, and for the scan.
const SERVE_MS = 60_000;
const READY_MS = 60_000;
// One `status` or `daily` run. `status` probes for 3 s; `daily` runs once the
// scan is done.
const COMMAND_MS = 30_000;
// SIGTERM to exit. The unit sets no stop timeout, so systemd's default, 90 s,
// applies; a daemon over a corpus this small that needs a third of it is
// broken.
const STOP_MS = 30_000;
// A process's output, read to its end once the process has ended.
const STREAMS_MS = 2_000;
// One request over the socket, so a daemon that accepts and never answers
// cannot stall a wait past its deadline.
const FETCH_MS = 3_000;

// How a process ended. `code` is null when a signal ended it, and `error`
// says why there was no exit to read: it could not start, or it outran its
// deadline and was killed.
export type Ended = { code: number | null; signal: string | null; error: string | null };
export type Ran = Ended & { stdout: string; stderr: string };

export type Verdict = { verdict: "pass" | "fail"; detail: string };
export type SmokeRow = Verdict & { name: string; command: string };

export type SmokeResult = {
  rows: SmokeRow[];
  // Why the run could not be made, or null.
  broken: string | null;
  // Everything `serve` wrote to stdout and stderr.
  serveLog: string;
  ok: boolean;
};

export type SmokeArgs = { version: string; binary: string };

const USAGE =
  "usage: bun scripts/acceptance/headless/smoke.ts --version <vX.Y.Z|X.Y.Z> [--binary <path>]";

// The bare version, and the binary resolved against `cwd`, or a usage error.
export function parseSmokeArgs(argv: string[], cwd = process.cwd()): SmokeArgs | { usage: string } {
  let values: { version?: string; binary?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { version: { type: "string" }, binary: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { usage: `${messageOf(error)}\n${USAGE}` };
  }
  if (values.version === undefined) return { usage: `--version is required\n${USAGE}` };
  if (values.binary === "") return { usage: `--binary names no path\n${USAGE}` };
  let version: string;
  try {
    version = normalizeVersion(values.version);
  } catch (error) {
    return { usage: `${messageOf(error)}\n${USAGE}` };
  }
  return {
    version,
    binary: values.binary === undefined ? DEFAULT_BINARY : resolve(cwd, values.binary),
  };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The first line of `text` that is not blank, trimmed, at most `chars` long.
export function firstLine(text: string, chars = 200): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim().slice(0, chars);
}

// Null when the process exited 0; else how it ended instead.
export function abnormal(ended: Ended): string | null {
  if (ended.error !== null) return ended.error;
  if (ended.signal !== null) return `was ended by ${ended.signal}`;
  if (ended.code === null) return "ended with no exit status";
  if (ended.code !== 0) return `exited ${ended.code}`;
  return null;
}

// A run that ended abnormally, as `how`, with its stderr's first line.
export function failed(ran: Ran, how: string): Verdict {
  const said = firstLine(ran.stderr);
  return { verdict: "fail", detail: said === "" ? how : `${how}: ${said}` };
}

// `updater` is the command that checks a downloaded binary's `--version`
// against the manifest's: this binary's by default, and `maxprice-hub update`
// for the Headless Hub's smoke (ADR-0129 section 4).
export function versionVerdict(expected: string, ran: Ran, updater = "maxprice update"): Verdict {
  const how = abnormal(ran);
  if (how !== null) return failed(ran, how);
  const printed = ran.stdout.trim();
  if (printed === expected) return { verdict: "pass", detail: `printed ${expected}` };
  const why =
    printed === `v${expected}`
      ? `: \`${updater}\` requires the bare version, with no \`v\``
      : `, which \`${updater}\` would refuse`;
  return {
    verdict: "fail",
    detail: `printed ${JSON.stringify(printed.slice(0, 80))}, not ${expected}${why}`,
  };
}

// A shared Zod schema, as far as a verdict reads it. Structural, since zod
// itself does not resolve from scripts/.
type Schema<T> = {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } };
};

// A `--json` run: exit 0, an empty stderr, and stdout the schema parses.
// `vacuous` names what makes a parsed answer prove nothing, or returns null.
function jsonVerdict<T>(
  ran: Ran,
  schema: Schema<T>,
  name: string,
  describe: (data: T) => string,
  vacuous: (data: T) => string | null = () => null,
): Verdict {
  const how = abnormal(ran);
  if (how !== null) return failed(ran, how);
  if (ran.stderr !== "") return failed(ran, "wrote to stderr");
  let body: unknown;
  try {
    body = JSON.parse(ran.stdout);
  } catch {
    return { verdict: "fail", detail: `stdout is not JSON: ${firstLine(ran.stdout)}` };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? "" : ` at ${issue.path.join(".") || "the root"}`;
    return {
      verdict: "fail",
      detail: `stdout does not parse with ${name}${where}: ${issue?.message ?? ""}`,
    };
  }
  const empty = vacuous(parsed.data);
  if (empty !== null) return { verdict: "fail", detail: empty };
  return { verdict: "pass", detail: describe(parsed.data) };
}

export function statusVerdict(ran: Ran): Verdict {
  return jsonVerdict<StatusSnapshot>(
    ran,
    statusSnapshotSchema,
    "statusSnapshotSchema",
    (status) => `parses; engineVersion ${status.engineVersion}, ready ${status.ready}`,
  );
}

export function dailyVerdict(ran: Ran): Verdict {
  return jsonVerdict<DailyResponse>(
    ran,
    dailyResponseSchema,
    "dailyResponseSchema",
    (daily) => `parses; ${daily.daily.length} days`,
    (daily) =>
      daily.daily.length === 0
        ? "parses, but has no rows over a corpus that holds usage this week"
        : null,
  );
}

export function stopVerdict(ended: Ended): Verdict {
  const how = abnormal(ended);
  return how === null ? { verdict: "pass", detail: "exited 0" } : { verdict: "fail", detail: how };
}

export function exitCodeOf(result: Pick<SmokeResult, "rows" | "broken">): 0 | 1 | 2 {
  if (result.broken !== null || result.rows.length === 0) return 2;
  return result.rows.every((row) => row.verdict === "pass") ? 0 : 1;
}

// The Markdown table of a run's rows. The rehearsal's carries a `banner`
// above the count and says why it `stopped`; the smoke's has neither.
export function smokeTable(
  result: Pick<SmokeResult, "rows" | "broken"> & { stopped?: string | null },
  header: string,
  banner: string | null = null,
): string {
  const esc = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
  const pass = result.rows.filter((row) => row.verdict === "pass").length;
  const { stopped = null } = result;
  return (
    [
      header,
      "",
      ...(banner === null ? [] : [banner, ""]),
      `${pass} pass, ${result.rows.length - pass} fail`,
      "",
      "| # | Row | Command | Verdict | Detail |",
      "| - | --- | ------- | ------- | ------ |",
      ...result.rows.map(
        (row, i) =>
          `| ${i + 1} | ${esc(row.name)} | \`${esc(row.command)}\` | ${row.verdict} | ${esc(row.detail)} |`,
      ),
      ...(stopped === null ? [] : ["", `Stopped: ${stopped}`]),
      ...(result.broken === null ? [] : ["", `Run failed: ${result.broken}`]),
    ].join("\n") + "\n"
  );
}

class RunFailure extends Error {}

type Child = Bun.Subprocess<"ignore", "pipe", "pipe">;

// One smoke's sandbox, every process it spawned, and its `serve` once spawned.
type Run = { binary: string; sandbox: Sandbox; children: Set<Child>; daemon: Daemon | null };

const live = new Set<Run>();

// Synchronous, so a signal handler can call it and exit at once: SIGKILL to
// every process the smoke spawned that has not ended, then the sandbox goes.
// It never signals anything else.
export function abandonSmokes(): void {
  for (const run of [...live]) {
    for (const child of run.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    rmSync(run.sandbox.root, { recursive: true, force: true, maxRetries: 3 });
    live.delete(run);
  }
}

// The normal teardown: the same kills, but each process is waited for before
// the sandbox it writes to is removed.
async function stopRun(run: Run): Promise<void> {
  for (const child of run.children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  rmSync(run.sandbox.root, { recursive: true, force: true, maxRetries: 3 });
  live.delete(run);
}

// `promise`'s value, or null once `ms` pass first. The timer is cleared
// either way, so a finished smoke leaves nothing pending.
export async function within<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((done) => (timer = setTimeout(() => done(null), ms)));
  try {
    return await Promise.race([promise.then((value) => ({ value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function spawn(run: Run, args: string[]): Child {
  const child = Bun.spawn([run.binary, ...args], {
    env: run.sandbox.env,
    cwd: run.sandbox.root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  run.children.add(child);
  return child;
}

// One run of the binary, killed at `ms`.
async function runBinary(run: Run, args: string[], ms: number): Promise<Ran> {
  let child: Child;
  try {
    child = spawn(run, args);
  } catch (error) {
    return {
      code: null,
      signal: null,
      error: `could not start: ${messageOf(error)}`,
      stdout: "",
      stderr: "",
    };
  }
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const ended = await within(child.exited, ms);
  if (ended === null) child.kill("SIGKILL");
  await child.exited;
  run.children.delete(child);
  // Bounded: a process the binary started could still hold its streams.
  const streams = await within(Promise.all([stdout, stderr]), STREAMS_MS);
  return {
    code: child.exitCode,
    signal: child.signalCode,
    error:
      ended === null
        ? `did not finish within ${ms / 1000} s`
        : streams === null
          ? `exited, but its output did not end within ${STREAMS_MS / 1000} s`
          : null,
    stdout: streams?.value[0] ?? "",
    stderr: streams?.value[1] ?? "",
  };
}

// `drained` settles once both of `serve`'s streams have ended.
type Daemon = { child: Child; log: () => string; drained: Promise<unknown> };

function spawnDaemon(run: Run): Daemon {
  const child = spawn(run, ["serve"]);
  let log = "";
  const decoder = new TextDecoder();
  const drained = Promise.all(
    [child.stdout, child.stderr].map(async (stream) => {
      for await (const chunk of stream) log += decoder.decode(chunk, { stream: true });
    }),
  );
  run.daemon = { child, log: () => log, drained };
  return run.daemon;
}

function gone(daemon: Daemon): RunFailure | null {
  const { exitCode, signalCode } = daemon.child;
  if (exitCode === null && signalCode === null) return null;
  return new RunFailure(
    `serve ${signalCode === null ? `exited ${exitCode}` : `was ended by ${signalCode}`}`,
  );
}

async function socketFetch(run: Run, path: string): Promise<Response> {
  return await fetch(`http://localhost${path}`, {
    unix: run.sandbox.socket,
    signal: AbortSignal.timeout(FETCH_MS),
  });
}

// `serve` has logged `listening on`, its last boot step, and answers
// `/healthz`: an answer alone can come before its signal handlers exist.
async function serving(run: Run, daemon: Daemon): Promise<void> {
  const socket = run.sandbox.socket;
  await until(
    async () => {
      const ended = gone(daemon);
      if (ended !== null) throw ended;
      if (!daemon.log().includes(`[serve] listening on ${socket}\n`)) return false;
      return (await socketFetch(run, "/healthz").catch(() => null))?.ok === true;
    },
    "serve logging `listening on` and answering /healthz",
    SERVE_MS,
  );
}

// `/api/status` says the initial scan is done.
async function scanned(run: Run, daemon: Daemon): Promise<void> {
  let last = "no answer";
  try {
    await until(
      async () => {
        const ended = gone(daemon);
        if (ended !== null) throw ended;
        const response = await socketFetch(run, "/api/status").catch(() => null);
        if (response === null) {
          last = `no answer within ${FETCH_MS / 1000} s`;
          return false;
        }
        const parsed = statusSnapshotSchema.safeParse(await response.json());
        if (!parsed.success)
          throw new RunFailure("/api/status does not parse with statusSnapshotSchema");
        last = `ready ${parsed.data.ready}, phase ${parsed.data.bootProgress?.phase ?? "unknown"}`;
        return parsed.data.ready;
      },
      "/api/status reporting ready",
      READY_MS,
    );
  } catch (error) {
    throw new RunFailure(`${messageOf(error)} (last seen: ${last})`);
  }
}

export async function smokeBinary(options: SmokeArgs): Promise<SmokeResult> {
  const binary = resolve(options.binary);
  const expected = normalizeVersion(options.version);
  const rows: SmokeRow[] = [];
  if (!existsSync(binary)) {
    const broken = `no binary at ${binary}: build it with \`bun run build:cli\`, or pass --binary`;
    return { rows, broken, serveLog: "", ok: false };
  }
  const run: Run = { binary, sandbox: makeSandbox(), children: new Set(), daemon: null };
  live.add(run);
  let broken: string | null;
  try {
    broken = await smokeRows(run, expected, rows);
  } finally {
    await stopRun(run);
  }
  // Read once serve's streams have ended, so the log holds its last lines.
  // Bounded: a process that inherited them could hold them open.
  if (run.daemon !== null) await within(run.daemon.drained, STREAMS_MS);
  return {
    rows,
    broken,
    serveLog: run.daemon?.log() ?? "",
    ok: exitCodeOf({ rows, broken }) === 0,
  };
}

// The five rows, pushed onto `rows` as each is judged. Returns why the run
// could not be made, or null.
async function smokeRows(run: Run, expected: string, rows: SmokeRow[]): Promise<string | null> {
  rows.push({
    name: "--version prints the bare version",
    command: "maxprice --version",
    ...versionVerdict(expected, await runBinary(run, ["--version"], VERSION_MS)),
  });

  writeCorpus(run.sandbox.env.CLAUDE_CONFIG_DIR!);
  const serveRow = { name: "serve comes up", command: "maxprice serve" };
  let daemon: Daemon;
  try {
    daemon = spawnDaemon(run);
    await serving(run, daemon);
  } catch (error) {
    const why = messageOf(error);
    rows.push({ ...serveRow, verdict: "fail", detail: why });
    return `serve never served: ${why}`;
  }
  rows.push({
    ...serveRow,
    verdict: "pass",
    detail: `listening on ${run.sandbox.socket}, /healthz answered (pid ${daemon.child.pid})`,
  });

  rows.push({
    name: "status --json parses",
    command: "maxprice status --json",
    ...statusVerdict(await runBinary(run, ["status", "--json"], COMMAND_MS)),
  });

  const dailyRow = {
    name: "daily --json parses and holds a row",
    command: "maxprice daily --json",
  };
  try {
    await scanned(run, daemon);
    rows.push({
      ...dailyRow,
      ...dailyVerdict(await runBinary(run, ["daily", "--json"], COMMAND_MS)),
    });
  } catch (error) {
    rows.push({ ...dailyRow, verdict: "fail", detail: messageOf(error) });
  }

  const { child } = daemon;
  const stopRow = { name: "SIGTERM stops serve with exit 0", command: `kill -TERM ${child.pid}` };
  const early = gone(daemon);
  if (early !== null) {
    rows.push({ ...stopRow, verdict: "fail", detail: `${early.message} before SIGTERM` });
    return null;
  }
  child.kill("SIGTERM");
  const stopped = await within(child.exited, STOP_MS);
  rows.push({
    ...stopRow,
    ...stopVerdict({
      code: child.exitCode,
      signal: child.signalCode,
      error: stopped === null ? `did not exit within ${STOP_MS / 1000} s of SIGTERM` : null,
    }),
  });
  return null;
}

async function main(argv: string[]): Promise<number> {
  const args = parseSmokeArgs(argv);
  if ("usage" in args) {
    console.error(args.usage);
    return 2;
  }
  const interrupted = () => {
    abandonSmokes();
    process.exit(130);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  process.once("exit", abandonSmokes);

  const result = await smokeBinary(args);
  const inRepo = relative(REPO, args.binary);
  const shown = inRepo.startsWith("..") ? args.binary : inRepo;
  const header = `# Headless client smoke\n\nBinary: \`${shown}\`, version ${args.version}, run ${new Date().toISOString()}`;
  if (result.rows.length === 0) console.error(`run failed: ${result.broken}`);
  else process.stdout.write(smokeTable(result, header));
  const code = exitCodeOf(result);
  if (code !== 0 && result.serveLog !== "") {
    process.stderr.write(`\nserve's log:\n${result.serveLog}`);
  }
  return code;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    return 2;
  });
}
