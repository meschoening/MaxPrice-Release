import { readFileSync } from "node:fs";
import { type FSWatcher, watch as chokidarWatch } from "chokidar";
import type { WatcherRestarts } from "./watcher-restarts";

// settings.json watcher (ADR-0014). The Tauri shell passes MAXPRICE_SETTINGS_PATH
// on spawn; this helper chokidar-watches that file and, on every event, applies
// the in-session settings hook and asks the JSONL watcher's restart path to
// re-check the roots, which restarts the watcher if `claudePaths` changed.
//
// The restart orchestration itself is `watcher-restarts.ts`: the one
// serialized path a watch-loss recovery shares (ADR-0113). Injected, like the
// chokidar factory and the file read, so a unit test can drive this with
// fakes alone and touch no file.
//
// Each event is followed by a re-read (ADR-0014, amended #468). chokidar can
// drop a temp-file-plus-rename that lands within tens of ms of the previous
// one: it reports the first and never the second, so two quick writers (two
// `maxprice org` runs, a `settings set` beside an `org` edit, two quick
// Desktop toggles) would leave the sidecar on the first write until some
// later one. So each handler run first reads the file and remembers it, and
// RECHECK_MS after the last event the file is read again: if it differs, the
// handler runs once more, which arms the next re-read in turn. One trailing
// re-read per event is enough because chokidar loses only a rename that
// closely follows another; a write after that window gets an event of its
// own, which re-arms the re-read, so the re-read after the last event sees
// the file's final content. The read comes BEFORE the hook's own: a write
// landing between the two then reads as a difference and re-runs the hook,
// which costs a "same" verdict, where a read after the hook could remember
// content newer than what the hook applied, and miss it. A re-run over
// unchanged settings does nothing: bootSidecar's hook and the roots re-check
// each compare before they act.

// How long after the last settings event the file is read again.
export const RECHECK_MS = 250;

export type CreateSettingsWatchOptions = {
  // Absolute path of settings.json (the MAXPRICE_SETTINGS_PATH value).
  settingsPath: string;
  // The JSONL watcher's restart path. Every settings event asks it to
  // re-check the roots; a re-check that lands mid-restart is coalesced there.
  restarts: Pick<WatcherRestarts, "recheckRoots">;
  // The ADR-0041 fleet-toggle hook — fired on EVERY settings add/change event,
  // independent of the roots re-check (a toggle-only edit changes no roots,
  // so the re-check finds nothing to do). Fired before the re-check and its
  // closed gate, so a settings edit landing mid-restart still applies its
  // toggles.
  onSettingsChanged?: () => void;
  // Injectable chokidar factory — defaults to the real `watch`. Tests pass a
  // fake to drive `add`/`change` synchronously.
  watchFactory?: (path: string) => FSWatcher;
  // The re-read delay, RECHECK_MS by default. Tests pass a short one.
  recheckMs?: number;
  // The file's text, or null when it cannot be read: only compared, never
  // parsed. Defaults to reading `settingsPath` from disk; tests pass a file
  // held in memory.
  readContent?: (path: string) => string | null;
};

export type SettingsWatch = {
  close: () => Promise<void>;
};

function readFileContent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function createSettingsWatch(opts: CreateSettingsWatchOptions): SettingsWatch {
  const watchFactory =
    opts.watchFactory ?? ((path: string) => chokidarWatch(path, { ignoreInitial: true }));
  const recheckMs = opts.recheckMs ?? RECHECK_MS;
  const readContent = opts.readContent ?? readFileContent;
  const fsWatcher = watchFactory(opts.settingsPath);
  let closed = false;
  // What the file held just before the hook last read it.
  let seen: string | null = null;
  let recheck: ReturnType<typeof setTimeout> | null = null;

  function onSettingsEvent(): void {
    seen = readContent(opts.settingsPath);
    // Wrapped so a throwing hook can't stop the roots re-check that follows.
    try {
      opts.onSettingsChanged?.();
    } catch (err) {
      console.warn("[sidecar] settings onSettingsChanged hook failed:", err);
    }
    if (closed) return;
    opts.restarts.recheckRoots();
    // Debounced: each run restarts the one pending re-read.
    if (recheck !== null) clearTimeout(recheck);
    recheck = setTimeout(() => {
      recheck = null;
      if (closed) return;
      if (readContent(opts.settingsPath) !== seen) onSettingsEvent();
    }, recheckMs);
  }

  // Re-read once the file watch is attached: settings may have changed since
  // bootSidecar's boot snapshot, while its private corpus selection was
  // running.
  fsWatcher.on("ready", onSettingsEvent);
  fsWatcher.on("add", onSettingsEvent);
  fsWatcher.on("change", onSettingsEvent);
  fsWatcher.on("error", (err) => console.error("[sidecar] settings watcher error:", err));

  return {
    close: async () => {
      closed = true;
      if (recheck !== null) clearTimeout(recheck);
      recheck = null;
      await fsWatcher.close();
    },
  };
}
