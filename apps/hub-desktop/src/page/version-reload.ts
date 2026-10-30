import { useEffect } from "react";

// A Hub updated under an open tab serves a view the page's bundle may not know
// how to read, so the page reloads itself onto the new bundle once the view's
// version differs from its own (ADR-0124 §6). Once: if the reload still comes
// back with the old bundle (a cache, a web server's stale copy), a second
// would loop. The guard is the served version a reload was made for, kept in
// sessionStorage. If site storage is unavailable, the current history entry
// carries it instead: location.reload keeps that entry's state. No URL is
// passed to replaceState, so the prefix, query and hash stay byte-for-byte.
// A later served version differs from either guard and gets its own reload.
export const RELOAD_GUARD_KEY = "maxprice-hub-page-reload";

export type GuardStorage = Pick<Storage, "getItem" | "setItem">;
export type GuardHistory = Pick<History, "state" | "replaceState">;

// True when it reloaded. The record is written before the reload, so the
// reloaded page reads it. History is checked even after storage recovers, so
// a fallback reload cannot repeat just because site storage became available.
// The page owns this history entry; retain any existing metadata beside the
// namespaced guard. Entries that never needed fallback do not write history.
export function reloadOnce({
  built,
  served,
  storage,
  history,
  reload,
}: {
  built: string;
  served: string | undefined;
  storage: GuardStorage;
  history: GuardHistory;
  reload: () => void;
}): boolean {
  if (served === undefined || served === built) return false;
  const previous: Record<string, unknown> | null = history.state;
  if (previous?.[RELOAD_GUARD_KEY] === served) return false;
  const recordHistory = () => history.replaceState({ ...previous, [RELOAD_GUARD_KEY]: served }, "");
  if (typeof previous?.[RELOAD_GUARD_KEY] === "string") {
    // Once fallback is used it stays authoritative for this entry, avoiding
    // stale sessionStorage taking over if access later returns.
    recordHistory();
  } else {
    try {
      if (storage.getItem(RELOAD_GUARD_KEY) === served) return false;
      storage.setItem(RELOAD_GUARD_KEY, served);
    } catch {
      recordHistory();
    }
  }
  reload();
  return true;
}

// Runs the check on each view version, against the version this bundle was
// built with. The storage is read through the getter on each call, inside the
// guard's try: reading window.sessionStorage itself throws where it is denied.
export function useVersionReload(served: string | undefined): void {
  useEffect(() => {
    reloadOnce({
      built: __APP_VERSION__,
      served,
      storage: {
        getItem: (key) => window.sessionStorage.getItem(key),
        setItem: (key, value) => window.sessionStorage.setItem(key, value),
      },
      history: window.history,
      reload: () => window.location.reload(),
    });
  }, [served]);
}
