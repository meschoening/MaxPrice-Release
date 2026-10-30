import { isAbsolute, join, resolve } from "node:path";
import type { Settings, WeekSetting } from "@maxprice/shared";
import { type CliError, usageError } from "./exit";

// The seven keys `maxprice settings get|set|unset` covers (ADR-0122 §4): each
// one's CLI name and file key, whether the daemon applies it live, how its
// value words become what the file stores, and how its effective value
// prints. Every other key in settings.json belongs to another command or to
// the Desktop client, and is unknown here.

// The keys of settings.json these seven write.
export type SettingFile =
  | "timezone"
  | "costMode"
  | "week"
  | "timeFormat"
  | "claudePaths"
  | "hubShareEvents"
  | "hubFleetReplica";

export type SettingValue = Settings[SettingFile];

export type ParseContext = {
  // The invoking shell's working directory: a relative claude path is made
  // absolute against it (ADR-0122 §5).
  cwd: string;
  // The file's schema reading. A Week set to rolling or limit-reset keeps the
  // stored weekday and time, as the file does while the mode is not custom
  // (`weekSettingSchema`'s comment).
  stored: Settings;
};

export type SettingKey = {
  name: string;
  file: SettingFile;
  // Whether the daemon applies a change live, so `set` and `unset` probe it.
  daemon: boolean;
  // The value words it takes, as the usage errors and the help name them.
  syntax: string;
  // The value to store, or a usage error (exit 2). The file's strict schema
  // must accept the value too (`settingValue` in settings.ts).
  parse: (words: readonly string[], context: ParseContext) => SettingValue;
  // The effective value, as `get` and `status` print it.
  format: (settings: Settings) => string;
};

const HELP = "maxprice settings --help";

export function settingsUsage(message: string): CliError {
  return usageError(message, HELP);
}

function takes(key: { name: string; syntax: string }, words: readonly string[]): CliError {
  const given = words.join(" ");
  return settingsUsage(`${key.name} takes ${key.syntax}${given === "" ? "" : `, not '${given}'`}`);
}

// One of `choices`, given as the only word.
function oneOf<T extends string>(
  key: { name: string; syntax: string },
  words: readonly string[],
  choices: readonly T[],
): T {
  const word = words.length === 1 ? words[0] : undefined;
  const choice = choices.find((candidate) => candidate === word);
  if (choice === undefined) throw takes(key, words);
  return choice;
}

function enumKey<F extends "costMode" | "timeFormat">(
  name: string,
  file: F,
  choices: readonly Settings[F][],
): SettingKey {
  const key = {
    name,
    file,
    daemon: false,
    syntax: `${choices.slice(0, -1).join(", ")} or ${choices.at(-1)}`,
  };
  return {
    ...key,
    parse: (words) => oneOf(key, words, choices),
    format: (settings) => settings[file],
  };
}

function switchKey(name: string, file: "hubShareEvents" | "hubFleetReplica"): SettingKey {
  const key = { name, file, daemon: true, syntax: "on or off" };
  return {
    ...key,
    parse: (words) => oneOf(key, words, ["on", "off"]) === "on",
    format: (settings) => (settings[file] ? "on" : "off"),
  };
}

// JS `getDay` numbering, as the Week stores it: 0 is Sunday.
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_LIST = `${DAYS.slice(0, -1).join(", ")} or ${DAYS.at(-1)}`;
// 24-hour, two digits each, as the Week stores it.
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const WEEK = {
  name: "week",
  file: "week",
  daemon: false,
  syntax: "rolling, limit-reset or custom <day> <HH:MM>",
} as const;

function parseWeek(words: readonly string[], { stored }: ParseContext): WeekSetting {
  // Joined and split again, so `custom mon 09:00` reads the same quoted.
  const parts = words.join(" ").split(/\s+/).filter(Boolean);
  const [mode, day, time] = parts;
  const carried = { weekday: stored.week.weekday, time: stored.week.time };
  if (parts.length === 1 && mode === "rolling") return { mode: "rolling", ...carried };
  if (parts.length === 1 && mode === "limit-reset") return { mode: "limitReset", ...carried };
  if (parts.length !== 3 || mode !== "custom" || day === undefined || time === undefined) {
    throw takes(WEEK, words);
  }
  const weekday = DAYS.findIndex((name) => name === day.toLowerCase());
  if (weekday === -1) throw settingsUsage(`week's day is ${DAY_LIST}, not '${day}'`);
  if (!TIME.test(time)) {
    throw settingsUsage(`week's time is HH:MM on a 24-hour clock, such as 09:00, not '${time}'`);
  }
  return { mode: "custom", weekday, time };
}

function formatWeek({ week }: Settings): string {
  switch (week.mode) {
    case "rolling":
      return "rolling";
    case "limitReset":
      return "limit-reset";
    case "custom":
      return `custom ${DAYS[week.weekday] ?? week.weekday} ${week.time}`;
  }
}

const CLAUDE_PATHS = {
  name: "claude-paths",
  file: "claudePaths",
  daemon: true,
  syntax: "one or more paths",
} as const;

// ADR-0122 §5: `~` and `~/…` stay literal, since the sidecar expands them
// against its own home; any other relative path is made absolute against the
// shell's cwd, which the daemon does not share.
function parseClaudePaths(words: readonly string[], { cwd }: ParseContext): string[] {
  if (words.length === 0 || words.includes("")) throw takes(CLAUDE_PATHS, words);
  return words.map((path) =>
    path === "~" || path.startsWith("~/") || isAbsolute(path) ? path : resolve(cwd, path),
  );
}

// A stored claude path as the sidecar expands it (`watch-roots.ts`), for the
// command's warning about a path that is no directory.
export function expandClaudePath(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

const TIMEZONE = {
  name: "timezone",
  file: "timezone",
  daemon: false,
  syntax: "an IANA time zone, such as Europe/Berlin",
} as const;

export const SETTING_KEYS: readonly SettingKey[] = [
  {
    ...TIMEZONE,
    // Kept as typed; the strict schema checks it is a zone.
    parse: (words) => {
      const [zone] = words;
      if (words.length !== 1 || zone === undefined || zone === "") throw takes(TIMEZONE, words);
      return zone;
    },
    format: (settings) => settings.timezone,
  },
  enumKey("cost-mode", "costMode", ["auto", "calculate", "display"]),
  { ...WEEK, parse: parseWeek, format: formatWeek },
  enumKey("time-format", "timeFormat", ["12h", "24h"]),
  {
    ...CLAUDE_PATHS,
    parse: parseClaudePaths,
    format: (settings) => settings.claudePaths.join(", "),
  },
  switchKey("share-events", "hubShareEvents"),
  switchKey("fleet-replica", "hubFleetReplica"),
];

function nameList(): string {
  const names = SETTING_KEYS.map((key) => key.name);
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// The key a command names, or a usage error listing the seven.
export function findSettingKey(name: string): SettingKey {
  const key = SETTING_KEYS.find((candidate) => candidate.name === name);
  if (key === undefined) {
    throw settingsUsage(`unknown setting '${name}'; the settings are ${nameList()}`);
  }
  return key;
}

// The `settings` key that writes a file key, or null for one another command
// owns.
export function settingKeyForFile(file: string): SettingKey | null {
  return SETTING_KEYS.find((key) => key.file === file) ?? null;
}
