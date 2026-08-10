import { mkdirSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { usageSampleSchema, type UsageSample } from "@maxprice/shared";

// The usage history (ADR-0024): an append-only JSONL on disk loaded into a
// sorted-by-capturedAt array in memory. The array is kept sorted UNCONDITIONALLY
// by an internal insert() that both append() and merge() route through, so the
// latest-sample reads (latest() here; latestSampleWindow + precomputeSamples'
// latestUtil in the engine's block-windows.ts, all `samples[len - 1]`) stay
// correct even after merge() inserts a future-dated remote sample (cross-machine
// clock skew) ahead of a later present-dated local append. Membership is tracked
// in a persistent capturedAt Set so merge() dedups in O(1) instead of rebuilding
// it each call. The local poll is the single writer, but load tolerates
// concurrent appends via that same dedup. Mirrors the engine's event store:
// cheap in-memory range queries, no database.
//
// ACCEPTED UNBOUNDED GROWTH (ADR-0024 "In-memory growth is unbounded"): the
// in-memory `samples` array and usage-history.jsonl grow append-only forever
// (~525k samples ≈ ~80 MB per year at 1 sample/min on an always-on hub).
// Retention/downsampling was deliberately NOT added — see the ADR.
//
// Construction is synchronous and does NO file read — only the in-memory array
// and a one-time best-effort mkdir. The on-disk history is loaded by an
// explicit async `loadHistory()`, kicked off *after* the LISTENING handshake so
// a large history read can't blow the Rust shell's 5s timeout (mirrors the
// event store's deferred initial scan).

export type SampleStore = {
  // Resolves once loadHistory() has FIRST completed — the success path, the
  // file-missing early-return, and any read/parse failure all settle it (it
  // never rejects). Consumers that must not query a half-loaded history await
  // this. Independent of the loadHistory() call's own promise so a caller can
  // await readiness without holding the loader's return value.
  ready: Promise<void>;
  // Async one-time load of the persisted history. Tolerates a missing file /
  // read error (leaves history empty) and skips malformed lines.
  loadHistory: () => Promise<void>;
  append: (sample: UsageSample) => void;
  // Two-way-sync entry point (ADR-0035): insert externally-captured samples
  // (hub backfill / live stream), dedup on capturedAt — the sample's identity,
  // see CONTEXT.md [[Usage sample]] — keep the in-memory array sorted, and
  // append each NEW sample to disk through the same ordered write chain.
  // Returns how many were new. Callers validate at the wire boundary; the
  // store trusts its input shape.
  merge: (incoming: UsageSample[]) => number;
  latest: () => UsageSample | null;
  all: () => UsageSample[];
};

// The factory returns a superset of the consumer contract: `flush()` resolves
// once every disk write queued so far has settled. The consumers (poller,
// /api/blocks) hold the narrower SampleStore and never need it — appends are
// fire-and-forget — but it gives a graceful-shutdown / deterministic-test
// barrier so pending writes don't outlive their context.
type OwnedSampleStore = SampleStore & { flush: () => Promise<void> };

export function createSampleStore(opts: { path: string }): OwnedSampleStore {
  const path = opts.path;
  const samples: UsageSample[] = [];
  // Persistent membership index over `samples` by capturedAt (the sample's
  // identity). Kept in lockstep with `samples` so merge() can dedup in O(1)
  // instead of rebuilding a Set (and re-sorting) on every — per-minute — call.
  const seen = new Set<string>();
  // Serializes the async disk writes so append ORDER is preserved on disk
  // without blocking the serving event loop. A failed write must not reject
  // into the poller, so each link swallows its own error.
  let writeChain: Promise<void> = Promise.resolve();

  // Readiness deferred (F6): resolved by the FIRST loadHistory() completion,
  // whichever path it takes. Idempotent — later loadHistory() calls don't
  // re-signal — and never rejects (load swallows every error).
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  // Insert `sample` keeping `samples` sorted ascending by capturedAt. capturedAt
  // is fixed-width ISO-8601 UTC (producers use new Date().toISOString()), so a
  // plain string compare is chronological — no Date.parse needed. Fast-path the
  // common in-order case; binary-search the rare out-of-order insert (a
  // future-dated merged sample now preceding a present-dated append). Does NOT
  // touch `seen` or disk — callers own membership + the write chain.
  function insert(sample: UsageSample): void {
    const tail = samples[samples.length - 1];
    if (tail === undefined || sample.capturedAt >= tail.capturedAt) {
      samples.push(sample);
      return;
    }
    // First slot whose capturedAt exceeds the new sample's; splice in there.
    let lo = 0;
    let hi = samples.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (samples[mid]!.capturedAt <= sample.capturedAt) lo = mid + 1;
      else hi = mid;
    }
    samples.splice(lo, 0, sample);
  }

  // Public loader: wraps the read/parse in a `finally` so `ready` settles on
  // EVERY exit — the file-missing early-return, a parse throw, or success.
  async function loadHistory(): Promise<void> {
    try {
      await loadHistoryInner();
    } finally {
      markReady();
    }
  }

  async function loadHistoryInner(): Promise<void> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      // ENOENT (first launch) or any other read failure — leave history empty.
      return;
    }
    // Parse into a temp array first, then merge — append() may have pushed
    // samples while the read was in flight, so dedup on capturedAt to avoid
    // double-counting a line the poller already holds in memory.
    const loaded: UsageSample[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed = usageSampleSchema.safeParse(JSON.parse(trimmed));
        if (parsed.success) loaded.push(parsed.data);
      } catch {
        // skip a corrupt line (e.g. a crash mid-write)
      }
    }
    // Bulk-push the new lines then sort once — cheaper than a binary insert per
    // line for a whole-history load (the array is empty or near-empty here).
    let pushedAny = false;
    for (const s of loaded) {
      if (seen.has(s.capturedAt)) continue;
      seen.add(s.capturedAt);
      samples.push(s);
      pushedAny = true;
    }
    if (pushedAny) {
      samples.sort((a, b) =>
        a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0,
      );
    }
  }

  function append(sample: UsageSample): void {
    // insert() keeps `samples` sorted unconditionally; the poller appends in
    // capturedAt order so this is the fast-path push in practice.
    insert(sample);
    seen.add(sample.capturedAt);
    // Push the disk write through a serialization chain so order is preserved
    // without blocking the loop. The in-memory insert above is synchronous, so
    // latest()/all() observe the sample immediately.
    const line = `${JSON.stringify(sample)}\n`;
    writeChain = writeChain
      .then(() => appendFile(path, line))
      .catch((err) => {
        console.warn("[usage-core] usage-history append failed:", err);
      });
  }

  function merge(incoming: UsageSample[]): number {
    let added = 0;
    for (const s of incoming) {
      if (seen.has(s.capturedAt)) continue;
      seen.add(s.capturedAt);
      // insert() sorts the sample into place — a merged sample can land anywhere
      // in time (future-dated remote samples, out-of-order backfill).
      insert(s);
      const line = `${JSON.stringify(s)}\n`;
      writeChain = writeChain
        .then(() => appendFile(path, line))
        .catch((err) => {
          console.warn("[usage-core] usage-history merge append failed:", err);
        });
      added += 1;
    }
    return added;
  }

  // Ensure the parent dir exists once at creation, not on every append.
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // best-effort — append's own catch reports a later write failure
  }

  return {
    ready,
    loadHistory,
    append,
    merge,
    latest: () => samples[samples.length - 1] ?? null,
    all: () => samples, // READ-ONLY — callers must not mutate
    flush: () => writeChain,
  };
}
