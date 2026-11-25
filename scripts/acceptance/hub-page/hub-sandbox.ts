// The sandbox a compiled Headless Hub runs in for the real-route rigs (#493):
// served.ts on the host's loopback, peers.ts (through its probe) inside a
// Docker network namespace.
//
// The binary runs only from a COPY, alone in a fresh directory under
// os.tmpdir(): a compiled binary resolves its keychain helper beside its own
// executable (apps/hub/src/credstore.ts `resolveCredstorePath`), and its
// `import.meta.dir` is `$bunfs`, so the tree's cargo builds are out of its
// reach. `helperProblems` refuses a copy with anything beside it, or a helper
// at any path `credstoreHelperPaths` names. With no helper, a Hub off Linux
// keeps its claude.ai key in memory and says so ("no credstore helper found").
// A Linux Hub resolves no helper at all (#496, ADR-0126 §1): it keeps its key
// in `<hub-data>/secrets.json`, inside the sandbox, and says which with one
// `[hub] session key:` line.
//
// The environment is built from nothing: PATH, then HOME, XDG_CONFIG_HOME,
// XDG_DATA_HOME and MAXPRICE_HUB_DATA_DIR inside the sandbox, and
// MAXPRICE_CLAUDE_BASE_URL at a fake claude.ai on loopback. No
// MAXPRICE_CREDSTORE_* key, ever; MAXPRICE_HUB_EMBEDDED=1 only for the run
// that checks the embedded daemon mounts no page.
import { execFileSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { TARGETS } from "../../../apps/hub/scripts/build-binaries";
import { bindLoopback, credstoreHelperPaths, type LoopbackProbe } from "../hub-process";
import { type SandboxPaths, sandboxPaths } from "./hub-env";

export const REPO = resolve(import.meta.dir, "..", "..", "..");

/** The two hub targets the rigs build: the Headless Hub's and the tray app's. */
export type HubTarget = "linux-x64" | "windows-x64";

/** Where apps/hub/scripts/build-binaries.ts writes `target`'s binary in `tree`. */
export function hubBinary(target: HubTarget, tree: string = REPO): string {
  const { triple } = TARGETS[target]!;
  const ext = triple.includes("windows") ? ".exe" : "";
  return join(tree, "apps", "hub", "binaries", `maxprice-hub-${triple}${ext}`);
}
export const LINUX_HUB_BINARY = hubBinary("linux-x64");
export const WINDOWS_HUB_BINARY = hubBinary("windows-x64");
/**
 * The darwin-arm64 Headless Hub, page and all, which
 * `bun apps/hub/scripts/build-binaries.ts --headless darwin-arm64` writes
 * apart from the tray app's pageless sidecar of that triple (ADR-0147 §2).
 */
export const DARWIN_HUB_BINARY = join(
  REPO,
  "apps",
  "hub",
  "binaries",
  "darwin-arm64",
  "maxprice-hub",
);
export const DIST_PAGE = join(REPO, "apps", "hub-desktop", "dist-page");
export const HUB_PACKAGE_JSON = join(REPO, "apps", "hub", "package.json");

/**
 * Why the copy may not run: anything beside it in its directory, and every
 * keychain helper path that exists (`credstoreHelperPaths` of the tree, which
 * names the one beside the Bun running this rig, and the tree's cargo
 * builds). Empty when it may.
 */
export function helperProblems(copy: string, tree: string = REPO): string[] {
  const beside = readdirSync(dirname(copy)).filter((name) => name !== basename(copy));
  return [
    ...beside.map((name) => `${join(dirname(copy), name)} is beside the binary's copy`),
    ...credstoreHelperPaths(tree)
      .filter((path) => existsSync(path))
      .map((path) => `a keychain helper exists at ${path}`),
  ];
}

/**
 * The rigs' host ports: 50000–64999, chosen at random. The production Hub's
 * 47100 is below the range. hub-process.ts's `freeLoopbackPort` is not used:
 * it takes the OS's ephemeral port (32768–60999 on Linux), which holds 47100.
 */
export const HIGH_PORTS = { min: 50_000, end: 65_000 } as const;

export function randomHighPort(): number {
  return randomInt(HIGH_PORTS.min, HIGH_PORTS.end);
}

/**
 * A random high port 127.0.0.1 can bind right now: bound through
 * hub-process.ts's `bindLoopback`, released, returned. A taken one is
 * retried, up to `attempts`. `bind` is injectable for tests.
 */
export async function freeHighPort(
  bind: (port: number) => LoopbackProbe = bindLoopback,
  attempts = 20,
): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let probe: LoopbackProbe;
    try {
      probe = bind(randomHighPort());
    } catch {
      continue; // Taken: another one.
    }
    await probe.stop();
    return probe.port;
  }
  throw new Error(
    `no free loopback port in ${HIGH_PORTS.min}–${HIGH_PORTS.end - 1} after ${attempts} attempts`,
  );
}

/** A fresh sandbox under os.tmpdir() holding a copy of `binary`, alone, 0755. */
export function makeSandbox(label: string, binary: string): SandboxPaths {
  const paths = sandboxPaths(mkdtempSync(join(tmpdir(), `mp493-${label}-`)));
  for (const dir of [paths.bin, paths.home, paths.config, paths.data, paths.hubData]) {
    mkdirSync(dir, { recursive: true });
  }
  copyFileSync(binary, paths.binary);
  chmodSync(paths.binary, 0o755);
  return paths;
}

/** sha256 and size of a file. */
export function fileFacts(path: string): { sha256: string; bytes: number } {
  return {
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    bytes: statSync(path).size,
  };
}

/** apps/hub/package.json's version: the Hub's own, which its view carries. */
export function hubPackageVersion(): string {
  return (JSON.parse(readFileSync(HUB_PACKAGE_JSON, "utf8")) as { version: string }).version;
}

/** Every file under a built dist, dist-relative and `/`-separated, sorted. */
export function distFiles(dist: string = DIST_PAGE): string[] {
  return readdirSync(dist, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dist, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

/** The tree's HEAD and how many paths `git status --porcelain` lists. */
export function gitFacts(tree: string = REPO): { head: string; dirtyPaths: number } {
  const git = (args: string[]) =>
    execFileSync("git", ["-C", tree, ...args], { encoding: "utf8" }).trim();
  const status = git(["status", "--porcelain"]);
  return {
    head: git(["rev-parse", "HEAD"]),
    dirtyPaths: status === "" ? 0 : status.split("\n").length,
  };
}

/**
 * `bun apps/hub/scripts/build-binaries.ts <target>` in `tree`, its output
 * appended to `log`. `track` is handed the process, so a rig's cleanup can
 * stop it. Resolves with the exit code and how long it took.
 */
export async function buildHub(
  target: HubTarget,
  options: { tree?: string; log: string; track?: (proc: Bun.Subprocess) => () => void },
): Promise<{ code: number; ms: number }> {
  const tree = options.tree ?? REPO;
  const started = Date.now();
  appendFileSync(
    options.log,
    `$ (cd ${tree} && bun apps/hub/scripts/build-binaries.ts ${target})\n`,
  );
  const proc = Bun.spawn(["bun", "apps/hub/scripts/build-binaries.ts", target], {
    cwd: tree,
    stdout: "pipe",
    stderr: "pipe",
  });
  const untrack = options.track?.(proc) ?? (() => {});
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream)
      appendFileSync(options.log, decoder.decode(chunk, { stream: true }));
  };
  await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  const code = await proc.exited;
  untrack();
  const ms = Date.now() - started;
  appendFileSync(options.log, `exit ${code} after ${Math.round(ms / 1000)} s\n\n`);
  return { code, ms };
}
