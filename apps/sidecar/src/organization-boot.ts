import type { EventStore, ScanProgress } from "./engine/store";
import type { CreateWatcherOptions } from "./watcher";
import { chooseHomeSeed } from "./organizations";
import { scanGate } from "./scan-gate";

// The unrestricted selection corpus is PRIVATE: never install it, attach an
// archive subscriber, or give it to fleet. The caller gates readiness and all
// feeders on this promise, including when the renderer cannot persist the seed.
export async function prepareOrganizationStore(deps: {
  home: string | null;
  loginOrganization: string | null;
  roots: string[];
  createStore: (home: string | null) => EventStore;
  onProgress?: (progress: ScanProgress) => void;
}): Promise<{ home: string | null; store: EventStore }> {
  let home = deps.home;
  let store = deps.createStore(home);
  await scanGate.run(() => store.scan(deps.roots, deps.onProgress));
  if (home === null) {
    home = chooseHomeSeed(store.organizationSessionCounts(), deps.loginOrganization);
    if (home !== null) {
      store = deps.createStore(home);
      await scanGate.run(() => store.scan(deps.roots));
    }
  }
  return { home, store };
}

// Start chokidar alongside the walks so a write after a file's scan is not
// lost to ignoreInitial. Buffer both halves of its append-before-emit contract
// in order; once the filtered store is installed, replay through its feeders.
export function gateOrganizationWatcher(
  options: CreateWatcherOptions,
  ready: Promise<void>,
): CreateWatcherOptions {
  let open = false;
  const pending: Array<() => void> = [];
  const deliver = (action: () => void) => {
    if (open) action();
    else pending.push(action);
  };
  void ready
    .then(() => {
      open = true;
      for (const action of pending) action();
      pending.length = 0;
    })
    .catch((err: unknown) => {
      pending.length = 0;
      console.error("[sidecar] organization watcher handoff failed:", err);
    });
  return {
    ...options,
    onRecords: (records, project, session) =>
      deliver(() => options.onRecords?.(records, project, session)),
    onEvent: (event) => deliver(() => options.onEvent(event)),
  };
}
