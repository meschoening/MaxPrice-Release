import { existsSync, statSync } from "node:fs";
import { DEFAULT_SETTINGS, parseSettings } from "@maxprice/shared";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { connect } from "../daemon-client";
import { CliError, EXIT } from "../exit";
import type { Io, Parsed } from "../main";
import { dataDir, displayPath, type Env, home, settingsPath } from "../paths";
import { renderSettings } from "../render/settings";
import { terminalOutput } from "../render/table";
import { type EditOptions, editSettings, readSettingsObject, settingValue } from "../settings";
import { expandClaudePath, findSettingKey, SETTING_KEYS, settingsUsage } from "../settings-keys";

// `maxprice settings get|set|unset` (ADR-0122 §4): the seven settings the
// Headless client's user changes, in its own settings.json. `get` reads only
// the file. `set` and `unset` write it through `editSettings`, the one
// locked, sparse writer (§2), and never need the daemon: it applies a change
// through its own watch of the file (§1). For the three keys it applies live,
// they probe it afterwards (ADR-0119 §5), so a down daemon gets a note and a
// skewed one exit 4, the file written either way.

// What a test replaces; production passes none.
export type SettingsDeps = {
  // The shell's working directory, which a relative claude path is made
  // absolute against (ADR-0122 §5).
  cwd?: () => string;
  edit?: EditOptions;
};

function get(words: readonly string[], io: Io, env: Env): number {
  if (words.length > 1) throw settingsUsage("settings get takes one setting at most");
  const keys = words[0] === undefined ? SETTING_KEYS : [findSettingKey(words[0])];
  const raw = readSettingsObject(env);
  const path = displayPath(settingsPath(dataDir(env)), env);
  io.stdout.write(renderSettings({ path, raw, keys }, terminalOutput(io.stdout, env)));
  return EXIT.OK;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ADR-0122 §5: a claude path that is no directory is saved all the same, and
// said once, after the write.
function warnMissingDirs(paths: readonly string[], io: Io, env: Env): void {
  for (const path of paths) {
    if (isDirectory(expandClaudePath(path, home(env)))) continue;
    io.stderr.write(`maxprice: ${terminalText(path)} is not a directory; it is saved anyway\n`);
  }
}

// ADR-0122 §4, ADR-0119 §5: the change is in the file already, and a daemon
// that is up applies it through its watch. One that is down applies it when
// it starts, so that is a note and exit 0. A skewed daemon, or one that
// fails to answer, keeps its exit code and its hints, plus where the change
// is.
async function probe(io: Io, env: Env): Promise<void> {
  try {
    await connect({ env });
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    if (error.code === EXIT.NOT_RUNNING) {
      io.stderr.write("maxprice: the daemon is not running; the change applies when it starts\n");
      return;
    }
    const path = displayPath(settingsPath(dataDir(env)), env);
    throw new CliError(error.code, error.message, [
      ...error.hints,
      `The change is saved in ${path}.`,
    ]);
  }
}

async function set(
  words: readonly string[],
  io: Io,
  env: Env,
  deps: SettingsDeps,
): Promise<number> {
  const [name, ...given] = words;
  if (name === undefined) throw settingsUsage("settings set needs a setting and a value");
  const key = findSettingKey(name);
  if (given.length === 0) {
    throw settingsUsage(`settings set ${key.name} needs a value: ${key.syntax}`);
  }
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  // Checked before the lock, so a bad value exits 2 having written nothing,
  // not even the data dir.
  const checked = settingValue(key, given, { cwd, stored: DEFAULT_SETTINGS });
  const written = await editSettings(
    env,
    (raw) => {
      // Again against the file as read under the lock: a Week set to rolling
      // or limit-reset keeps the stored day and time.
      const value = settingValue(key, given, { cwd, stored: parseSettings(raw) });
      // The value already stored writes nothing (ADR-0122 §2 as amended).
      if (Object.hasOwn(raw, key.file) && Bun.deepEquals(raw[key.file], value)) return false;
      raw[key.file] = value;
      return true;
    },
    deps.edit,
  );
  // Only the Week reads what is stored, so these are the paths saved.
  if (key.file === "claudePaths" && Array.isArray(checked)) warnMissingDirs(checked, io, env);
  // Nothing written, nothing for the daemon to apply.
  if (written && key.daemon) await probe(io, env);
  return EXIT.OK;
}

async function unset(
  words: readonly string[],
  io: Io,
  env: Env,
  deps: SettingsDeps,
): Promise<number> {
  if (words.length > 1) throw settingsUsage("settings unset takes one setting");
  const name = words[0];
  if (name === undefined) throw settingsUsage("settings unset needs a setting");
  const key = findSettingKey(name);
  // No data dir, no file: every setting is already unset, and nothing is
  // made to say so.
  if (!existsSync(dataDir(env))) return EXIT.OK;
  const removed = await editSettings(
    env,
    (raw) => {
      if (!Object.hasOwn(raw, key.file)) return false;
      delete raw[key.file];
      return true;
    },
    deps.edit,
  );
  if (removed && key.daemon) await probe(io, env);
  return EXIT.OK;
}

export async function settings(
  parsed: Parsed,
  io: Io,
  env: Env = process.env,
  deps: SettingsDeps = {},
): Promise<number> {
  const [verb, ...rest] = parsed.positionals;
  switch (verb) {
    case undefined:
      throw settingsUsage("settings needs a command: get, set or unset");
    case "get":
      return get(rest, io, env);
    case "set":
      return await set(rest, io, env, deps);
    case "unset":
      return await unset(rest, io, env, deps);
    default:
      throw settingsUsage(`unknown settings command '${verb}'`);
  }
}
