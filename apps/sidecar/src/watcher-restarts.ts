import type { Watcher } from "./watcher";

// The JSONL watcher's one restart path (ADR-0014, ADR-0113). Two things
// replace the watcher: a `claudePaths` edit, which `settings-watch.ts` turns
// into a roots re-check, and a watch loss, which the watcher itself reports
// (#338). Both go through the one serialized chain here, so a recovery and a
// settings restart can never interleave, or swap the watcher out from under
// each other.
//
// Extracted from `main()` so the reentrancy-safe orchestration is a single
// named, testable unit. The JSONL-watcher factory, the roots resolver and the
// install callback are all injected, so a unit test can drive the whole state
// machine with fakes and never touch the real filesystem.

// Why a restart ran: `roots` for a re-check that found new roots, `recovery`
// for a watch loss on unchanged ones.
export type RestartReason = "roots" | "recovery";

export type CreateWatcherRestartsOptions = {
  // Re-resolve the JSONL roots from settings.json (falling back to
  // $CLAUDE_CONFIG_DIR on a missing/unparseable file). Read on every re-check;
  // a parse failure surfacing as the fallback roots is simply "no change"
  // when it equals the current roots.
  resolveRoots: () => Promise<string[]>;
  // The installed watcher's roots and the watcher itself, read fresh on each
  // restart so a coalesced follow-up compares against what the previous
  // restart installed. The caller owns both; `onReplaced` is their sole writer.
  getCurrentRoots: () => string[];
  getCurrentWatcher: () => Watcher | null;
  // Build a JSONL watcher for `roots`. Injected (rather than importing
  // `createWatcher` directly) so `main()` keeps the single shared option
  // builder and tests can supply fakes.
  createJsonlWatcher: (roots: string[]) => Promise<Watcher>;
  // Install a completed restart: record the new watcher and its roots. Called
  // exactly once per restart, after the replacement is live; the superseded
  // watcher is closed right after, so the installed watcher is the only live
  // one.
  onReplaced: (next: { watcher: Watcher; roots: string[] }) => void;
  // Walk the roots once the replacement is installed. After a roots change it
  // pulls in history under the new roots; after a recovery, writes the dead
  // watches missed. The event store's `(messageId, requestId)` dedup makes the
  // full-set walk safe (non-minimal but correct — see ADR-0014).
  scan: (roots: string[], reason: RestartReason) => void;
  // A restart attempt failed: `resolveRoots()` or `createJsonlWatcher()`
  // rejected. The watcher still installed is the PREVIOUS one, and nothing
  // else signals that: the loop below logs and moves on, and a failed restart
  // leaves no trace on the status snapshot. The caller raises
  // `watcherDegraded`. Fired once per failed iteration.
  onRestartFailed?: (err: unknown) => void;
  // Recovery hit its bound (RECOVERY_LIMIT) and stopped restarting: the
  // installed watcher keeps its dead watches until a roots change or a
  // relaunch. The caller raises `watcherDegraded`. Fired once per episode.
  onRecoveryExhausted?: () => void;
  // Injectable clock for the recovery bound.
  now?: () => number;
};

export type WatcherRestarts = {
  // The settings may name new roots: re-resolve them, and restart if they
  // changed.
  recheckRoots: () => void;
  // `lost` reports watches it cannot get back: restart it on its own roots,
  // unless it has been replaced since.
  recover: (lost: Watcher) => void;
  // Stop taking requests and drain the chain. A restart already owed still
  // runs and installs; the caller's own shutdown closes what it installed.
  close: () => Promise<void>;
};

// The recovery bound (ADR-0113). A watch loss within RECOVERY_QUIET_MS of
// the previous one continues the same incident; after RECOVERY_LIMIT
// restarts in one incident the tree is taken to be failing for good, and
// recovery stops until a minute passes with no loss at all. Each recovery
// walks the whole corpus; if a concurrent engine rebuild swaps stores during
// it, the walk repeats on the replacement. The bound counts restarts, rather
// than exact walks. Three covers a tree rebuilt a few times in quick
// succession, as the test-fixture builder #338 was observed under does. A minute is far
// longer than one rebuild, whose burst lands within 40 ms.
export const RECOVERY_LIMIT = 3;
export const RECOVERY_QUIET_MS = 60_000;

function rootsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

export function createWatcherRestarts(opts: CreateWatcherRestartsOptions): WatcherRestarts {
  const now = opts.now ?? Date.now;

  // Reentrancy guard (review I1). A request can arrive while a prior
  // restart's `await createJsonlWatcher(...)` is still pending (a user editing
  // paths twice quickly; macOS double-fires `change`; a watch loss during a
  // settings restart). Without serialization two restarts interleave: both
  // read the same stale current roots, both build a new watcher, and the first
  // one's watcher leaks.
  //
  // So restarts are strictly serialized through `chain`, and what a request
  // asks for is recorded as owed (`recheckOwed`, `lossOwed`) and read once per
  // iteration — requests that arrive mid-restart coalesce into a single
  // follow-up, which re-reads the roots and the installed watcher, so it
  // compares against what the just-finished restart installed.
  let chain: Promise<void> = Promise.resolve();
  let running = false;
  let recheckOwed = false;
  let lossOwed: Watcher | null = null;
  let closed = false;

  // The recovery bound's state: restarts in the current incident, when the
  // last loss was heard, and whether this episode's exhaustion was reported.
  let incidentRestarts = 0;
  let lastLossAt = Number.NEGATIVE_INFINITY;
  let exhausted = false;

  function recoveryAllowed(): boolean {
    const at = now();
    if (at - lastLossAt > RECOVERY_QUIET_MS) {
      incidentRestarts = 0;
      exhausted = false;
    }
    lastLossAt = at;
    if (incidentRestarts >= RECOVERY_LIMIT) {
      if (!exhausted) {
        exhausted = true;
        console.error(
          `[sidecar] watch recovery exhausted: ${RECOVERY_LIMIT} restarts without a quiet minute; file watching may be inactive until the roots change or MaxPrice relaunches`,
        );
        try {
          opts.onRecoveryExhausted?.();
        } catch (hookErr) {
          console.warn("[sidecar] watcher onRecoveryExhausted hook failed:", hookErr);
        }
      }
      return false;
    }
    incidentRestarts += 1;
    return true;
  }

  async function restartOnce(): Promise<void> {
    const recheck = recheckOwed;
    const lost = lossOwed;
    recheckOwed = false;
    lossOwed = null;

    const current = opts.getCurrentRoots();
    const next = recheck ? await opts.resolveRoots() : current;
    const rootsChanged = !rootsEqual(next, opts.getCurrentRoots());
    // A loss reported by a watcher already replaced is answered: its
    // replacement holds fresh watches.
    const recovering = lost !== null && lost === opts.getCurrentWatcher();
    let reason: RestartReason;
    if (rootsChanged) {
      // A fresh watcher on new roots answers any owed loss too, and starts
      // the recovery bound over.
      reason = "roots";
      incidentRestarts = 0;
      exhausted = false;
    } else if (recovering && recoveryAllowed()) {
      reason = "recovery";
      console.warn("[sidecar] watch recovery: restarting the watcher on the same roots");
    } else {
      return;
    }

    // Build the replacement first; only install it (and close the
    // predecessor) once it is live, so a failed `createJsonlWatcher` leaves
    // the running watcher untouched and the installed watcher and its roots
    // stay consistent. A restart that completes after `close()` still
    // installs — the caller owns the watcher and its own shutdown closes it;
    // `close()` drains the chain so the installed watcher is never an orphan.
    //
    // Except a watcher that lost its watches: it is closed FIRST. chokidar
    // keeps one OS watch per path for every FSWatcher in the process
    // (handler.js `FsWatchInstances`), so a replacement built while the lost
    // watcher is open attaches to the very watches that died, and is born
    // deaf. The cost is that a failed replacement leaves no live watcher, so
    // `onRestartFailed` raises `watcherDegraded` over a closed one. It was deaf
    // already.
    const previous = opts.getCurrentWatcher();
    const closedFirst = recovering && previous !== null;
    if (closedFirst) await previous.close();
    const replacement = await opts.createJsonlWatcher(next);
    opts.onReplaced({ watcher: replacement, roots: next });
    // Close the superseded watcher; a failure here is logged, not fatal.
    if (previous !== null && !closedFirst)
      void previous.close().catch((err: unknown) => {
        console.error("[sidecar] superseded watcher close failed:", err);
      });
    opts.scan(next, reason);
  }

  function request(): void {
    if (running) return; // The loop below reads what was just owed.
    running = true;
    chain = chain
      .then(async () => {
        try {
          while (recheckOwed || lossOwed !== null) {
            // Catch per-iteration, not around the whole loop: a failed
            // `restartOnce()` (e.g. `createJsonlWatcher` rejecting) must still
            // honour a request that arrived mid-restart, rather than
            // abandoning the loop and leaving the JSONL watcher on stale roots
            // until the next settings edit.
            try {
              await restartOnce();
            } catch (err) {
              console.error("[sidecar] watcher restart failed:", err);
              // Surface the failure to the caller — wrapped, so a throwing
              // hook can't abort the coalescing loop and strand a request.
              try {
                opts.onRestartFailed?.(err);
              } catch (hookErr) {
                console.warn("[sidecar] watcher onRestartFailed hook failed:", hookErr);
              }
            }
          }
        } finally {
          running = false;
        }
      })
      // The chain itself must never reject — a void-ed rejection would escalate
      // to the process-level `unhandledRejection` handler and exit the sidecar.
      .catch(() => {});
  }

  return {
    recheckRoots: () => {
      if (closed) return;
      recheckOwed = true;
      request();
    },
    recover: (lost) => {
      if (closed) return;
      lossOwed = lost;
      request();
    },
    close: async () => {
      closed = true;
      // Drain any in-flight restart so a leaked watcher can't outlive close().
      await chain;
    },
  };
}
