import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { fleetCopySupersedes, fleetEventSchema, type FleetEvent } from "@maxprice/shared";
import { fleetEventKey, type LocalArchiveStore } from "@maxprice/usage-core";

// The Local archive's one-time move from JSONL to SQLite (ADR-0111 §6, #396).
// An older build kept the archive in `local-archive.jsonl`, an epoch header and
// one line per appended row, superseded copies included. The first open of the
// SQLite archive converts it once and deletes it. This module is the whole of
// that conversion: the release after it ships removes it (#397), and with it
// the archive's `importRows`.
//
// THE RULES. The JSONL store's own load rules decide what the live rows are:
// - the fullest copy per key under the one merge rule (ADR-0103), first-seen
//   on a tie, read in line order;
// - a torn tail (the last non-blank line, cut short by a crash mid-append) is
//   skipped, as the JSONL store skipped it;
// - a missing header is repaired: line 1 that is a row is read as one.
// Anything else that does not parse as a row fails the conversion. The JSONL
// store skipped such a line and counted it, but a conversion never skips valid
// history silently: the archive stays degraded with its JSONL untouched.
//
// THE INSTALL. The rows are written, in chunks that yield, into a fresh file
// beside the archive's path, and every live key's full row read back from it,
// unknown fields included, must equal the JSONL's. Only then is the file
// fsynced and renamed into place. The JSONL is deleted once the installed
// archive has loaded. A failure or a crash at any earlier point leaves the
// JSONL untouched and nothing at the archive's path, and the next open
// converts again. A crash after the rename leaves both files: the SQLite
// archive wins, and the JSONL is deleted once it has loaded.

/** The JSONL Local archive's basename, as builds before #396 wrote it. */
export const JSONL_LOCAL_ARCHIVE_FILE = "local-archive.jsonl";

/** A JSONL archive that cannot be converted as it stands. */
export class ArchiveConversionError extends Error {}

// Lines parsed, and rows written or verified, between yields to the event loop
// (ADR-0111 §6: the conversion yields as §3's reads do).
const CHUNK = 1_000;

// The epoch header, line 1 of every JSONL archive: an object carrying a string
// `epoch` and no `messageId`. Its value is inert and is not carried over.
function isHeader(line: string): boolean {
  try {
    const value: unknown = JSON.parse(line);
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { epoch?: unknown }).epoch === "string" &&
      !("messageId" in value)
    );
  } catch {
    return false;
  }
}

function parseRow(line: string): FleetEvent | null {
  try {
    const parsed = fleetEventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The JSONL archive's live rows, by dedup key, under its load rules (the
 * header above). Rejects with an `ArchiveConversionError` on a line that is
 * neither a row, the header nor the torn tail. `lines` counts the lines read.
 */
export async function readJsonlArchive(
  text: string,
): Promise<{ rows: Map<string, FleetEvent>; lines: number }> {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let tail = lines.length - 1;
  while (tail >= 0 && lines[tail]!.trim() === "") tail--;
  const rows = new Map<string, FleetEvent>();
  for (let i = lines.length > 0 && isHeader(lines[0]!) ? 1 : 0; i < lines.length; i++) {
    if (i % CHUNK === 0) await yieldToLoop();
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const row = parseRow(line);
    if (row === null) {
      if (i === tail) continue;
      throw new ArchiveConversionError(`line ${i + 1} of the JSONL archive is not a valid row`);
    }
    const key = fleetEventKey(row.messageId, row.requestId);
    const held = rows.get(key);
    if (held === undefined || fleetCopySupersedes(row, held)) rows.set(key, row);
  }
  return { rows, lines: lines.length };
}

/** Opens (creates if absent, then loads) a Local archive store at `path`. */
export type ArchiveOpener = (path: string) => Promise<LocalArchiveStore>;

export type ConversionOptions = {
  path: string; // the SQLite archive
  jsonlPath: string; // the JSONL archive an older build kept
  open: ArchiveOpener;
  // Test seam: runs after verification and the fsync, just before the rename.
  beforeInstall?: () => void;
  log?: (line: string) => void;
};

function removeWithCompanions(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(path + suffix, { force: true });
}

function fsyncFile(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Every live key's full row read back from `store` must equal the JSONL's
// (`Bun.deepEquals`, as `toEqual` compares: unknown fields included), and the
// store must hold no other row.
async function verify(store: LocalArchiveStore, live: Map<string, FleetEvent>): Promise<void> {
  let matched = 0;
  await store.readRows((rows) => {
    for (const row of rows) {
      const expected = live.get(fleetEventKey(row.messageId, row.requestId));
      if (expected === undefined || !Bun.deepEquals(row, expected))
        throw new ArchiveConversionError(
          `the converted row at seq ${row.seq} does not equal the JSONL archive's`,
        );
      matched++;
    }
  });
  if (matched !== live.size || store.size() !== live.size)
    throw new ArchiveConversionError(
      `the converted archive holds ${store.size()} rows, the JSONL archive ${live.size}`,
    );
}

// Converts the JSONL archive into a verified file at `path`. Rejects, leaving
// nothing at `path` and the JSONL untouched, on any failure.
async function convert(opts: ConversionOptions): Promise<void> {
  const started = performance.now();
  const fresh = `${opts.path}.converting`;
  removeWithCompanions(fresh); // an interrupted conversion's leftover
  const { rows: live, lines } = await readJsonlArchive(await readFile(opts.jsonlPath, "utf8"));
  let store: LocalArchiveStore | null = null;
  try {
    store = await opts.open(fresh);
    const ordered = [...live.values()].sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < ordered.length; i += CHUNK) {
      store.importRows(ordered.slice(i, i + CHUNK));
      await yieldToLoop();
    }
    await verify(store, live);
    const closing = store;
    store = null;
    await closing.close();
    // The last connection's close checkpoints the WAL into the file and
    // removes it. A WAL still holding frames would mean the renamed file lacks
    // rows, so the conversion stops short of the install.
    const wal = `${fresh}-wal`;
    if (existsSync(wal) && statSync(wal).size > 0)
      throw new ArchiveConversionError("the converted archive's WAL was not checkpointed");
    fsyncFile(fresh);
    opts.beforeInstall?.();
    renameSync(fresh, opts.path);
  } catch (err) {
    await store?.close();
    removeWithCompanions(fresh);
    throw err;
  }
  removeWithCompanions(fresh); // the WAL's empty companions, if any
  opts.log?.(
    `[sidecar] local archive converted from JSONL: ${live.size} rows from ${lines} lines in ${Math.round(performance.now() - started)} ms`,
  );
}

/**
 * Opens the SQLite Local archive at `path`, converting the JSONL one at
 * `jsonlPath` first when no SQLite archive exists yet. The JSONL is deleted
 * only after the SQLite archive loads. Rejects on a failed conversion or load,
 * with the JSONL untouched.
 */
export async function openConvertedArchive(opts: ConversionOptions): Promise<LocalArchiveStore> {
  if (!existsSync(opts.path) && existsSync(opts.jsonlPath)) await convert(opts);
  const store = await opts.open(opts.path);
  if (existsSync(opts.jsonlPath)) {
    try {
      rmSync(opts.jsonlPath, { force: true });
      opts.log?.("[sidecar] local archive: removed the converted JSONL archive");
    } catch (err) {
      // The archive is open and whole; the next open retries the delete.
      opts.log?.(`[sidecar] local archive: could not remove the converted JSONL archive: ${err}`);
    }
  }
  return store;
}
