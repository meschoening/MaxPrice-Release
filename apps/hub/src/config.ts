import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { HUB_DEFAULT_PORT } from "@maxprice/shared";

// Hub durable config (ADR-0035): hub.json in the hub's own data dir. It holds
// the OPTIONAL hub password's argon2id HASH (ADR-0037) — never a plaintext
// secret — the transport ACL (defense-in-depth on top of the tailnet), not the
// account credential; the claude.ai session key is what the credstore keychain
// helper guards.

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
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "maxprice-hub");
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
  })
  .passthrough();
export type HubFileConfig = z.infer<typeof hubFileConfigSchema>;

// Atomically persist the serialized config. writeFileSync is NOT atomic — a
// crash mid-write truncates hub.json, and the next boot's parse catch silently
// degrades to defaults (passwordHash null ⇒ a password-protected hub reopens on
// the tailnet, F9). So write a sibling .tmp and renameSync over hub.json —
// rename(2) is atomic on POSIX, and Windows renameSync replaces the existing
// target (MoveFileEx/ReplaceFile semantics), so a reader ever only sees a whole
// file, old or new. chmod the tmp to 0o600 on EVERY write: hub.json holds the
// password HASH (ADR-0037), and writeFileSync's `mode` option applies only at
// file CREATION — a no-op for a pre-existing hub.json (F19). chmod is a harmless
// no-op on Windows, where the tailnet + password remain the boundary.
function writeConfig(path: string, serialized: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serialized);
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
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

// Load hub.json, creating/normalizing it on boot. Synchronous — runs once
// before the server binds.
export function loadOrInitConfig(dataDir: string): HubFileConfig {
  mkdirSync(dataDir, { recursive: true });
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
    try {
      raw = JSON.parse(rawBytes);
      if (hasInvalidPasswordHash(raw)) {
        recoveryReason = "its passwordHash field had an invalid type";
      }
    } catch {
      recoveryReason = "it was not valid JSON";
    }
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

// Persist a new password hash (null = cleared) through the same normalize+write
// path as boot. Read-modify-write is safe: one daemon per data dir, and the CLI
// subcommands run against a stopped daemon (a RUNNING daemon holds config in
// memory — restart to apply CLI changes).
export function savePasswordHash(dataDir: string, hash: string | null): void {
  const config = loadOrInitConfig(dataDir);
  config.passwordHash = hash;
  writeConfig(join(dataDir, "hub.json"), `${JSON.stringify(config, null, 2)}\n`);
}
