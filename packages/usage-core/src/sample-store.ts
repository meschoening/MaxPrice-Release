import { mkdirSync } from "node:fs";
import { appendFile, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { usageSampleSchema, type UsageSample } from "@maxprice/shared";

// The usage history (ADR-0024): an append-only JSONL on disk loaded into a
// sorted-by-capturedAt array in memory. The array is kept sorted UNCONDITIONALLY
// — append() and merge() insert each admitted sample in place, loadHistory()
// sorts once after its bulk admit — so the latest-sample reads (latest() here;
// latestSampleWindow + precomputeSamples' latestUtil in the engine's
// block-windows.ts, all `samples[len - 1]`) stay correct even after merge()
// inserts a future-dated remote sample (cross-machine clock skew) ahead of a
// later present-dated local append. Mirrors the engine's event store: cheap
// in-memory range queries, no database.
//
// IDENTITY (GLOSSARY.md [[Usage sample]]): a sample's key is
// (organizationUuid ?? legacy, capturedAt), so two Organizations read at the
// same millisecond are two samples. Admitting one incoming sample is the same
// everywhere: (a) its exact key is held → dropped; (b) it is unstamped and ANY
// stamped sample is held at its capturedAt → dropped, the stamped copy wins;
// (c) it is stamped and an unstamped sample is held at its capturedAt → it
// REPLACES that incumbent in memory and its line is appended to disk like any
// new one — the file then holds both lines, and load's same rules resolve
// either file order to the stamped copy; (d) otherwise it is added. Hence an
// unstamped sample held at t means no stamped sample is held at t. Membership
// is kept in persistent per-key buckets (the unstamped one, and one per
// Organization: a capturedAt Map beside that key's sorted array), so admission
// costs O(Organizations held), never a rebuild, and a scoped read never scans
// the whole history. The local poll is the single writer, but load tolerates
// concurrent appends via those same rules.
//
// STAMPING: stampUnstamped() is the only rewrite of the append-only file. One
// link on the write chain rewrites it text-preservingly — each unstamped line
// gains only `organizationUuid`, every other line stays byte-verbatim — through
// a synced `${path}.stamp-tmp` and a rename, and only then stamps the same
// samples in memory, so a failed stamp stamps nothing anywhere. Disk and memory
// then agree with one exception (stampHeld): a stamped copy for ANOTHER
// Organization merged at a stamped line's instant while the rewrite is in
// flight replaces the unstamped sample in memory (rule c), but the file keeps
// both stamped lines, so a reload holds one sample more. Production reaches it
// only after a failed load: the Hub stamps at boot before its routes open, and
// a client merges only samples newer than its latest — unless the load failed,
// its latest is null, and a full Hub backfill lands during the re-read stamp.
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

// Which samples a scoped read answers: those stamped with `organization`, plus
// the unstamped (legacy) ones when `organization` is `home`. An unstamped line
// is presumed the Home organization's AT QUERY TIME — the store holds no Home —
// so a Home change re-answers only the unstamped samples and moves no stamped
// one. `home: null` presumes the unstamped samples nobody's.
export type SampleScope = { organization: string; home: string | null };

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
  // Admits the sample by the identity rules above; when it changed the store,
  // its line is appended to disk through the ordered write chain.
  append: (sample: UsageSample) => void;
  // Two-way-sync entry point (ADR-0035): admit externally-captured samples
  // (hub backfill / live stream) by the identity rules above — the key is
  // (organizationUuid, capturedAt), see GLOSSARY.md [[Usage sample]] — keep the
  // in-memory array sorted, and append each admitted sample to disk through the
  // same ordered write chain. Returns how many incoming samples changed the
  // store: those added plus stamped copies that replaced an unstamped
  // incumbent. Callers validate at the wire boundary; the store trusts its
  // input shape.
  merge: (incoming: UsageSample[]) => number;
  // Unscoped: the newest sample held, across every Organization. Scoped: the
  // tail of all(scope).
  latest: {
    (): UsageSample | null;
    (scope: SampleScope): UsageSample | null;
  };
  // Unscoped: every sample held, ascending by capturedAt — the store's own
  // array, READ-ONLY (the Hub's sample endpoints, the push-up loop and the
  // history cursor read it). Scoped: the samples SampleScope selects, also
  // ascending; all()'s own array when that is every sample held (a store of
  // unstamped lines only, or of one Organization's), otherwise a read-only
  // array valid until the store's next mutation.
  all: {
    (): UsageSample[];
    (scope: SampleScope): readonly UsageSample[];
  };
  // Stamps every unstamped sample with `organizationUuid`, on disk and then in
  // memory (STAMPING above), resolving with the number of lines stamped. Waits
  // for `ready`; resolves 0 with no file I/O when no unstamped sample is held
  // and the load read the file, and 0 when the history file is missing. When
  // the load could not read it, the stamp reads it — rejecting while it is
  // still unreadable — and admits its lines as the load would have. A
  // read/write/rename failure rejects with no sample stamped in memory, and
  // later appends still land. Once the history has loaded, the link is queued
  // before this returns: an append made after the call is written after the
  // rewrite, and stays unstamped.
  stampUnstamped: (organizationUuid: string) => Promise<number>;
};

// The factory returns a superset of the consumer contract: `flush()` resolves
// once every disk write queued so far has settled. The consumers (poller,
// /api/blocks) hold the narrower SampleStore and never need it — appends are
// fire-and-forget — but it gives a graceful-shutdown / deterministic-test
// barrier so pending writes don't outlive their context.
type OwnedSampleStore = SampleStore & { flush: () => Promise<void> };

// One identity key's samples: `byTime` is the membership index (capturedAt →
// the sample held under this key there) and `sorted` the same samples ascending.
type Bucket = { byTime: Map<string, UsageSample>; sorted: UsageSample[] };

// What admitting one sample did, by the rule letters in the header.
type Admission =
  | { kind: "dropped" } // (a) or (b)
  | { kind: "added"; into: Bucket } // (d)
  | { kind: "replaced"; into: Bucket; incumbent: UsageSample }; // (c)

const DROPPED: Admission = { kind: "dropped" };
const NONE: readonly UsageSample[] = Object.freeze([]);

const newBucket = (): Bucket => ({ byTime: new Map(), sorted: [] });

// capturedAt is fixed-width ISO-8601 UTC (producers use new Date().toISOString()),
// so a plain string compare is chronological — no Date.parse needed.
function byCapturedAt(a: UsageSample, b: UsageSample): number {
  return a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0;
}

// Insert `sample` keeping `arr` sorted ascending by capturedAt. Fast-path the
// common in-order case; binary-search the rare out-of-order insert (a
// future-dated merged sample now preceding a present-dated append).
function insertSorted(arr: UsageSample[], sample: UsageSample): void {
  const tail = arr[arr.length - 1];
  if (tail === undefined || sample.capturedAt >= tail.capturedAt) {
    arr.push(sample);
    return;
  }
  // First slot whose capturedAt exceeds the new sample's; splice in there.
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]!.capturedAt <= sample.capturedAt) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, sample);
}

// Index of `sample` (by identity) in the sorted `arr` that holds it: binary
// search to its capturedAt, then step through that instant's samples.
function indexOf(arr: readonly UsageSample[], sample: UsageSample): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]!.capturedAt < sample.capturedAt) lo = mid + 1;
    else hi = mid;
  }
  for (; lo < arr.length; lo += 1) if (arr[lo] === sample) return lo;
  throw new Error("[usage-core] sample store index out of step with its buckets");
}

// Drop every element `gone` holds from `arr` in one in-place pass, keeping order.
function removeAll(arr: UsageSample[], gone: ReadonlySet<UsageSample>): void {
  let kept = 0;
  for (const s of arr) if (!gone.has(s)) arr[kept++] = s;
  arr.length = kept;
}

// Linear merge of two ascending arrays into a new ascending one.
function mergeSorted(a: readonly UsageSample[], b: readonly UsageSample[]): UsageSample[] {
  const out: UsageSample[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    out.push(byCapturedAt(a[i]!, b[j]!) <= 0 ? a[i++]! : b[j++]!);
  }
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

// The object of a history line that is a valid UNSTAMPED sample, else null —
// blank, corrupt, schema-invalid and already-stamped lines all stay verbatim.
function unstampedLine(line: string): { raw: Record<string, unknown>; capturedAt: string } | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsed = usageSampleSchema.safeParse(raw);
  if (!parsed.success || parsed.data.organizationUuid !== undefined) return null;
  return { raw: raw as Record<string, unknown>, capturedAt: parsed.data.capturedAt };
}

function isMissingFile(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ENOENT";
}

export function createSampleStore(opts: { path: string }): OwnedSampleStore {
  const path = opts.path;
  // Every sample held, ascending — all()'s array, never reassigned.
  const samples: UsageSample[] = [];
  // The per-key buckets over `samples`, kept in lockstep with it: `legacy` for
  // the unstamped samples, `stamped` one per Organization. A bucket, once made,
  // is never deleted (a stamped sample is never removed).
  const legacy = newBucket();
  const stamped = new Map<string, Bucket>();
  // Memoized scoped reads that had to interleave an Organization's bucket with
  // the unstamped one, by Organization; every mutation clears them.
  const views = new Map<string, readonly UsageSample[]>();
  // Serializes the async disk writes so append ORDER is preserved on disk
  // without blocking the serving event loop. A failed append must not reject
  // into the poller, so each append link swallows its own error.
  let writeChain: Promise<void> = Promise.resolve();

  // Readiness deferred (F6): resolved by the FIRST loadHistory() completion,
  // whichever path it takes. Idempotent — later loadHistory() calls don't
  // re-signal — and never rejects (load swallows every error). `loaded` lets
  // stampUnstamped() queue its link synchronously once it has settled.
  let loaded = false;
  // Set when the load could not read an existing file (any failure but
  // ENOENT, which is a first launch): memory then does not mirror the file, so
  // holding nothing unstamped says nothing about it. The stamp link's own read
  // clears this: it admits the file, or finds it missing.
  let loadFailed = false;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  function stampedAt(capturedAt: string): boolean {
    for (const bucket of stamped.values()) if (bucket.byTime.has(capturedAt)) return true;
    return false;
  }

  // The identity rules (header), applied to the membership indexes only — the
  // caller places the sample in the sorted arrays and owns the write chain.
  function admit(s: UsageSample): Admission {
    const t = s.capturedAt;
    const org = s.organizationUuid;
    if (org === undefined) {
      if (legacy.byTime.has(t) || stampedAt(t)) return DROPPED;
      legacy.byTime.set(t, s);
      return { kind: "added", into: legacy };
    }
    let into = stamped.get(org);
    if (into === undefined) {
      into = newBucket();
      stamped.set(org, into);
    } else if (into.byTime.has(t)) {
      return DROPPED;
    }
    into.byTime.set(t, s);
    const incumbent = legacy.byTime.get(t);
    if (incumbent === undefined) return { kind: "added", into };
    legacy.byTime.delete(t);
    return { kind: "replaced", into, incumbent };
  }

  // append()/merge()'s single-sample path: admit, place in the sorted arrays,
  // and queue the line. Returns whether the sample changed the store.
  function admitOne(s: UsageSample, failure: string): boolean {
    const admission = admit(s);
    if (admission.kind === "dropped") return false;
    if (admission.kind === "replaced") {
      // The incumbent is the only sample held at its capturedAt (rule b), so
      // the stamped copy takes its exact slot in the time order.
      samples[indexOf(samples, admission.incumbent)] = s;
      legacy.sorted.splice(indexOf(legacy.sorted, admission.incumbent), 1);
    } else {
      insertSorted(samples, s);
    }
    insertSorted(admission.into.sorted, s);
    views.clear();
    const line = `${JSON.stringify(s)}\n`;
    writeChain = writeChain
      .then(() => appendFile(path, line))
      .catch((err) => {
        console.warn(failure, err);
      });
    return true;
  }

  // Public loader: wraps the read/parse in a `finally` so `ready` settles on
  // EVERY exit — the file-missing early-return, a parse throw, or success.
  async function loadHistory(): Promise<void> {
    try {
      await loadHistoryInner();
    } finally {
      loaded = true;
      markReady();
    }
  }

  async function loadHistoryInner(): Promise<void> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      // ENOENT (first launch) or any other read failure — leave history empty.
      if (!isMissingFile(err)) loadFailed = true;
      return;
    }
    admitHistory(text);
  }

  // Admits the whole history file's text into memory: the load's path, and the
  // stamp link's when the load could not read the file.
  function admitHistory(text: string): void {
    // Parse into a temp array first, then admit — append() may have pushed
    // samples while the read was in flight, and the identity rules dedup a
    // line the poller already holds in memory.
    const parsedLines: UsageSample[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed = usageSampleSchema.safeParse(JSON.parse(trimmed));
        if (parsed.success) parsedLines.push(parsed.data);
      } catch {
        // skip a corrupt line (e.g. a crash mid-write)
      }
    }
    // Admit every line against the indexes, bulk-push the admitted ones, drop
    // the replaced incumbents in one pass, then sort once — a binary insert per
    // line is O(n²) over a whole history while the poller appends.
    const replaced = new Set<UsageSample>();
    const grown = new Set<Bucket>();
    for (const s of parsedLines) {
      const admission = admit(s);
      if (admission.kind === "dropped") continue;
      if (admission.kind === "replaced") replaced.add(admission.incumbent);
      samples.push(s);
      admission.into.sorted.push(s);
      grown.add(admission.into);
    }
    if (grown.size === 0) return;
    if (replaced.size > 0) {
      removeAll(samples, replaced);
      removeAll(legacy.sorted, replaced);
    }
    samples.sort(byCapturedAt);
    for (const bucket of grown) bucket.sorted.sort(byCapturedAt);
    views.clear();
  }

  function append(sample: UsageSample): void {
    // The in-memory placement is synchronous, so latest()/all() observe the
    // sample immediately; the poller appends in capturedAt order, so it is the
    // fast-path push in practice.
    admitOne(sample, "[usage-core] usage-history append failed:");
  }

  function merge(incoming: UsageSample[]): number {
    let changed = 0;
    for (const s of incoming) {
      // A merged sample can land anywhere in time (future-dated remote samples,
      // out-of-order backfill); admitOne sorts it into place.
      if (admitOne(s, "[usage-core] usage-history merge append failed:")) changed += 1;
    }
    return changed;
  }

  function all(): UsageSample[];
  function all(scope: SampleScope): readonly UsageSample[];
  function all(scope?: SampleScope): readonly UsageSample[] {
    if (scope === undefined) return samples; // READ-ONLY — callers must not mutate
    const own = stamped.get(scope.organization)?.sorted ?? NONE;
    const presumed = scope.organization === scope.home ? legacy.sorted : NONE;
    if (own.length + presumed.length === samples.length) return samples;
    if (presumed.length === 0) return own;
    if (own.length === 0) return presumed;
    let view = views.get(scope.organization);
    if (view === undefined) {
      view = mergeSorted(own, presumed);
      views.set(scope.organization, view);
    }
    return view;
  }

  function latest(): UsageSample | null;
  function latest(scope: SampleScope): UsageSample | null;
  function latest(scope?: SampleScope): UsageSample | null {
    if (scope === undefined) return samples[samples.length - 1] ?? null;
    // all(scope)'s tail without building it: the two tails never share an
    // instant (an unstamped sample held at t means no stamped one is), so the
    // later of them is the merged tail.
    const own = stamped.get(scope.organization)?.sorted.at(-1) ?? null;
    const presumed = scope.organization === scope.home ? (legacy.sorted.at(-1) ?? null) : null;
    if (own === null || presumed === null) return own ?? presumed;
    return presumed.capturedAt > own.capturedAt ? presumed : own;
  }

  async function stampUnstamped(organizationUuid: string): Promise<number> {
    if (!loaded) await ready;
    if (legacy.byTime.size === 0 && !loadFailed) return 0;
    const link = writeChain.then(() => stampLink(organizationUuid));
    // The chain continues past a failed stamp; the caller sees the rejection.
    writeChain = link.then(
      () => {},
      () => {},
    );
    return link;
  }

  // The write-chain link behind stampUnstamped(): every write queued before it
  // has settled, so the file holds every line it will ever hold before this
  // point. Reads memory at run time — a stamped copy merged since the link was
  // queued has already superseded its unstamped line.
  async function stampLink(organizationUuid: string): Promise<number> {
    // A link queued behind another stamp may find nothing left: still no I/O.
    if (legacy.byTime.size === 0 && !loadFailed) return 0;
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      // Any read failure rejects — after a failed load too, so a file whose
      // lines were never seen is never taken for stamped.
      if (!isMissingFile(err)) throw err;
      loadFailed = false; // a missing file holds nothing memory lacks
      return 0;
    }
    if (loadFailed) {
      // Admit the file as the load would have, BEFORE the rewrite: its own
      // stamped lines must supersede their unstamped twins here as everywhere,
      // and memory mirrors the file whether the rewrite then succeeds or fails.
      admitHistory(text);
      loadFailed = false;
      if (legacy.byTime.size === 0) return 0;
    }
    const stampedTimes = new Set<string>();
    const out: string[] = [];
    let count = 0;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const eol = i < lines.length - 1 ? "\n" : ""; // keeps the trailing newline as found
      const unstamped = unstampedLine(line);
      if (unstamped === null) {
        out.push(line + eol);
        continue;
      }
      // Superseded by rule (c): a stamped copy is held at this instant, so the
      // line goes (with its newline) rather than become a second sample.
      if (stampedAt(unstamped.capturedAt)) continue;
      out.push(JSON.stringify({ ...unstamped.raw, organizationUuid }) + eol);
      stampedTimes.add(unstamped.capturedAt);
      count += 1;
    }
    const tmp = `${path}.stamp-tmp`;
    try {
      // Durable before the rename (fleet-event-store's writeCompactSnapshot
      // barrier): the rename replaces the whole history, the only copy there
      // is, so a crash in the writeback window must not leave it truncated.
      const file = await open(tmp, "w");
      try {
        await file.writeFile(out.join(""));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, path);
    } catch (err) {
      // Best effort, then the original error: no temp file outlives a failure.
      await unlink(tmp).catch(() => {});
      throw err;
    }
    stampHeld(organizationUuid, stampedTimes);
    return count;
  }

  // Memory's half of a stamp, after the rename: every unstamped sample whose
  // capturedAt was stamped on disk moves to the Organization's bucket as a
  // stamped copy, keeping its slot in the time order.
  function stampHeld(organizationUuid: string, times: ReadonlySet<string>): void {
    const restamped = new Map<UsageSample, UsageSample>();
    for (const t of times) {
      const s = legacy.byTime.get(t);
      // Gone only if a stamped copy was merged while the rewrite was in flight
      // (rule c already replaced it); the file then holds both stamped lines.
      if (s === undefined) continue;
      restamped.set(s, { ...s, organizationUuid });
      legacy.byTime.delete(t);
    }
    if (restamped.size === 0) return;
    let into = stamped.get(organizationUuid);
    if (into === undefined) {
      into = newBucket();
      stamped.set(organizationUuid, into);
    }
    const kept: UsageSample[] = [];
    const moved: UsageSample[] = [];
    for (const s of legacy.sorted) {
      const copy = restamped.get(s);
      if (copy === undefined) kept.push(s);
      else moved.push(copy);
    }
    legacy.sorted = kept;
    for (const copy of moved) into.byTime.set(copy.capturedAt, copy);
    into.sorted = mergeSorted(into.sorted, moved);
    for (let i = 0; i < samples.length; i += 1) {
      const copy = restamped.get(samples[i]!);
      if (copy !== undefined) samples[i] = copy;
    }
    views.clear();
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
    latest,
    all,
    stampUnstamped,
    flush: () => writeChain,
  };
}
