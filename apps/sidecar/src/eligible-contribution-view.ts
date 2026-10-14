import { PUSH_CHANGED_KEYS_MAX, type LocalChanges } from "@maxprice/usage-core";
import type { ForgetSessionRef } from "@maxprice/shared";
import type { EventStore, StoredEvent } from "./engine/store";
import type { createForgetIntent } from "./fleet-forget-intent";

// The Eligible contribution view (ADR-0100) as the push pass reads it: whole,
// for a full pass, or by the keys whose contribution changed since the last
// take, for an ordinary one (#364). Both readings apply one eligibility, so a
// pass of changed keys can never send a row a full pass would withhold.

// What makes a contribution eligible beyond being in the store. The view is
// closed until ingestion settles or while the forget intent cannot be read, and
// a pending forget bars its pairs. The holder hands back the same object while
// nothing changed, so the view tells a change by identity.
export type ContributionEligibility = {
  open: boolean;
  // Each barred pair as `barredPairKey` builds it.
  barred: ReadonlySet<string>;
};

// A pair's key in `ContributionEligibility.barred`.
export function barredPairKey(pair: ForgetSessionRef): string {
  return JSON.stringify([pair.projectSlug, pair.sessionId]);
}

// fleet.ts's eligibility: open once ingestion has settled and the forget
// intent is readable, every pair of a pending forget barred. Rebuilt only when
// the gate or the intent changed, any write of it included, so one object
// stands for one state.
export function createContributionEligibility(deps: {
  ingestible: () => boolean;
  intent: Pick<ReturnType<typeof createForgetIntent>, "error" | "read" | "revision">;
}): () => ContributionEligibility {
  let current: ContributionEligibility = { open: false, barred: new Set() };
  let revision = -1;
  return () => {
    const open = deps.ingestible() && deps.intent.error() === null;
    const written = deps.intent.revision();
    if (open !== current.open || written !== revision) {
      revision = written;
      current = {
        open,
        barred: new Set(
          deps.intent.read()?.batches.flatMap((batch) => batch.sessions.map(barredPairKey)) ?? [],
        ),
      };
    }
    return current;
  };
}

const NONE: ReadonlySet<string> = new Set();

export type EligibleContributionView = LocalChanges<StoredEvent> & {
  // Every eligible contribution, timestamp-sorted: a full pass's reading.
  all: () => StoredEvent[];
};

export function createEligibleContributionView(deps: {
  getStore: () => EventStore;
  eligibility: () => ContributionEligibility;
}): EligibleContributionView {
  // The store whose change feed this view listens to, and the eligibility the
  // last take saw. A different one of either means a full pass. The store is
  // held weakly: a rebuild swaps it, and a strong hold would keep the old
  // engine's whole corpus resident until the next pass (ADR-0111), which
  // with sharing off or no Hub may never come. The old store keeps its
  // listener, which ignores it from then on, and the two go together.
  let tracked: WeakRef<EventStore> | null = null;
  let listening: object | null = null;
  let seen: ContributionEligibility | null = null;
  // The keys written since the last take, unless `wholesale` already asks for
  // a full pass. Replaced at each take, never cleared (ADR-0110 §4).
  let changed = new Set<string>();
  let wholesale = true;

  function onWrite(key: string | null): void {
    if (wholesale) return;
    if (key !== null && changed.size < PUSH_CHANGED_KEYS_MAX) {
      changed.add(key);
      return;
    }
    wholesale = true;
    changed = new Set();
  }

  const barred = (eligibility: ContributionEligibility, row: StoredEvent): boolean =>
    eligibility.barred.has(barredPairKey(row));

  return {
    all: () => {
      const eligibility = deps.eligibility();
      if (!eligibility.open) return [];
      const rows = deps.getStore().contributions();
      // Nothing pending is the usual case: skip a key built per row (#361).
      if (eligibility.barred.size === 0) return rows;
      return rows.filter((row) => !barred(eligibility, row));
    },
    take: () => {
      const store = deps.getStore();
      if (tracked?.deref() !== store) {
        // A swapped store (a rebuild, the boot install) holds contributions
        // the old one's feed never named.
        const subscription = {};
        listening = subscription;
        tracked = new WeakRef(store);
        store.onContributionChange((key) => {
          if (listening === subscription) onWrite(key);
        });
        wholesale = true;
      }
      const eligibility = deps.eligibility();
      if (eligibility !== seen) {
        seen = eligibility;
        wholesale = true;
      }
      if (wholesale) {
        wholesale = false;
        changed = new Set();
        return null;
      }
      if (changed.size === 0) return NONE;
      const out = changed;
      changed = new Set();
      return out;
    },
    get: (key) => {
      const eligibility = deps.eligibility();
      if (!eligibility.open) return undefined;
      const row = deps.getStore().localContributionByKey(key);
      if (row === undefined || eligibility.barred.size === 0) return row;
      return barred(eligibility, row) ? undefined : row;
    },
  };
}
