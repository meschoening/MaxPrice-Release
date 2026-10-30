// The systemd tools a headless product's `service` verbs run, and what they
// read from their output (ADR-0120 §5, ADR-0127 §6, §11). Each tool is found
// on the PATH of the environment the caller passes and runs with that
// environment alone, so a test's fake tools are the only ones it can reach.
//
// Reachable only via the "./systemctl" subpath, never index.ts.

import { constants } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { type Env, home } from "./home-path";

export type Tool = "systemctl" | "journalctl" | "loginctl";

export type Ran = { code: number; stdout: string; stderr: string };

// Where `tool` is on `env`'s PATH, or null. Never the process's own PATH.
export function locate(tool: Tool, env: Env): string | null {
  return Bun.which(tool, { PATH: env.PATH ?? "" });
}

// Runs `tool` to its end and returns what it wrote. A tool missing from PATH
// is code 127, as a shell reports it.
export async function runTool(tool: Tool, args: readonly string[], env: Env): Promise<Ran> {
  const path = locate(tool, env);
  if (path === null) return { code: 127, stdout: "", stderr: `${tool} is not on PATH` };
  const proc = Bun.spawn([path, ...args], {
    env: env as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

// Runs `tool` on this process's own stdin, stdout and stderr, as an exec
// would, and returns its exit code; null when it is not on PATH.
export async function execTool(
  tool: Tool,
  args: readonly string[],
  env: Env,
): Promise<number | null> {
  const path = locate(tool, env);
  if (path === null) return null;
  const proc = Bun.spawn([path, ...args], {
    env: env as Record<string, string>,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

// Why a run failed, as one line: the tool's first stderr line, or its code.
export function reason(ran: Ran): string {
  const line = ran.stderr
    .split("\n")
    .map((text) => text.trim())
    .find((text) => text !== "");
  return line ?? `exit ${ran.code}`;
}

// `systemctl show` and `loginctl show-user` print one `Key=Value` line per
// property. A key may repeat (one ExecStart line per command), so each maps
// to every value it had, in order.
export function parseProperties(text: string): Map<string, string[]> {
  const properties = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at);
    const values = properties.get(key) ?? [];
    values.push(line.slice(at + 1));
    properties.set(key, values);
  }
  return properties;
}

// The value `systemctl show` gave `key`, its first if it repeats, or "".
export function property(properties: Map<string, string[]>, key: string): string {
  return properties.get(key)?.[0] ?? "";
}

// The C escapes systemd's cescape writes for a control character or a byte
// above ASCII: a letter, three octal digits, or `x` and two hex digits.
const LETTER_ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };

// A string-array property as systemd's shell_maybe_quote leaves it:
// bare, or double-quoted with a backslash before `"`, `\`, `` ` `` and `$`
// and a C escape for a control character or a byte above ASCII. Escapes
// decode to bytes, so an escaped UTF-8 sequence becomes its character again.
function parseWords(value: string): string[] {
  const chars = Array.from(value);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const words: string[] = [];
  let bytes: number[] | null = null;
  let quoted = false;
  const add = (...more: number[]) => (bytes ??= []).push(...more);
  for (let at = 0; at < chars.length; at++) {
    const char = chars[at]!;
    if (char === "\\" && at + 1 < chars.length) {
      const next = chars[at + 1]!;
      const ahead = chars.slice(at + 1, at + 4).join("");
      const octal = /^[0-7]{3}$/.exec(ahead);
      const hex = /^x([0-9a-fA-F]{2})$/.exec(ahead);
      if (Object.hasOwn(LETTER_ESCAPES, next)) {
        add(LETTER_ESCAPES[next]!);
        at += 1;
      } else if (octal !== null) {
        add(parseInt(octal[0], 8));
        at += 3;
      } else if (hex !== null) {
        add(parseInt(hex[1]!, 16));
        at += 3;
      } else {
        add(...encoder.encode(next));
        at += 1;
      }
    } else if (char === '"') {
      bytes ??= [];
      quoted = !quoted;
    } else if (char === " " && !quoted) {
      if (bytes !== null) words.push(decoder.decode(new Uint8Array(bytes)));
      bytes = null;
    } else {
      add(...encoder.encode(char));
    }
  }
  if (bytes !== null) words.push(decoder.decode(new Uint8Array(bytes)));

  return words;
}

// The unit's Environment assignments, from its file and drop-ins. A later
// assignment wins, as in the unit.
export function parseEnvironment(value: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const assignment of parseWords(value)) {
    const at = assignment.indexOf("=");
    if (at > 0) vars[assignment.slice(0, at)] = assignment.slice(at + 1);
  }
  return vars;
}

// The data dir the unit's daemon serves: the product's `dataDir` over the
// unit's own `Environment` property, under this user's home. A variable the
// unit does not set is unset there, so the product's default fills it in,
// never the shell's value. A relative path the unit sets is read against the
// home directory, where the user manager runs a unit that sets no
// WorkingDirectory=. A WorkingDirectory= the unit sets is not read, as the
// manager's own environment, which environment.d can set, is not (ADR-0120
// §5). `service status` compares it with the shell's.
export function unitDataDir(
  dataDir: (env: Env, cwd: string) => string,
  properties: Map<string, string[]>,
  env: Env,
): string {
  return dataDir(
    { ...parseEnvironment(property(properties, "Environment")), HOME: env.HOME },
    home(env),
  );
}

// Manager UnitPath is a shell-quoted string array, already in search order.
// In systemd >=249 the persistent config's systemd/user.control and its
// systemd/user sibling are both listed. The runtime pair shares its parent
// with systemd/transient: identify that from the manager's paths, since even
// XDG_RUNTIME_DIR in this shell may differ from the manager's environment.
// An override without this recognizable config pair has no answer here.
export function persistentUserUnitDir(value: string): string | null {
  const paths = parseWords(value);
  const listed = new Set(paths);
  return (
    paths.find(
      (path) =>
        isAbsolute(path) &&
        path.endsWith("/systemd/user") &&
        listed.has(path + ".control") &&
        !listed.has(join(dirname(path), "transient")),
    ) ?? null
  );
}

export type ExecCommand = { path: string; argv: string };

// One `ExecStart` value: `{ path=/x/maxprice ; argv[]=/x/maxprice serve ;
// ignore_errors=no ; … }`. `argv` is the arguments joined by spaces, as
// systemctl prints them.
export function parseExecStart(value: string): ExecCommand | null {
  const match = /^\{ path=(.*?) ; argv\[\]=(.*?) ; ignore_errors=/.exec(value);
  return match === null ? null : { path: match[1]!, argv: match[2]! };
}

// `ExecMainCode` is the waitid code of the main process's last exit:
// CLD_EXITED (1) with an exit status, CLD_KILLED (2) or CLD_DUMPED (3) with a
// signal number; 0 while it runs or before it ever ran.
export const CLD_EXITED = 1;
const CLD_KILLED = 2;
const CLD_DUMPED = 3;

function signalName(signal: number): string {
  const entry = Object.entries(constants.signals).find(([, value]) => value === signal);
  return entry === undefined ? `signal ${signal}` : entry[0];
}

// How the main process last ended, or null when it has not.
export function describeExit(code: number, status: number): string | null {
  if (code === CLD_EXITED) return `exit ${status}`;
  if (code === CLD_KILLED) return `killed by ${signalName(status)}`;
  if (code === CLD_DUMPED) return `killed by ${signalName(status)}, core dumped`;
  return null;
}
