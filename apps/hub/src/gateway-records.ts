// Exported via a package.json subpath for the fleet test rigs (the sidecar's test Hub, ADR-0141's fleet acceptance) — keep signatures stable, a cross-app test contract.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { z } from "zod";
import {
  GATEWAY_RECORDS_PAGE_MAX,
  reducedGatewayRecordSchema,
  type GatewayRecordsFeed,
  type ReducedGatewayRecord,
} from "@maxprice/shared";

// The Hub's Gateway record feed (ADR-0141 §5, D9): the reduced records it
// drained from its Gateways or a client pushed up, held 7 days from when the
// Hub received each, and served oldest first to every client, which matches
// only its own sessions.
//
// `gateway-records.json` beside hub.json, `{ version: 1, epoch, seq,
// records: [{ seq, receivedAt, record }] }`, rewritten whole and atomically
// (tmp + fsync + rename) at each change, the Membership assertion directory's
// mechanics: loaded once at construction, a corrupt file kept as `.bak` and
// the feed started empty under a new epoch, an unreadable entry skipped.
// Written only once a record exists, so a Hub with no Gateway has no such
// file; removed when the last record expires.
//
// - Deduplicated by `executionId`: a record drained twice, or drained here
//   and pushed by a client, is held once, under its first `seq`.
// - Each stored record takes the next `seq`, which never goes back within an
//   epoch (`seq` is the high-water mark, persisted beside the records).
// - The cursor is `<epoch>.<seq>`, opaque to clients. A page holds the
//   records after the cursor's `seq`, at most GATEWAY_RECORDS_PAGE_MAX, and
//   its cursor is its last record's, or the high-water mark when it is empty.
//   A cursor this feed cannot read, or one from another epoch (a store that
//   was reset, or another Hub's), starts again from the oldest record held;
//   one older than the window resumes at the oldest held, which is the same
//   thing. A client's own dedup by `executionId` makes the replay harmless.
// - At most GATEWAY_RECORDS_MAX records are held; past that the oldest go
//   early (a warning says how many).
//
// Never an email or an email hash: the record schema is strict and has no
// field for either (ADR-0137 §1, ADR-0138 §9).

export const GATEWAY_RECORDS_FILE = "gateway-records.json";
export const GATEWAY_RECORDS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Far above a week of one person's Gateway traffic; bounds the file
// (~450 bytes a record).
export const GATEWAY_RECORDS_MAX = 100_000;

const entrySchema = z.object({
  seq: z.number().int().positive(),
  receivedAt: z.number().int().nonnegative(),
  record: reducedGatewayRecordSchema,
});
type Entry = z.infer<typeof entrySchema>;
const fileSchema = z.object({
  version: z.literal(1),
  epoch: z.string().regex(/^[0-9a-f]{16}$/),
  seq: z.number().int().nonnegative(),
  records: z.array(z.unknown()),
});

export type GatewayRecordsAdd = {
  // How many records were new and are now held.
  stored: number;
  // Every executionId the caller may drop: stored now, already held, or (for
  // a push) refused as past the window. A push's ack.
  accepted: string[];
};

export type GatewayRecordsStore = {
  // Adds records. A drain's records are held from now, whatever their
  // timestamps; a push's (`push: true`) whose timestamp is already past the
  // window is refused and acked. Persists before it returns when anything was
  // stored; a write that fails keeps the previous feed and throws.
  add: (records: readonly ReducedGatewayRecord[], opts?: { push?: boolean }) => GatewayRecordsAdd;
  // A page of the feed after `since` (null: from the start).
  feed: (since: string | null) => GatewayRecordsFeed;
  // Drops what is past the window, persisting when anything went. Returns
  // how many went. A write that fails keeps them, and throws.
  prune: () => number;
  size: () => number;
};

function newEpoch(): string {
  return randomBytes(8).toString("hex");
}

export function createGatewayRecordsStore(opts: {
  path: string;
  now?: () => number;
  retentionMs?: number;
  max?: number;
  writeFileImpl?: (path: string, data: string) => void;
  warn?: (line: string) => void;
}): GatewayRecordsStore {
  const { path } = opts;
  const now = opts.now ?? Date.now;
  const retentionMs = opts.retentionMs ?? GATEWAY_RECORDS_RETENTION_MS;
  const max = opts.max ?? GATEWAY_RECORDS_MAX;
  const warn = opts.warn ?? ((line: string) => console.warn(line));

  let epoch = newEpoch();
  let seq = 0;
  // Ascending by seq.
  let entries: Entry[] = [];
  let byExecution = new Map<string, Entry>();

  function write(nextEntries: readonly Entry[], nextSeq: number): void {
    if (nextEntries.length === 0) {
      rmSync(path, { force: true });
      return;
    }
    const tmp = `${path}.tmp`;
    (opts.writeFileImpl ?? writeFileSync)(
      tmp,
      `${JSON.stringify({ version: 1, epoch, seq: nextSeq, records: nextEntries })}\n`,
    );
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }

  function adopt(nextEntries: Entry[], nextSeq: number): void {
    entries = nextEntries;
    seq = nextSeq;
    byExecution = new Map(entries.map((e) => [e.record.executionId, e]));
  }

  let raw: string | null = null;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Missing: no record yet, or every one expired.
  }
  if (raw !== null) {
    let file: z.infer<typeof fileSchema> | null = null;
    try {
      const parsed = fileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) file = parsed.data;
    } catch {
      // fall through to the recovery path
    }
    if (file === null) {
      try {
        writeFileSync(`${path}.bak`, raw);
      } catch {
        // best-effort — never block boot on the backup copy
      }
      warn(`[hub] ${GATEWAY_RECORDS_FILE} unreadable; starting an empty feed (kept ${path}.bak)`);
    } else {
      epoch = file.epoch;
      const loaded: Entry[] = [];
      const seen = new Set<string>();
      let skipped = 0;
      for (const candidate of file.records) {
        const parsed = entrySchema.safeParse(candidate);
        if (
          !parsed.success ||
          parsed.data.seq > file.seq ||
          seen.has(parsed.data.record.executionId)
        ) {
          skipped += 1;
          continue;
        }
        seen.add(parsed.data.record.executionId);
        loaded.push(parsed.data);
      }
      loaded.sort((a, b) => a.seq - b.seq);
      adopt(loaded, file.seq);
      if (skipped > 0) {
        warn(
          `[hub] ${GATEWAY_RECORDS_FILE}: skipped ${skipped} unreadable ${skipped === 1 ? "record" : "records"}`,
        );
      }
    }
  }

  const live = (list: readonly Entry[], at: number) =>
    list.filter((e) => e.receivedAt > at - retentionMs);

  function parseCursor(since: string | null): number {
    if (since === null) return 0;
    const match = /^([0-9a-f]{16})\.(\d{1,15})$/.exec(since);
    if (match === null || match[1] !== epoch) return 0;
    return Number(match[2]);
  }

  return {
    add(records, addOpts = {}) {
      const at = now();
      const accepted: string[] = [];
      const fresh: Entry[] = [];
      let nextSeq = seq;
      const batch = new Set<string>();
      for (const record of records) {
        const id = record.executionId;
        if (byExecution.has(id) || batch.has(id)) {
          accepted.push(id);
          continue;
        }
        if (addOpts.push === true && Date.parse(record.timestamp) <= at - retentionMs) {
          accepted.push(id);
          continue;
        }
        batch.add(id);
        nextSeq += 1;
        fresh.push({ seq: nextSeq, receivedAt: at, record: { ...record } });
        accepted.push(id);
      }
      if (fresh.length === 0) return { stored: 0, accepted };
      // Pruned on write, the window first, then the cap.
      let next = live([...entries, ...fresh], at);
      if (next.length > max) {
        const over = next.length - max;
        next = next.slice(over);
        warn(`[hub] Gateway record feed is full; dropped its ${over} oldest`);
      }
      write(next, nextSeq);
      adopt(next, nextSeq);
      const stored = fresh.filter((e) => byExecution.has(e.record.executionId)).length;
      return { stored, accepted };
    },
    feed(since) {
      const after = parseCursor(since);
      const at = now();
      const page: Entry[] = [];
      for (const entry of entries) {
        if (entry.seq <= after || entry.receivedAt <= at - retentionMs) continue;
        page.push(entry);
        if (page.length === GATEWAY_RECORDS_PAGE_MAX) break;
      }
      const last = page.length === 0 ? seq : page[page.length - 1]!.seq;
      return { records: page.map((e) => ({ ...e.record })), cursor: `${epoch}.${last}` };
    },
    prune() {
      const next = live(entries, now());
      const gone = entries.length - next.length;
      if (gone === 0) return 0;
      write(next, seq);
      adopt(next, seq);
      return gone;
    },
    size: () => entries.length,
  };
}
