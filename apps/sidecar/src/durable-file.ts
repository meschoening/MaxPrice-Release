import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";

// The sidecar's durable JSON files (#651): a whole-file replace that survives
// a crash mid-write, and a load that keeps an unreadable file as `.bak` and
// starts empty. Shared by the Gateway evidence, pending and relay files and
// the fleet forget intent. The Hub keeps its own copies of the same mechanics
// (gateway-registry.ts, gateway-records.ts), following its directory-file
// pattern (the Membership assertion directory's), as the apps share no fs
// helper.

// A durable replace: the temp file written, fsynced, then renamed over
// `path`. Throws on failure, leaving `path` as it was.
export function writeDurably(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, text);
    const fd = openSync(temporary, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// Reads `path` as JSON against `schema`. Null when the file is missing (said
// nothing), cannot be read (warned), or does not parse (its bytes kept as
// `<path>.bak`, best-effort, and warned). `label` names the file in the
// warnings, e.g. `gateway-pending.json`.
export function loadDurably<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  label: string,
  warn: (line: string) => void = console.warn,
): z.infer<S> | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      warn(`[sidecar] ${label} could not be read; starting empty: ${String(err)}`);
    }
    return null;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (parsed.success) return parsed.data as z.infer<S>;
  } catch {
    // the recovery below
  }
  try {
    writeFileSync(`${path}.bak`, bytes);
  } catch {
    // best-effort
  }
  warn(`[sidecar] ${label} unreadable; starting empty (kept .bak)`);
  return null;
}
