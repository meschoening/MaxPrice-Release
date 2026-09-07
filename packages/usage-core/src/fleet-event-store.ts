import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { z } from "zod";
import {
  fleetDedupKey,
  fleetDedupTokenTotal,
  fleetEventSchema,
  type FleetEvent,
  type HubEventStamp,
  type StoredEventWire,
} from "@maxprice/shared";

// The fleet-event store (ADR-0041): the hub's archive of record — an
// append-only events.jsonl (line 1 = epoch header, rows = fleetEventSchema
// lines) mirrored fully in RAM. Append order = seq order: the file IS the
// replication log; replay at boot reproduces state and cursor together.
//
// HUB MODE (M4): mints seqs, enforces durability-before-visibility (no seq is
// observable outside the process before its line is fsync'd — push acks await
// the flush, page() serves only up to the durable watermark), and counts
// garbage/unreadable lines (skip-and-surface; never refuse to boot).
//
// REPLICA MODE (M5, ADR-0041 §3/§4): the CLIENT's disposable cache — a strict
// prefix-mirror of the hub log. `applyPage` is its ONLY writer; there is NO
// visibility barrier (RAM applies synchronously, disk writes ride the write
// chain fire-and-forget; `flush()` awaits them for tests). The pull cursor is
// DERIVED, never stored: at load = max parsed seq; at runtime = max seq seen in
// `applyPage` (ties/losers included, so a re-pulled overlap still advances; a
// crash re-derives a LOWER cursor from disk and the re-pull ties harmlessly).
// EPOCH: an empty replica has `epoch() === ""`; the first `applyPage` ADOPTS
// the hub's epoch (writes the header); a later `applyPage` with a different
// epoch returns "epoch-mismatch" WITHOUT mutating anything (the caller unlinks
// + reseeds). CORRUPTION is the INVERSION of the hub rule: a torn TAIL line
// skips silently (the derived cursor drops; the next pull re-covers), but a bad
// epoch header OR any non-tail unparseable line WIPES the whole file at load
// and the store comes up empty — a mid-file skip below the cursor would be a
// permanent silent gap. Rows persist verbatim; losers/ties are NOT appended (no
// disk growth on no-ops); replacements append (the superseded line becomes
// load-converging garbage, the hub-mode pattern). Keep this module free of any
// hub-app dependency (it is shared with the client replica).
//
// READING THE ARCHIVE AT LOAD (#85): only ENOENT means "fresh". Every other read
// error retries ONCE and then PROPAGATES — a transient fault must never be
// mistaken for an empty archive, because the fresh path mints an epoch, and
// minting one over a populated log restarts seqs into collisions and makes every
// client wipe its replica. The caller degrades the event surface instead (no
// `events` on HubStatus, 503 on the event + mutation routes) and the file is
// left byte-identical for the next boot. That propagation is HUB-ONLY: in
// REPLICA mode a still-unreadable cache WIPES instead, because `load()` must
// never reject there — it gates the client's `engineReady`, so a rejection would
// 500 every report for the process lifetime over a disposable file. Durable writes
// use a separate handle: `writeDurable` for the header/repair/hub rewrite,
// `writeCompactSnapshot` for the replica's batched asynchronous rewrite.
// They never use the append handle:
// the handle is opened lazily by the first push, so no `sync()` is ever issued
// against one that has not been written to.

// Line 1. Structurally distinct from event rows: no messageId/seq.
const epochHeaderSchema = z.object({ epoch: z.string() }).passthrough();

// The on-disk byte layout, defined ONCE. `rewrite` writes the archive with
// these; `reclaimableBytes` measures the post-compact size with them; the
// lazy live-row-bytes accumulator uses these same canonical lines, NEVER the
// source line lengths (escaping, whitespace and numeric spellings can differ).
function serializeHeader(epoch: string): string {
  return `${JSON.stringify({ epoch })}\n`;
}
function serializeLine(row: FleetEvent): string {
  return `${JSON.stringify(row)}\n`;
}

// The on-disk byte cost of ONE live row. Exported so a caller measuring a
// SUBSET of the archive — the unbacked-row classifier (#130), which reports the
// bytes a machine-scoped forget would drop — gets a figure that adds up under
// the same layout `reclaimableBytes` accounts in, rather than re-deriving the
// layout privately and drifting from it. Used by the running accumulator below
// too, so "defined ONCE" stays true.
export function fleetRowBytes(row: FleetEvent): number {
  return Buffer.byteLength(serializeLine(row));
}

// One transient-fault retry on the archive read at load, then degrade. See the
// classification in loadInner for why one and not a ladder.
const LOAD_READ_RETRIES = 1;
const LOAD_READ_RETRY_MS = 250;

// Write a file and make it durable, with no long-lived handle in the picture:
// writeFileSync then an explicit fsync on a freshly-opened fd. The three
// callers all need the same barrier for the same reason — a crash in the
// write→writeback window must not leave a truncated archive that the next boot
// mistakes for a fresh one (silent LOSS, not merely a re-minted epoch). Used
// for the fresh-archive header, the header repair's tmp file, and `rewrite`'s.
function writeDurable(target: string, contents: string): void {
  writeFileSync(target, contents);
  const fd = openSync(target, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

type CompactFile = Pick<FileHandle, "writeFile" | "sync" | "close">;

// Bound both serialization work and temporary strings. One oversized row is
// indivisible; otherwise a batch is at most 256 rows / ~256 KiB. writeFile
// handles short writes, sync preserves the durability-before-rename barrier,
// and the explicit macrotask yield also lets timers run on fast/cached IO.
async function writeCompactSnapshot(
  target: string,
  epoch: string,
  rows: readonly FleetEvent[],
  openFile: (path: string) => Promise<CompactFile>,
  serializeRow: (row: FleetEvent) => string,
): Promise<number> {
  const file = await openFile(target);
  let bytes = 0;
  try {
    let lines = [serializeHeader(epoch)];
    let batchBytes = Buffer.byteLength(lines[0]!);
    for (let i = 0; i < rows.length; i += 1) {
      const line = serializeRow(rows[i]!);
      lines.push(line);
      batchBytes += Buffer.byteLength(line);
      if (lines.length >= 256 || batchBytes >= 256 * 1024) {
        await file.writeFile(lines.join(""));
        bytes += batchBytes;
        lines = [];
        batchBytes = 0;
        await yieldToLoop();
      }
    }
    if (lines.length > 0) {
      await file.writeFile(lines.join(""));
      bytes += batchBytes;
    }
    await file.sync();
    return bytes;
  } finally {
    await file.close();
  }
}

export type FleetLogWriter = {
  append: (data: string) => Promise<void>;
  sync: () => Promise<void>;
  close: () => Promise<void>;
};

// Real writer: one append-mode FileHandle held for the store's lifetime.
// fh.sync() is fsync(2) — the durability barrier acks await.
export function createFleetLogWriter(path: string): FleetLogWriter {
  let handlePromise: Promise<FileHandle> | null = null;
  const handle = () => (handlePromise ??= open(path, "a"));
  return {
    append: async (data) => {
      await (await handle()).write(data);
    },
    sync: async () => {
      await (await handle()).sync();
    },
    close: async () => {
      if (handlePromise !== null) await (await handlePromise).close();
      handlePromise = null;
    },
  };
}

export type FleetEventPushResult = { epoch: string; added: number; stamps: HubEventStamp[] };
export type FleetEventPage = { epoch: string; seq: number; events: FleetEvent[] };

export type FleetEventStore = {
  ready: Promise<void>;
  load: () => Promise<void>;
  push: (rows: StoredEventWire[], machineId: string) => Promise<FleetEventPushResult>;
  page: (since: number, limit: number) => FleetEventPage;
  epoch: () => string;
  durableSeq: () => number;
  size: () => number;
  garbageLines: () => number;
  unreadableLines: () => number;
  fileBytes: () => number; // statSync size of the on-disk log; 0 when absent
  // Bytes a compact would free = fileBytes − (what rewrite would write). Exact,
  // not estimated: a compact re-serializes the live rows verbatim, so the
  // residual is precisely the superseded/unreadable/torn bytes that fall away.
  reclaimableBytes: () => number;
  lastAppendAt: () => string | null; // ISO of the last fsync'd push append THIS process; null at boot
  // Hub-mode only (M7): the purge/compact log rewrite — tmp + fsync + atomic
  // rename (the loadInner header-repair pattern), surviving seqs verbatim,
  // counter re-derived from the surviving max, concurrent pushes briefly
  // queued across the swap. newEpoch true mints a fresh epoch header (purge —
  // every client resyncs via the existing mismatch invariants); false keeps it
  // (compact — invisible on the wire, cursors survive). `keep` filters LIVE
  // rows (garbage + unreadable lines are always dropped); omitted = keep all.
  rewrite: (opts: {
    keep?: (row: FleetEvent) => boolean;
    newEpoch: boolean;
  }) => Promise<{ kept: number; droppedRows: number; droppedLines: number }>;
  flush: () => Promise<void>;
  close: () => Promise<void>;
  // Replica-mode methods (M5). `cursor`/`applyPage`/`unlink`/`compact` throw in
  // hub mode; `push`/`rewrite` throw in replica mode. `get`/`all` serve both.
  cursor: () => number; // the derived pull cursor — max seq SEEN
  get: (messageId: string, requestId: string | undefined) => FleetEvent | undefined;
  all: () => readonly FleetEvent[]; // seq-ascending internal refs — NEVER mutate
  // Retains row references. Callers must not mutate them (including nested
  // unknown fields); replacements arrive as new objects in a later page.
  applyPage: (rows: FleetEvent[], epoch: string) => "applied" | "epoch-mismatch";
  unlink: () => Promise<void>;
  // Replica-mode only: drop the superseded + torn lines from the cache file,
  // keeping every live row and the epoch. See `compact` below for why this is
  // not `rewrite`.
  compact: () => Promise<{ droppedLines: number; freedBytes: number }>;
};

// The ONE merge rule (dedup key + tie-breaker), defined once in
// `@maxprice/shared` (fleet-dedup.ts) and shared byte-for-byte with the engine
// store's private copy (apps/sidecar/src/engine/store.ts). Re-exported under
// these local names for event-sync's stamp predicate (Tasks 5/6) and the tests;
// the cross-store parity tests pin the invariant.
export const fleetEventKey = fleetDedupKey;
export const fleetTokenTotal = fleetDedupTokenTotal;

export function createFleetEventStore(opts: {
  path: string;
  mode: "hub" | "replica";
  writer?: FleetLogWriter;
  nowImpl?: () => string; // lastAppendAt stamps (hub mode); default ISO now
  // The archive read at load, seam-injected so tests can drive the failure
  // classification below (an ENOENT is a fresh archive; anything else must NOT
  // be mistaken for one). Same posture as `nowImpl` — a test hook, defaulted to
  // the real thing. Throw a `NodeJS.ErrnoException`-shaped error to simulate.
  readFileImpl?: (path: string) => string;
  retryDelayMs?: number; // the load-read retry pause, seam-injected beside readFileImpl so the failure tests don't sleep 250 ms of real time
  // Real async IO by default; tests hold/fail write + fsync to prove the
  // compact's swap barrier and races without sleeping or mocking node:fs.
  openCompactFileImpl?: (path: string) => Promise<CompactFile>;
}): FleetEventStore {
  const path = opts.path;
  const writer = opts.writer ?? createFleetLogWriter(path);
  const readFile = opts.readFileImpl ?? ((p: string) => readFileSync(p, "utf8"));
  const retryDelayMs = opts.retryDelayMs ?? LOAD_READ_RETRY_MS;
  const isReplica = opts.mode === "replica";
  const openCompactFile = opts.openCompactFileImpl ?? ((p: string) => open(p, "w"));

  const byKey = new Map<string, FleetEvent>();
  // Ascending-seq mirror for page(). Replacement splices the old seq out —
  // O(n), accepted at measured volumes (~12k rows/machine-month, ADR-0041).
  const bySeqAsc: FleetEvent[] = [];
  let epochId = "";
  let nextSeq = 1;
  // No seq observable outside the process before its line is fsync'd: page()
  // serves only rows with seq <= durable. Advanced post-sync by push (T3) and
  // at load (a loaded file is durable by definition). In replica mode `durable`
  // doubles as "max applied seq" — there is no visibility barrier, so it never
  // lags and page() still works in tests.
  let durable = 0;
  // The replica's derived pull cursor — max seq SEEN (ties/losers included).
  let cursorSeq = 0;
  let validLinesOnDisk = 0; // incl. superseded — garbage = this − live keys
  let unreadable = 0;
  // Replay needs membership and cursors, not storage hygiene (ADR-0094).
  // null means unmeasured: the FIRST reclaimableBytes call sums only surviving
  // rows. Thereafter every mutation maintains the sum and queries are O(1).
  // Cache costs by immutable row identity, including displaced incumbents held
  // for push rollback. Weak keys let dead rows go; nothing touches the wire.
  let liveRowBytes: number | null = null;
  let rowByteCosts = new WeakMap<FleetEvent, number>();
  let replicaGeneration = 0; // changes on wipe, even if the same epoch is re-adopted
  // Cumulative successful compact removals within a generation. A later
  // snapshot subtracts what earlier queued compacts have already removed.
  let compactedLines = 0;
  let compactedUnreadable = 0;
  // First append after loading a file with no trailing newline must start a
  // fresh line, or the torn tail would concatenate with the new row forever.
  let needsLeadingNewline = false;
  // Serializes disk writes (order = seq order on disk). Links swallow their
  // own error for flush(); push() awaits its OWN link's result (T3).
  let writeChain: Promise<void> = Promise.resolve();
  const now = opts.nowImpl ?? (() => new Date().toISOString());
  let lastAppend: string | null = null;
  // Pushes park here while a rewrite swaps the file (ADR-0041 M7: "pushes
  // briefly queued across the swap"). Set synchronously at rewrite entry so a
  // push arriving mid-rewrite cannot RAM-apply against a snapshot in flight.
  let rewriteGate: Promise<void> | null = null;

  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  // Binary search: first index in bySeqAsc with seq > target.
  function firstIndexAbove(target: number): number {
    let lo = 0;
    let hi = bySeqAsc.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (bySeqAsc[mid]!.seq <= target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function rowBytes(row: FleetEvent): number {
    const cached = rowByteCosts.get(row);
    if (cached !== undefined) return cached;
    const bytes = fleetRowBytes(row);
    rowByteCosts.set(row, bytes);
    return bytes;
  }

  // Appends and rewrites already need a canonical line. Retain its byte cost
  // so accounting never serializes the same row separately from that write.
  function serializeAccountedLine(row: FleetEvent): string {
    const line = serializeLine(row);
    rowByteCosts.set(row, Buffer.byteLength(line));
    return line;
  }

  function measuredLiveRowBytes(): number {
    if (liveRowBytes === null) {
      let bytes = 0;
      for (const row of bySeqAsc) bytes += rowBytes(row);
      liveRowBytes = bytes;
    }
    return liveRowBytes;
  }

  // Apply one already-stamped row to RAM (load replay + push apply share it).
  // Runtime writers collect winning lines here, after the shared merge check;
  // replay passes no collector and does no serialization while unmeasured.
  // Returns "new" | "replaced" | "lost".
  function applyRow(candidate: FleetEvent, appendLines?: string[]): "new" | "replaced" | "lost" {
    const key = fleetEventKey(candidate.messageId, candidate.requestId);
    const incumbent = byKey.get(key);
    if (incumbent !== undefined && fleetTokenTotal(incumbent) >= fleetTokenTotal(candidate))
      return "lost";
    if (appendLines !== undefined) appendLines.push(serializeAccountedLine(candidate));
    byKey.set(key, candidate);
    if (incumbent !== undefined) {
      const idx = firstIndexAbove(incumbent.seq) - 1;
      // idx points at incumbent.seq exactly (it is present by construction).
      bySeqAsc.splice(idx, 1);
      if (liveRowBytes !== null) liveRowBytes -= rowBytes(incumbent);
    }
    bySeqAsc.push(candidate); // seqs only ever grow — tail push keeps order
    if (liveRowBytes !== null) liveRowBytes += rowBytes(candidate);
    return incumbent === undefined ? "new" : "replaced";
  }

  // Drop the on-disk file AND all RAM state in one act, leaving the store empty
  // and immediately reusable (the next applyPage adopts a fresh epoch and the
  // writer lazily reopens the file). Replica-mode only: load calls it on
  // corruption (cache repair, not archive rescue), unlink queues it on the
  // write chain. Silent by design — a `force` rmSync never throws
  // on a present/absent file, so the catch fires only on a real IO fault.
  async function wipeAndReset(): Promise<void> {
    await writer.close();
    try {
      rmSync(path, { force: true });
    } catch (err) {
      console.warn("[usage-core] fleet replica wipe failed:", err);
    }
    byKey.clear();
    bySeqAsc.length = 0;
    liveRowBytes = 0;
    rowByteCosts = new WeakMap();
    replicaGeneration += 1;
    compactedLines = 0;
    compactedUnreadable = 0;
    epochId = "";
    nextSeq = 1;
    durable = 0;
    cursorSeq = 0;
    validLinesOnDisk = 0;
    unreadable = 0;
    needsLeadingNewline = false;
  }

  async function load(): Promise<void> {
    try {
      await loadInner();
    } finally {
      markReady();
    }
  }

  async function loadInner(): Promise<void> {
    // ENOENT — and ONLY ENOENT — means "fresh archive".
    //
    // This catch used to be bare, which made any transient read fault (EACCES,
    // EBUSY, EMFILE — an AV scanner holding the file is the everyday Windows
    // one) look like a brand-new archive on a POPULATED one. The hub then minted
    // a fresh epoch, appended that header to the END of the existing file, came
    // up with zero events in RAM, restarted nextSeq at 1 into seqs that collide
    // with the ones already on disk, and advertised the new epoch — so every
    // client saw a mismatch, wiped its replica, and reseeded from what looked
    // like an empty archive. Silent fleet-wide loss from a momentary IO blip,
    // and the exact inverse of the posture the rest of this module keeps.
    //
    // Anything that is not ENOENT now propagates, degrading the event surface
    // (runReadySequence catches it: no `events` on HubStatus, 503 on the event
    // and archive-mutation routes) and leaving the file untouched. Loud and
    // reversible beats quiet and destructive.
    //
    // ONE retry first, because that trade makes transient faults fatal to event
    // sync where they used to be (destructively) swallowed. One is the whole
    // ladder: `ready` gates every route (ADR-0047), and a backoff would delay
    // boot repeatedly for a fault that is probably permanent.
    let text: string | null = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        text = readFile(path);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          text = null;
          break;
        }
        if (attempt >= LOAD_READ_RETRIES) {
          // HUB: an unreadable archive of record must degrade loudly (the caller
          // strips `events` off HubStatus and 503s the event routes). REPLICA: the
          // file is a disposable cache and load() must never reject — a rejection
          // rides Promise.all into engineReady (apps/sidecar/src/index.ts) and 500s
          // every report for the process lifetime. Wipe instead: the next pull
          // reseeds from cursor 0, and unlike coming up empty on a file we still
          // can't read, this leaves nothing for applyPage to append a second epoch
          // header onto.
          if (!isReplica) throw err;
          console.warn("[usage-core] fleet replica read failed, wiping cache:", err);
          return wipeAndReset();
        }
        console.warn("[usage-core] fleet-event archive read failed, retrying:", err);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    if (text === null || text.trim() === "") {
      // A fresh replica mints NOTHING: epochId stays "" until the first
      // applyPage adopts the hub's epoch. Only the hub mints an epoch here (and
      // makes it durable BEFORE any ack can cite it).
      if (isReplica) return;
      epochId = crypto.randomUUID();
      // Deliberately NOT through the writer: this goes through `writeDurable`,
      // the same barrier the header repair and `rewrite` also use — one durable
      // write of ~40 bytes with no long-lived handle involved. The
      // append handle is therefore never opened during load at all — its first
      // use is a push against an existing, non-empty file.
      //
      // It also removes the call that #85 observed throwing: `fh.sync()` on a
      // never-yet-written append-mode handle raised EBADF once on Windows and
      // took event sync down for the whole session. That reproduction was never
      // pinned (300 fresh-dir iterations on bun 1.3.11/Win32 came back clean),
      // so this deletes the call rather than defending it.
      //
      // Safe to truncate: we are here only because the file is absent or blank.
      writeDurable(path, serializeHeader(epochId));
      return;
    }

    needsLeadingNewline = !text.endsWith("\n");
    const lines = text.split("\n");
    // Drop the final empty fragment from a trailing newline so "last line"
    // means the last REAL line (the torn-tail candidate).
    if (lines[lines.length - 1] === "") lines.pop();

    // Line 1: the epoch header. A valid header must parse AND not look like an
    // event row (an event row also parses as an object — the header is
    // structurally distinct by carrying `epoch` and no `messageId`).
    let firstEventLine = 1;
    let headerOk = false;
    try {
      const raw: unknown = JSON.parse(lines[0]!);
      const parsed = epochHeaderSchema.safeParse(raw);
      if (parsed.success && typeof raw === "object" && raw !== null && !("messageId" in raw)) {
        epochId = parsed.data.epoch;
        headerOk = true;
      }
    } catch {
      // header line unparseable — repaired below
    }
    if (!headerOk) {
      // A bad epoch header in a disposable cache is unrecoverable garbage: wipe
      // and come up empty. The hub instead repairs (archive posture) by
      // treating line 0 as an event line.
      if (isReplica) return wipeAndReset();
      firstEventLine = 0;
    }

    for (let i = firstEventLine; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      const isFinalLine = i === lines.length - 1;
      let parsedRow: FleetEvent | null = null;
      try {
        const parsed = fleetEventSchema.safeParse(JSON.parse(line));
        if (parsed.success) parsedRow = parsed.data;
      } catch {
        // fall through to the corruption classification below
      }
      if (parsedRow === null) {
        // The torn TAIL self-heals (never acked ⇒ origin re-pushes) — skip
        // uncounted, in BOTH modes (the replica's derived cursor drops and the
        // next pull re-covers). Anything mid-file was acked: for the hub archive
        // it is real loss, surface it; for the replica cache a below-cursor skip
        // would be a permanent silent gap, so wipe and re-pull from scratch.
        if (!isFinalLine) {
          if (isReplica) return wipeAndReset();
          unreadable += 1;
        }
        continue;
      }
      validLinesOnDisk += 1;
      applyRow(parsedRow);
      if (parsedRow.seq >= nextSeq) nextSeq = parsedRow.seq + 1;
    }
    durable = nextSeq - 1;
    // The replica's cursor is derived from the log it just replayed (no stored
    // watermark). It reuses `durable` as "max applied seq" — nothing lags it.
    cursorSeq = nextSeq - 1;

    if (!headerOk) {
      // Missing/corrupt header with surviving rows: mint fresh, keep EVERY
      // original byte (archive posture) — new header + original content
      // verbatim, tmp + atomic rename. Close the writer first: it may hold an
      // append handle on the old inode (and Windows blocks the rename).
      epochId = crypto.randomUUID();
      await writer.close();
      const tmpPath = `${path}.tmp`;
      // Durable BEFORE the rename (writeDurable's whole reason for existing).
      writeDurable(tmpPath, `${serializeHeader(epochId)}${text}`);
      renameSync(tmpPath, path);
    }
  }

  function page(since: number, limit: number): FleetEventPage {
    const events: FleetEvent[] = [];
    for (let i = firstIndexAbove(since); i < bySeqAsc.length && events.length < limit; i += 1) {
      const row = bySeqAsc[i]!;
      if (row.seq > durable) break; // durability before visibility
      events.push(row);
    }
    return { epoch: epochId, seq: durable, events };
  }

  // Minimal push (Task 2) — Task 3 adds the full durability/stamp contract.
  async function push(rows: StoredEventWire[], machineId: string): Promise<FleetEventPushResult> {
    if (isReplica) throw new Error("push is hub-mode only");
    while (rewriteGate !== null) await rewriteGate;
    const stamps: HubEventStamp[] = [];
    let added = 0;
    let lastMinted = durable;
    const lines: string[] = [];
    // The winners this batch applied to RAM — each paired with the durable
    // incumbent it displaced (undefined for a brand-new key) — retained so a
    // failed fsync can roll the winner back out AND restore the incumbent whose
    // line is still fsync'd on disk (durability-before-visibility, below).
    const applied: { key: string; row: FleetEvent; incumbent: FleetEvent | undefined }[] = [];
    for (const row of rows) {
      const key = fleetEventKey(row.messageId, row.requestId);
      const incumbent = byKey.get(key);
      if (incumbent !== undefined && fleetTokenTotal(incumbent) >= fleetTokenTotal(row)) {
        stamps.push(
          row.requestId === undefined
            ? { messageId: row.messageId, seq: incumbent.seq }
            : { messageId: row.messageId, requestId: row.requestId, seq: incumbent.seq },
        );
        continue;
      }
      const seq = nextSeq;
      nextSeq += 1;
      lastMinted = seq;
      const fleetRow = { ...row, machineId, seq } as FleetEvent;
      // `incumbent` (captured above, pre-applyRow) is the row this winner
      // displaces — applyRow spliced it out of bySeqAsc and overwrote byKey. It
      // is undefined for a new key. Batches are key-unique (the engine store
      // feeds deduped rows), so each key appears once in `applied`.
      applyRow(fleetRow, lines);
      applied.push({ key, row: fleetRow, incumbent });
      validLinesOnDisk += 1;
      added += 1;
      stamps.push(
        row.requestId === undefined
          ? { messageId: row.messageId, seq }
          : { messageId: row.messageId, requestId: row.requestId, seq },
      );
    }
    if (lines.length > 0) {
      // The leading-newline guard is consumed INSIDE the chained write, at
      // write time — not synchronously here. The chain serializes writes, so
      // reading the flag there is race-free; consuming it at push() time would
      // let a queued batch capture "no prefix" before an EARLIER batch's
      // append fails mid-line, concatenating the later acked row onto torn
      // bytes (unparseable at reload).
      const link = writeChain.then(async () => {
        const prefix = needsLeadingNewline ? "\n" : "";
        try {
          await writer.append(`${prefix}${lines.join("")}`);
          await writer.sync();
          needsLeadingNewline = false;
        } catch (err) {
          // A failed append may have landed partial bytes: force the next
          // write to start a fresh line. An extra blank line is harmless
          // (load skips blanks); concatenation corrupts the NEXT acked row.
          needsLeadingNewline = true;
          throw err;
        }
      });
      writeChain = link.catch((err) => {
        console.warn("[usage-core] fleet-event append failed:", err);
      });
      try {
        await link;
      } catch (err) {
        // This batch's append/fsync rejected — its rows never reached disk, so
        // they must not stay in RAM at minted seqs: a LATER batch's successful
        // fsync would advance `durable` past them and page() would then serve
        // rows that are not on disk (violating durability-before-visibility).
        // Roll the failed batch's winners back out. Identity-compare each: a
        // later concurrent push may already have REPLACED one of our rows (its
        // own line carries the full row), in which case byKey holds that row,
        // not ours — leave it (disk replay converges). This continuation fires
        // when A's link settles, one IO turn BEFORE any later batch's durable
        // advance, so it always runs first.
        for (const { key, row: r, incumbent } of applied) {
          if (byKey.get(key) !== r) continue; // superseded by a later push — keep it
          const idx = firstIndexAbove(r.seq) - 1;
          if (idx >= 0 && bySeqAsc[idx] === r) {
            bySeqAsc.splice(idx, 1);
            if (liveRowBytes !== null) liveRowBytes -= rowBytes(r);
          }
          if (incumbent !== undefined) {
            // Our winner REPLACED a durable incumbent whose line is still
            // fsync'd on disk (an earlier successful push counted it in
            // validLinesOnDisk). Deleting the key would hide that row from RAM
            // until a restart reloads it — a real convergence gap. Restore it.
            byKey.set(key, incumbent);
            bySeqAsc.splice(firstIndexAbove(incumbent.seq), 0, incumbent);
            if (liveRowBytes !== null) liveRowBytes += rowBytes(incumbent);
          } else {
            byKey.delete(key); // brand-new key — nothing durable to restore
          }
        }
        // The lines never landed on disk. nextSeq is deliberately NOT rewound —
        // seqs are never reused; a permanent gap is correct and the loader
        // tolerates it.
        validLinesOnDisk -= lines.length;
        throw err;
      }
      if (lastMinted > durable) durable = lastMinted;
      lastAppend = now();
    }
    return { epoch: epochId, added, stamps };
  }

  // Apply one pulled page to the replica cache. The replica's ONLY writer.
  function applyPage(rows: FleetEvent[], epoch: string): "applied" | "epoch-mismatch" {
    if (!isReplica) throw new Error("applyPage is replica-mode only");
    if (epochId !== "" && epoch !== epochId) return "epoch-mismatch";
    const lines: string[] = [];
    if (epochId === "") {
      // Adopt the hub's epoch — the replica never mints one; its header always
      // names the hub log it mirrors.
      epochId = epoch;
      lines.push(`${JSON.stringify({ epoch })}\n`);
    }
    for (const row of rows) {
      // Ties/losers still advance the cursor (a re-pulled overlap must make
      // progress) but never re-append — the disk stays a no-garbage-on-no-op
      // mirror. Replacements append; the superseded line is load-converging
      // garbage, the hub-store pattern. cursorSeq/durable/nextSeq all advance
      // from row.seq BEFORE the applyRow win/lose check.
      if (row.seq > cursorSeq) cursorSeq = row.seq;
      if (row.seq > durable) durable = row.seq;
      if (row.seq >= nextSeq) nextSeq = row.seq + 1;
      if (applyRow(row, lines) === "lost") continue;
      validLinesOnDisk += 1;
    }
    if (lines.length > 0) {
      // Fire-and-forget (NO visibility barrier — the replica is a cache): the
      // write chain serializes appends and consumes the leading-newline guard
      // at write time exactly like the hub path, but nothing awaits the sync.
      writeChain = writeChain.then(async () => {
        const prefix = needsLeadingNewline ? "\n" : "";
        try {
          await writer.append(`${prefix}${lines.join("")}`);
          needsLeadingNewline = false;
        } catch (err) {
          needsLeadingNewline = true;
          console.warn("[usage-core] fleet replica append failed:", err);
        }
      });
    }
    return "applied";
  }

  // Drop the replica cache entirely (file + RAM) and leave the store reusable —
  // the caller reseeds on an epoch flip. Replica-mode only.
  async function unlink(): Promise<void> {
    if (!isReplica) throw new Error("unlink is replica-mode only");
    // Reserve the whole wipe on the chain, including close's await. Otherwise
    // a later compact could close the same handle and rename after the wipe.
    const link = writeChain.then(wipeAndReset);
    writeChain = link.catch((err) => {
      console.warn("[usage-core] fleet replica unlink failed:", err);
    });
    await link;
  }

  // Drop the superseded + torn lines from the replica cache, keeping every live
  // row and the epoch — the replica half of the Settings › Storage "Clean up"
  // action (map #124, ticket #132).
  //
  // WHY NOT `rewrite`. It throws here, and not merely as a modal formality: its
  // two parameters are both things a replica may not express. It never mints an
  // epoch (its header names the hub log it mirrors, and adopting one it invented
  // would make every later page an epoch-mismatch), and it may never drop a LIVE
  // row (the pull cursor is derived from this file, so a dropped row is
  // unrecoverable until an epoch flip re-seeds it — the archive would be
  // silently short a row nobody will ask for again). Remove both and RAM falls
  // out of the problem too: a compact keeps every live row by definition, so
  // there is nothing to swap — only the file changes.
  //
  // CONCURRENCY (ADR-0093): snapshot membership and enqueue are synchronous;
  // serialization is not. Rows are whole-object replacements, never mutated
  // in place, so copying the references freezes this point in the write chain.
  // Earlier appends land on the old file and are covered by the snapshot;
  // later pages cannot enter it and append exactly once after the rename.
  //
  // Counters move relatively: later pages have already incremented them in
  // RAM. Cumulative removals additionally stop overlapping compacts from
  // subtracting the same garbage twice. Failed/cancelled writes remove nothing.
  async function compact(): Promise<{ droppedLines: number; freedBytes: number }> {
    if (!isReplica) throw new Error("compact is replica-mode only");
    if (epochId === "") return { droppedLines: 0, freedBytes: 0 };
    const rows = bySeqAsc.slice();
    const snapshotEpoch = epochId;
    const generation = replicaGeneration;
    const removalTarget = compactedLines + validLinesOnDisk - rows.length + unreadable;
    const unreadableTarget = compactedUnreadable + unreadable;
    const isCurrent = () => generation === replicaGeneration && epochId === snapshotEpoch;
    const link = writeChain.then(async () => {
      // A preceding queued unlink invalidates this snapshot, including a
      // reseed that happens to adopt the same epoch (the ABA case).
      if (!isCurrent()) return { droppedLines: 0, freedBytes: 0 };
      let sizeBefore: number;
      try {
        sizeBefore = statSync(path).size;
      } catch {
        sizeBefore = 0;
      }
      // Windows cannot replace an open append handle. Later appends are on
      // this chain, and reopen lazily against the replacement after we settle.
      await writer.close();
      const tmpPath = `${path}.tmp`;
      try {
        if (!isCurrent()) return { droppedLines: 0, freedBytes: 0 };
        const writtenBytes = await writeCompactSnapshot(
          tmpPath,
          snapshotEpoch,
          rows,
          openCompactFile,
          serializeAccountedLine,
        );
        // Final resurrection backstop after EVERY yielding operation. The
        // guard, rename and counter update form one synchronous commit.
        if (!isCurrent()) return { droppedLines: 0, freedBytes: 0 };
        renameSync(tmpPath, path);
        const droppedLines = removalTarget - compactedLines;
        validLinesOnDisk -= droppedLines;
        unreadable -= unreadableTarget - compactedUnreadable;
        compactedLines = removalTarget;
        compactedUnreadable = unreadableTarget;
        needsLeadingNewline = false;
        return { droppedLines, freedBytes: Math.max(0, sizeBefore - writtenBytes) };
      } finally {
        // On failure/cancellation the original archive and counters survive.
        // The next queued append still runs; no partial tmp should linger.
        rmSync(tmpPath, { force: true });
      }
    });
    writeChain = link.then(
      () => {},
      (err) => {
        console.warn("[usage-core] fleet replica compact failed:", err);
      },
    );
    return await link;
  }

  // The purge/compact rewrite (ADR-0041 M7). Ordering: (1) the gate parks new
  // pushes before they touch RAM; (2) chaining the body onto writeChain drains
  // every in-flight append first — push()'s RAM-apply and its chain enqueue are
  // one synchronous block, so any push that got past the gate check is already
  // on the chain ahead of us and lands on the OLD file, inside our snapshot.
  // The snapshot therefore sees settled RAM; the rename atomically replaces the
  // file; queued pushes then reopen the writer lazily against the NEW file.
  async function rewrite(rwOpts: {
    keep?: (row: FleetEvent) => boolean;
    newEpoch: boolean;
  }): Promise<{ kept: number; droppedRows: number; droppedLines: number }> {
    if (isReplica) throw new Error("rewrite is hub-mode only");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = rewriteGate;
    rewriteGate = gate;
    try {
      if (prior !== null) await prior; // serialize back-to-back rewrites
      const link = writeChain.then(async () => {
        const keep = rwOpts.keep ?? (() => true);
        const survivors = bySeqAsc.filter(keep);
        const droppedRows = bySeqAsc.length - survivors.length;
        const droppedLines = validLinesOnDisk - byKey.size + unreadable + droppedRows;
        const nextEpoch = rwOpts.newEpoch ? crypto.randomUUID() : epochId;
        // Close the writer BEFORE the rename: it may hold an append handle on
        // the old inode (Windows blocks the rename). It reopens lazily against
        // the new file on the next append.
        await writer.close();
        const tmpPath = `${path}.tmp`;
        // Durable before the rename, the loadInner pattern (writeDurable).
        const rowLines = survivors.map(serializeAccountedLine).join("");
        writeDurable(tmpPath, serializeHeader(nextEpoch) + rowLines);
        renameSync(tmpPath, path);
        // Swap RAM atomically with the file. Surviving seqs verbatim; the
        // counter re-derives from the surviving max (safe under newEpoch:false
        // too — seqs above it were never observable: their append failed
        // before any ack/poke).
        byKey.clear();
        bySeqAsc.length = 0;
        liveRowBytes = Buffer.byteLength(rowLines);
        for (const r of survivors) {
          byKey.set(fleetEventKey(r.messageId, r.requestId), r);
          bySeqAsc.push(r);
        }
        epochId = nextEpoch;
        durable = survivors.length > 0 ? survivors[survivors.length - 1]!.seq : 0;
        nextSeq = durable + 1;
        validLinesOnDisk = survivors.length;
        unreadable = 0;
        needsLeadingNewline = false;
        return { kept: survivors.length, droppedRows, droppedLines };
      });
      writeChain = link.then(
        () => {},
        (err) => {
          console.warn("[usage-core] fleet-event rewrite failed:", err);
        },
      );
      return await link;
    } finally {
      // Only the owner of the CURRENT gate clears it — an earlier rewrite's
      // finally must not open the gate while a later one is still swapping.
      if (rewriteGate === gate) rewriteGate = null;
      release();
    }
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // best-effort — a later write failure reports itself
  }

  return {
    ready,
    load,
    push,
    page,
    epoch: () => epochId,
    durableSeq: () => durable,
    size: () => byKey.size,
    garbageLines: () => validLinesOnDisk - byKey.size,
    unreadableLines: () => unreadable,
    fileBytes: () => {
      try {
        return statSync(path).size;
      } catch {
        return 0;
      }
    },
    // What a Compact frees, exactly. A compact rewrites the log as the epoch
    // header + every live row re-serialized (see `rewrite`, newEpoch:false), so
    // the post-compact size is computable in RAM from the same state rewrite
    // draws on — no whole-archive intermediate string. The post-compact size
    // comes from a lazy running sum: the first query measures surviving rows
    // using cached write costs or canonical serialization, then every mutation
    // maintains it. Subsequent queries are O(1). Replay never measures source
    // lines or superseded rows. The residual (current − post-compact) includes
    // superseded lines and unreadable/torn bytes a compact clears; clamped ≥ 0.
    //
    // Best-effort, like fileBytes: it reads statSync(path).size (disk) against
    // the in-RAM live-row sum without synchronizing with the write chain, so
    // during an in-flight append it may transiently read low (clamped to 0) and
    // self-corrects on the next status refresh.
    reclaimableBytes: () => {
      let current: number;
      try {
        current = statSync(path).size;
      } catch {
        return 0;
      }
      const postCompact = Buffer.byteLength(serializeHeader(epochId)) + measuredLiveRowBytes();
      return Math.max(0, current - postCompact);
    },
    lastAppendAt: () => lastAppend,
    rewrite,
    flush: () => writeChain,
    close: async () => {
      await writeChain;
      await writer.close();
    },
    cursor: () => {
      if (!isReplica) throw new Error("cursor is replica-mode only");
      return cursorSeq;
    },
    // get/all serve both modes. `all` returns the store's INTERNAL seq-ascending
    // array by reference — callers must NEVER mutate it (event-sync reads it to
    // build the replica projection).
    get: (messageId, requestId) => byKey.get(fleetEventKey(messageId, requestId)),
    all: () => bySeqAsc,
    applyPage,
    unlink,
    compact,
  };
}
