import type { EventStore, ScanProgress } from "./engine/store";
import type { CreateWatcherOptions } from "./watcher";
import { chooseHomeSeed } from "./organizations";
import { scanGate } from "./scan-gate";
import { resolveTrackedOrganizations } from "./settings-file";

// The unrestricted selection corpus is PRIVATE: never install it, attach an
// archive subscriber, or give it to fleet. The caller gates readiness and all
// feeders on this promise, including when the renderer cannot persist the seed.
//
// `trackedOrganizations` is the PERSISTED list; the set every store is built
// with is `resolveTrackedOrganizations(home, list)`, recomputed after the seed
// so the seeded Home lands in it (the #260 lifecycle decision, item 8:
// tracked = {seed} — or {seed} ∪ a hand-edited list). With no Home that
// resolver answers `null`, so the selection walk is unrestricted by
// construction.
export async function prepareOrganizationStore(deps: {
  home: string | null;
  trackedOrganizations: readonly string[];
  loginOrganization: string | null;
  roots: string[];
  // #311: awaited before the first store, so the boot walk's store already
  // holds the dormant snapshot.
  assertionsReady: Promise<void>;
  createStore: (tracked: ReadonlySet<string> | null) => EventStore;
  onProgress?: (progress: ScanProgress) => void;
}): Promise<{ home: string | null; store: EventStore }> {
  await deps.assertionsReady;
  let home = deps.home;
  let store = deps.createStore(resolveTrackedOrganizations(home, deps.trackedOrganizations));
  await scanGate.run(() => store.scan(deps.roots, deps.onProgress));
  if (home === null) {
    home = chooseHomeSeed(store.organizationSessionCounts(), deps.loginOrganization);
    if (home !== null) {
      store = deps.createStore(resolveTrackedOrganizations(home, deps.trackedOrganizations));
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
    onRecords: (records, project, session, isSubagent) =>
      deliver(() => options.onRecords?.(records, project, session, isSubagent)),
    onEvent: (event) => deliver(() => options.onEvent(event)),
  };
}
