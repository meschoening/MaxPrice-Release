// The secrets files' mechanics, one module for the headless products
// (ADR-0126 §10): the atomic 0600 write, the delete in place of an empty
// file, the read that changes nothing, and the boot's tighten-or-skip. The
// Headless client's `secrets.json` uses them (ADR-0121 §4–5), and the Headless
// Hub's `secrets.json` and `operator-token` are to. Each caller keeps its own
// schema.
//
// POSIX mechanics (modes, owners, a rename over a file) on synchronous
// `node:fs`, since both callers are Linux-only.
//
// No reason this module gives can carry any part of a value: an fs error is
// named by its errno code, never its message (which can be anything a fault
// says), and neither JSON.parse's message nor zod's ever reaches one, since
// both can quote the input. Callers put a reason in a log line or an error
// message as it is.
//
// Reachable only via the "./secrets-file" subpath, never index.ts, so reading
// a file does not load the poller or the hub client.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ZodIssue, ZodType, ZodTypeDef } from "zod";

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * An fs error as the callers' messages name it: its errno code, else "an
 * error", never its message, which is whatever the fault says.
 */
export function fsErrorName(error: unknown): string {
  return codeOf(error) ?? "an error";
}

// Best effort: the failure being thrown is the one worth reporting.
function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or the dir refuses: nothing more to do.
  }
}

/**
 * Writes `text` to `path` atomically, never loose: a uniquely named temp file
 * beside it (`.<name>.<pid>.<16 hex>.tmp`), created with mode 0600 rather
 * than chmodded after, written, fsynced, closed and renamed over `path`. A
 * reader sees the old file or the new one, never part of either. On any
 * failure the temp is removed and the error rethrown.
 */
export function writeSecretFile(path: string, text: string): void {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  // "wx": a name that exists is never followed or reused.
  const fd = openSync(temp, "wx", 0o600);
  let open = true;
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
    open = false;
    closeSync(fd);
    renameSync(temp, path);
  } catch (error) {
    if (open) closeSync(fd);
    unlinkQuietly(temp);
    throw error;
  }
}

/** Deletes `path`; an absent file is fine. Returns whether one was removed. */
export function removeSecretFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (codeOf(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * The file's entries, deleted rather than left as `{}` when there are none
 * (ADR-0121 §4). An undefined entry is none, as JSON drops it. Otherwise
 * indented JSON with a final newline, through `writeSecretFile`.
 */
export function writeSecretEntries(
  path: string,
  entries: Record<string, unknown>,
): "written" | "deleted" {
  if (Object.values(entries).every((value) => value === undefined)) {
    removeSecretFile(path);
    return "deleted";
  }
  writeSecretFile(path, JSON.stringify(entries, null, 2) + "\n");
  return "written";
}

export type SecretFileRead<T> =
  | { kind: "absent" }
  // `mode` is the permission bits, `& 0o777`.
  | { kind: "ok"; value: T; mode: number }
  // It cannot be opened or read, or it is not a regular file.
  | { kind: "unreadable"; reason: string }
  // Another uid owns it; it is not read.
  | { kind: "foreign"; uid: number; reason: string }
  // Not JSON, or the schema refused it.
  | { kind: "invalid"; reason: string };

export type SecretFileOptions = {
  // The uid the file must belong to; this process's by default. A test
  // passes another to make its own file a foreign one.
  uid?: number;
};

const NOT_REGULAR = "it is not a regular file";

function article(noun: string): string {
  return /^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`;
}

/**
 * Why the schema refused a file, from zod's first issue, built only from the
 * issue's path and code: never its message, nor a received value or an
 * unknown key's name, any of which could be a pasted secret. A path names
 * schema fields only for schemas whose object keys are fixed, so a secrets
 * schema has no `z.record`.
 */
export function describeSecretIssue(issue: ZodIssue | undefined): string {
  if (issue === undefined) return "the file is invalid";
  const where = issue.path.length === 0 ? "the file" : issue.path.join(".");
  switch (issue.code) {
    case "unrecognized_keys":
      return `${where} has an unknown field`;
    case "invalid_type":
      return issue.received === "undefined"
        ? `${where} is missing`
        : `${where} is not ${article(issue.expected)}`;
    case "too_small":
      return issue.type === "string" && Number(issue.minimum) === 1
        ? `${where} is empty`
        : `${where} is invalid`;
    case "invalid_string":
      return issue.validation === "datetime"
        ? `${where} is not an ISO timestamp`
        : `${where} is invalid`;
    default:
      return `${where} is invalid`;
  }
}

// Heard once a file that is ours and regular has been checked, before its
// bytes are read: the boot tightens it here.
type BeforeRead = (fd: number, mode: number) => number;

// The one open behind both reads. The ownership, the type, the mode and the
// bytes all come from this descriptor, so a file renamed over `path` meanwhile
// is never half of the answer. O_NONBLOCK: a FIFO in its place would
// otherwise hold the open until a writer came, and a boot would hang on it.
function examine<T>(
  path: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
  options: SecretFileOptions,
  beforeRead?: BeforeRead,
): SecretFileRead<T> {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: `cannot read it (${fsErrorName(error)})` };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { kind: "unreadable", reason: NOT_REGULAR };
    const uid = options.uid ?? process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
      return {
        kind: "foreign",
        uid: stat.uid,
        reason: `owned by uid ${stat.uid}, not this user (${uid})`,
      };
    }
    let mode = stat.mode & 0o777;
    if (beforeRead !== undefined) mode = beforeRead(fd, mode);
    let text: string;
    try {
      text = readFileSync(fd, "utf8");
    } catch (error) {
      return { kind: "unreadable", reason: `cannot read it (${fsErrorName(error)})` };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { kind: "invalid", reason: "it is not valid JSON" };
    }
    const result = schema.safeParse(raw);
    if (!result.success) {
      return { kind: "invalid", reason: describeSecretIssue(result.error.issues[0]) };
    }
    return { kind: "ok", value: result.data, mode };
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads and checks `path` without changing anything, for a command or a
 * status line. ENOENT is absent; a file that is not ours is not read.
 */
export function readSecretFile<T>(
  path: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
  options: SecretFileOptions = {},
): SecretFileRead<T> {
  return examine(path, schema, options);
}

function octal(mode: number): string {
  return "0" + mode.toString(8).padStart(3, "0");
}

/**
 * ADR-0121 §5 and ADR-0126 §5, at boot. A file that is ours and regular
 * with any group or other bit is tightened to 0600 on the descriptor and
 * logged, whatever it holds, since an invalid file can still hold a pasted
 * key; one that cannot be tightened is read as it is, since a loose file is
 * never refused. Then it is read. An unreadable, foreign or invalid file is
 * one `skipped` line and null; no file is null with no line. Never throws for
 * the file's state. `log` hears unprefixed lines; the caller prefixes them.
 */
export function loadSecretFileAtBoot<T>(
  path: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
  log: (line: string) => void,
  options: SecretFileOptions = {},
): T | null {
  const read = examine(path, schema, options, (fd, mode) => {
    if ((mode & 0o077) === 0) return mode;
    try {
      fchmodSync(fd, 0o600);
    } catch (error) {
      log(
        `cannot tighten ${path} from ${octal(mode)} to 0600 ` +
          `(${fsErrorName(error)}); reading it as it is`,
      );
      return mode;
    }
    log(`tightened ${path} from ${octal(mode)} to 0600`);
    return 0o600;
  });
  switch (read.kind) {
    case "ok":
      return read.value;
    case "absent":
      return null;
    default:
      log(`skipped ${path}: ${read.reason}`);
      return null;
  }
}
