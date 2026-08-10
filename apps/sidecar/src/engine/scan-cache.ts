import { rename, rm, stat, writeFile } from "node:fs/promises";
import { collectUsageRecords } from "./jsonl";
import { SCAN_CACHE_VERSION, type UsageRecord } from "./types";

// The on-disk parse cache (ADR-0048, startup-readiness T8).
//
// Cold-start's remaining cost after the T5 quick wins is parse+Zod on the
// *kept* lines — work whose input (the transcript files) rarely changes
// between boots. This cache persists each file's parsed `UsageRecord[]`
// (post-inclusion-filter, PRE-dedup) keyed by absolute path, so an unchanged
// file's records load with one native `JSON.parse` instead of a line-by-line
// JSON.parse + Zod pass. Dedup correctness is untouched by construction: the
// scan appends per-file arrays in readdir order exactly as before, and each
// array is byte-equivalent to what `collectUsageRecords` returned when the
// file was last parsed.

// One cached file: its freshness stamp + its parsed records. `size` catches
// nearly every change on append-only transcripts; `mtimeMs` backstops.
type ScanCacheEntry = {
  size: number;
  mtimeMs: number;
  records: UsageRecord[];
};

export type ScanCache = {
  // The scan's per-file read: stat → cache lookup → cached records on a
  // (size, mtimeMs) match, else `collectUsageRecords`. Either way the entry is
  // staged for the next `save`. Throws what stat/read throws — the scan
  // worker's per-file catch owns that failure, and a file that failed is
  // simply not staged (re-tried next boot).
  readRecords: (path: string) => Promise<UsageRecord[]>;
  // Atomically rewrite the cache file with every entry staged since process
  // start — files the scans of THIS process observed; entries for files no
  // longer present simply drop. tmp + rename, so a torn write never becomes
  // visible. A no-op boot — every file a cache hit, the file set unchanged —
  // skips the rewrite entirely.
  save: () => Promise<void>;
  // Delete the cache file and forget its contents, returning the bytes
  // reclaimed (0 when there was no file). The Settings › Storage "Clean up"
  // action's scan-cache half (#132) goes through HERE rather than `rm`-ing the
  // path itself: only the owner can also stop the pending `save` that would
  // write the in-memory copy straight back.
  drop: () => Promise<number>;
};

export function createScanCache(opts: { path: string }): ScanCache {
  const { path } = opts;

  // The on-disk snapshot, hydrated once per process (single-flight — the scan
  // pool calls readRecords 8-wide). Read-only after load; never mutated.
  let loadedPromise: Promise<Map<string, ScanCacheEntry>> | null = null;
  const loaded = (): Promise<Map<string, ScanCacheEntry>> => (loadedPromise ??= loadFromDisk(path));

  // Entries observed by this process's scans — what `save` writes. Checked
  // before `loaded` on lookup so a rescan sees this process's fresher parses.
  const staged = new Map<string, ScanCacheEntry>();

  // Did this process actually PARSE anything? A miss (a real re-parse) sets it;
  // a pure warm boot (every file a hit) leaves it false and `save` short-
  // circuits. A dropped file produces no miss, so `save` also compares key sets.
  let dirty = false;

  // Has `drop` run? STICKY, and that is a deliberate simplification rather than
  // a general policy: exactly one `save()` is wired today (`wireScanCachePersist`
  // fires it once, on engineReady settle), so "dropped forever" and "dropped
  // until the pending save" are the same object. If a future feature ever saves
  // more than once — a periodic persist, a post-rescan write — this flag should
  // become "suppress the NEXT save" and be cleared by the next real parse in
  // `readRecords`, because a process that keeps parsing after a Clean should be
  // allowed to rebuild the cache it was asked to discard.
  let dropped = false;

  async function readRecords(filePath: string): Promise<UsageRecord[]> {
    // Stat BEFORE read: if the file grows between the stat and the read, the
    // stored stamp is older than the records — a stale stamp re-parses next
    // boot (safe). Stat-after would stamp newer than the records and silently
    // trust a missing tail.
    const s = await stat(filePath);
    const hit = staged.get(filePath) ?? (await loaded()).get(filePath);
    if (hit !== undefined && hit.size === s.size && hit.mtimeMs === s.mtimeMs) {
      staged.set(filePath, hit);
      return hit.records;
    }
    // A miss means a real parse — the cache content changed, so mark dirty.
    dirty = true;
    const records = await collectUsageRecords(filePath);
    staged.set(filePath, { size: s.size, mtimeMs: s.mtimeMs, records });
    return records;
  }

  async function drop(): Promise<number> {
    // Flag FIRST: everything after this awaits, and a `save` that interleaved
    // would otherwise restore the file between the stat and the unlink.
    dropped = true;
    staged.clear();
    // Forget the on-disk snapshot too — it is gone, so a later `readRecords`
    // must re-parse rather than serve records from a cache that no longer
    // exists.
    loadedPromise = Promise.resolve(new Map());

    let bytes = 0;
    try {
      bytes = (await stat(path)).size;
    } catch {
      // Not there. Nothing to reclaim and nothing to report.
      bytes = 0;
    }
    // `force` so a file that vanished between the stat and here is not an error.
    // Anything else — a permissions failure, a lock — propagates: the button
    // promised bytes it did not deliver, and reporting 0 would be
    // indistinguishable from the benign case.
    await rm(path, { force: true });
    return bytes;
  }

  async function save(): Promise<void> {
    // Dropped: the user asked for this file to be gone, and it is. Writing the
    // in-memory copy back would undo a completed action.
    if (dropped) return;
    // Skip the rewrite when this boot changed nothing. A pure warm boot hits
    // the cache for every file (readRecords re-stages each hit), so `staged`
    // ends up equal to what we loaded — re-serializing and rewriting the whole
    // ~18MB cache would stall the just-booted event loop for zero gain. A real
    // change is either a parse (a miss set `dirty`) OR a differing key set: a
    // file dropped or added since last boot. A DROP produces no miss, so
    // `dirty` alone would miss it — compare the staged key set against the
    // loaded one (size-equal + every staged key present ⇒ identical sets).
    const loadedMap = await loaded();
    const changed =
      dirty || staged.size !== loadedMap.size || ![...staged.keys()].every((k) => loadedMap.has(k));
    if (!changed) return;

    const files: Record<string, ScanCacheEntry> = {};
    for (const [filePath, entry] of staged) files[filePath] = entry;
    const payload = JSON.stringify({ version: SCAN_CACHE_VERSION, files });
    // tmp + rename, no fsync: the atomic rename is the only durability property
    // that matters here — a torn tmp file never replaces the live cache. The
    // cache is disposable by contract (ADR-0048): a torn or lost cache is
    // detected on load (loadFromDisk's try/catch + version/shape sniff) and
    // discarded, worst case one slow boot. So we spend no disk flush on the hot
    // startup path, and the write is async so it never blocks in-flight
    // HTTP/SSE right after boot.
    const tmpPath = `${path}.tmp`;
    await writeFile(tmpPath, payload);
    await rename(tmpPath, path);
  }

  return { readRecords, save, drop };
}

// Hydrate the cache file. Any anomaly — missing file, unreadable JSON — yields
// an empty map: the scan falls back to a full parse (today's path) and the
// scan-end save rewrites a fresh cache. Worst outcome of any corruption is one
// slow boot.
async function loadFromDisk(path: string): Promise<Map<string, ScanCacheEntry>> {
  try {
    const text = await Bun.file(path).text();
    const parsed = JSON.parse(text) as { version?: unknown; files?: unknown };
    // Whole-cache version gate: the records were serialized under this
    // SCAN_CACHE_VERSION's parse semantics or they are worthless (see the
    // constant's review-discipline comment in types.ts).
    if (parsed.version !== SCAN_CACHE_VERSION) return new Map();
    if (typeof parsed.files !== "object" || parsed.files === null) return new Map();
    const files = parsed.files as Record<string, ScanCacheEntry>;
    const map = new Map(Object.entries(files));
    // Structural spot-check, NOT Zod (ADR-0048): re-validating ~50k records
    // would re-spend the seconds the cache exists to save. Per entry, sniff
    // the stamp types + the FIRST record's shape; any anomaly discards the
    // whole cache — the design's locked trust boundary is "spot-checks,
    // bounded by the full-rescan fallback", not per-record proof.
    for (const entry of map.values()) {
      if (!sniffsAsEntry(entry)) return new Map();
    }
    return map;
  } catch {
    return new Map();
  }
}

// One bounded per-entry shape check: numeric stamps, an array of records, and
// a first record that looks like a `UsageRecord`. O(files), never O(records).
function sniffsAsEntry(entry: ScanCacheEntry): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  if (typeof entry.size !== "number" || typeof entry.mtimeMs !== "number") return false;
  if (!Array.isArray(entry.records)) return false;
  const first = entry.records[0];
  if (first === undefined) return true; // an empty file's entry has no records
  return (
    typeof first === "object" &&
    first !== null &&
    typeof first.timestamp === "string" &&
    typeof first.messageId === "string" &&
    typeof first.model === "string" &&
    typeof first.inputTokens === "number" &&
    typeof first.outputTokens === "number"
  );
}
