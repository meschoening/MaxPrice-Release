import { type FSWatcher, watch as chokidarWatch } from "chokidar";
import type { WatcherRestarts } from "./watcher-restarts";

// settings.json watcher (ADR-0014). The Tauri shell passes MAXPRICE_SETTINGS_PATH
// on spawn; this helper chokidar-watches that file and, on every event, applies
// the in-session settings hook and asks the JSONL watcher's restart path to
// re-check the roots, which restarts the watcher if `claudePaths` changed.
//
// The restart orchestration itself is `watcher-restarts.ts`: the one
// serialized path a watch-loss recovery shares (ADR-0113). Injected, like the
// chokidar factory, so a unit test drives this with fakes and never touches
// the real filesystem.

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
};

export type SettingsWatch = {
  close: () => Promise<void>;
};

export function createSettingsWatch(opts: CreateSettingsWatchOptions): SettingsWatch {
  const watchFactory =
    opts.watchFactory ?? ((path: string) => chokidarWatch(path, { ignoreInitial: true }));
  const fsWatcher = watchFactory(opts.settingsPath);
  let closed = false;

  function onSettingsEvent(): void {
    // Wrapped so a throwing hook can't stop the roots re-check that follows.
    try {
      opts.onSettingsChanged?.();
    } catch (err) {
      console.warn("[sidecar] settings onSettingsChanged hook failed:", err);
    }
    if (closed) return;
    opts.restarts.recheckRoots();
  }

  // Re-read once the file watch is attached: settings may have changed since
  // main's boot snapshot, while its private corpus selection was running.
  fsWatcher.on("ready", onSettingsEvent);
  fsWatcher.on("add", onSettingsEvent);
  fsWatcher.on("change", onSettingsEvent);
  fsWatcher.on("error", (err) => console.error("[sidecar] settings watcher error:", err));

  return {
    close: async () => {
      closed = true;
      await fsWatcher.close();
    },
  };
}
