import { loadDurably, writeDurably } from "./durable-file";
import { z } from "zod";
import type { GatewayEvidence, GatewayEvidenceLookup } from "./engine/store";

// gateway-evidence.json — the Gateway evidence store (ADR-0141 §1, D2): one
// entry per transcript line a Gateway record was matched to, keyed by the
// line's store session and its dedup key (`fleetDedupKey(messageId,
// requestId)`), naming the record's Organization and its Account, an account
// uuid or the credential's email hash.
//
// `{ version: 1, sessions: { [sessionId]: { [dedupKey]: entry } } }`.
//
// LOCAL ONLY, like the pair table: no wire, Hub, archive or directory carries
// it, and an email hash in it never leaves this machine (ADR-0137 §1). The
// event store reads it at every append (`createEventStore`'s
// `gatewayEvidence`), as it reads a transcript's own records, so a re-parse, a
// rebuild after re-tracking, or a Local archive reset finds the evidence again
// without the record, which the Gateway's queue no longer holds.
//
// Written only once a match exists: an install with no Gateway writes
// nothing. Each write is a durable replace (temp file, fsync, rename). An
// unreadable file is kept as `.bak` and the store starts empty, so its lines
// fall back to owner-less (ADR-0141 §4) until a record matches them again.
// Entries are kept: nothing prunes a line's evidence (a residual: the file
// grows by one entry per matched line).

const HASH = /^[0-9a-f]{64}$/;
const uuidField = z.string().min(1).max(256);
const entrySchema = z
  .object({
    organizationUuid: uuidField.optional(),
    accountUuid: uuidField.optional(),
    accountEmailHash: z.string().regex(HASH).optional(),
  })
  .refine((e) => e.accountUuid === undefined || e.accountEmailHash === undefined);
type Entry = z.infer<typeof entrySchema>;

const fileSchema = z.object({
  version: z.literal(1),
  // `unknown` per entry so one bad entry cannot empty the whole file.
  sessions: z.record(z.record(z.unknown())),
});

export type GatewayEvidenceEntry = {
  sessionId: string;
  dedupKey: string;
  evidence: GatewayEvidence;
};

export type GatewayEvidenceStore = GatewayEvidenceLookup & {
  // Whether the line already holds Gateway evidence (a line is matched at
  // most once, across restarts too).
  has: (sessionId: string, dedupKey: string) => boolean;
  // Records matches and persists them in one durable write. An entry naming
  // neither an Organization nor an Account is not kept. A line that already
  // holds evidence keeps it (first match wins). Returns how many were added.
  add: (entries: readonly GatewayEvidenceEntry[]) => number;
  size: () => number;
};

export function createGatewayEvidenceStore(opts: { path: string }): GatewayEvidenceStore {
  const sessions = new Map<string, Map<string, GatewayEvidence>>();
  let count = 0;

  load();

  function load(): void {
    const file = loadDurably(opts.path, fileSchema, "gateway-evidence.json");
    if (file === null) return;
    let skipped = 0;
    for (const [sessionId, entries] of Object.entries(file.sessions)) {
      for (const [dedupKey, candidate] of Object.entries(entries)) {
        const entry = entrySchema.safeParse(candidate);
        if (!entry.success) {
          skipped += 1;
          continue;
        }
        put(sessionId, dedupKey, toEvidence(entry.data));
      }
    }
    if (skipped > 0) console.warn(`[sidecar] gateway-evidence.json: skipped ${skipped} entries`);
  }

  function toEvidence(entry: Entry): GatewayEvidence {
    return {
      organizationUuid: entry.organizationUuid,
      accountUuid: entry.accountUuid,
      accountEmailHash: entry.accountEmailHash,
    };
  }

  function put(sessionId: string, dedupKey: string, evidence: GatewayEvidence): boolean {
    let lines = sessions.get(sessionId);
    if (lines === undefined) {
      lines = new Map();
      sessions.set(sessionId, lines);
    }
    if (lines.has(dedupKey)) return false;
    lines.set(dedupKey, evidence);
    count += 1;
    return true;
  }

  function write(): void {
    const out: Record<string, Record<string, Entry>> = {};
    for (const [sessionId, lines] of sessions) {
      const entries: Record<string, Entry> = {};
      for (const [dedupKey, e] of lines) {
        entries[dedupKey] = {
          ...(e.organizationUuid === undefined ? {} : { organizationUuid: e.organizationUuid }),
          ...(e.accountUuid === undefined ? {} : { accountUuid: e.accountUuid }),
          ...(e.accountEmailHash === undefined ? {} : { accountEmailHash: e.accountEmailHash }),
        };
      }
      out[sessionId] = entries;
    }
    writeDurably(opts.path, JSON.stringify({ version: 1, sessions: out }));
  }

  return {
    lookup: (sessionId, dedupKey) => sessions.get(sessionId)?.get(dedupKey),
    has: (sessionId, dedupKey) => sessions.get(sessionId)?.has(dedupKey) ?? false,
    add: (entries) => {
      let added = 0;
      for (const { sessionId, dedupKey, evidence } of entries) {
        const accountEmailHash =
          evidence.accountUuid === undefined ? evidence.accountEmailHash : undefined;
        if (
          evidence.organizationUuid === undefined &&
          evidence.accountUuid === undefined &&
          accountEmailHash === undefined
        ) {
          continue;
        }
        if (accountEmailHash !== undefined && !HASH.test(accountEmailHash)) continue;
        if (put(sessionId, dedupKey, { ...evidence, accountEmailHash })) added += 1;
      }
      if (added > 0) {
        try {
          write();
        } catch (err) {
          // The match still applies in this process; the next match rewrites
          // the whole file.
          console.error("[sidecar] gateway-evidence.json write failed:", err);
        }
      }
      return added;
    },
    size: () => count,
  };
}
