import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { HUB_DEFAULT_PORT } from "@maxprice/shared";
import { displayPath, type Env } from "@maxprice/usage-core/home-path";
import { CliError, EXIT } from "./cli";
import { checkHubPageUrl } from "./page-url";

// Hub durable config (ADR-0035): hub.json in the hub's own data dir. It holds
// the OPTIONAL hub password's argon2id HASH (ADR-0037) — never a plaintext
// secret — the transport ACL (defense-in-depth on top of the tailnet), not the
// account credential; the claude.ai session key is kept apart from it, on
// Linux in the data dir's secrets.json (ADR-0126), elsewhere by the credstore
// keychain helper.

// The data dir. MAXPRICE_HUB_DATA_DIR wins everywhere; Windows and macOS keep
// their app-data dirs. Everywhere else, Linux above all, the dir holds the
// fleet archive and the usage history, which are data, so it follows
// XDG_DATA_HOME by the Headless client's rule (ADR-0127 §4, ADR-0119): a
// relative value is invalid and ignored, so a daemon and a command started
// from different working directories agree on one path. No Linux Hub shipped
// with the old `$XDG_CONFIG_HOME/maxprice-hub`, so nothing migrates.
export function defaultDataDir(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.MAXPRICE_HUB_DATA_DIR) return env.MAXPRICE_HUB_DATA_DIR;
  if (platform === "win32") {
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "maxprice-hub");
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "maxprice-hub");
  const xdg = env.XDG_DATA_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), "maxprice-hub");
}

// Whether the data dir holds a Hub: its hub.json, which only `serve` or
// `setup` creates, or `restore` copies from a backup (ADR-0127 §4, ADR-0128
// §2, ADR-0130). The commands that edit a Hub's files refuse a dir without
// one rather than conjure a fresh Hub out of a mistyped
// MAXPRICE_HUB_DATA_DIR; setup reads it as `(new)` (ADR-0128 §2).
export function hasHub(dataDir: string): boolean {
  return existsSync(join(dataDir, "hub.json"));
}

// The data dir of a command that acts on a Hub, the operator verbs, the
// password verbs, the key verbs and the page commands: exit 2 when it holds
// no hub.json, before
// the command prompts, reaches a daemon or creates anything (ADR-0127 §4).
export function requireHub(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const dataDir = defaultDataDir(env, platform);
  if (!hasHub(dataDir)) {
    throw new CliError(
      EXIT.USAGE,
      `no Hub at ${displayPath(dataDir, env)}; set MAXPRICE_HUB_DATA_DIR`,
    );
  }
  return dataDir;
}

// Per-field .catch() mirrors the Settings schema's recovery posture: one bad
// field degrades alone.
export const hubFileConfigSchema = z
  .object({
    port: z.number().int().min(1).max(65535).default(HUB_DEFAULT_PORT).catch(HUB_DEFAULT_PORT),
    // "tailnet" (default) | "loopback" | an explicit interface IP.
    bind: z.string().default("tailnet").catch("tailnet"),
    // argon2id hash of the optional hub password (ADR-0037); null = open (no
    // gate). Set via POST /api/password (console) or `maxprice-hub password set`.
    passwordHash: z.string().nullable().default(null).catch(null),
    // The Hub page URL (ADR-0125 §2): absent or null while unset. A value the
    // validator rejects degrades to null alone, like every other field; a valid
    // one is kept in its normalized form. Absent stays absent, so boot adds no
    // key and leaves a hub.json written before it as it was.
    pageUrl: z
      .string()
      .transform((value, ctx) => {
        const check = checkHubPageUrl(value);
        if (check.ok) return check.url;
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: check.reason });
        return z.NEVER;
      })
      .nullable()
      .optional()
      .catch(null),
  })
  .passthrough();
export type HubFileConfig = z.infer<typeof hubFileConfigSchema>;

// A short, cross-process lock for EVERY complete config read-modify-write,
// separate from serve.lock (which a daemon holds for its lifetime). SQLite's
// reserved lock works on Windows too and the OS releases it after a crash.
// The database stores no config or secrets; BEGIN IMMEDIATE only holds its
// writer lock. Never unlink it: that would let writers lock different files.
// A stuck writer fails its contender after a 1 s lock wait, without replacing
// hub.json. This synchronous bound also bounds a live password route's wait.
function withConfigWrite<T>(dataDir: string, update: () => T): T {
  const lock = new Database(join(dataDir, "hub.json.lock"), { create: true });
  try {
    lock.exec("PRAGMA busy_timeout = 1000");
    lock.exec("BEGIN IMMEDIATE");
    return update();
  } finally {
    // Closing rolls back the empty transaction and releases the lock, even
    // when reading, normalizing or replacing the config failed.
    lock.close();
  }
}

// Atomically persist the serialized config. writeFileSync is NOT atomic — a
// crash mid-write truncates hub.json, and the next boot's parse catch silently
// degrades to defaults (passwordHash null ⇒ a password-protected hub reopens on
// the tailnet, F9). So write a sibling .tmp and renameSync over hub.json —
// rename(2) is atomic on POSIX, and Windows renameSync replaces the existing
// target (MoveFileEx/ReplaceFile semantics), so a reader ever only sees a whole
// file, old or new. chmod the tmp to 0o600 on EVERY write: hub.json holds the
// password HASH (ADR-0037), and writeFileSync's `mode` option applies only at
// file CREATION — a no-op for a pre-existing hub.json (F19). chmod is a harmless
// no-op on Windows, where the tailnet + password remain the boundary. The tmp
// is named for the writing process: `page set|clear` write beside a running
// daemon's own writer (POST /api/password, ADR-0125 §3), and two writers
// sharing one tmp could each rename the other's file into place.
function writeConfig(path: string, serialized: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, serialized, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Already renamed, or an unwritable path: keep the original error.
    }
  }
}

// True when the raw parsed config carries a `passwordHash` field of the wrong
// type. The schema .catch(null)'s such a value to null silently — which would
// drop the gate without a trace — so we detect it here to warn + preserve.
function hasInvalidPasswordHash(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  if (!("passwordHash" in raw)) return false;
  const value = (raw as Record<string, unknown>).passwordHash;
  return value !== null && typeof value !== "string";
}

// Why hub.json's text cannot hold a Hub's config, and the words for it.
export type HubConfigProblem =
  | { kind: "not-json"; reason: "it was not valid JSON" }
  | { kind: "not-object"; reason: "it is not a JSON object" }
  | { kind: "password-hash"; reason: "its passwordHash field had an invalid type" };

// hub.json's text as the Hub reads it: the parsed value (`{}` when it is not
// JSON), and why it cannot hold a Hub's config, or null when it can. Boot and
// `restore` read it through this one check (ADR-0130 §2). Each problem would
// leave the Hub open: the schema has no gate to read from any of them.
export function parseHubConfigText(text: string): {
  raw: unknown;
  problem: HubConfigProblem | null;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { raw: {}, problem: { kind: "not-json", reason: "it was not valid JSON" } };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { raw, problem: { kind: "not-object", reason: "it is not a JSON object" } };
  }
  if (hasInvalidPasswordHash(raw)) {
    return {
      raw,
      problem: { kind: "password-hash", reason: "its passwordHash field had an invalid type" },
    };
  }
  return { raw, problem: null };
}

// Load hub.json, creating/normalizing it: at boot, once, before the server
// binds, and at setup's start (ADR-0128 §2). Synchronous. The data dir must
// exist: only `serve`, `setup` and `restore` make one (ADR-0127 §4, ADR-0128
// §2, ADR-0130), so a missing dir throws here rather than appear.
export function loadOrInitConfig(dataDir: string): HubFileConfig {
  return withConfigWrite(dataDir, () => loadConfigUnderLock(dataDir));
}

function loadConfigUnderLock(dataDir: string): HubFileConfig {
  const path = join(dataDir, "hub.json");

  // Distinguish "file missing" (first boot — silent) from "file present but
  // unreadable" (corrupt JSON / wrong-typed passwordHash — warn + preserve).
  let rawBytes: string | null = null;
  try {
    rawBytes = readFileSync(path, "utf8");
  } catch {
    // missing file — first boot; stays silent, defaults written below.
  }

  let raw: unknown = {};
  let recoveryReason: string | null = null;
  if (rawBytes !== null) {
    const { raw: parsed, problem } = parseHubConfigText(rawBytes);
    raw = parsed;
    // A JSON value that is no object holds no password hash to lose: boot
    // replaces it with the defaults below, silently, as it always has.
    // `restore` refuses it with the other two.
    recoveryReason = problem === null || problem.kind === "not-object" ? null : problem.reason;
  }

  if (recoveryReason !== null) {
    // F20a (warn + preserve; fail-closed was declined — the degrade-to-defaults
    // posture is retained by design). Copy the original bytes to hub.json.bak
    // BEFORE the rewrite clobbers them so the operator can recover the hash,
    // then warn loudly that the hub is coming up OPEN.
    try {
      const bak = `${path}.bak`;
      writeFileSync(bak, rawBytes ?? "");
      chmodSync(bak, 0o600);
    } catch {
      // best-effort — never block boot on the backup copy.
    }
    console.warn(
      `[hub] WARNING: could not restore hub.json (${recoveryReason}). The hub ` +
        `password gate could not be recovered and the hub is coming up OPEN on ` +
        `the tailnet. The original file was preserved at ${path}.bak — restore ` +
        `the passwordHash from it, then restart.`,
    );
  }

  const parsed = hubFileConfigSchema.safeParse(raw);
  const config = parsed.success ? parsed.data : hubFileConfigSchema.parse({});
  // ADR-0037: the pre-password minted bearer token is retired — strip a legacy
  // `token` field so .passthrough() doesn't carry the old secret forever.
  delete (config as Record<string, unknown>).token;

  // Skip the boot-time rewrite when the normalized config is byte-identical to
  // what was read — closes the every-boot exposure window of the old
  // unconditional writeFileSync (F9).
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (serialized !== rawBytes) {
    writeConfig(path, serialized);
  }
  return config;
}

// hub.json as it stands, read and never written, for `page` and `page
// snippet`: the parsed value, the config the schema makes of it (the defaults
// when it holds no object), and why it cannot hold a Hub's config, or null.
// A missing or unreadable file throws: the callers check hasHub first.
export function readHubConfig(dataDir: string): {
  raw: unknown;
  config: HubFileConfig;
  problem: HubConfigProblem | null;
} {
  const { raw, problem } = parseHubConfigText(readFileSync(join(dataDir, "hub.json"), "utf8"));
  const parsed = hubFileConfigSchema.safeParse(raw);
  return { raw, config: parsed.success ? parsed.data : hubFileConfigSchema.parse({}), problem };
}

// Set (a URL checkHubPageUrl accepted) or clear the Hub page URL: a
// read-modify-write beside a running Hub, which reads the key only for its
// boot log; every writer serializes its full update (ADR-0125 §3). A hub.json
// boot would degrade to the defaults is refused instead, with nothing
// written: a rewrite would drop the password hash under a running Hub.
export function saveHubPageUrl(dataDir: string, url: string | null): void {
  // Preserve the no-file/no-usable-config refusal without creating a lock
  // file. This preflight is never the snapshot used for a replacement.
  const { problem } = readHubConfig(dataDir);
  if (problem !== null) throw new Error(`hub.json cannot be updated: ${problem.reason}`);
  withConfigWrite(dataDir, () => {
    const { config, problem } = readHubConfig(dataDir);
    if (problem !== null) throw new Error(`hub.json cannot be updated: ${problem.reason}`);
    // As boot does (ADR-0037): the retired bearer token is not carried on.
    delete (config as Record<string, unknown>).token;
    if (url === null) delete config.pageUrl;
    else config.pageUrl = url;
    writeConfig(join(dataDir, "hub.json"), `${JSON.stringify(config, null, 2)}\n`);
  });
}

// Persist a new password hash (null = cleared) through the same normalize+write
// path as boot, into a data dir that exists. Read-modify-write is safe on
// Linux, where `password set|clear` write only while they hold serve.lock, so
// never beside a running Hub: they send it the change instead (ADR-0127 §3,
// §7). Page commands may still write beside either. Elsewhere password verbs
// take no serve.lock:
// a running daemon holds the config in memory, and applies their change only
// when it restarts.
// All platforms serialize the entire read-modify-write with boot and page
// changes, so each keeps unrelated fields from the preceding writer.
export function savePasswordHash(dataDir: string, hash: string | null): void {
  withConfigWrite(dataDir, () => {
    const config = loadConfigUnderLock(dataDir);
    config.passwordHash = hash;
    writeConfig(join(dataDir, "hub.json"), `${JSON.stringify(config, null, 2)}\n`);
  });
}
