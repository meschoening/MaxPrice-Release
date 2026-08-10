import { readdir, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import type { StorageCleanResponse, StorageReport, StorageSegment } from "@maxprice/shared";
import type { FleetEventStore } from "@maxprice/usage-core";
import {
  backedSessionsFromPaths,
  classifyUnbacked,
  type UnbackedSession,
} from "./storage-unbacked";

// The Settings › Storage measurement (map #124, tickets #126 / #131).
//
// WHAT IT MEASURES. Every byte MaxPrice put on this disk — the whole app-data
// directory, attributed into named segments with an `other` catch-all — plus
// the embedded-webview profile, which lives elsewhere on two of three platforms
// and is handed over by the Rust shell. Beside the bar it measures the Claude
// Code corpus, which is NOT ours: the app reads it and cannot delete a byte, so
// it is a context line rather than a segment.
//
// WHY IT WALKS RATHER THAN READING A CACHE. `ScanCacheEntry.size` was the
// tempting zero-IO shortcut and it is not a corpus measurement: the scan skips
// every non-`.jsonl` entry, drops files it failed to read, and holds sizes for
// PARSED TRANSCRIPTS rather than the directory's footprint. On the live corpus
// it knows 1414 files where the tree holds 2588. This number's whole job is to
// say honestly "the thing you cannot delete dwarfs everything below", so ~160 ms
// once per page visit is not a cost worth being wrong for (#126 §5).
//
// WHY IT NEVER TOUCHES `scan-gate.ts`. That gate serializes corpus RE-PARSES.
// Queueing a stat-only walk behind a 3.4 s cold parse would make the section
// feel broken for a reason that has nothing to do with it.
//
// DO NOT BLOCK THE LOOP. Async fs throughout, under a bounded worker pool — the
// sidecar's saturation detector trips at 30% `blockedPct` (ADR-0056) and this
// tree is ~3700 entries. Never `readdirSync`, never `Promise.all` over the
// whole file list. The pool is bounded by ONE shared token budget spanning both
// levels of the walk (directories AND files), so the in-flight ceiling really is
// `concurrency` rather than `concurrency²` — see `walkTree`.

// Basenames of the files main() writes beside `usage-history.jsonl`. Exported
// so main() JOINS THESE rather than repeating the literals: the segment
// attribution below is by basename, so a drift between the two would silently
// move a 40 MB file into `other`.
export const STORAGE_FILE = {
  fleetReplica: "fleet-events.jsonl",
  localArchive: "local-archive.jsonl",
  scanCache: "scan-cache.json",
  usageHistory: "usage-history.jsonl",
} as const;

// The durable log directory (ADR-0056) — the Rust shell owns the file, we only
// measure it.
export const STORAGE_LOGS_DIR = "logs";

// The 8-wide idiom the engine scan already uses: enough to overlap file IO with
// the single JS thread, few enough that the loop is never handed a corpus-sized
// batch of stat callbacks at once.
const WALK_CONCURRENCY = 8;

// One `readdir` with dirents, wrapped so `DirEntries` can name the type it
// infers: `readdir` is overloaded on its options, and a hand-written annotation
// picks the wrong arm.
function listDir(dir: string) {
  return readdir(dir, { withFileTypes: true });
}
type DirEntries = Awaited<ReturnType<typeof listDir>>;

// One directory tree's footprint. `errors` counts entries that could not be
// stat'd or listed BELOW the root — per-entry failures are skipped and counted,
// never fatal. A root that cannot be opened at all is reported separately (see
// `walkTree`'s null return), because that is the case the bar has to confess to.
export type WalkResult = { bytes: number; files: number; errors: number };

/**
 * Walk `root` recursively, summing regular-file bytes.
 *
 * Returns `null` when the ROOT ITSELF could not be listed — the caller decides
 * whether that means "absent" (this platform has no such thing) or
 * "unavailable" (it should be here and could not be read). Everything deeper is
 * best-effort: an unreadable subdirectory or a file that vanished mid-walk
 * increments `errors` and is skipped, so one bad entry can never collapse a
 * measurement to zero.
 *
 * Symlinks are counted as neither bytes nor files and never followed. They hold
 * no data of their own, and following them risks both double-counting (a link
 * back into the tree) and an unbounded walk.
 *
 * `onFile` receives every regular file's absolute path — the corpus walk uses it
 * to build the backed-session set from the SAME enumeration it measured, which
 * is what lets guard 1 vouch for the set it guards (#130 §1).
 *
 * `exclude` holds absolute directory paths to skip. On Linux the webview
 * profile's nine subdirectories live INSIDE our own app-data directory, so
 * without this the app-data walk and the webview walk would count the same
 * bytes twice (#125).
 *
 * `statImpl` / `listDirImpl` are TEST SEAMS, mirroring the repo's `nowImpl` /
 * `readFileImpl` pattern. `errors` is half of guard 1 (`corpus.errors` →
 * `scan.fileErrors` → the `scan-incomplete` block), and there is no portable way
 * to make a real temp-dir entry unstattable: a dangling symlink is skipped
 * before the stat, `chmod 0o000` is POSIX-only and a no-op for root, and a
 * conditionally-skipped test would cover nothing on the Windows primary where
 * releases are built. Injecting the failure is what lets the walk→guard boundary
 * be asserted at all.
 */
export async function walkTree(
  root: string,
  opts: {
    onFile?: (path: string) => void;
    exclude?: ReadonlySet<string>;
    concurrency?: number;
    statImpl?: (path: string) => Promise<{ size: number }>;
    listDirImpl?: (dir: string) => Promise<DirEntries>;
  } = {},
): Promise<WalkResult | null> {
  const concurrency = opts.concurrency ?? WALK_CONCURRENCY;
  const exclude = opts.exclude;
  const statOne = opts.statImpl ?? stat;
  const listOne = opts.listDirImpl ?? listDir;

  let rootEntries: DirEntries;
  try {
    rootEntries = await listOne(root);
  } catch {
    return null;
  }

  const result: WalkResult = { bytes: 0, files: 0, errors: 0 };

  // ONE shared in-flight budget, drawn from by BOTH levels. `take` is itself
  // called from up to `concurrency` directory workers, so a nested file pool
  // sized independently would put the real ceiling at `concurrency²` (64) while
  // the header comment promised 8. Instead a directory worker holds a token for
  // as long as it is working, and the file pool inside `take` may only open as
  // many workers as are left over. The case this exists for — one directory
  // holding thousands of files, which is exactly the WebView2 `Cache_Data`
  // profile that dominates the Windows bar — sees a single directory worker and
  // so gets the whole remaining budget for its files.
  let inFlight = 0;

  // Sum one directory's files and return its subdirectories. Two passes: dirents
  // are classified first, then the files are drained by the same index-taking
  // worker idiom the directory level uses. A plain `for` loop here stat'd every
  // file in a directory strictly serially, which made the widest directory in
  // the tree the whole walk's floor.
  const take = async (dir: string, dirents: DirEntries): Promise<string[]> => {
    const subdirs: string[] = [];
    const files: string[] = [];
    for (const dirent of dirents) {
      const path = join(dir, dirent.name);
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        if (exclude?.has(resolve(path)) === true) continue;
        subdirs.push(path);
        continue;
      }
      if (!dirent.isFile()) continue;
      files.push(path);
    }

    // One file: stat it, count it, announce it. The stat's `try` covers the
    // stat ALONE. It used to wrap `onFile` too, which meant a throwing callback
    // landed in the same `catch` AFTER bytes/files had been incremented — the
    // file was both counted and errored. A callback that throws is a bug in the
    // caller rather than an unreadable file, so it propagates rather than
    // inflating a filesystem-error count it has nothing to do with.
    const takeFile = async (path: string): Promise<void> => {
      let size: number;
      try {
        size = (await statOne(path)).size;
      } catch {
        result.errors += 1;
        return;
      }
      result.bytes += size;
      result.files += 1;
      // NOTE: `onFile` is called in COMPLETION order, not dirent order — the
      // file pool below interleaves. Order-independence is part of the callback
      // contract: `walkCorpus`, the only caller, pushes into an array consumed
      // as a Set, and its "did this root yield any transcript" check compares
      // lengths.
      opts.onFile?.(path);
    };

    let cursor = 0;
    const fileWorker = async (): Promise<void> => {
      while (cursor < files.length) {
        const path = files[cursor];
        cursor += 1;
        if (path === undefined) return;
        await takeFile(path);
      }
    };
    // At least one worker so a fully-booked budget still makes progress (that
    // degenerate case is exactly today's serial behaviour, never worse).
    const fileWorkers = Math.max(1, Math.min(concurrency - inFlight, files.length));
    if (files.length > 0) {
      await Promise.all(Array.from({ length: fileWorkers }, fileWorker));
    }
    return subdirs;
  };

  // Breadth-first, one depth level per round, each round drained by an
  // index-taking worker pool — the engine scan's idiom (`store.ts`). A queue
  // with idle workers spinning on a "is anyone still working?" flag was the
  // obvious alternative and is a trap here: those spins are microtasks, and a
  // microtask loop starves the macrotask queue outright, which is precisely the
  // loop-blocking this walk is bounded to avoid.
  let level = await take(root, rootEntries);
  while (level.length > 0) {
    const dirs = level;
    const next: string[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      inFlight += 1;
      try {
        while (cursor < dirs.length) {
          const dir = dirs[cursor];
          cursor += 1;
          if (dir === undefined) return;
          try {
            next.push(...(await take(dir, await listOne(dir))));
          } catch {
            // An unreadable subdirectory is one entry skipped, never fatal: a
            // single permissions failure deep in the tree must not collapse the
            // whole measurement to zero.
            result.errors += 1;
          }
        }
      } finally {
        inFlight -= 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, dirs.length) }, worker));
    level = next;
  }

  return result;
}

/**
 * Split MAXPRICE_WEBVIEW_PROFILE_DIR into paths.
 *
 * The env var is a path LIST joined by the platform delimiter, not a single
 * path: the profile is one directory on Windows, two on macOS and nine on Linux
 * (#125). Exported so main() calls THIS rather than inlining the split — the
 * inline copy and the test's copy of it could only agree by luck.
 */
export function parseWebviewProfileDirs(raw: string | undefined): string[] {
  return (raw ?? "").split(delimiter).filter((p) => p !== "");
}

// Everything the report needs that is not on disk. Accessors rather than
// snapshots throughout: a fleet rebuild swaps the replica and the settings
// watcher rewrites the roots, and this runs per request.
export type StorageReporterDeps = {
  // The directory holding every file the sidecar itself writes — `dirname` of
  // the usage-history path, which is also where settings.json and `logs/` sit
  // in the packaged app. Walked WHOLESALE, so a file a future feature adds is
  // visible in `other` rather than quietly missing from the total (#126 §7).
  appDataDir: string;
  // The embedded-webview profile, as a LIST. Resolved Rust-side and handed over
  // as MAXPRICE_WEBVIEW_PROFILE_DIR: the sidecar walks what it is given and
  // knows nothing about platforms. A list rather than one path because the
  // profile is not one directory everywhere — macOS splits WebsiteData from the
  // cache, Linux scatters nine subdirectories (#125). Empty ⇒ the segment is
  // ABSENT, which the schema defines as "does not apply here".
  webviewProfileDirs: readonly string[];
  // The watched Claude Code roots, live (the settings watcher reassigns them).
  getRoots: () => string[];
  // The fleet replica, or null when no hub is configured / the replica is off.
  // Null ⇒ `forget: null` — permanently absent from the UI, not disabled.
  getReplica: () => FleetEventStore | null;
  // The Local archive (ADR-0069), or null while degraded / not yet loaded.
  // Clean compacts it exactly as it compacts the replica; the preview folds its
  // superseded lines into the same "duplicated rows" numbers.
  getLocalArchive: () => FleetEventStore | null;
  selfMachineId: string;
  // The engine store's `ready`, as a synchronous boolean — guard 1's first
  // half. Read off the live status snapshot, which is the app's own answer to
  // "has the initial scan landed".
  engineReady: () => boolean;
  // Drop the parse cache THROUGH ITS OWNER, returning the bytes reclaimed.
  // Wired to the live `ScanCache.drop()`. Clean used to re-derive the path and
  // `rm` it itself, which raced the boot window: `wireScanCachePersist` fires
  // one `save()` on engineReady settle, `dirty` is true after a cold boot, so a
  // Clean during boot reported N bytes reclaimed and the file reappeared
  // seconds later. Only the object holding the in-memory copy can both delete
  // the file and stop the write that would restore it.
  dropScanCache: () => Promise<number>;
  concurrency?: number;
  // Test seam, handed to every `walkTree` this snapshot runs. It exists for one
  // assertion the suite could not otherwise make: that a per-file stat failure
  // during the CORPUS walk reaches guard 1 as `scan-incomplete`. Everything
  // between the counter and the guard is covered piecemeal; nothing crossed
  // that boundary, so a regression that stopped counting would have disabled
  // half of guard 1 with the suite green.
  statImpl?: (path: string) => Promise<{ size: number }>;
};

// What one measurement produces. The wire carries `report` only; `forgetSessions`
// is the full actionable list #128's route takes, kept beside it because the
// classifier produces both from one pass and the action endpoint (#132) needs
// the list measured at the same instant as the verdict that authorised it.
export type StorageSnapshot = {
  report: StorageReport;
  forgetSessions: readonly UnbackedSession[];
};

export type StorageReporter = {
  // Single-flight. Concurrent callers share one walk; a caller arriving after it
  // settles walks again. Deliberately NO cached result and no TTL: an action
  // must be followed by visibly moved numbers, so any cache would need busting
  // anyway — and a report that is always freshly measured cannot be caught
  // lying.
  read: () => Promise<StorageSnapshot>;
  // The safe action (#132). Lives here rather than in main() because it acts on
  // exactly the two things `read` measures for its `clean` preview, through the
  // same deps — the app-data path and the live replica accessor. Serialized
  // against itself; see `clean` below.
  clean: () => Promise<StorageCleanResponse>;
};

export function createStorageReporter(deps: StorageReporterDeps): StorageReporter {
  let inflight: Promise<StorageSnapshot> | null = null;
  // Cleans queue rather than share, unlike reads: a read is a pure measurement
  // that two callers may honestly split, while two overlapping cleans would both
  // claim the same bytes and the second would compact a file the first was
  // renaming. Queued, not dropped — a second click must not silently no-op.
  let cleanChain: Promise<StorageCleanResponse> | null = null;
  return {
    read: () =>
      (inflight ??= buildStorageSnapshot(deps).finally(() => {
        inflight = null;
      })),
    clean: () => {
      const next = (cleanChain ?? Promise.resolve(null))
        .catch(() => null)
        .then(() => cleanStorage(deps));
      cleanChain = next;
      return next;
    },
  };
}

/**
 * Drop the parse cache and compact both archives — the "Clean up" action.
 *
 * WHAT IT MAY TOUCH, exactly. `scan-cache.json` (ADR-0048), which is keyed
 * `(path, size, mtimeMs)` and rebuilt from the corpus on demand, and the
 * SUPERSEDED lines of `fleet-events.jsonl` and `local-archive.jsonl` — the ones
 * a later pull or a fuller re-parse replaced, which each store already accounts
 * as `garbageLines`. Nothing else, and in particular never a LIVE row of either:
 * the map's measurement found only ~1% of the replica literally duplicated, and
 * the live rows are precisely the history worth keeping. The Local archive
 * (ADR-0069) is the archive that arrived — this machine's own events, durably
 * held past the point Claude Code sweeps the transcripts that produced them —
 * and a replica's live self rows remain untouchable for a second reason of their
 * own: they are the pull cursor's substrate, so dropping one would silently
 * un-anchor the next pull. Deleting either would reclaim a few megabytes today
 * and silently destroy a month of history later. That is what "Forget" is for,
 * and why it is a separate button with a typed confirm.
 *
 * THE COST, stated because the UI states it. Dropping the parse cache buys the
 * user exactly one slower launch (~3.4 s cold re-parse on the measured corpus)
 * and nothing else. The file does not come back in this process — the cache
 * writes once, off `engineReady` (`wireScanCachePersist`), so an in-session
 * rescan re-parses into RAM without re-persisting; the next boot re-parses cold
 * and writes a fresh cache.
 *
 * FAILURE POSTURE. A missing scan cache is success with 0 bytes, not an error:
 * "already clean" is the ordinary second click. A cache that exists and cannot
 * be removed IS an error — the button promised bytes it did not deliver, and
 * reporting 0 would be indistinguishable from the benign case.
 *
 * WHY THE CACHE IS DROPPED THROUGH ITS OWNER. `deps.dropScanCache` is the live
 * `ScanCache`'s own `drop()`, not an `rm` of a re-derived path. The route has no
 * engine-ready gate by design, so a Clean can land inside the boot window — and
 * the one `save()` `wireScanCachePersist` fires on engineReady settle would then
 * write the in-memory cache straight back over the file we just reported
 * reclaiming. Deleting behind the owner's back is what made that possible.
 */
export async function cleanStorage(deps: StorageReporterDeps): Promise<StorageCleanResponse> {
  const scanCacheBytes = await deps.dropScanCache();

  // The replica half. Absent on a hub-less client, whose `clean` preview showed
  // the same zeroes — the wire shape does not change, so the renderer's
  // "and N duplicated rows" clause disappears for the same reason it never
  // appeared.
  const replica = deps.getReplica();
  let duplicateRows = 0;
  let duplicateBytes = 0;
  if (replica !== null) {
    const { droppedLines, freedBytes } = await replica.compact();
    duplicateRows = droppedLines;
    duplicateBytes = freedBytes;
  }

  // The Local archive half (ADR-0069 §9): an epoch-preserving rewrite with no
  // keep-filter — every live row survives, only superseded/torn lines drop.
  // freedBytes is read BEFORE the rewrite: reclaimableBytes is defined as
  // "current size minus what a rewrite would write", so it IS the delta.
  const localArchive = deps.getLocalArchive();
  if (localArchive !== null) {
    const freed = localArchive.reclaimableBytes();
    const { droppedLines } = await localArchive.rewrite({ newEpoch: false });
    duplicateRows += droppedLines;
    duplicateBytes += freed;
  }

  return {
    bytes: scanCacheBytes + duplicateBytes,
    scanCacheBytes,
    duplicateRows,
    duplicateBytes,
  };
}

export async function buildStorageSnapshot(deps: StorageReporterDeps): Promise<StorageSnapshot> {
  const roots = deps.getRoots();
  const webviewDirs = deps.webviewProfileDirs.map((p) => resolve(p));
  // Linux puts the webview profile inside our own app-data directory, so the
  // app-data walk must skip exactly those paths or the bytes land in BOTH the
  // `other` bucket and the webview segment. A no-op on Windows and macOS, where
  // the profile is elsewhere.
  const exclude = new Set(webviewDirs);

  // The two walks that matter run concurrently — they touch different trees and
  // the pool bounds each one independently.
  const [appData, webview, corpus] = await Promise.all([
    walkAppData(deps, exclude),
    walkWebview(webviewDirs, deps.concurrency, deps.statImpl),
    walkCorpus(roots, deps.concurrency, deps.statImpl),
  ]);

  const segments: StorageSegment[] = [];
  // ORDER IS THE WIRE'S (#127). The legend renders off this same array, so the
  // renderer never sorts it — and every segment MaxPrice cannot reclaim is
  // emitted LAST, which is why `webviewProfile` sits at the end rather than in
  // size order. The order is FIXED rather than size-ranked on purpose: a
  // size-ranked bar would reshuffle its colours the moment Clean emptied the
  // parse cache, so the picture would jump for a reason the user did not cause.
  if (appData.fleetReplica !== null) segments.push(appData.fleetReplica);
  if (appData.localArchive !== null) segments.push(appData.localArchive);
  if (appData.scanCache !== null) segments.push(appData.scanCache);
  if (appData.usageHistory !== null) segments.push(appData.usageHistory);
  if (appData.logs !== null) segments.push(appData.logs);
  if (appData.other !== null) segments.push(appData.other);
  if (webview !== null) segments.push(webview);

  const replica = deps.getReplica();
  const localArchive = deps.getLocalArchive();
  const scanCacheBytes = appData.scanCache?.state === "measured" ? appData.scanCache.bytes : 0;
  // Each archive's superseded lines and the bytes a compact would drop —
  // "literally duplicated", exactly. Both come from the store's own accounting
  // (`garbageLines` = valid lines on disk minus live keys; `reclaimableBytes` =
  // file size minus what a rewrite would write), so the preview is measured in
  // the units the archive accounts itself in rather than re-derived here. The
  // Local archive's numbers FOLD into the replica's (ADR-0069 §9) rather than
  // earning wire fields: it is the same kind of waste with the same remedy, and
  // the renderer's one "and N duplicated rows" clause covers both.
  const duplicateRows = (replica?.garbageLines() ?? 0) + (localArchive?.garbageLines() ?? 0);
  const duplicateBytes =
    (replica?.reclaimableBytes() ?? 0) + (localArchive?.reclaimableBytes() ?? 0);

  // The archive's left edge (issue #139) — the "Storing history back to <date>" line.
  //
  // A full pass over the archive's live rows, which is why it sits here rather
  // than on the status snapshot: this endpoint already walks ~3700 directory
  // entries under a bounded pool, so one RAM scan over rows the store is
  // already holding is far below its own noise floor. Anywhere cheaper (a
  // status field patched per append) would need the store to maintain a running
  // minimum across `rewrite`, which it has no reason to carry for one label.
  //
  // Lexicographic `<` on the ISO strings, matching the hub's own per-machine
  // stats join (`server.ts`, `lastEventAt`). Sound because every timestamp
  // reaching the archive is UTC-normalised by the parser; a mixed-offset corpus
  // would break both this and the hub identically.
  //
  // null on an empty or absent archive — see the wire field's comment for why
  // that draws nothing rather than an em dash.
  let localArchiveEarliestAt: string | null = null;
  if (localArchive !== null) {
    for (const row of localArchive.all()) {
      if (localArchiveEarliestAt === null || row.timestamp < localArchiveEarliestAt) {
        localArchiveEarliestAt = row.timestamp;
      }
    }
  }

  // Guard 1's error count is THIS walk's, not the engine scan's: a guard must
  // vouch for the enumeration that produced the set it guards (#130 §1). The
  // backed set likewise comes from the paths we just saw, never from the engine
  // store — whose event set never shrinks, so it would call a deleted session
  // backed forever and reduce Forget to a permanent no-op.
  const classification = classifyUnbacked({
    replicaAttached: replica !== null,
    rows: replica?.all() ?? [],
    selfMachineId: deps.selfMachineId,
    backed: corpus.backed,
    scan: { ready: deps.engineReady(), fileErrors: corpus.errors },
    roots,
    missingRoots: corpus.missingRoots,
    emptyRoots: corpus.emptyRoots,
  });

  return {
    report: {
      segments,
      corpus: {
        bytes: corpus.bytes,
        files: corpus.files,
        roots,
        missingRoots: corpus.missingRoots,
      },
      localArchiveEarliestAt,
      clean: {
        bytes: scanCacheBytes + duplicateBytes,
        scanCacheBytes,
        duplicateRows,
        duplicateBytes,
      },
      forget: classification.forget,
    },
    forgetSessions: classification.sessions,
  };
}

// The named segments carved out of one app-data walk. `null` = absent from the
// array entirely: on this install there is no such file, which the schema
// defines as "does not apply" and the section renders as nothing at all (a
// hub-less client has no replica; a never-cleaned install has no logs dir).
type AppDataSegments = {
  fleetReplica: StorageSegment | null;
  localArchive: StorageSegment | null;
  scanCache: StorageSegment | null;
  usageHistory: StorageSegment | null;
  logs: StorageSegment | null;
  other: StorageSegment | null;
};

async function walkAppData(
  deps: StorageReporterDeps,
  exclude: ReadonlySet<string>,
): Promise<AppDataSegments> {
  const empty: AppDataSegments = {
    fleetReplica: null,
    localArchive: null,
    scanCache: null,
    usageHistory: null,
    logs: null,
    other: null,
  };

  let entries: DirEntries;
  try {
    entries = await listDir(deps.appDataDir);
  } catch (err) {
    // The one directory we are certain we own could not be listed. Reporting
    // every segment as absent would draw a complete-looking empty bar, so the
    // catch-all carries the confession instead: `other` is `unavailable`, the
    // renderer says the total is incomplete, and no fabricated proportion is
    // shown for what we failed to measure.
    return { ...empty, other: { state: "unavailable", id: "other", detail: String(err) } };
  }

  const named = new Map<string, keyof AppDataSegments>([
    [STORAGE_FILE.fleetReplica, "fleetReplica"],
    [STORAGE_FILE.localArchive, "localArchive"],
    [STORAGE_FILE.scanCache, "scanCache"],
    [STORAGE_FILE.usageHistory, "usageHistory"],
  ]);

  const out: AppDataSegments = { ...empty };
  // Everything not named above — settings.json, machine-id, the machine and
  // identity directories, and whatever a future feature adds. The catch-all is
  // what keeps the total honest later: stat-ing only the files we thought to
  // name would let the bar drift quietly below the truth with nothing to reveal
  // it (#126 §7).
  let otherBytes = 0;
  let otherFiles = 0;
  let otherSeen = false;

  const subdirs: Array<{ name: string; path: string }> = [];

  for (const dirent of entries) {
    const path = join(deps.appDataDir, dirent.name);
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) {
      if (exclude.has(resolve(path))) continue;
      subdirs.push({ name: dirent.name, path });
      continue;
    }
    if (!dirent.isFile()) continue;
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      // A file that vanished between listing and stat. It cannot be attributed,
      // and it is one file: skip it rather than failing the whole bar.
      continue;
    }
    const slot = named.get(dirent.name);
    if (slot !== undefined) {
      out[slot] = { state: "measured", id: slot, bytes: size, files: 1 };
      continue;
    }
    otherBytes += size;
    otherFiles += 1;
    otherSeen = true;
  }

  // Subdirectories: `logs/` is its own segment, everything else folds into
  // `other` — including the loose Linux webview files that sit beside the nine
  // excluded directories. Counting those under "Other app files" overstates
  // that segment slightly on Linux and is the honest direction: the wholesale
  // walk cannot lose bytes, only attribute them coarsely.
  for (const dir of subdirs) {
    const walked = await walkTree(dir.path, {
      exclude,
      concurrency: deps.concurrency,
      statImpl: deps.statImpl,
    });
    if (dir.name === STORAGE_LOGS_DIR) {
      out.logs =
        walked === null
          ? { state: "unavailable", id: "logs", detail: `${dir.path} could not be read` }
          : { state: "measured", id: "logs", bytes: walked.bytes, files: walked.files };
      continue;
    }
    if (walked === null) continue;
    otherBytes += walked.bytes;
    otherFiles += walked.files;
    otherSeen = true;
  }

  // Emitted only when there is something to say. A measured `0 B / 0 files`
  // row would put a legend entry and a 3px floor segment on the bar for a thing
  // that does not exist.
  if (otherSeen) {
    out.other = { state: "measured", id: "other", bytes: otherBytes, files: otherFiles };
  }
  return out;
}

async function walkWebview(
  dirs: readonly string[],
  concurrency: number | undefined,
  statImpl: StorageReporterDeps["statImpl"],
): Promise<StorageSegment | null> {
  if (dirs.length === 0) return null;

  let bytes = 0;
  let files = 0;
  let measuredAny = false;
  const unreadable: string[] = [];

  for (const dir of dirs) {
    const walked = await walkTree(dir, { concurrency, statImpl });
    if (walked === null) {
      // Could be "this platform's arm does not exist on this install" or "we
      // were denied". `stat` tells the two apart: a path that is not there is
      // simply not part of this profile, and unset-or-missing ⇒ absent is the
      // contract (#126 §4).
      try {
        await stat(dir);
        unreadable.push(dir);
      } catch {
        // Not there. Nothing to confess.
      }
      continue;
    }
    measuredAny = true;
    bytes += walked.bytes;
    files += walked.files;
  }

  // A path we were denied outranks the partial sum: the profile is ~71% of the
  // bar on Windows, so a permissions failure that silently halved it would be
  // exactly the lie this section exists not to tell.
  if (unreadable.length > 0) {
    return {
      state: "unavailable",
      id: "webviewProfile",
      detail: `${unreadable.join(", ")} could not be read`,
    };
  }
  if (!measuredAny) return null;
  return { state: "measured", id: "webviewProfile", bytes, files };
}

type CorpusWalk = {
  bytes: number;
  files: number;
  errors: number;
  missingRoots: string[];
  // The subset of `missingRoots` that listed FINE and simply held no
  // transcripts. Sidecar-internal and deliberately not on the wire: the two
  // situations are one `roots-missing` block with one remedy shape, and the only
  // thing that differs is the sentence. Splitting the wire field would make the
  // renderer choose the wording, which is the sidecar's job here.
  emptyRoots: string[];
  backed: ReadonlySet<string>;
};

async function walkCorpus(
  roots: readonly string[],
  concurrency: number | undefined,
  statImpl: StorageReporterDeps["statImpl"],
): Promise<CorpusWalk> {
  const paths: string[] = [];
  let bytes = 0;
  let files = 0;
  let errors = 0;
  const missingRoots: string[] = [];
  const emptyRoots: string[] = [];

  for (const root of roots) {
    const before = paths.length;
    const walked = await walkTree(root, {
      onFile: (path) => {
        if (path.endsWith(".jsonl")) paths.push(path);
      },
      concurrency,
      statImpl,
    });
    if (walked === null) {
      missingRoots.push(root);
      continue;
    }
    bytes += walked.bytes;
    files += walked.files;
    errors += walked.errors;
    // "Missing" for guard 2's purposes means "backs nothing": a root that is
    // present but holds no transcripts makes every session under it look
    // unbacked exactly as a vanished one does, and it is the same thing to fix.
    // A readable-but-empty root is indistinguishable from a wiped or remounted
    // drive, and refusing is the conservative direction on an irreversible
    // action — so the block stays. What it earns is its OWN sentence, tracked
    // here and used for nothing else.
    if (paths.length === before) {
      missingRoots.push(root);
      emptyRoots.push(root);
    }
  }

  return {
    bytes,
    files,
    errors,
    missingRoots,
    emptyRoots,
    // ONE helper, shared with the classifier, so the two sides cannot drift on
    // the NUL-joined key (#130 §5).
    backed: backedSessionsFromPaths(paths, roots),
  };
}
