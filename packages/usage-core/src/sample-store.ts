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
// IDENTITY (GLOSSARY.md [[Usage sample]], ADR-0139 §8): a sample's key is
// (accountUuid ?? none, organizationUuid ?? none, capturedAt), so two
// Organizations, or two Accounts reading one Organization, at the same
// millisecond are two samples. One sample COVERS another at the same instant
// when it carries every stamp the other carries, with the same value, and at
// least one more: an Organization-stamped sample covers the unstamped one, and
// an Account-stamped one the same Organization's Account-less one. Admitting
// one incoming sample is the same everywhere: (a) its exact key is held →
// dropped; (b) a held sample at its capturedAt covers it → dropped, the
// stamped copy wins; (c) it covers held samples at its capturedAt → it
// REPLACES them in memory and its line is appended to disk like any new one —
// the file then holds both lines, and load's same rules resolve either file
// order to the stamped copy; (d) otherwise it is added. Hence a sample held at
// t means no sample covering it is held at t. Membership is kept in persistent
// per-key buckets (one per (Organization, Account) stamp pair, each a
// capturedAt Map beside that key's sorted array) and an instant index, so
// admission costs O(samples held at that instant), never a rebuild, and a
// scoped read never scans the whole history. The local poll is the single
// writer, but load tolerates concurrent appends via those same rules.
//
// STAMPING: stampUnstamped() (the Organization, ADR-0104) and
// stampAccountless() (the Account, ADR-0139 §8) are the only rewrites of the
// append-only file. One link on the write chain rewrites it
// text-preservingly — each line lacking the stamp gains only that field, every
// other line stays byte-verbatim, and a line a held sample covers goes — through
// a synced `${path}.stamp-tmp` and a rename, and only then stamps the same
// samples in memory, so a failed stamp stamps nothing anywhere. Memory is then
// re-indexed by the identity rules, so it holds what a reload of the file
// would, with one exception: a stamped copy merged at a line's instant while
// the rewrite is in flight replaces the sample in memory (rule c), and a
// reload of a file holding both may keep one sample more where the two do not
// cover each other. Production reaches it only when the merged copy's stamp
// differs from the one the rewrite gives: an Organization stamp after a failed
// load (the Hub stamps it at boot before its routes open, and a client merges
// only samples newer than its latest — unless the load failed, its latest is
// null, and a full Hub backfill lands during the re-read stamp), or an Account
// stamp of another Account than the move's, merged during the move's stamp by
// the cursorless sample exchange (hub-client.ts, #634) or a push to the Hub. A
// copy of the rewrite's own stamp is the rewritten line's twin on reload.
//
// LOCAL STAMP TIME (ADR-0139 §8, #634): `localSamplesStampedAt` is when this
// store's own stamping (either stamp above) last stamped a sample — never a
// merge, which only carries another side's stamps here. A client's cursorless
// sample exchange (hub-client.ts) runs again once it moves. With `stampsPath`
// it is durable: the link writes it there (a synced temp and a rename) BEFORE
// the history's rename, so a crash between the two can only make it newer than
// the stamp — one exchange too many, never one too few — and loadHistory()
// reads it back. Without one it lives in memory.
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
//
// `membership` narrows the read to one Membership (#633): the samples its
// Account's key read, plus the Account-less ones when that Account is the Home
// membership's (`homeAccount`; ADR-0137 §3's presumption at query time), or
// when no Home membership's Account is known (`homeAccount: null`), since an
// Account-less sample then has no presumption to lose. Without it every
// Account's samples of the Organization answer, as before.
export type SampleScope = {
  organization: string;
  home: string | null;
  membership?: { account: string; homeAccount: string | null };
};

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
  // (accountUuid, organizationUuid, capturedAt), see GLOSSARY.md [[Usage
  // sample]] — keep the in-memory array sorted, and append each admitted
  // sample to disk through the same ordered write chain. `changed` counts the
  // incoming samples that changed the store: those added plus stamped copies
  // that replaced a less-stamped incumbent. `stamped` counts, among those
  // replacements, the ones that gave a held Account-less sample its Account
  // (the Hub's `samplesStampedAt`, ADR-0139 §8): a report only, the store
  // keeps the same either way. Callers validate at the wire boundary; the
  // store trusts its input shape.
  merge: (incoming: UsageSample[]) => MergeResult;
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
  // The same for the Account (ADR-0139 §8, #633): stamps every Account-less
  // sample with `accountUuid`, by stampUnstamped's contract above, run once at
  // ADR-0138 §12's move from the key's Account. No file I/O when no
  // Account-less sample is held and the load read the file.
  stampAccountless: (accountUuid: string) => Promise<number>;
  // When this store's own stamping last stamped a sample (LOCAL STAMP TIME
  // above); null until then, and before loadHistory() read `stampsPath`.
  localSamplesStampedAt: () => string | null;
};

export type MergeResult = { changed: number; stamped: number };

// The factory returns a superset of the consumer contract: `flush()` resolves
// once every disk write queued so far has settled. The consumers (poller,
// /api/blocks) hold the narrower SampleStore and never need it — appends are
// fire-and-forget — but it gives a graceful-shutdown / deterministic-test
// barrier so pending writes don't outlive their context.
type OwnedSampleStore = SampleStore & { flush: () => Promise<void> };

// One identity key's samples: `byTime` is the membership index (capturedAt →
// the sample held under this key there) and `sorted` the same samples
// ascending. `org` and `account` are the key's stamps (undefined: none).
type Bucket = {
  key: string;
  org: string | undefined;
  account: string | undefined;
  byTime: Map<string, UsageSample>;
  sorted: UsageSample[];
};

// What admitting one sample did, by the rule letters in the header.
type Admission =
  | { kind: "dropped" } // (a) or (b)
  | { kind: "added"; into: Bucket } // (d)
  | { kind: "replaced"; into: Bucket; incumbents: UsageSample[] }; // (c)

type StampField = "organizationUuid" | "accountUuid";

const DROPPED: Admission = { kind: "dropped" };
const NONE: readonly UsageSample[] = Object.freeze([]);

// The identity key less the instant. NUL separates: no stamp holds one.
const identityKey = (s: Pick<UsageSample, "organizationUuid" | "accountUuid">): string =>
  `${s.organizationUuid ?? ""}\u0000${s.accountUuid ?? ""}`;

// Whether `a` covers `b` (header): every stamp `b` carries `a` carries alike,
// and the two are not the same key.
function covers(a: UsageSample, b: UsageSample): boolean {
  return (
    (b.organizationUuid === undefined || b.organizationUuid === a.organizationUuid) &&
    (b.accountUuid === undefined || b.accountUuid === a.accountUuid) &&
    identityKey(a) !== identityKey(b)
  );
}

// capturedAt is fixed-width ISO-8601 UTC (producers use new Date().toISOString()),
// so a plain string compare is chronological — no Date.parse needed. Exported
// for the Hub's restore, which merges client histories in this order (ADR-0130 §4).
export function byCapturedAt(a: UsageSample, b: UsageSample): number {
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

// The object of a history line that is a valid sample lacking `field`, else
// null — blank, corrupt, schema-invalid and already-stamped lines all stay
// verbatim.
function unstampedLine(
  line: string,
  field: StampField,
): { raw: Record<string, unknown>; sample: UsageSample } | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsed = usageSampleSchema.safeParse(raw);
  if (!parsed.success || parsed.data[field] !== undefined) return null;
  return { raw: raw as Record<string, unknown>, sample: parsed.data };
}

function isMissingFile(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ENOENT";
}

async function syncedWrite(path: string, text: string): Promise<void> {
  const file = await open(path, "w");
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
}

// A small file replaced whole: a synced temp beside it, then a rename.
async function writeDurably(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  try {
    await syncedWrite(tmp, text);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// The persisted LOCAL STAMP TIME, or null: missing, unreadable or malformed
// reads as never stamped (the next stamp writes it whole).
async function readStampedAt(path: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { localSamplesStampedAt?: unknown };
    const value = raw?.localSamplesStampedAt;
    return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

export function createSampleStore(opts: {
  path: string;
  // Where `localSamplesStampedAt` persists (LOCAL STAMP TIME); none: memory.
  stampsPath?: string;
  now?: () => number;
}): OwnedSampleStore {
  const path = opts.path;
  const stampsPath = opts.stampsPath;
  const now = opts.now ?? Date.now;
  let localStampedAt: string | null = null;
  // Every sample held, ascending — all()'s array, never reassigned.
  const samples: UsageSample[] = [];
  // The per-key buckets over `samples`, kept in lockstep with it, by
  // identityKey. A bucket, once made, is never deleted.
  const buckets = new Map<string, Bucket>();
  // Every sample held at each instant: admission's index.
  const atTime = new Map<string, UsageSample[]>();
  // Memoized scoped reads that had to interleave several buckets, by the
  // buckets' keys; every mutation clears them.
  const views = new Map<string, readonly UsageSample[]>();
  // Serializes the async disk writes so append ORDER is preserved on disk
  // without blocking the serving event loop. A failed append must not reject
  // into the poller, so each append link swallows its own error.
  let writeChain: Promise<void> = Promise.resolve();

  // Readiness deferred (F6): resolved by the FIRST loadHistory() completion,
  // whichever path it takes. Idempotent — later loadHistory() calls don't
  // re-signal — and never rejects (load swallows every error). `loaded` lets
  // a stamp queue its link synchronously once it has settled.
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

  function bucketFor(s: UsageSample): Bucket {
    const key = identityKey(s);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        key,
        org: s.organizationUuid,
        account: s.accountUuid,
        byTime: new Map(),
        sorted: [],
      };
      buckets.set(key, bucket);
    }
    return bucket;
  }

  // Whether a held sample covers `s` at its instant: a line lacking a stamp
  // that memory already holds a stamped copy of.
  function covered(s: UsageSample): boolean {
    return (atTime.get(s.capturedAt) ?? NONE).some((held) => covers(held, s));
  }

  // How many held samples lack `field`.
  function lacking(field: StampField): number {
    let count = 0;
    for (const bucket of buckets.values()) {
      const stamp = field === "organizationUuid" ? bucket.org : bucket.account;
      if (stamp === undefined) count += bucket.byTime.size;
    }
    return count;
  }

  // The identity rules (header), applied to the membership indexes only — the
  // caller places the sample in the sorted arrays and owns the write chain.
  function admit(s: UsageSample): Admission {
    const t = s.capturedAt;
    const key = identityKey(s);
    const held = atTime.get(t) ?? [];
    for (const h of held) if (identityKey(h) === key || covers(h, s)) return DROPPED;
    const incumbents = held.filter((h) => covers(s, h));
    const into = bucketFor(s);
    into.byTime.set(t, s);
    for (const incumbent of incumbents) bucketFor(incumbent).byTime.delete(t);
    atTime.set(t, [...held.filter((h) => !incumbents.includes(h)), s]);
    return incumbents.length === 0
      ? { kind: "added", into }
      : { kind: "replaced", into, incumbents };
  }

  // append()/merge()'s single-sample path: admit, place in the sorted arrays,
  // and queue the line. Returns what the admission did.
  function admitOne(s: UsageSample, failure: string): Admission {
    const admission = admit(s);
    if (admission.kind === "dropped") return admission;
    if (admission.kind === "replaced") {
      // The stamped copy takes its first incumbent's exact slot in the time
      // order; any other incumbent (one it covers on another axis) goes.
      const [first, ...rest] = admission.incumbents;
      samples[indexOf(samples, first!)] = s;
      for (const incumbent of rest) samples.splice(indexOf(samples, incumbent), 1);
      for (const incumbent of admission.incumbents) {
        const own = bucketFor(incumbent).sorted;
        own.splice(indexOf(own, incumbent), 1);
      }
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
    return admission;
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
    if (stampsPath !== undefined) localStampedAt = await readStampedAt(stampsPath);
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
    admitBulk(parsedLines);
  }

  // Admits many samples at once: every one against the indexes, a bulk push
  // of the admitted ones, one pass dropping the replaced incumbents, then one
  // sort — a binary insert per line is O(n²) over a whole history.
  function admitBulk(incoming: readonly UsageSample[]): void {
    const replaced = new Set<UsageSample>();
    const grown = new Set<Bucket>();
    const shrunk = new Set<Bucket>();
    for (const s of incoming) {
      const admission = admit(s);
      if (admission.kind === "dropped") continue;
      if (admission.kind === "replaced") {
        for (const incumbent of admission.incumbents) {
          replaced.add(incumbent);
          shrunk.add(bucketFor(incumbent));
        }
      }
      samples.push(s);
      admission.into.sorted.push(s);
      grown.add(admission.into);
    }
    if (grown.size === 0) return;
    if (replaced.size > 0) {
      removeAll(samples, replaced);
      for (const bucket of shrunk) removeAll(bucket.sorted, replaced);
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

  function merge(incoming: UsageSample[]): MergeResult {
    let changed = 0;
    let stamped = 0;
    for (const s of incoming) {
      // A merged sample can land anywhere in time (future-dated remote samples,
      // out-of-order backfill); admitOne sorts it into place.
      const admission = admitOne(s, "[usage-core] usage-history merge append failed:");
      if (admission.kind === "dropped") continue;
      changed += 1;
      if (
        admission.kind === "replaced" &&
        s.accountUuid !== undefined &&
        admission.incumbents.some((incumbent) => incumbent.accountUuid === undefined)
      ) {
        stamped += 1;
      }
    }
    return { changed, stamped };
  }

  // The buckets a scope reads (SampleScope), in creation order.
  function scoped(scope: SampleScope): Bucket[] {
    const m = scope.membership;
    const presumeAccount =
      m !== undefined && (m.homeAccount === null || m.homeAccount === m.account);
    return [...buckets.values()].filter(
      (b) =>
        (b.org === scope.organization ||
          (b.org === undefined && scope.organization === scope.home)) &&
        (m === undefined || b.account === m.account || (b.account === undefined && presumeAccount)),
    );
  }

  function all(): UsageSample[];
  function all(scope: SampleScope): readonly UsageSample[];
  function all(scope?: SampleScope): readonly UsageSample[] {
    if (scope === undefined) return samples; // READ-ONLY — callers must not mutate
    const read = scoped(scope).filter((b) => b.sorted.length > 0);
    const count = read.reduce((n, b) => n + b.sorted.length, 0);
    if (count === samples.length) return samples;
    if (read.length === 0) return NONE;
    if (read.length === 1) return read[0]!.sorted;
    const memo = read.map((b) => b.key).join("\u0001");
    let view = views.get(memo);
    if (view === undefined) {
      view = read
        .slice(1)
        .reduce<readonly UsageSample[]>((acc, b) => mergeSorted(acc, b.sorted), read[0]!.sorted);
      views.set(memo, view);
    }
    return view;
  }

  function latest(): UsageSample | null;
  function latest(scope: SampleScope): UsageSample | null;
  function latest(scope?: SampleScope): UsageSample | null {
    if (scope === undefined) return samples[samples.length - 1] ?? null;
    // all(scope)'s tail without building it: the latest of the buckets' tails,
    // a later bucket winning a tie as mergeSorted's order does.
    let best: UsageSample | null = null;
    for (const bucket of scoped(scope)) {
      const tail = bucket.sorted.at(-1);
      if (tail !== undefined && (best === null || tail.capturedAt >= best.capturedAt)) best = tail;
    }
    return best;
  }

  async function stamp(field: StampField, value: string): Promise<number> {
    if (!loaded) await ready;
    if (lacking(field) === 0 && !loadFailed) return 0;
    const link = writeChain.then(() => stampLink(field, value));
    // The chain continues past a failed stamp; the caller sees the rejection.
    writeChain = link.then(
      () => {},
      () => {},
    );
    return link;
  }

  // The write-chain link behind a stamp: every write queued before it has
  // settled, so the file holds every line it will ever hold before this point.
  // Reads memory at run time — a stamped copy merged since the link was queued
  // has already superseded its line.
  async function stampLink(field: StampField, value: string): Promise<number> {
    // A link queued behind another stamp may find nothing left: still no I/O.
    if (lacking(field) === 0 && !loadFailed) return 0;
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
      if (lacking(field) === 0) return 0;
    }
    // The identities stamped on disk: instant, then the line's own key.
    const stampedIds = new Set<string>();
    const out: string[] = [];
    let count = 0;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const eol = i < lines.length - 1 ? "\n" : ""; // keeps the trailing newline as found
      const unstamped = unstampedLine(line, field);
      if (unstamped === null) {
        out.push(line + eol);
        continue;
      }
      // Superseded by rule (c): a stamped copy is held at this instant, so the
      // line goes (with its newline) rather than become a second sample.
      if (covered(unstamped.sample)) continue;
      out.push(JSON.stringify({ ...unstamped.raw, [field]: value }) + eol);
      stampedIds.add(`${unstamped.sample.capturedAt}\u0001${identityKey(unstamped.sample)}`);
      count += 1;
    }
    // LOCAL STAMP TIME: durable before the history's rename, and a failure
    // here fails the stamp like any other.
    const stampedAt = count > 0 ? new Date(now()).toISOString() : null;
    if (stampedAt !== null && stampsPath !== undefined) {
      await writeDurably(stampsPath, `${JSON.stringify({ localSamplesStampedAt: stampedAt })}\n`);
    }
    const tmp = `${path}.stamp-tmp`;
    try {
      // Durable before the rename (the barrier the JSONL fleet store's
      // compaction kept, until #396 deleted it): the rename replaces the whole
      // history, the only copy there is, so a crash in the writeback window
      // must not leave it truncated.
      await syncedWrite(tmp, out.join(""));
      await rename(tmp, path);
    } catch (err) {
      // Best effort, then the original error: no temp file outlives a failure.
      await unlink(tmp).catch(() => {});
      throw err;
    }
    stampHeld(field, value, stampedIds);
    if (stampedAt !== null) localStampedAt = stampedAt;
    return count;
  }

  // Memory's half of a stamp, after the rename: every held sample whose
  // identity was stamped on disk becomes its stamped copy, keeping its slot in
  // the time order, and the indexes are rebuilt by the identity rules, so a
  // copy that now covers another held sample replaces it as a reload would.
  function stampHeld(field: StampField, value: string, ids: ReadonlySet<string>): void {
    let changed = false;
    const next = samples.map((s) => {
      if (s[field] !== undefined || !ids.has(`${s.capturedAt}\u0001${identityKey(s)}`)) return s;
      changed = true;
      return { ...s, [field]: value };
    });
    if (!changed) return;
    samples.length = 0;
    buckets.clear();
    atTime.clear();
    admitBulk(next);
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
    stampUnstamped: (organizationUuid) => stamp("organizationUuid", organizationUuid),
    stampAccountless: (accountUuid) => stamp("accountUuid", accountUuid),
    localSamplesStampedAt: () => localStampedAt,
    flush: () => writeChain,
  };
}
