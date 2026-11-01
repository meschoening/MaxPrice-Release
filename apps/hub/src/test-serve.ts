import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { Subprocess } from "bun";
import { HUB_DEFAULT_PORT } from "@maxprice/shared";
import { clientPath } from "@maxprice/usage-core/test-loopback";
import { UPDATE_CHECK_FILE } from "@maxprice/usage-core/update-check";
import { MANIFEST_NAME, PRODUCT } from "./update-channel";

// `maxprice-hub` from source, as `bun src/index.ts`, each run in a sandbox of
// its own, for the suites that spawn it: serve-lifecycle.test.ts,
// key-custody.test.ts, restore.test.ts, operator-verbs.test.ts, which also
// runs a script of its own there (`spawnScript`), and
// page-publish.spawned.test.ts. Each test file's afterEach calls
// `cleanUpServeRuns()`, which kills every child still running and removes
// every sandbox.
//
// The child's environment is the sandbox's alone, never a spread of this
// process's: its HOME, every XDG dir and its data dir are inside the sandbox,
// its credstore helper path names no file (the Hub never resolves one on
// Linux, ADR-0126 §1, and elsewhere it would spawn it and fail, so no
// keychain is ever reached), claude.ai is a closed loopback port, and its
// hub.json binds loopback on a free high port, never 47100. A data dir with
// no hub.json would boot on 47100 and the tailnet, so no case lets `serve`
// reach one. `makeSandbox`'s environment is POSIX, for the Linux suites; a case
// off Linux builds its own Sandbox and spawns it with the same helpers.
//
// The update channel is build-time (update-channel.ts, ADR-0129 §7 with
// ADR-0123 §9 as amended by #472), so it rides the command line, not the
// environment: every spawn runs `bun --define MAXPRICE_TEST_UPDATE_CHANNEL=<the
// sandbox's channel>`. By default that channel is an unroutable loopback port
// under a throwaway key, so a Headless `serve`'s boot check fails at once and
// never reaches the real channel; the dead HTTPS proxy below is the second
// guard, for a URL the define does not cover. A sandbox that names a
// `noAnswerMs` defines the operator commands' answer bound too
// (no-answer.ts), so a case that waits out a Hub that never answers waits
// that long rather than the real 10 s.

export const ENTRY = join(import.meta.dir, "index.ts");
export const CASE_MS = 60_000;
export const DEADLINE_MS = 30_000;

export type UpdateChannel = { manifestUrl: string; pubkey: string };

export type Sandbox = {
  root: string;
  home: string;
  dataDir: string;
  env: Record<string, string>;
  // The channel every spawn defines; a case may point it at its own.
  updateChannel: UpdateChannel;
  // The answer bound every spawn defines, when a case sets one.
  noAnswerMs?: number;
};

// Not a key: no channel a sandbox defines is ever installed from, so its
// pubkey only has to be one the release does not use. Spelled here rather
// than made with usage-core's `./test-channel`, a test-only subpath this
// file may not import, since it ships to the public mirror (whose
// scripts/public-sync.test.ts case "nothing shipping reaches usage-core's
// test-only subpath exports" holds it to that).
const THROWAWAY_PUBKEY = Buffer.from("untrusted comment: no MaxPrice release key\n").toString(
  "base64",
);

export const UNROUTABLE_CHANNEL: UpdateChannel = {
  manifestUrl: "http://127.0.0.1:9/headless-hub-latest.json",
  pubkey: THROWAWAY_PUBKEY,
};

const roots: string[] = [];
const children: Subprocess[] = [];
const channels: Array<ReturnType<typeof Bun.serve>> = [];
// Dirs a case sealed (mode 000), reopened before the sandbox is removed.
const sealed: string[] = [];

// `env` replaces the sandbox's own keys, for a case that points the Hub at a
// fake claude.ai or a fake helper; it must not leave the sandbox either.
export function makeSandbox(env: Record<string, string> = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "mp-hub-serve-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  // In HOME, so a message shows it as ~/hub (displayPath).
  const dataDir = join(home, "hub");
  const sandboxEnv: Record<string, string> = {
    HOME: home,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    MAXPRICE_HUB_DATA_DIR: dataDir,
    // Names no file: no real keychain helper (the sibling of the binary, or
    // the crate's build) is ever resolved, on any platform.
    MAXPRICE_CREDSTORE_PATH: join(root, "no-credstore"),
    // Refused at once: nothing here may reach the real claude.ai.
    MAXPRICE_CLAUDE_BASE_URL: "http://127.0.0.1:9/api",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
    PATH: "/usr/bin:/bin",
    TZ: "America/Chicago",
    // Bun's transpiler cache would write into the sandbox's cache dir.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    ...env,
  };
  const realHome = homedir();
  for (const path of [dataDir, ...Object.values(sandboxEnv).filter((v) => v.startsWith(root))]) {
    if (path === realHome || path.startsWith(realHome + sep)) {
      throw new Error(`refusing to run: the sandbox path ${path} is under the real home`);
    }
  }
  return { root, home, dataDir, env: sandboxEnv, updateChannel: { ...UNROUTABLE_CHANNEL } };
}

// hub.json as loadOrInitConfig normalizes it, so serve does not rewrite it.
export function writeHub(
  sandbox: Sandbox,
  port: number,
  bind = "loopback",
  mode = 0o700,
  passwordHash: string | null = null,
): void {
  if (port === HUB_DEFAULT_PORT) throw new Error("refusing to use the Hub's default port");
  mkdirSync(sandbox.dataDir, { recursive: true });
  chmodSync(sandbox.dataDir, mode);
  writeFileSync(
    join(sandbox.dataDir, "hub.json"),
    `${JSON.stringify({ port, bind, passwordHash }, null, 2)}\n`,
  );
}

export function seal(dir: string): void {
  sealed.push(dir);
  chmodSync(dir, 0o000);
}

export function unseal(): void {
  for (const dir of sealed.splice(0)) chmodSync(dir, 0o700);
}

// A free high loopback port, never the Hub's default.
export async function freePort(hostname = "127.0.0.1"): Promise<number> {
  for (;;) {
    const server = Bun.serve({ hostname, port: 0, fetch: () => new Response() });
    const port = server.port!;
    await server.stop(true);
    if (port !== HUB_DEFAULT_PORT && port >= 1024) return port;
  }
}

export function canBind(hostname: string, port: number): boolean {
  try {
    const server = Bun.serve({ hostname, port, fetch: () => new Response() });
    void server.stop(true);
    return true;
  } catch {
    return false;
  }
}

// What serve's bind line names a holder by: its pid and /proc's command.
export function holder(pid: number): string {
  return `pid ${pid}, ${readFileSync(`/proc/${pid}/comm`, "utf8").trim()}`;
}

// The operator secret an embedded daemon prints is never kept, so no failure
// message can show it.
export function redact(text: string): string {
  return text.replace(/^OPERATOR_TOKEN .*$/gm, "OPERATOR_TOKEN <redacted>");
}

export type Ended = { code: number | null; signal: string | null; stdout: string; stderr: string };

export type Spawned = {
  proc: Subprocess<"ignore" | "pipe" | Uint8Array, "pipe", "pipe">;
  // Date.now() just before the spawn.
  startedAt: number;
  // What the child has written so far, OPERATOR_TOKEN redacted.
  stdout: () => string;
  stderr: () => string;
  done: Promise<Ended>;
};

// The sandbox's channel, and its answer bound if it names one, as bun's
// build-time defines (the header says why).
function define(sandbox: Sandbox): string[] {
  const bound = sandbox.noAnswerMs;
  return [
    "--define",
    `MAXPRICE_TEST_UPDATE_CHANNEL=${JSON.stringify(sandbox.updateChannel)}`,
    ...(bound === undefined ? [] : ["--define", `MAXPRICE_TEST_NO_ANSWER_MS=${bound}`]),
  ];
}

// `stdin` is what a headless child reads, all of it and then its end, as a
// command reads a password or a key piped to it (ADR-0128 §6); without it the
// child's stdin is empty.
export function spawnHub(
  sandbox: Sandbox,
  args: string[] = [],
  { embedded = false, stdin }: { embedded?: boolean; stdin?: string } = {},
): Spawned {
  if (embedded && stdin !== undefined) throw new Error("an embedded daemon's stdin is the tray's");
  const startedAt = Date.now();
  const proc = Bun.spawn([process.execPath, ...define(sandbox), ENTRY, ...args], {
    cwd: sandbox.root,
    env: embedded ? { ...sandbox.env, MAXPRICE_HUB_EMBEDDED: "1" } : sandbox.env,
    // The tray app's pipe, held open for the child's life: its end is an
    // embedded daemon's orphan signal.
    stdin: embedded ? "pipe" : stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return watched(proc, startedAt);
}

// A script of the case's own, written into the sandbox's root and run there
// with the sandbox's environment: a stand-in for a Hub that a case stops
// (SIGSTOP) without stopping itself. The cleanup kills it, stopped or not.
export function spawnScript(
  sandbox: Sandbox,
  name: string,
  source: string,
  args: string[] = [],
): Spawned {
  const path = join(sandbox.root, name);
  writeFileSync(path, source);
  const startedAt = Date.now();
  const proc = Bun.spawn([process.execPath, ...define(sandbox), path, ...args], {
    cwd: sandbox.root,
    env: sandbox.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return watched(proc, startedAt);
}

// A child of the cleanup's, with what it writes kept as it comes.
function watched(proc: Spawned["proc"], startedAt: number): Spawned {
  children.push(proc);
  let stdout = "";
  let stderr = "";
  const read = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
  };
  const reading = Promise.all([
    read(proc.stdout, (text) => (stdout = redact(stdout + text))),
    read(proc.stderr, (text) => (stderr += text)),
  ]);
  const done = (async () => {
    await proc.exited;
    await reading;
    return { code: proc.exitCode, signal: proc.signalCode, stdout, stderr };
  })();
  return { proc, startedAt, stdout: () => stdout, stderr: () => stderr, done };
}

export async function until(
  probe: () => boolean | Promise<boolean>,
  what: string,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${DEADLINE_MS} ms`);
    await Bun.sleep(intervalMs);
  }
}

export async function healthz(port: number, host = "127.0.0.1"): Promise<boolean> {
  try {
    return (await fetch(`http://${host}:${port}/healthz`)).ok;
  } catch {
    return false;
  }
}

// Throws with what the child said once it has ended, so a wait on a dead
// child fails at once rather than at its deadline.
export function stillRunning(spawned: Spawned): void {
  if (spawned.proc.exitCode !== null || spawned.proc.signalCode !== null) {
    const how = spawned.proc.signalCode ?? spawned.proc.exitCode;
    throw new Error(`serve ended (${how}): ${spawned.stderr()}\n${spawned.stdout()}`);
  }
}

// Resolves once the spawned serve has fully started. `[hub] data dir:` is the
// last line before the signal handlers, in the same synchronous run, so an
// answer to a /healthz sent after it means they are in place.
export async function serving(spawned: Spawned, port: number): Promise<void> {
  await until(async () => {
    stillRunning(spawned);
    return spawned.stdout().includes("[hub] data dir: ") && (await healthz(port));
  }, "serve logging its data dir and answering /healthz");
}

// Once /api/status answers, the boot-readiness sequence has run: the archive
// is open and the credential read. `headers` pass a protected Hub's gate.
export async function booted(port: number, headers: Record<string, string> = {}): Promise<void> {
  await until(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/api/status`, { headers })).ok;
    } catch {
      return false;
    }
  }, "/api/status answering");
}

export async function stop(spawned: Spawned, signal: "SIGTERM" | "SIGHUP"): Promise<Ended> {
  spawned.proc.kill(signal);
  return await spawned.done;
}

// Every file and dir under `dir`, relative to it, sorted.
export function listTree(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).sort();
}

export const lockFile = (sandbox: Sandbox) => join(sandbox.dataDir, "serve.lock");

export const updateCheckFile = (sandbox: Sandbox) => join(sandbox.dataDir, UPDATE_CHECK_FILE);

// An update channel on loopback offering `version`, for a sandbox's
// `updateChannel`, with every path it was asked of the two a Hub could ask
// it, its manifest and its tarball, in order. Only the manifest should be: a
// check never downloads the tarball, which is named on a closed port. Any
// other request (a prober's `GET /`) is answered, never recorded (#596). The
// cleanup stops it.
export function offeringChannel(version: string): { channel: UpdateChannel; requests: string[] } {
  const requests: string[] = [];
  const tarball = `http://127.0.0.1:9/${PRODUCT.assetName(version)}`;
  const asked = [`/${MANIFEST_NAME}`, `/${PRODUCT.assetName(version)}`];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (clientPath(request, asked)) requests.push(path);
      if (path !== `/${MANIFEST_NAME}`) return new Response("no", { status: 404 });
      // A Tauri updater manifest with the one entry, as `MP-Updates` serves it.
      return Response.json({
        version,
        notes: "",
        pub_date: "2026-10-19T00:00:00Z",
        platforms: { [PRODUCT.platform]: { url: tarball, signature: "c2lnbmF0dXJl" } },
      });
    },
  });
  channels.push(server);
  return {
    channel: {
      manifestUrl: `http://127.0.0.1:${server.port}/${MANIFEST_NAME}`,
      pubkey: THROWAWAY_PUBKEY,
    },
    requests,
  };
}

// Resolves once `spawned`, a Headless serve, has written its boot check's
// record (ADR-0129 §6): one checked no earlier than the spawn, so a record an
// earlier serve left in the data dir never counts. The check starts once the
// boot lines are out and settles on its own time, so a case that pins the
// data dir's files across a running serve, or reads the Update row, waits
// for the record first. A serve that has ended fails it at once.
export async function checked(sandbox: Sandbox, spawned: Spawned): Promise<void> {
  await until(() => {
    stillRunning(spawned);
    return checkedSince(updateCheckFile(sandbox), spawned.startedAt);
  }, "the serve's boot update check recorded");
}

// Whether the record at `path` was checked at or after `since`. The writer
// renames a whole record into place, so a read is one record or none. The
// child's clock is this process's: no clock preload runs here.
function checkedSince(path: string, since: number): boolean {
  try {
    const { checkedAt } = JSON.parse(readFileSync(path, "utf8")) as { checkedAt?: unknown };
    return typeof checkedAt === "string" && Date.parse(checkedAt) >= since;
  } catch {
    return false;
  }
}

export async function cleanUpServeRuns(): Promise<void> {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  for (const channel of channels.splice(0)) await channel.stop(true);
  unseal();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
