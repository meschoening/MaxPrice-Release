import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { usageCredentialSchema, type UsageCredential } from "@maxprice/shared";

// TS face of the Rust keyring helper (see credstore/src/main.rs). The secret
// crosses process boundaries via stdin/stdout only. The helper inherits this
// process's env, so MAXPRICE_CREDSTORE_ACCOUNT (tests) flows through.

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

export type Credstore = {
  get: () => Promise<UsageCredential | null>;
  set: (cred: UsageCredential | null) => Promise<void>;
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
        const parsed = usageCredentialSchema.safeParse(JSON.parse(stdout));
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
      const { code } = await run(["set"], JSON.stringify(cred));
      if (code !== 0) throw new Error(`credstore set failed (exit ${code})`);
    },
  };
}

// Fallback when no helper binary is found (a dev box without cargo): the hub
// still runs, the credential is memory-only — exactly ADR-0035's rejected-as-
// end-state but acceptable-as-degraded mode (a client re-push re-arms it).
export function createMemoryCredstore(): Credstore {
  let held: UsageCredential | null = null;
  return {
    get: () => Promise.resolve(held),
    set: (cred) => {
      held = cred;
      return Promise.resolve();
    },
  };
}
