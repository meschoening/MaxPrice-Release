import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  storedUsageCredentialSchema,
  type StoredUsageCredential,
  type UsageCredential,
} from "@maxprice/shared";
import { createFileCredstore, secretsPath } from "./secrets";

// Where the Hub keeps its claude.ai session key (ADR-0035, ADR-0126 §1), chosen
// by the platform in `openCredstore`: on Linux, `<data dir>/secrets.json`
// (secrets.ts), and nowhere else; elsewhere the OS keychain through the Rust
// keyring helper (credstore/src/main.rs), else memory. The rest of this module
// is the helper's TS face: the secret crosses process boundaries via
// stdin/stdout only, and the helper inherits this process's env, so
// MAXPRICE_CREDSTORE_ACCOUNT (tests) flows through.

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

// When the key was set and by whom: `credentialUpdatedAt` and
// `credentialSource` on HubStatus (ADR-0036), "local" for the console's push or
// a healing client's machine id. POST /api/credential takes it once per push.
export type CredentialProvenance = { setAt: string; source: string };

// `get` reads what the store holds — a pre-#283 keychain entry still carries
// the `orgId` the boot stamp needs (ADR-0104), and the file store's entry its
// provenance, which the boot restores to the status (ADR-0126 §3); `set` only
// ever writes the key, with its provenance where the store keeps one. The
// keychain and memory stores keep none: theirs is lost at a restart.
export type Credstore = {
  get: () => Promise<(StoredUsageCredential & { provenance?: CredentialProvenance }) | null>;
  set: (cred: UsageCredential | null, provenance?: CredentialProvenance) => Promise<void>;
};

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

export function createCredstore(
  helperPath: string,
  run: CredstoreRunner = spawnRunner(helperPath),
): Credstore {
  return {
    async get() {
      const { code, stdout } = await run(["get"]);
      if (code === 3) return null; // NoEntry
      if (code !== 0) throw new Error(`credstore get failed (exit ${code})`);
      try {
        const parsed = storedUsageCredentialSchema.safeParse(JSON.parse(stdout));
        return parsed.success ? parsed.data : null;
      } catch {
        return null; // corrupt keychain value — treat as not configured
      }
    },
    async set(cred) {
      if (cred === null) {
        const { code } = await run(["delete"]);
        if (code !== 0) throw new Error(`credstore delete failed (exit ${code})`);
        return;
      }
      const value: UsageCredential = { sessionKey: cred.sessionKey };
      const { code } = await run(["set"], JSON.stringify(value));
      if (code !== 0) throw new Error(`credstore set failed (exit ${code})`);
    },
  };
}

// Fallback, off Linux, when no helper binary is found (a dev box without
// cargo): the hub still runs, the credential is memory-only — exactly
// ADR-0035's rejected-as-end-state but acceptable-as-degraded mode (a client
// re-push re-arms it). A Linux Hub never falls back to it (ADR-0126 §1).
// `initial` seeds it (tests: a pre-#283 entry for the boot migration).
export function createMemoryCredstore(initial: StoredUsageCredential | null = null): Credstore {
  let held: StoredUsageCredential | null = initial;
  return {
    get: () => Promise.resolve(held),
    set: (cred) => {
      held = cred === null ? null : { sessionKey: cred.sessionKey };
      return Promise.resolve();
    },
  };
}

const MEMORY_ONLY =
  "[hub] no credstore helper found — credential will be memory-only (set MAXPRICE_CREDSTORE_PATH or build credstore/)";

export type OpenCredstoreOptions = {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  // The file store's status line (stdout).
  log: (line: string) => void;
  // The file store's tighten and skip lines, and the memory-only warning
  // (stderr).
  warn: (line: string) => void;
};

// serve's store for the key (ADR-0126 §1). The platform decides, not
// headlessness: on Linux every Hub, an embedded one run from source included,
// keeps its key in `<data dir>/secrets.json`, and never resolves the helper,
// MAXPRICE_CREDSTORE_PATH included, nor falls back to memory, since the
// helper's keyring there loses the key at a reboot or refuses every write
// (#450). Elsewhere, as before: the helper, else memory with a warning.
export function openCredstore(
  dataDir: string,
  { platform = process.platform, env = process.env, log, warn }: OpenCredstoreOptions,
): Credstore {
  if (platform === "linux") return createFileCredstore(secretsPath(dataDir), { log, warn });
  const helper = resolveCredstorePath(env);
  if (helper !== null) return createCredstore(helper);
  warn(MEMORY_ONLY);
  return createMemoryCredstore();
}
