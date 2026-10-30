import { chmodSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { displayPath, home } from "@maxprice/usage-core/home-path";
import { defaultUnitPath } from "@maxprice/usage-core/systemd-unit";
import { UNIT } from "./service/unit";

// Where the Headless client keeps its files, and the one maker of its data
// dir. Every function takes the environment it reads, or the dir it makes, so
// a test passes its own and none reads the real one. A home and the `~` form
// of a path are `@maxprice/usage-core/home-path`'s.

export type Env = Record<string, string | undefined>;

export { displayPath, home };

// $XDG_DATA_HOME, or ~/.local/share. The XDG Base Directory spec makes a
// relative value invalid, to be ignored, so a daemon and a command started
// from different working directories still agree on one path.
export function xdgDataHome(env: Env): string {
  const xdg = env.XDG_DATA_HOME;
  if (xdg && isAbsolute(xdg)) return xdg;
  return join(home(env), ".local", "share");
}

// The data dir: `${XDG_DATA_HOME:-~/.local/share}/maxprice` (ADR-0120, as
// amended by the route's Q21). The socket, the lock and every file the
// sidecar writes live in it (ADR-0119 §1).
export function dataDir(env: Env): string {
  return join(xdgDataHome(env), "maxprice");
}

// ADR-0119 §2's 0700 data dir, made here when a command writes before any
// `serve` has run. An existing one is left as it is: tightening it is
// `serve`'s job.
export function ensureDataDir(dir: string): void {
  if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) {
    // mkdir's mode is subject to the umask; chmod is not.
    chmodSync(dir, 0o700);
  }
}

export function socketPath(dir: string): string {
  return join(dir, "daemon.sock");
}

export function serveLockPath(dir: string): string {
  return join(dir, "serve.lock");
}

export function settingsPath(dir: string): string {
  return join(dir, "settings.json");
}

// The session key and the Hub password (ADR-0121 §1), never settings.json.
export function secretsPath(dir: string): string {
  return join(dir, "secrets.json");
}

// Every settings write takes it first (ADR-0122 §2).
export function settingsLockPath(dir: string): string {
  return join(dir, "settings.lock");
}

// The Desktop client's settings.json: Tauri's app_data_dir for the identifier
// `com.maxprice.desktop`, which follows XDG_DATA_HOME the same way. Read only
// for the double-join warning (ADR-0120 §6).
export function desktopSettingsPath(env: Env): string {
  return join(xdgDataHome(env), "com.maxprice.desktop", "settings.json");
}

// The default systemd user unit path (ADR-0120 §4), the shared module's for
// maxprice.service. A manager started with XDG_CONFIG_HOME uses that config
// home instead; a shell's value cannot tell us the manager's. Service verbs
// resolve its UnitPath and fall back to the same path; daemon-client uses
// only this cheap default-path check for its hints.
export function unitPath(env: Env): string {
  return defaultUnitPath(UNIT, env);
}
