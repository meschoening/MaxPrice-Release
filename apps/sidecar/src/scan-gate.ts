// The corpus-walk gate (ADR-0059).
//
// A [[Corpus walk]] — the full re-read of every `.jsonl` under the watched
// roots — has four callers: the boot scan and the settings-roots-change scan
// (both via `scanAndPoke`), the fleet's in-session engine rebuild (`fleet.ts`,
// which walks a FRESH store), and `POST /api/rescan`. Each is individually
// safe against the others: the store's `(messageId, requestId)` dedup makes
// overlapping walks merge-only (ADR-0019). What they are not is *cheap*
// together — the sidecar has one JS thread, so two concurrent walks do not
// halve each other's latency, they add their parse+upsert blocks to the same
// loop and starve every request queued behind them. Issue #115's reproduction
// is exactly that shape: a rescan aborted at the renderer's ceiling, the
// user clicked again, and attempt 2 ran while attempt 1's abandoned walk was
// still going.
//
// So every walk goes through one gate:
//
//   run           — serialize. At most one walk runs at a time, process-wide.
//   runCoalesced  — serialize, but a caller arriving while a walk with the
//                   same key is QUEUED joins it instead of queueing a third.
//
// `runCoalesced` is what makes a second refresh gesture cheap without making
// it a lie. It coalesces onto the *queued* walk, never onto the *running* one:
// a walk already underway may have read the disk before the second gesture
// happened, and reporting its result would answer a question the user asked
// later than the evidence. The queued walk always starts after the gesture
// that joined it, so its count is honest for every one of its callers.
//
// One shared instance (`scanGate` below) rather than a `BuildAppDeps` field:
// the invariant is "at most one walk in this PROCESS", and a per-construction
// dep is a thing a future call site can forget to pass — or pass a second gate
// to, which silently reinstates the concurrency this exists to remove. The
// factory stays exported so the gate's own tests drive an isolated one.

const NOOP = (): void => {};

export type ScanGate = {
  /**
   * Run `walk` as the next corpus walk, serialized against every other walk on
   * this gate.
   *
   * REJECTION is contained: it propagates to THIS caller only, and the chain
   * keeps a swallowed copy, so one failed walk cannot wedge every later one.
   *
   * NON-SETTLEMENT is NOT contained, and the two are not the same thing. A walk
   * that never settles — a hung `readdir` on a dead network mount — owns the
   * chain for the process lifetime: the roots-change scan, `fleet.ts`'s
   * `rebuildEngine`, and every future rescan queue behind it forever.
   *
   * That is deliberate, not an oversight. Racing a deadline here would be
   * WORSE: `store.scan` takes no `AbortSignal`, so dropping a walk off the
   * chain does not cancel it — the abandoned walk keeps parsing and upserting
   * concurrently with its successor, reinstating exactly the single-thread
   * contention this gate exists to remove and making `added` unattributable.
   * It would also reject `rebuildEngine`, which then never calls `swapStore` —
   * so the replica toggle silently never takes effect while an orphaned scan
   * writes into a store nobody swaps in.
   *
   * The user-visible surface is already covered: the renderer races POST
   * /api/rescan against its own 120 s deadlock breaker and writes a durable
   * `manual-refresh: timed out` line (ADR-0059). This module's contribution is
   * observability only — see WEDGE_WARN_MS below.
   */
  run: <T>(walk: () => Promise<T>) => Promise<T>;
  /**
   * `run`, plus coalescing on `key`: if a walk with this key is queued and has
   * not started yet, join it and share its result rather than queueing another.
   * The slot is released the moment the walk starts, so the next caller queues
   * a fresh follow-up rather than joining work whose disk read predates them.
   */
  runCoalesced: <T>(key: string, walk: () => Promise<T>) => Promise<T>;
};

// How long a walk may own the chain before we say so out loud. 10 min is ~175x
// the measured 3.4 s fully-cold whole-corpus re-parse (1253 files / 650 MB), so
// a line here means "this walk is not coming back", never "this corpus is big".
// Observability only — nothing is cancelled, nothing is dropped (see `run`).
export const WEDGE_WARN_MS = 600_000;

/** Timer seam, mirroring the repo's `nowImpl` / `setIntervalImpl` pattern, so
 *  the wedge-warning tests drive the deadline without faking globals. */
export type ScanGateOptions = {
  setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
};

export function createScanGate(opts: ScanGateOptions = {}): ScanGate {
  const setTimeoutImpl =
    opts.setTimeoutImpl ??
    ((callback: () => void, ms: number): unknown => setTimeout(callback, ms));
  const clearTimeoutImpl =
    opts.clearTimeoutImpl ??
    ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));

  // The serialization point. Every `run` appends to this; the tail is kept
  // non-rejecting (the `NOOP, NOOP` below) so a walk that throws is that
  // caller's problem and nobody else's.
  let chain: Promise<unknown> = Promise.resolve();
  // Queued-but-not-started walks by key. At most one entry per key at a time.
  const queued = new Map<string, Promise<unknown>>();

  function run<T>(walk: () => Promise<T>): Promise<T> {
    // `then(walk, walk)` — run regardless of how the predecessor settled. The
    // returned `next` carries this walk's own outcome to its own caller; the
    // chain moves on to a swallowed copy so the next walk starts either way.
    const next = chain.then(walk, walk);
    chain = next.then(NOOP, NOOP);
    // A non-settling walk owns the chain forever and there is no safe way to
    // take it back (see `run`'s doc) — so the least we do is leave a trace.
    // console.error is teed into sidecar.log (ADR-0056), which is the durable
    // record ADR-0059 decision 4 exists for. The timer arms at QUEUE time, not
    // at start, so a walk stuck *behind* a wedge reports the same symptom: from
    // its caller's seat, "still running" and "still queued" are one condition.
    const warn = setTimeoutImpl(() => {
      console.error(
        `[scan-gate] corpus walk still running after ${WEDGE_WARN_MS}ms — every later walk is blocked behind it`,
      );
    }, WEDGE_WARN_MS);
    // Must never hold the process open: an un-unref'd 10-minute timer would
    // keep the compiled Bun sidecar alive after its parent is reaped, which is
    // the ADR-0002 watchdog contract. Optional-called — a seam (or a browser
    // timer id) has no unref.
    (warn as { unref?: () => void }).unref?.();
    void next.then(
      () => clearTimeoutImpl(warn),
      () => clearTimeoutImpl(warn),
    );
    return next;
  }

  function runCoalesced<T>(key: string, walk: () => Promise<T>): Promise<T> {
    const existing = queued.get(key);
    // The cast is sound by construction: a key identifies one call-site
    // INSTANCE — `mintRescanWalkKey` below hands each app its own — so every
    // walk sharing a key produces the same result type, over the same store.
    if (existing !== undefined) return existing as Promise<T>;

    // `run` appends to a promise chain, so it NEVER invokes `walk`
    // synchronously — `slot.promise` is therefore always assigned before the
    // wrapper below can read it. Held in a holder object rather than a `let`
    // so that fact is local and needs no temporal-dead-zone reasoning.
    const slot: { promise?: Promise<T> } = {};
    const promise = run(() => {
      // Started — release the slot. A caller arriving from here on queues its
      // own follow-up instead of joining a read that is already underway.
      if (queued.get(key) === slot.promise) queued.delete(key);
      return walk();
    });
    slot.promise = promise;
    queued.set(key, promise);
    return promise;
  }

  return { run, runCoalesced };
}

/** Key prefix for `POST /api/rescan`'s walk — see `mintRescanWalkKey`. */
export const RESCAN_WALK_KEY = "rescan";

let rescanKeySeq = 0;
/** A per-app rescan coalescing key. `run` stays process-wide (that is the
 *  ADR-0059 invariant); coalescing must identify the WORK, and a rescan's
 *  result describes one app's store — so two apps in one process (the fleet
 *  test rigs) must not share a slot. */
export const mintRescanWalkKey = (): string => `${RESCAN_WALK_KEY}:${rescanKeySeq++}`;

/**
 * The process's one corpus-walk gate. Imported directly by every walk site
 * (`scanAndPoke`, `fleet.rebuildEngine`, the rescan handler) — see the module
 * comment for why this is a shared instance and not an injected dep.
 */
export const scanGate: ScanGate = createScanGate();
