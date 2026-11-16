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
//
// The Account half (#631, ADR-0136 §3–§4, §8; ADR-0137 §1) rides the same two
// walks. `accounts.tracked(home)` is the tracked Account set a walk for that
// Home is built with, as bootSidecar() resolves it right then (`null`, no
// Account excluded, while it has nothing to resolve from). After the first
// walk, `accounts.settle(home, store, seeded)` lets bootSidecar() decide what
// settings.json cannot say, from that walk's evidence: the upgrade's set
// (ADR-0136 §8), a first launch's (§4) and the Pending account folds; it
// answers whether that store still resolves as one built now would, which a
// pair the walk itself learned can change (ADR-0137 §1). The second walk then
// runs whenever the Home was seeded, the tracked Account set moved or the
// pairs did, so the installed store is built under the sets the boot settled.
// The first walk of an upgrade runs under `null`, and the set it settles
// tracks every Account that walk read, so the second admits the same rows.
export async function prepareOrganizationStore(deps: {
  home: string | null;
  trackedOrganizations: readonly string[];
  loginOrganization: string | null;
  roots: string[];
  // #311: awaited before the first store, so the boot walk's store already
  // holds the dormant snapshot.
  assertionsReady: Promise<void>;
  // #631: the pair table's load, awaited beside it, so the boot walk's store
  // resolves Email records through the persisted pairs (ADR-0137 §1).
  accountPairsReady: Promise<void>;
  createStore: (
    tracked: ReadonlySet<string> | null,
    trackedAccounts: ReadonlySet<string> | null,
  ) => EventStore;
  // Omitted, no Account is excluded and nothing is settled.
  accounts?: {
    tracked: (home: string | null) => ReadonlySet<string> | null;
    settle: (home: string | null, store: EventStore, seeded: boolean) => { stale: boolean };
  };
  onProgress?: (progress: ScanProgress) => void;
}): Promise<{ home: string | null; store: EventStore }> {
  await Promise.all([deps.assertionsReady, deps.accountPairsReady]);
  const accounts = deps.accounts ?? NO_ACCOUNTS;
  let home = deps.home;
  const walkedAccounts = accounts.tracked(home);
  let store = deps.createStore(
    resolveTrackedOrganizations(home, deps.trackedOrganizations),
    walkedAccounts,
  );
  await scanGate.run(() => store.scan(deps.roots, deps.onProgress));
  let seeded = false;
  if (home === null) {
    home = chooseHomeSeed(store.organizationSessionCounts(), deps.loginOrganization);
    seeded = home !== null;
  }
  const { stale } = accounts.settle(home, store, seeded);
  const settledAccounts = accounts.tracked(home);
  if (seeded || stale || !sameSet(walkedAccounts, settledAccounts)) {
    store = deps.createStore(
      resolveTrackedOrganizations(home, deps.trackedOrganizations),
      settledAccounts,
    );
    await scanGate.run(() => store.scan(deps.roots));
  }
  return { home, store };
}

const NO_ACCOUNTS = {
  tracked: (): ReadonlySet<string> | null => null,
  settle: () => ({ stale: false }),
};

// Set equality by value; `null` (nothing excluded) equals only `null`.
function sameSet(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

// Start chokidar alongside the walks so a write after a file's scan is not
// lost to ignoreInitial. Buffer both halves of its append-before-emit contract
// in order; once the filtered store is installed, replay through its feeders.
// A failed walk installs none, so from then on the gate drops: the sidecar
// stays up after one (#340), and a buffer would grow until relaunch.
export function gateOrganizationWatcher(
  options: CreateWatcherOptions,
  ready: Promise<void>,
): CreateWatcherOptions {
  let open = false;
  let failed = false;
  const pending: Array<() => void> = [];
  const deliver = (action: () => void) => {
    if (open) action();
    else if (!failed) pending.push(action);
  };
  void ready
    .then(() => {
      open = true;
      for (const action of pending) action();
      pending.length = 0;
    })
    .catch((err: unknown) => {
      failed = true;
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
