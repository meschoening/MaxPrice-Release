// The systemd user unit a headless product's `service install` writes
// (ADR-0120 §4, ADR-0127 §5, §11): its text, a pure function of the
// product's descriptor, the command that starts it and the installing
// shell's environment and working directory. Each product passes its unit
// name, description, ExecStart arguments, the variables to bake and the
// exits systemd must not retry, as self-update.ts takes its product
// (ADR-0123 §9).
//
// Reachable only via the "./systemd-unit" subpath, never index.ts.

import { join, posix } from "node:path";

import { type Env, home } from "./home-path";

export type BakedVariable = {
  name: string;
  /**
   * `"one"`: the whole value is one path, made absolute against the
   * installing shell's directory when it is relative (MAXPRICE_HUB_DATA_DIR's
   * rule); a comma is part of it. `"list"`: a comma-separated list of paths,
   * each relative entry made absolute against that directory
   * (CLAUDE_CONFIG_DIR's rule). Otherwise the value is baked as it is.
   */
  path?: "one" | "list";
};

/** One headless product's user unit. */
export interface UserUnit {
  /** The binary, and every command a hint names: "maxprice". */
  name: string;
  /** "maxprice.service"; its stem is what `systemctl --user` hints name. */
  unit: string;
  /** Description=. */
  description: string;
  /** ExecStart's arguments after the command: ["serve"]. */
  execArgs: readonly string[];
  /** The variables baked in when the installing shell sets them. */
  baked: readonly BakedVariable[];
  /** serve's exit when another process holds the lock; first in RestartPreventExitStatus=. */
  lockedExit: number;
  /**
   * The line `service status` prints for a unit stopped on `lockedExit`.
   * By default another `serve` held the data dir; a product whose other
   * commands take the lock too names them.
   */
  lockedNote?: string;
  /**
   * serve's other exits a relaunch cannot fix, each with the line
   * `service status` prints for a unit stopped on it.
   */
  refusedExits: readonly { exit: number; note: string }[];
}

// The unit's name without `.service`, as `systemctl --user` commands name it.
export function unitStem(unit: UserUnit): string {
  return unit.unit.replace(/\.service$/, "");
}

// The command the unit runs, as messages name it: "maxprice serve".
export function serveCommand(unit: UserUnit): string {
  return [unit.name, ...unit.execArgs].join(" ");
}

// The exits systemd does not retry: the lock's, then each refused one.
export function preventedExits(unit: UserUnit): number[] {
  return [unit.lockedExit, ...unit.refusedExits.map(({ exit }) => exit)];
}

// The default systemd user unit path (ADR-0120 §4). A manager started with
// XDG_CONFIG_HOME uses that config home instead; a shell's value cannot tell
// us the manager's. Service verbs resolve its UnitPath and fall back here.
export function defaultUnitPath(unit: string, env: Env): string {
  return join(home(env), ".config", "systemd", "user", unit);
}

// The user manager never sees a shell's variables, so each the product names
// is baked when the installing shell sets it; an empty value counts as
// unset. A relative path names a dir under the shell's working directory,
// but the unit's daemon runs in the home directory, so it is made absolute
// against `cwd`: a single path whole, its commas and spaces included, and a
// path list entry by entry, the list staying comma-separated. An absolute
// path, and any other value, is baked as it is. The unit is a systemd
// artifact, so its paths are POSIX ones on any host, the Windows VM that
// runs these tests included.
export function bakedEnvironment(
  unit: UserUnit,
  env: Env,
  cwd: string,
): [name: string, value: string][] {
  return unit.baked.flatMap(({ name, path }) => {
    const value = env[name];
    if (!value) return [];
    if (path === "one") {
      const dir = posix.isAbsolute(value) ? value : posix.resolve(cwd, value);
      return [[name, dir] as [string, string]];
    }
    if (path !== "list") return [[name, value] as [string, string]];
    const dirs = value.split(",").map((dir) => {
      const trimmed = dir.trim();
      return trimmed === "" || posix.isAbsolute(trimmed) ? dir : posix.resolve(cwd, trimmed);
    });
    return [[name, dirs.join(",")] as [string, string]];
  });
}

const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;

// One word of a unit setting, as systemd's parser reads it back: `%` starts a
// specifier anywhere in the line, so it is doubled. A word with anything
// outside a plain path's characters is double-quoted, with C escapes for `\`,
// `"` and control characters, which systemd unescapes inside quotes.
function unitWord(word: string): string {
  const text = word.replaceAll("%", "%%");
  if (BARE.test(text)) return text;
  return `"${[...text].map(escapeQuoted).join("")}"`;
}

function escapeQuoted(char: string): string {
  if (char === "\\" || char === '"') return "\\" + char;
  if (char === "\n") return "\\n";
  if (char === "\t") return "\\t";
  const code = char.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return "\\x" + code.toString(16).padStart(2, "0");
  return char;
}

// In ExecStart's arguments `$` starts a variable, but the executable's path is
// never substituted, so a doubled `$$` would reach execve as written. The `:`
// prefix turns substitution off for the whole command instead, which keeps
// every `$` literal; it is used only when a word holds one.
export function execStartLine(unit: UserUnit, command: readonly string[]): string {
  const words = [...command, ...unit.execArgs];
  const prefix = words.some((word) => word.includes("$")) ? ":" : "";
  return `ExecStart=${prefix}${words.map(unitWord).join(" ")}`;
}

// `$` means nothing in Environment=.
export function environmentLine(name: string, value: string): string {
  return `Environment=${unitWord(`${name}=${value}`)}`;
}

// `command` starts this product: the compiled binary's absolute path, or bun
// and its entry when run from source.
export function unitText(
  unit: UserUnit,
  command: readonly string[],
  env: Env,
  cwd: string,
): string {
  return [
    `# Generated by \`${unit.name} service install\`, which rewrites this file.`,
    `# Customize it with \`systemctl --user edit ${unitStem(unit)}\`.`,
    "[Unit]",
    `Description=${unit.description}`,
    "StartLimitIntervalSec=15min",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=exec",
    execStartLine(unit, command),
    ...bakedEnvironment(unit, env, cwd).map(([name, value]) => environmentLine(name, value)),
    "Restart=on-failure",
    "RestartSec=10s",
    `RestartPreventExitStatus=${preventedExits(unit).join(" ")}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}
