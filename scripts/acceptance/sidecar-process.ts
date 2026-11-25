// Spawns the REAL sidecar entry (`apps/sidecar/src/index.ts`) from one checkout,
// sandboxed, for the acceptance harness (#296).
//
// Sandboxing: the child gets a hand-built environment rather than the harness's
// own, so no inherited MAXPRICE_HUB_URL, MAXPRICE_AUTH_TOKEN or real
// CLAUDE_CONFIG_DIR can leak in. Its home directory, settings file and usage
// history all live under `dataDir`, so the real `~/.claude`, the real app-data
// directory and a real Hub are never read or written.
//
// Parent watchdog (ADR-0078): the sidecar arms a libc `getppid` watchdog on
// macOS and Linux that exits within 1 s of its parent dying. The harness IS the
// parent and outlives every child it starts, so the watchdog stays quiet and
// needs nothing from here; if the harness dies, the watchdog is what reaps the
// child. On Windows the watchdog is a no-op (no libc; the Job Object that covers
// it there is the Rust shell's), so a harness killed mid-run leaves its sidecars
// running. `stop()` and the CLI's `finally` are the only cleanup there.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PRICING_STARTUP_FETCH_ENV,
  PRICING_STARTUP_FETCH_SKIPPED_LINE,
} from "../../apps/sidecar/src/pricing-startup-seam";
import { clockEnv, type ClockOrigin } from "./clock";

export interface SidecarHandle {
  readonly url: string; // http://127.0.0.1:<port>
  readonly tree: string; // the checkout it runs from
  readonly dataDir: string;
  readonly log: () => string; // stdout+stderr captured so far
  /** stderr alone, in the order it was written: #404's GC log and markers, which a stdout chunk may not split. */
  readonly stderr: () => string;
  stop(): Promise<void>;
}

/**
 * What `startSidecar` needs. Before it spawns, it writes exactly these, and
 * only when their content would change (a file already holding the same bytes
 * is left alone), so a second boot with the same options on the same data
 * directory writes nothing:
 *   - the empty CLAUDE_CONFIG_DIR, `.claude/` in `<dataDir>`'s `home`, created if missing;
 *   - `<dataDir>/settings.json`, only when `settings` is given;
 *   - `<dataDir>/machine-id`, only when `machineId` is given.
 * Nothing else: no login file, no history, no archive. A caller booting an
 * existing data directory (#348's upgrade fixture) omits `settings` and
 * `machineId`, and the directory's own files are what the sidecar reads.
 */
export interface StartSidecarOptions {
  readonly tree: string; // checkout root (baseline or candidate)
  readonly dataDir: string; // holds settings.json, usage-history.jsonl, every data file
  /**
   * Written to `<dataDir>/settings.json` before spawn when given. Omitted, the
   * file is left exactly as it is (or absent, if it is).
   */
  readonly settings?: Record<string, unknown>;
  readonly clock: ClockOrigin;
  readonly env?: Record<string, string>; // e.g. MAXPRICE_CLAUDE_BASE_URL
  /**
   * Written to `<dataDir>/machine-id` before spawn when given. The sidecar
   * otherwise mints a random one per data directory (apps/sidecar/src/machine-id.ts),
   * and that id rides every per-machine body, so two sides would differ by
   * construction. One fixed id says what the comparison means: the same machine,
   * on two versions. Omitted, an existing file is left as it is.
   */
  readonly machineId?: string;
  /**
   * More `--preload` modules, after the clock and offline ones: #361's memory
   * sampler (`memory-preload.ts`). Omitted, the child gets exactly those two.
   */
  readonly preloads?: readonly string[];
  /**
   * Skip ADR-0096's startup pricing fetch (#353), whose `lastAttempt.at` each
   * side stamps from its own clock: two sides booted a step apart differ there
   * for good. Sets MAXPRICE_PRICING_STARTUP_FETCH=0 and requires the child to
   * acknowledge it on stderr; a tree older than the seam ignores the
   * variable, so it is stopped and the start throws. The two-sided scenarios
   * set it on every side; a single-tree or frozen-clock rig has nothing to
   * compare it with.
   */
  readonly skipStartupPricingFetch?: boolean;
  /**
   * How long the child has to announce its port (and, with
   * `skipStartupPricingFetch`, acknowledge the seam). Omitted, the
   * production bound `SIDECAR_STARTUP_TIMEOUT_MS`; a test that waits a refusal
   * out passes a shorter one.
   */
  readonly startupTimeoutMs?: number;
}

/**
 * Writes `text` to `path` unless the file already holds exactly that text.
 * Returns whether it wrote. The start functions write through this, so a
 * second boot on the same directory leaves every file untouched.
 */
export function writeFileIfChanged(path: string, text: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  writeFileSync(path, text);
  return true;
}

/**
 * Whether `tree` has #353's startup pricing seam, so `skipStartupPricingFetch`
 * can be set on a sidecar from it. A tree older than the seam (v0.7.1) cannot
 * acknowledge it; its startup fetch is refused by the offline guard instead.
 */
export function treeHasPricingSeam(tree: string): boolean {
  return existsSync(join(tree, "apps", "sidecar", "src", "pricing-startup-seam.ts"));
}

/**
 * Whether a tree's POST /api/usage/credential takes the whole keyset (#633,
 * ADR-0138 §6): `{ keys, legacy }`. Before it, the route took the stored blob
 * itself.
 */
export function treeTakesKeyset(tree: string): boolean {
  return readFileSync(join(tree, "apps", "sidecar", "src", "index.ts"), "utf8").includes(
    "usageKeysetSchema.safeParse",
  );
}

/**
 * The body a tree's renderer pushes for one stored blob (`{ sessionKey,
 * orgId? }`, the keychain slot): the blob itself before #633, the keyset with
 * the blob as its legacy key from #633 (the renderer's `keysetOfBlob`). So a
 * rig drives a baseline of either age as its own renderer would.
 */
export function credentialPushBody(
  tree: string,
  blob: { readonly sessionKey: string; readonly orgId?: string },
): string {
  if (!treeTakesKeyset(tree)) return JSON.stringify(blob);
  const legacy =
    blob.orgId === undefined
      ? { sessionKey: blob.sessionKey }
      : { sessionKey: blob.sessionKey, orgId: blob.orgId };
  return JSON.stringify({ keys: [], legacy });
}

/** How long the child has to print its `LISTENING <port>` line (ADR-0002). */
export const SIDECAR_STARTUP_TIMEOUT_MS = 20_000;

/** The one machine id every harness sidecar is given (see `machineId` above). */
export const ACCEPTANCE_MACHINE_ID = "00000000-0000-4000-8000-000000000296";

const CLOCK_PRELOAD = join(import.meta.dir, "clock-preload.ts");
const OFFLINE_PRELOAD = join(import.meta.dir, "offline-preload.ts");

/**
 * The keys that sandbox a child: where it finds its home, its data, its Claude
 * transcripts and its keychain, plus the three that make both sides comparable
 * (the shared clock, the time zone, and the startup pricing seam, which only
 * `skipStartupPricingFetch` sets, so it is never set unchecked). The harness
 * sets them itself (the Hub spawner adds MAXPRICE_HUB_DATA_DIR), and a caller's
 * `env` may set none of them, in any spelling: one override would point a
 * "sandboxed" process at real data. The platform data-directory keys
 * (APPDATA, LOCALAPPDATA, XDG_*) also point inside its synthetic HOME, as does
 * CLAUDE_CONFIG_DIR. The list also guards the credstore
 * helper's keychain account. Spelled in upper case; `sandboxEnv` compares a
 * caller's key upper-cased, because Windows environment names are
 * case-insensitive.
 */
export const SANDBOX_ENV_KEYS: readonly string[] = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "CLAUDE_CONFIG_DIR",
  "MAXPRICE_SETTINGS_PATH",
  "MAXPRICE_USAGE_HISTORY_PATH",
  "MAXPRICE_HUB_DATA_DIR",
  "MAXPRICE_CREDSTORE_PATH",
  "MAXPRICE_CREDSTORE_ACCOUNT",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  "MAXPRICE_ACCEPTANCE_CLOCK",
  "TZ",
  PRICING_STARTUP_FETCH_ENV,
];

/**
 * The child's whole environment. The Hub spawner (hub-process.ts) builds on the
 * same base. Throws, before anything is written or spawned, when `extra` sets a
 * SANDBOX_ENV_KEYS entry in ANY case: on Windows a child given both
 * `USERPROFILE` and `userprofile` reads the latter, and `homedir()` follows it,
 * so a lower-case key is the same override.
 */
export function sandboxEnv(
  dataDir: string,
  clock: ClockOrigin,
  extra: Record<string, string> = {},
): Record<string, string> {
  const overrides = Object.keys(extra).filter((key) =>
    SANDBOX_ENV_KEYS.includes(key.toUpperCase()),
  );
  if (overrides.length > 0) {
    throw new Error(
      `refusing to start a sandboxed process: env may not set ${overrides.join(", ")} ` +
        "(SANDBOX_ENV_KEYS: the harness owns where a child finds its home, data and keychain)",
    );
  }
  const home = join(dataDir, "home");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    TZ: "America/Chicago",
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    MAXPRICE_SETTINGS_PATH: join(dataDir, "settings.json"),
    MAXPRICE_USAGE_HISTORY_PATH: join(dataDir, "usage-history.jsonl"),
    // Empty, so the fallback watch roots are empty too: only `claudePaths` counts.
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    // Bun caches transpiled sources under `$HOME/.bun`, which is inside
    // `dataDir` here, and GET /api/storage walks `dataDir` wholesale: the cache
    // would show up as `other` bytes that depend on which tree's sources were
    // transpiled. "0" turns the cache off.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
  // Nothing else is inherited. Bun needs no SystemRoot, TEMP or TMP to bind,
  // fetch or mint UUIDs on Windows (checked with a bare `{ PATH }` child).
  return { ...env, ...clockEnv(clock), ...extra };
}

/**
 * Starts one sidecar and resolves once it has announced its port. Writes only
 * what `StartSidecarOptions` lists, and only after `sandboxEnv` has accepted the
 * caller's `env`.
 */
export async function startSidecar(opts: StartSidecarOptions): Promise<SidecarHandle> {
  const env: Record<string, string> = {
    ...sandboxEnv(opts.dataDir, opts.clock, opts.env),
    ...(opts.skipStartupPricingFetch === true ? { [PRICING_STARTUP_FETCH_ENV]: "0" } : {}),
  };
  mkdirSync(env.CLAUDE_CONFIG_DIR!, { recursive: true });
  if (opts.settings !== undefined) {
    writeFileIfChanged(env.MAXPRICE_SETTINGS_PATH!, `${JSON.stringify(opts.settings, null, 2)}\n`);
  }
  if (opts.machineId !== undefined) {
    writeFileIfChanged(join(opts.dataDir, "machine-id"), `${opts.machineId}\n`);
  }

  const child = await spawnAnnouncing({
    entry: join(opts.tree, "apps", "sidecar", "src", "index.ts"),
    cwd: opts.tree,
    env,
    what: `sidecar from ${opts.tree}`,
    timeoutMs: opts.startupTimeoutMs ?? SIDECAR_STARTUP_TIMEOUT_MS,
    preloads: opts.preloads,
    requiredStderrLine:
      opts.skipStartupPricingFetch === true ? PRICING_STARTUP_FETCH_SKIPPED_LINE : undefined,
  });
  return {
    url: `http://127.0.0.1:${child.port}`,
    tree: opts.tree,
    dataDir: opts.dataDir,
    log: child.log,
    stderr: child.stderr,
    stop: child.stop,
  };
}

/** A child spawned with the harness's preloads, both its pipes drained for its whole life. */
export interface PreloadedChild {
  readonly pid: number;
  /** Settles with its exit code once it has exited. */
  readonly exited: Promise<number>;
  readonly log: () => string; // stdout+stderr captured so far
  readonly stderr: () => string; // stderr alone
  stop(): Promise<void>;
}

/**
 * Spawns `bun --preload <clock> --preload <offline> [--preload <extra>...] <entry> [...args]`
 * and returns at once, waiting for nothing. Shared by `spawnAnnouncing` (the
 * sidecar's handshake) and the Hub spawner, which reads no handshake: a
 * Headless Hub prints no `LISTENING` line (ADR-0127 §9). So every child the
 * harness starts carries the same two preloads. `onStdout` and `onStderr` are
 * handed each chunk once it is captured.
 */
export function spawnPreloaded(opts: {
  readonly entry: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly preloads?: readonly string[];
  readonly onStdout?: (text: string) => void;
  readonly onStderr?: (text: string) => void;
}): PreloadedChild {
  const proc = Bun.spawn(
    [
      process.execPath,
      "--preload",
      CLOCK_PRELOAD,
      "--preload",
      OFFLINE_PRELOAD,
      ...(opts.preloads ?? []).flatMap((preload) => ["--preload", preload]),
      opts.entry,
      ...(opts.args ?? []),
    ],
    { cwd: opts.cwd, env: opts.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );

  let captured = "";
  let stderrCaptured = "";

  // Both pipes are drained for the child's whole life: an undrained pipe would
  // stall it once the OS buffer fills.
  const pump = async (
    stream: ReadableStream<Uint8Array>,
    onText: (text: string) => void,
  ): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) onText(decoder.decode(chunk, { stream: true }));
  };
  const drained = Promise.all([
    pump(proc.stdout, (text) => {
      captured += text;
      opts.onStdout?.(text);
    }),
    pump(proc.stderr, (text) => {
      captured += text;
      stderrCaptured += text;
      opts.onStderr?.(text);
    }),
  ]).catch(() => {
    // A pipe torn down by stop() ends the pump; there is nothing to report.
  });

  let stopped: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      proc.kill();
      await proc.exited;
      await drained;
    })();
    return stopped;
  };

  return {
    pid: proc.pid,
    exited: proc.exited,
    log: () => captured,
    stderr: () => stderrCaptured,
    stop,
  };
}

/** A child that has announced its port with `LISTENING <port>`. */
export interface AnnouncedChild {
  readonly port: number;
  readonly log: () => string; // stdout+stderr captured so far
  readonly stderr: () => string; // stderr alone
  stop(): Promise<void>;
}

/**
 * Spawns the child as `spawnPreloaded` does and resolves once a whole stdout
 * line reads `LISTENING <port>` (ADR-0002). A child that exits or stays silent
 * past `timeoutMs` is stopped, and the error carries its log.
 * When `requiredStderrLine` is set, both that whole line and the handshake
 * must arrive within the deadline. Their observation order is unspecified.
 */
export async function spawnAnnouncing(opts: {
  readonly entry: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly what: string; // for the error: "sidecar from <tree>"
  readonly timeoutMs: number;
  readonly preloads?: readonly string[];
  /** Require a whole diagnostic line too, within the same startup deadline. */
  readonly requiredStderrLine?: string;
}): Promise<AnnouncedChild> {
  let stdoutLine = "";
  let portSeen = false;
  let stderrLine = "";
  let acknowledged = opts.requiredStderrLine === undefined;
  let acknowledge: () => void = () => {};
  const acknowledgment = new Promise<void>((resolve) => {
    acknowledge = resolve;
    if (acknowledged) resolve();
  });
  let announce: (port: number) => void = () => {};
  const announced = new Promise<number>((resolve) => {
    announce = resolve;
  });

  const child = spawnPreloaded({
    entry: opts.entry,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env,
    preloads: opts.preloads,
    onStdout: (text) => {
      stdoutLine += text;
      // The handshake is a whole line. Older trees may have diagnostics here.
      let nl: number;
      while ((nl = stdoutLine.indexOf("\n")) !== -1) {
        const line = stdoutLine.slice(0, nl).trim();
        stdoutLine = stdoutLine.slice(nl + 1);
        const match = /^LISTENING (\d+)$/.exec(line);
        if (match !== null) {
          portSeen = true;
          announce(Number(match[1]));
        }
      }
    },
    onStderr: (text) => {
      stderrLine += text;
      let nl: number;
      while ((nl = stderrLine.indexOf("\n")) !== -1) {
        const line = stderrLine.slice(0, nl).replace(/\r$/, "");
        stderrLine = stderrLine.slice(nl + 1);
        if (line === opts.requiredStderrLine) {
          acknowledged = true;
          acknowledge();
        }
      }
    },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    // The producer flushes stderr before stdout, but independent pipe pumps
    // can observe either first. Require both, without trusting merged log order.
    Promise.all([announced, acknowledgment]).then(([port]) => ({ kind: "port" as const, port })),
    child.exited.then((code) => ({ kind: "exited" as const, code })),
    new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), opts.timeoutMs);
    }),
  ]);
  clearTimeout(timer);

  if (outcome.kind !== "port") {
    await child.stop();
    const why =
      outcome.kind === "exited"
        ? `exited with code ${outcome.code}`
        : portSeen
          ? `did not complete startup within ${opts.timeoutMs} ms`
          : `printed no LISTENING line within ${opts.timeoutMs} ms`;
    const seam = acknowledged
      ? ""
      : `; no stderr acknowledgment "${opts.requiredStderrLine}": use a tree supporting ${PRICING_STARTUP_FETCH_ENV}=0 (#353); it cannot be compared`;
    throw new Error(`${opts.what} ${why}${seam}. Its log:\n${child.log()}`);
  }

  return { port: outcome.port, log: child.log, stderr: child.stderr, stop: child.stop };
}
