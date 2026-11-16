import { fleetDedupKey, fleetDedupTokenTotal } from "@maxprice/shared";
import type { EventStore, LocalAppend } from "./engine/store";
import type { UsageRecord } from "./engine/types";
import type { GatewayEvidenceEntry, GatewayEvidenceStore } from "./gateway-evidence";
import type { GatewayOffer, GatewayPendingStore, PendingGatewayRecord } from "./gateway-pending";

// The Gateway record matcher (ADR-0141 §2–§3, D4): joins the Gateway records
// this client receives (its own fallback drain's, or the Hub's feed) to its
// own transcript lines, and turns each match into Attribution evidence.
//
// The join, for each record (a reduced record is never a failed attempt):
//   1. exact: the lines, in any session, whose `requestId` equals the
//      record's upstream `Request-Id`;
//   2. otherwise: the lines of the record's session (`parentSessionId ??
//      sessionId`) with no `requestId`, whose model and four token counts
//      equal the record's.
// Exactly one candidate is a match; none, or two or more, leaves the record
// pending (a later line can still decide it) until it expires 24 hours after
// receipt. A candidate the transcript already attributes (the store's
// `hasTranscriptEvidence`), or one a record already matched, consumes the
// record as ignored: a record never replaces a tag (§1). The builder's
// `matchRecords` (apps/sidecar/scripts/build-multi-account-corpus.ts) is the
// oracle; the several-Account corpus's `gateway/` holds this to it.
//
// A match is written to the Gateway evidence store first, then the line's
// original record is re-appended to the live store (`EventStore.reapply`), so
// the admission gate, the excluded holder, the foreign evidence listeners and
// the repair run on it as on any line (§3): a tag gained is a replacement, an
// Excluded Membership evicts the row.
//
// The line index holds the lines of the last 7 days (the Hub feed's window),
// fed by every store's `onLocalAppend` (`onLines`): the boot walk, a rebuild's
// walk, the watcher and the re-appends alike, deduplicated by (session, dedup
// key). Matching runs on `offer` and, a microtask after new lines, for the
// pending records those lines could decide; never before `start` (the live
// store is installed: before it the store's owner points are not there to
// tell a subagent line's evidence).
//
// RESIDUAL: two lines with equal counts and model in one session are
// ambiguous only if both are indexed when the record is evaluated. A record
// that arrives before the second is written matches the first.

export const GATEWAY_LINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// How often, at most, the line index drops lines past its window.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export type GatewayMatchCounters = {
  // Records matched to a line (since this process started).
  matched: number;
  // Records consumed without a match: their one candidate already carried
  // evidence (the transcript's, or an earlier record's).
  ignored: number;
  // Records pending now, and how many of those had two or more candidates at
  // their last evaluation.
  pending: number;
  ambiguous: number;
  // Records that expired unmatched (since this process started).
  expired: number;
};

export type GatewayMatcher = {
  // Offers records for matching (a drain's or the Hub feed's). A record whose
  // `executionId` was already offered within 7 days is ignored. Matching runs
  // at once when started.
  offer: (records: readonly GatewayOffer[]) => void;
  // Indexes one batch of local lines; subscribe it to every store's
  // `onLocalAppend`. Matching for the pending records the batch can decide
  // runs a microtask later.
  onLines: (batch: LocalAppend) => void;
  // The live store is installed (the boot walk is done): match everything
  // pending against the index. Idempotent.
  start: () => void;
  // Settles once every matching pass scheduled so far has run (tests).
  settled: () => Promise<void>;
  counters: () => GatewayMatchCounters;
  // When the last match was made (epoch ms), null before the first.
  lastMatchAt: () => number | null;
};

type IndexedLine = {
  record: UsageRecord;
  projectSlug: string;
  sessionId: string;
  isSubagent: boolean;
  dedupKey: string;
  ms: number;
};

export function createGatewayMatcher(deps: {
  // The live store, or null before the boot installed one.
  getStore: () => EventStore | null;
  evidence: GatewayEvidenceStore;
  pending: GatewayPendingStore;
  now?: () => number;
  // Hears how many rows a pass's re-appends changed, when any did (the
  // renderer's usage poke).
  onApplied?: (changed: number) => void;
}): GatewayMatcher {
  const now = deps.now ?? Date.now;
  let started = false;

  // ── The line index ──
  const lines = new Map<string, IndexedLine>(); // by session \0 dedup key
  const byRequestId = new Map<string, Set<IndexedLine>>();
  const bySession = new Map<string, Set<IndexedLine>>(); // lines with no requestId
  let lastPrune = 0;

  const lineKey = (sessionId: string, dedupKey: string): string => `${sessionId}\u0000${dedupKey}`;

  function addTo(map: Map<string, Set<IndexedLine>>, key: string, line: IndexedLine): void {
    let set = map.get(key);
    if (set === undefined) {
      set = new Set();
      map.set(key, set);
    }
    set.add(line);
  }
  function removeFrom(map: Map<string, Set<IndexedLine>>, key: string, line: IndexedLine): void {
    const set = map.get(key);
    if (set === undefined) return;
    set.delete(line);
    if (set.size === 0) map.delete(key);
  }

  // Indexes one record; returns it when it is new or replaced a smaller copy
  // (a streamed message's partial), else null.
  function indexRecord(
    record: UsageRecord,
    projectSlug: string,
    sessionId: string,
    isSubagent: boolean,
    floor: number,
  ): IndexedLine | null {
    const ms = Date.parse(record.timestamp);
    if (Number.isNaN(ms) || ms < floor) return null;
    const dedupKey = fleetDedupKey(record.messageId, record.requestId);
    const key = lineKey(sessionId, dedupKey);
    const held = lines.get(key);
    if (held !== undefined) {
      // One line per key: the fullest copy, as the store keeps it.
      if (fleetDedupTokenTotal(record) <= fleetDedupTokenTotal(held.record)) return null;
      held.record = record;
      held.ms = ms;
      return held;
    }
    const line: IndexedLine = { record, projectSlug, sessionId, isSubagent, dedupKey, ms };
    lines.set(key, line);
    if (record.requestId !== undefined) addTo(byRequestId, record.requestId, line);
    else addTo(bySession, sessionId, line);
    return line;
  }

  function prune(): void {
    const at = now();
    if (at - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = at;
    const floor = at - GATEWAY_LINE_WINDOW_MS;
    for (const [key, line] of lines) {
      if (line.ms >= floor) continue;
      lines.delete(key);
      if (line.record.requestId !== undefined) {
        removeFrom(byRequestId, line.record.requestId, line);
      } else {
        removeFrom(bySession, line.sessionId, line);
      }
    }
  }

  // ── Pending records, indexed by what a line can decide them by ──
  const pendingBySession = new Map<string, Set<string>>();
  const pendingByUpstream = new Map<string, Set<string>>();
  const ambiguousIds = new Set<string>();
  let matched = 0;
  let ignored = 0;
  let expired = 0;
  let lastMatchAt: number | null = null;

  const joinSession = (r: PendingGatewayRecord): string | undefined =>
    r.reduced.parentSessionId ?? r.reduced.sessionId;

  function indexPending(r: PendingGatewayRecord): void {
    const id = r.reduced.executionId;
    const session = joinSession(r);
    if (session !== undefined) addId(pendingBySession, session, id);
    if (r.reduced.upstreamRequestId !== undefined) {
      addId(pendingByUpstream, r.reduced.upstreamRequestId, id);
    }
  }
  function unindexPending(r: PendingGatewayRecord): void {
    const id = r.reduced.executionId;
    const session = joinSession(r);
    if (session !== undefined) removeId(pendingBySession, session, id);
    if (r.reduced.upstreamRequestId !== undefined) {
      removeId(pendingByUpstream, r.reduced.upstreamRequestId, id);
    }
    ambiguousIds.delete(id);
  }
  function addId(map: Map<string, Set<string>>, key: string, id: string): void {
    let set = map.get(key);
    if (set === undefined) {
      set = new Set();
      map.set(key, set);
    }
    set.add(id);
  }
  function removeId(map: Map<string, Set<string>>, key: string, id: string): void {
    const set = map.get(key);
    if (set === undefined) return;
    set.delete(id);
    if (set.size === 0) map.delete(key);
  }
  for (const r of deps.pending.pending()) indexPending(r);

  function expirePending(): void {
    for (const r of deps.pending.expire()) {
      unindexPending(r);
      expired += 1;
    }
  }

  // ── The join ──
  type Verdict =
    | { kind: "match"; line: IndexedLine }
    | { kind: "ignored" }
    | { kind: "ambiguous" }
    | { kind: "none" };

  function candidatesOf(r: PendingGatewayRecord): IndexedLine[] {
    const upstream = r.reduced.upstreamRequestId;
    const exact = upstream === undefined ? undefined : byRequestId.get(upstream);
    if (exact !== undefined && exact.size > 0) return [...exact];
    const session = joinSession(r);
    if (session === undefined) return [];
    const out: IndexedLine[] = [];
    for (const line of bySession.get(session) ?? []) {
      const l = line.record;
      if (
        l.model === r.reduced.model &&
        l.outputTokens === r.reduced.outputTokens &&
        l.cacheReadTokens === r.reduced.cacheReadTokens &&
        l.cacheCreationTokens === r.reduced.cacheCreationTokens &&
        l.inputTokens === r.reduced.inputTokens
      ) {
        out.push(line);
      }
    }
    return out;
  }

  function judge(r: PendingGatewayRecord, store: EventStore, taken: Set<IndexedLine>): Verdict {
    const candidates = candidatesOf(r);
    if (candidates.length === 0) return { kind: "none" };
    if (candidates.length > 1) return { kind: "ambiguous" };
    const line = candidates[0] as IndexedLine;
    if (
      taken.has(line) ||
      deps.evidence.has(line.sessionId, line.dedupKey) ||
      store.hasTranscriptEvidence(line.record, line.projectSlug, line.sessionId, line.isSubagent)
    ) {
      return { kind: "ignored" };
    }
    return { kind: "match", line };
  }

  // Evaluates the given pending records against the index, and applies every
  // match: the evidence store first (one durable write), then one re-append
  // per line.
  let applying = false;
  function evaluate(records: Iterable<PendingGatewayRecord>): void {
    const store = deps.getStore();
    if (!started || store === null) return;
    const taken = new Set<IndexedLine>();
    const matches: { record: PendingGatewayRecord; line: IndexedLine }[] = [];
    const consumed: string[] = [];
    for (const r of records) {
      const id = r.reduced.executionId;
      const verdict = judge(r, store, taken);
      if (verdict.kind === "ambiguous") {
        ambiguousIds.add(id);
        continue;
      }
      ambiguousIds.delete(id);
      if (verdict.kind === "none") continue;
      consumed.push(id);
      unindexPending(r);
      if (verdict.kind === "ignored") {
        ignored += 1;
        continue;
      }
      taken.add(verdict.line);
      matches.push({ record: r, line: verdict.line });
    }
    if (consumed.length === 0) return;
    const entries: GatewayEvidenceEntry[] = matches.map(({ record, line }) => ({
      sessionId: line.sessionId,
      dedupKey: line.dedupKey,
      evidence: {
        organizationUuid: record.reduced.organizationUuid,
        accountUuid: record.reduced.accountUuid,
        accountEmailHash: record.reduced.accountUuid === undefined ? record.emailHash : undefined,
      },
    }));
    deps.evidence.add(entries);
    deps.pending.remove(consumed);
    if (matches.length === 0) return;
    matched += matches.length;
    lastMatchAt = now();
    let changed = 0;
    applying = true;
    try {
      for (const { line } of matches) {
        changed += store.reapply([line.record], line.projectSlug, line.sessionId, line.isSubagent);
      }
    } finally {
      applying = false;
    }
    if (changed > 0) deps.onApplied?.(changed);
  }

  function pendingById(): Map<string, PendingGatewayRecord> {
    return new Map(deps.pending.pending().map((r) => [r.reduced.executionId, r]));
  }

  // Lines that arrived since the last pass, and the pass's scheduling.
  const dirtySessions = new Set<string>();
  const dirtyRequestIds = new Set<string>();
  let scheduled: Promise<void> | null = null;
  function schedule(): void {
    if (scheduled !== null) return;
    scheduled = Promise.resolve().then(() => {
      scheduled = null;
      runDirty();
    });
  }
  function runDirty(): void {
    if (!started || deps.getStore() === null) return;
    if (dirtySessions.size === 0 && dirtyRequestIds.size === 0) return;
    expirePending();
    const ids = new Set<string>();
    for (const s of dirtySessions) for (const id of pendingBySession.get(s) ?? []) ids.add(id);
    for (const q of dirtyRequestIds) {
      for (const id of pendingByUpstream.get(q) ?? []) ids.add(id);
    }
    dirtySessions.clear();
    dirtyRequestIds.clear();
    if (ids.size === 0) return;
    const byId = pendingById();
    evaluate([...ids].flatMap((id) => byId.get(id) ?? []));
  }

  return {
    offer: (records) => {
      const admitted = deps.pending.admit(records);
      for (const r of admitted) indexPending(r);
      if (!started) return;
      prune();
      expirePending();
      evaluate(admitted);
    },
    onLines: (batch) => {
      const floor = now() - GATEWAY_LINE_WINDOW_MS;
      for (const record of batch.records) {
        const line = indexRecord(
          record,
          batch.projectSlug,
          batch.sessionId,
          batch.isSubagent,
          floor,
        );
        // A re-append's own batch decides nothing new.
        if (line === null || applying) continue;
        if (line.record.requestId !== undefined) dirtyRequestIds.add(line.record.requestId);
        else dirtySessions.add(line.sessionId);
      }
      if (dirtySessions.size > 0 || dirtyRequestIds.size > 0) schedule();
    },
    start: () => {
      if (started) return;
      started = true;
      dirtySessions.clear();
      dirtyRequestIds.clear();
      prune();
      expirePending();
      evaluate(deps.pending.pending());
    },
    settled: async () => {
      while (scheduled !== null) await scheduled;
    },
    counters: () => ({
      matched,
      ignored,
      pending: deps.pending.pending().length,
      ambiguous: ambiguousIds.size,
      expired,
    }),
    lastMatchAt: () => lastMatchAt,
  };
}
