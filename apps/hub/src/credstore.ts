import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createHelperGatewayKeyStore,
  createHelperKeyStore,
  createMemoryGatewayKeyStore,
  createMemoryKeyStore,
  type HubGatewayKeyStore,
  type HubKeyStore,
  type KeychainEntries,
} from "./key-store";
import { isEmbedded } from "./config";
import { createFileGatewayKeyStore, createFileKeyStore, secretsPath } from "./secrets";

// Where the Hub keeps its claude.ai session keys (ADR-0035, ADR-0126 §1,
// ADR-0138 §6), chosen by the platform in `openKeyStore`: on Linux,
// `<data dir>/secrets.json` (secrets.ts), and nowhere else; elsewhere the OS
// keychain through the Rust keyring helper (credstore/src/main.rs), one entry
// per Account (key-store.ts), else memory. The rest of this module is the
// helper's TS face: the secret crosses process boundaries via stdin/stdout
// only, and the entry's account name is the helper's one argument.

const exeExt = process.platform === "win32" ? ".exe" : "";

// Resolution order: env override → sibling of the compiled hub binary
// (production layout) → the crate's local cargo build (dev).
export function resolveCredstorePath(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.MAXPRICE_CREDSTORE_PATH) return env.MAXPRICE_CREDSTORE_PATH;
  const sibling = join(dirname(process.execPath), `maxprice-credstore${exeExt}`);
  if (existsSync(sibling)) return sibling;
  for (const profile of ["release", "debug"]) {
    const local = join(
      import.meta.dir,
      "..",
      "credstore",
      "target",
      profile,
      `maxprice-credstore${exeExt}`,
    );
    if (existsSync(local)) return local;
  }
  return null;
}

// Injectable helper-IPC seam. The default spawns the Rust binary; tests pass a
// fake to exercise the exit-code mapping + JSON parse without a real keychain.
export type CredstoreRunner = (
  args: string[],
  stdin?: string,
) => Promise<{ code: number; stdout: string }>;

// The slice of Bun.spawn's Subprocess that spawnRunner uses. Injectable so the
// timeout path can be exercised against a hanging child without a real keychain
// or a platform-specific shim (F26).
export type SpawnedProcess = {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
};
export type SpawnFn = (
  cmd: string[],
  options: { stdin: "ignore" | Uint8Array; stdout: "pipe"; stderr: "inherit" },
) => SpawnedProcess;

// Default IPC seam: spawn the Rust helper, read its one-shot stdout, await exit.
// A keyring backend can hang indefinitely — a locked macOS keychain, a wedged
// secret-service — and the raw read/exit awaits have no deadline, so a hung
// helper would park serve()'s credstore.get() forever (F26). The exchange now
// races a timeout: on expiry the helper is killed and the op rejects with a
// `credstore <op> timed out after <n>s` message the caller's existing catch
// surfaces. `timeoutMs` and `spawn` are injectable for tests.
export function spawnRunner(
  helperPath: string,
  timeoutMs = 10_000,
  spawn: SpawnFn = Bun.spawn as unknown as SpawnFn,
): CredstoreRunner {
  return async (args, stdin) => {
    const proc = spawn([helperPath, ...args], {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "inherit",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`credstore ${args[0]} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
    });
    // A hung helper never closes stdout, so this arm parks until the timeout
    // wins the race and kills it.
    const work = (async () => {
      const stdout = await new Response(proc.stdout).text();
      const code = await proc.exited;
      return { code, stdout };
    })();
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // If the timeout won, `work` may still settle later (a post-kill stdout
      // error); attach a sink so it can't surface as an unhandled rejection.
      void work.catch(() => {});
    }
  };
}

// The helper's three verbs, each over the one keychain entry its argument
// names (`usage-credential`, `usage-credential/<uuid>` or
// `gateway-credential/<id>`). Exit 3 on `get` is
// no entry; any other non-zero exit throws, naming the verb and the code.
export function createKeychainEntries(
  helperPath: string,
  run: CredstoreRunner = spawnRunner(helperPath),
): KeychainEntries {
  return {
    async get(account) {
      const { code, stdout } = await run(["get", account]);
      if (code === 3) return null; // NoEntry
      if (code !== 0) throw new Error(`credstore get failed (exit ${code})`);
      return stdout;
    },
    async set(account, secret) {
      const { code } = await run(["set", account], secret);
      if (code !== 0) throw new Error(`credstore set failed (exit ${code})`);
    },
    async delete(account) {
      const { code } = await run(["delete", account]);
      if (code !== 0) throw new Error(`credstore delete failed (exit ${code})`);
    },
  };
}

const MEMORY_ONLY =
  "[hub] no credstore helper found — keys will be memory-only (set MAXPRICE_CREDSTORE_PATH or build credstore/)";

export type OpenKeyStoreOptions = {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  // The file store's status line (stdout).
  log: (line: string) => void;
  // The file store's tighten and skip lines, and the memory-only warning
  // (stderr).
  warn: (line: string) => void;
  // The helper's runner, for a test.
  run?: CredstoreRunner;
};

// Whether serve keeps its keys in `secrets.json` rather than the keychain
// helper: every Hub on Linux, and a Headless Hub on macOS.
function keepsKeyFile(platform: NodeJS.Platform, env: Record<string, string | undefined>): boolean {
  return platform === "linux" || (platform === "darwin" && !isEmbedded(env));
}

// serve's store for the keys (ADR-0126 §1, ADR-0146 §4). On Linux every Hub,
// an embedded one run from source included, and on macOS a Headless Hub,
// keeps its keys in `<data dir>/secrets.json`, and never resolves the helper,
// MAXPRICE_CREDSTORE_PATH included, nor falls back to memory: the helper's
// keyring on Linux loses the key at a reboot or refuses every write (#450),
// and a Headless Hub has no console to re-key it. Elsewhere, the hub tray
// app's embedded daemon above all, as before: the helper, its uuid list
// beside hub.json, else memory with a warning (ADR-0035's degraded mode: a
// client re-push re-arms it).
export function openKeyStore(
  dataDir: string,
  { platform = process.platform, env = process.env, log, warn, run }: OpenKeyStoreOptions,
): HubKeyStore {
  if (keepsKeyFile(platform, env)) {
    return createFileKeyStore(secretsPath(dataDir), { log, warn });
  }
  const helper = resolveCredstorePath(env);
  if (helper !== null) {
    return createHelperKeyStore({
      keychain: createKeychainEntries(helper, run),
      dataDir,
      warn,
    });
  }
  warn(MEMORY_ONLY);
  return createMemoryKeyStore();
}

// serve's store for the Gateways' management keys (ADR-0141 §7), by the same
// rule as `openKeyStore`: `secrets.json`'s `gateways` where it keeps the
// file, the keychain helper elsewhere, else memory. It says nothing of its own: the
// memory-only warning is `openKeyStore`'s, made once for both.
export function openGatewayKeyStore(
  dataDir: string,
  {
    platform = process.platform,
    env = process.env,
    run,
  }: Pick<OpenKeyStoreOptions, "platform" | "env" | "run"> = {},
): HubGatewayKeyStore {
  if (keepsKeyFile(platform, env)) return createFileGatewayKeyStore(secretsPath(dataDir));
  const helper = resolveCredstorePath(env);
  if (helper !== null) return createHelperGatewayKeyStore(createKeychainEntries(helper, run));
  return createMemoryGatewayKeyStore();
}
