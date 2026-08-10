import { type FSWatcher, watch as chokidarWatch } from "chokidar";
import type { Watcher } from "./watcher";

// settings.json watcher (ADR-0014). The Tauri shell passes MAXPRICE_SETTINGS_PATH
// on spawn; this helper chokidar-watches that file and, when the user's
// `claudePaths` change, restarts the JSONL watcher on the new roots and
// broadcasts the new watched paths.
//
// Extracted from `main()` so the reentrancy-safe restart orchestration is a
// single named, testable unit — mirroring `installParentWatchdog` /
// `createLiveHub`. The JSONL-watcher factory, the roots resolver, and the
// roots-changed callback are all injected, so a unit test can drive the whole
// state machine with fakes and never touch the real filesystem.

export type CreateSettingsWatchOptions = {
  // Absolute path of settings.json (the MAXPRICE_SETTINGS_PATH value).
  settingsPath: string;
  // Re-resolve the JSONL roots from settings.json (falling back to
  // $CLAUDE_CONFIG_DIR on a missing/unparseable file). Called on every
  // settings-file event; a parse failure surfacing as the fallback roots is
  // simply "no change" when it equals the current roots.
  resolveRoots: () => string[];
  // The current JSONL roots — read fresh on each restart so a coalesced
  // re-check compares against the roots the *previous* restart installed.
  getCurrentRoots: () => string[];
  // Build a JSONL watcher for `roots`. Injected (rather than importing
  // `createWatcher` directly) so `main()` keeps the single shared option
  // builder and tests can supply fakes.
  createJsonlWatcher: (roots: string[]) => Promise<Watcher>;
  // Apply a completed restart: swap in the new watcher and record the new
  // roots. Invoked exactly once per restart, after the new watcher is live and
  // the old one is closed — so `watcher` always corresponds to `watchRoots`.
  onRootsChanged: (next: { watcher: Watcher; roots: string[] }) => void;
  // Re-scan hook — pulls in events under roots added since the last scan. The
  // event store's `(messageId, requestId)` dedup makes re-scanning overlapping
  // roots safe, so this is passed the full new root set.
  scan: (roots: string[]) => void;
  // The ADR-0041 fleet-toggle hook — fired on EVERY settings add/change event,
  // independent of the roots-restart path (a toggle-only edit changes no roots,
  // so it would otherwise be swallowed by the "roots unchanged ⇒ no restart"
  // early return). Fired at the top of `scheduleRestart`, before the reentrancy
  // gates, so a settings edit landing mid-restart still applies its toggles.
  onSettingsChanged?: () => void;
  // Injectable chokidar factory — defaults to the real `watch`. Tests pass a
  // fake to drive `add`/`change` synchronously.
  watchFactory?: (path: string) => FSWatcher;
};

export type SettingsWatch = {
  close: () => Promise<void>;
};

function rootsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

export function createSettingsWatch(opts: CreateSettingsWatchOptions): SettingsWatch {
  const watchFactory =
    opts.watchFactory ?? ((path: string) => chokidarWatch(path, { ignoreInitial: true }));
  const fsWatcher = watchFactory(opts.settingsPath);

  // Reentrancy guard (review I1). chokidar can fire `change` again while a
  // prior restart's `await createJsonlWatcher(...)` is still pending (a user
  // editing paths twice quickly; macOS double-fires `change`). Without
  // serialization two restarts interleave: both read the same stale current
  // roots, both build a new watcher, and the first one's watcher leaks.
  //
  // So restarts are strictly serialized through `restartChain`, and a
  // `pendingRecheck` flag coalesces events that arrive mid-restart into a
  // single follow-up re-evaluation — `restartOnce` always re-reads
  // `getCurrentRoots()` and `resolveRoots()`, so the follow-up compares against
  // the roots the just-finished restart installed.
  let restartChain: Promise<void> = Promise.resolve();
  let restarting = false;
  let pendingRecheck = false;
  let closed = false;

  async function restartOnce(): Promise<void> {
    const nextRoots = opts.resolveRoots();
    if (rootsEqual(nextRoots, opts.getCurrentRoots())) return;

    // Build the replacement first; only hand it to `onRootsChanged` (which
    // swaps it in + closes the predecessor) once the new one is live, so a
    // failed `createJsonlWatcher` leaves the running watcher untouched and
    // `watcher`/`watchRoots` stay consistent. An in-flight restart that
    // completes after `close()` still installs — the caller owns the watcher
    // and its own `shutdown()` closes it; `close()` drains `restartChain`
    // before returning so the installed watcher is never an orphan.
    const replacement = await opts.createJsonlWatcher(nextRoots);
    opts.onRootsChanged({ watcher: replacement, roots: nextRoots });
    // Re-scan picks up events under roots new since the last scan; dedup makes
    // the full-set re-scan safe (non-minimal but correct — see ADR-0014).
    opts.scan(nextRoots);
  }

  function scheduleRestart(): void {
    // The fleet-toggle hook (ADR-0041) fires FIRST — before the closed /
    // restarting gates below — so a toggle-only edit (no roots change) and an
    // edit landing mid-restart both still reach fleet.applySettings. Wrapped so
    // a throwing hook can't abort the roots-restart orchestration that follows.
    try {
      opts.onSettingsChanged?.();
    } catch (err) {
      console.warn("[sidecar] settings onSettingsChanged hook failed:", err);
    }
    if (closed) return;
    if (restarting) {
      // A restart is in flight — coalesce: do exactly one re-check afterwards.
      pendingRecheck = true;
      return;
    }
    restarting = true;
    restartChain = restartChain
      .then(async () => {
        try {
          do {
            pendingRecheck = false;
            // Catch per-iteration, not around the whole loop: a failed
            // `restartOnce()` (e.g. `createJsonlWatcher` rejecting) must still
            // re-evaluate a `pendingRecheck` set by an event that arrived
            // mid-restart, rather than abandoning the loop and leaving the
            // JSONL watcher on stale roots until the next settings edit.
            try {
              await restartOnce();
            } catch (err) {
              console.error("[sidecar] settings-driven watcher restart failed:", err);
            }
            // Loop while events arrived mid-restart — `restartOnce` re-reads
            // the roots, so a coalesced run is a fresh evaluation. A recheck
            // requested before `close()` still drains here; `close()` awaits
            // `restartChain` before returning.
          } while (pendingRecheck);
        } finally {
          restarting = false;
        }
      })
      // The chain itself must never reject — a void-ed rejection would escalate
      // to the process-level `unhandledRejection` handler and exit the sidecar.
      .catch(() => {});
  }

  fsWatcher.on("add", scheduleRestart);
  fsWatcher.on("change", scheduleRestart);
  fsWatcher.on("error", (err) => console.error("[sidecar] settings watcher error:", err));

  return {
    close: async () => {
      closed = true;
      await fsWatcher.close();
      // Drain any in-flight restart so a leaked watcher can't outlive close().
      await restartChain;
    },
  };
}
