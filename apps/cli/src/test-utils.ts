import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { Subprocess } from "bun";
import { signingKey } from "@maxprice/usage-core/test-channel";
import { clockEnv, type ClockOrigin } from "../../../scripts/acceptance/clock";
import { dataDir, socketPath } from "./paths";

// The Headless client's test sandbox. Every spawned `maxprice` gets a throwaway
// root holding its HOME and every XDG dir, a synthetic CLAUDE_CONFIG_DIR with
// an empty `projects/`, an unroutable claude.ai, an unroutable update channel
// trusting a throwaway key, a dead HTTPS proxy, no startup pricing fetch, no
// Hub and no session bus. The child's environment is this object alone, never
// a spread of the test process's, so nothing of the real one reaches it, and
// the helper refuses to run if any of its dirs is under the real home.
//
// The update channel is build-time (update-channel.ts, ADR-0123 §9 as amended
// by #472), so it rides the command line, not the environment: every spawn
// runs `bun --define MAXPRICE_TEST_UPDATE_CHANNEL=<the sandbox's channel>`.

// This workspace's src dir, and its entry.
export const SRC = import.meta.dir;
export const MAIN = join(SRC, "main.ts");

export type UpdateChannel = { manifestUrl: string; pubkey: string };

export type Sandbox = {
  root: string;
  home: string;
  env: Record<string, string>;
  dataDir: string;
  socket: string;
  // What every spawned maxprice from source checks and installs from. A case
  // may replace it before spawning.
  updateChannel: UpdateChannel;
};

// Refused at once, like MAXPRICE_CLAUDE_BASE_URL, and trusting a key made
// here that signed nothing: no spawned `serve` or `update` reaches the real
// channel, and none would install its releases if it did.
const UNROUTABLE_CHANNEL: UpdateChannel = {
  manifestUrl: "http://127.0.0.1:9/headless-latest.json",
  pubkey: signingKey().pubkey,
};

const sandboxes: string[] = [];
const children: Subprocess[] = [];

export function makeSandbox(clock?: ClockOrigin): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "mp-cli-"));
  sandboxes.push(root);
  const home = join(root, "home");
  const run = join(root, "run");
  const claude = join(root, "claude");
  mkdirSync(home);
  mkdirSync(run, { mode: 0o700 });
  chmodSync(run, 0o700);
  mkdirSync(join(claude, "projects"), { recursive: true });
  const guard = join(root, "guard");
  mkdirSync(guard);
  writeFileSync(
    join(guard, "launchctl"),
    '#!/bin/sh\necho "Bad request.\nCould not find service in the test sandbox" >&2\nexit 113\n',
    { mode: 0o755 },
  );
  if (clock !== undefined) {
    // BUN_OPTIONS does not parse quoted preload paths. Resolve a relative
    // wrapper from the sandbox cwd, so even a checkout with spaces works.
    writeFileSync(
      join(root, "acceptance-clock.ts"),
      `import ${JSON.stringify(join(SRC, "../../../scripts/acceptance/clock-preload.ts"))};\n`,
    );
  }
  const env: Record<string, string> = {
    HOME: home,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: run,
    CLAUDE_CONFIG_DIR: claude,
    // Refused at once: nothing here may reach the real claude.ai.
    MAXPRICE_CLAUDE_BASE_URL: "http://127.0.0.1:9",
    MAXPRICE_PRICING_STARTUP_FETCH: "0",
    // A compiled production binary (the Headless rig runs one) checks the real
    // channel at boot, which no define can redirect. Bun's fetch honors the
    // proxy, sending `CONNECT github.com:443` to it, so that check is refused
    // on loopback and nothing leaves the machine; loopback itself, the
    // sandbox's own channel and claude.ai stand-in, goes direct.
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
    // The guard first: a `launchctl` that knows no service, so nothing a case
    // spawns reaches the real launchd through /bin/launchctl on macOS
    // (ADR-0143 §8's holder check in `serve`).
    PATH: `${guard}:/usr/bin:/bin`,
    TZ: "America/Chicago",
    // Explicit harness opt-in, including compiled Bun binaries. No ambient
    // BUN_OPTIONS or clock value is inherited; shipping code knows no override.
    ...(clock === undefined
      ? {}
      : {
          ...clockEnv(clock),
          BUN_OPTIONS: "--preload ./acceptance-clock.ts",
        }),
  };
  const dir = dataDir(env);
  const realHome = homedir();
  for (const path of [dir, ...Object.values(env).filter((v) => v.startsWith(root))]) {
    if (path === realHome || path.startsWith(realHome + sep)) {
      throw new Error(`refusing to run: the sandbox path ${path} is under the real home`);
    }
  }
  return {
    root,
    home,
    env,
    dataDir: dir,
    socket: socketPath(dir),
    updateChannel: { ...UNROUTABLE_CHANNEL },
  };
}

export type Spawned = {
  proc: Subprocess<"ignore" | Blob, "pipe", "pipe">;
  // Everything the child has written to stderr so far.
  stderr: () => string;
  // The exit code, once stdout and stderr are read to their end.
  done: Promise<{ code: number; stdout: string; stderr: string }>;
};

export type SpawnOptions = {
  // Written to the child's stdin, which then ends, as a pipe would; without
  // it the child's stdin is /dev/null.
  stdin?: string;
};

// `maxprice <args>` from source, as `bun src/main.ts`, in the sandbox.
export function spawnCli(sandbox: Sandbox, args: string[], options: SpawnOptions = {}): Spawned {
  return spawnBun(sandbox, [MAIN, ...args], options);
}

// A script a case writes into the sandbox, never into the repo, run by bun in
// the sandbox. It imports this workspace's modules by absolute path, e.g.
// `JSON.stringify(join(SRC, "main.ts"))`.
export function spawnScript(sandbox: Sandbox, source: string): Spawned {
  const script = join(sandbox.root, `script-${children.length}.ts`);
  writeFileSync(script, source);
  return spawnBun(sandbox, [script]);
}

function spawnBun(sandbox: Sandbox, args: string[], options: SpawnOptions = {}): Spawned {
  const channel = `MAXPRICE_TEST_UPDATE_CHANNEL=${JSON.stringify(sandbox.updateChannel)}`;
  const proc = Bun.spawn([process.execPath, "--define", channel, ...args], {
    cwd: sandbox.root,
    env: sandbox.env,
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(proc);
  let stderr = "";
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) stderr += decoder.decode(chunk, { stream: true });
  })();
  const stdout = new Response(proc.stdout).text();
  const done = (async () => {
    const code = await proc.exited;
    await stderrDone;
    return { code, stdout: await stdout, stderr };
  })();
  return { proc, stderr: () => stderr, done };
}

const DEADLINE_MS = 30_000;

export async function until(
  probe: () => boolean | Promise<boolean>,
  what: string,
  ms = DEADLINE_MS,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${ms} ms`);
    await Bun.sleep(25);
  }
}

export async function healthz(socket: string): Promise<boolean> {
  try {
    const response = await fetch("http://localhost/healthz", { unix: socket });
    return response.ok;
  } catch {
    return false;
  }
}

// Resolves once the spawned `serve` has fully started: it has logged
// `listening on`, its last step, and answers `/healthz`. An answer alone can
// come before the socket's chmod and before any signal handler exists.
export async function serving(spawned: Spawned, socket: string): Promise<void> {
  await until(async () => {
    if (spawned.proc.exitCode !== null || spawned.proc.signalCode !== null) {
      const how = spawned.proc.signalCode ?? spawned.proc.exitCode;
      throw new Error(`serve ended (${how}): ${spawned.stderr()}`);
    }
    return spawned.stderr().includes(`[serve] listening on ${socket}\n`) && (await healthz(socket));
  }, "serve logging `listening on` and answering /healthz");
}

// Every file and dir under `dir`, relative to it, sorted.
export function listTree(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).sort();
}

// For each test file's afterEach: kill every child still running, then remove
// every sandbox.
export async function cleanup(): Promise<void> {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
}

// A help text's `Exit codes:` block, each code with what it says: a row is
// two spaces, the code, two or more spaces and its text, and a wrapped line
// is indented with no code. main.test.ts and readme.test.ts both read it.
export function helpExitRows(help: string): Map<number, string> {
  const at = help.indexOf("\nExit codes:\n");
  if (at === -1) throw new Error("the help has no Exit codes block");
  const rows = new Map<number, string>();
  let last: number | null = null;
  for (const line of help.slice(at + "\nExit codes:\n".length).split("\n")) {
    const row = /^ {2}(\d+) {2,}(\S.*)$/.exec(line);
    if (row) {
      last = Number(row[1]);
      rows.set(last, row[2]!);
    } else if (last !== null && /^ {4,}\S/.test(line)) {
      rows.set(last, `${rows.get(last)!} ${line.trim()}`);
    } else break;
  }
  return rows;
}

export function helpExitCodes(help: string): number[] {
  return [...helpExitRows(help).keys()];
}

// The platforms the Headless client runs on, Linux and macOS (ADR-0143 §1):
// the cases that need its Unix socket, flock(2), signals or a spawned `serve`
// run on both. What only systemd or `/proc` has stays Linux's.
export const UNIX = process.platform === "linux" || process.platform === "darwin";
