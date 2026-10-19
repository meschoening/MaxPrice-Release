// The event store's timestamp-sorted snapshot (ADR-0089, amended by #417):
// every stored event, in the order a STABLE sort of the event map's insertion
// order by timestamp STRING gives — ties keep insertion order. `query` reads
// it, and hands it out itself on its unfiltered fast path (f27).
//
// THE INVARIANT: after every store mutation, the next read returns exactly a
// fresh stable sort of `events.values()` — the same objects, in the same order.
//
// THE GUARANTEE: an array handed out is never written again. The store writes
// only into a snapshot it still owns; the first write after a hand-out goes to
// a copy, which the store then owns until it hands that out in turn.
//
// How a mutation reaches the snapshot, given that `Map.set` keeps a replaced
// key's place in insertion order and a new key goes last:
//   - a NEW key is pending until the next read, which merges every pending
//     addition in one pass. A tie puts the addition after the snapshot's
//     event, because every addition joined the map after every event already
//     in the snapshot, and stable-sorting the additions keeps their own
//     arrival order;
//   - a REPLACEMENT keeping its timestamp takes the displaced event's slot;
//   - a replacement MOVING its timestamp leaves its slot for its new
//     timestamp's: exact while no other snapshot event holds that timestamp,
//     since the tie order among those would be their insertion ranks, which
//     the snapshot cannot see. A pending addition outranks it, so the moved
//     event goes before any;
//   - a replacement of a PENDING addition takes its place in the pending list,
//     whatever its timestamp;
//   - anything else (a removal, a key deleted and set again, a move onto a tie)
//     discards the snapshot, and the next read rebuilds it from the map.

type Stamped = { timestamp: string };

// Test-only work counters, like report-cache's `foldCounter`: a rebuild copies
// and re-sorts the corpus; a copy is the copy-on-write a hand-out forces.
export const snapshotCounter = { rebuilds: 0, copies: 0 };

// Code-unit order on the raw timestamp string. `byTimestamp` (model-rollup.ts)
// must agree with it exactly; see the note there.
function compareTimestamps(a: Stamped, b: Stamped): number {
  return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
}

// The first index whose timestamp is not less than `timestamp`.
function lowerBound(events: readonly Stamped[], timestamp: string): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((events[mid] as Stamped).timestamp < timestamp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Where `event` sits in `events`, or -1: its timestamp's run, searched by identity.
function indexOf<T extends Stamped>(events: readonly T[], event: T): number {
  for (let i = lowerBound(events, event.timestamp); i < events.length; i += 1) {
    const candidate = events[i] as T;
    if (candidate === event) return i;
    if (candidate.timestamp !== event.timestamp) return -1;
  }
  return -1;
}

export type SortedSnapshot<T extends Stamped> = {
  // A key new to the map.
  add: (event: T) => void;
  // A key's event replaced whole-row, in place in insertion order.
  replace: (previous: T, event: T) => void;
  // Any other change to the map.
  discard: () => void;
  // The snapshot, for a walk that ends before the store returns to its caller.
  read: () => T[];
  // The snapshot, for a caller that may keep it.
  handOut: () => T[];
};

export function createSortedSnapshot<T extends Stamped>(all: () => Iterable<T>): SortedSnapshot<T> {
  // `null` until a read builds it; nothing is tracked while it is null.
  let sorted: T[] | null = null;
  // Whether `sorted` has been handed out, and so may never be written again.
  let handedOut = false;
  // Keys added since the last merge, in insertion order.
  let additions: T[] = [];

  function discard(): void {
    sorted = null;
    handedOut = false;
    additions = [];
  }

  function rebuild(): T[] {
    snapshotCounter.rebuilds += 1;
    sorted = [...all()].sort(compareTimestamps);
    handedOut = false;
    additions = [];
    return sorted;
  }

  // Merge the pending additions into `base`, or into a copy of it. Backward,
  // so each slot is read before it is written; additions sorting after every
  // event `base` holds, the usual append, move nothing.
  function merge(base: T[], copy: boolean): T[] {
    const tail = additions.length > 1 ? additions.sort(compareTimestamps) : additions;
    additions = [];
    const n = base.length;
    let target: T[];
    if (copy) {
      target = base.concat(tail);
    } else {
      target = base;
      for (const event of tail) target.push(event);
    }
    let i = n - 1;
    let j = tail.length - 1;
    for (let w = target.length - 1; j >= 0; w -= 1) {
      const next = tail[j] as T;
      if (i >= 0 && (target[i] as T).timestamp > next.timestamp) {
        target[w] = target[i] as T;
        i -= 1;
      } else {
        target[w] = next;
        j -= 1;
      }
    }
    return target;
  }

  // The snapshot with every pending addition merged in.
  function current(): T[] {
    if (sorted === null) return rebuild();
    if (additions.length > 0) {
      if (handedOut) snapshotCounter.copies += 1;
      sorted = merge(sorted, handedOut);
      handedOut = false;
    }
    return sorted;
  }

  // The built snapshot, safe to write in place. A handed-out one is copied
  // first, and the copy takes in the pending additions at no extra cost.
  function owned(built: T[]): T[] {
    if (!handedOut) return built;
    snapshotCounter.copies += 1;
    sorted = additions.length > 0 ? merge(built, true) : built.slice();
    handedOut = false;
    return sorted;
  }

  function replace(previous: T, event: T): void {
    if (sorted === null) return;
    if (indexOf(sorted, previous) === -1) {
      // Added since the last merge: it keeps its place among the additions,
      // found from the newest back. Held nowhere, a replacement the store
      // never reports, it falls back to a rebuild, which is exact.
      const pending = additions.lastIndexOf(previous);
      if (pending === -1) discard();
      else additions[pending] = event;
      return;
    }
    if (event.timestamp === previous.timestamp) {
      const target = owned(sorted);
      // Found again: a copy may have merged additions ahead of it.
      target[indexOf(target, previous)] = event;
      return;
    }
    // Checked before `owned` merges the additions in: only the snapshot's own
    // events can tie it at an unknown rank.
    const tie = lowerBound(sorted, event.timestamp);
    if (tie < sorted.length && (sorted[tie] as T).timestamp === event.timestamp) {
      discard();
      return;
    }
    const target = owned(sorted);
    const from = indexOf(target, previous);
    // Ahead of any merged addition sharing its timestamp.
    const to = lowerBound(target, event.timestamp);
    if (from < to) {
      target.copyWithin(from, from + 1, to);
      target[to - 1] = event;
    } else {
      target.copyWithin(to + 1, to, from);
      target[to] = event;
    }
  }

  return {
    add: (event) => {
      if (sorted !== null) additions.push(event);
    },
    replace,
    discard,
    read: current,
    handOut: () => {
      const snapshot = current();
      handedOut = true;
      return snapshot;
    },
  };
}
