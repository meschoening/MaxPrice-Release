import type { CostMode, UsageSample } from "@maxprice/shared";
import {
  aggregateFormedBlocks,
  formPendingBlocks,
  resolveFormedBlockSpan,
  type AggregateBlocksOptions,
  type BlockFormation,
  type PendingBlock,
} from "./blocks";
import { FIVE_HOURS_MS, resolveWindows, type ResolvedWindow } from "./block-windows";
import { createBlockFlushCache } from "./block-flush-cache";
import { byTimestamp } from "./model-rollup";
import type { EventStore, StoredEvent } from "./store";

// Test-only work counter, like report-cache's foldCounter. Counts events sent
// through formation, not sample resolution or the separate totals fold.
export const formationCounter = { count: 0 };

function sameWindows(a: ResolvedWindow[], b: ResolvedWindow[]): boolean {
  return (
    a.length === b.length &&
    a.every((w, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        w.start === other.start &&
        w.end === other.end &&
        w.source === other.source
      );
    })
  );
}

// PRECONDITION (ADR-0091): unchanged resolved geometry, an epoch-monotone
// existing stream, and new events extending BOTH its string and epoch order.
// Only the last residual block and the resolved window containing the tail can
// gain events. These are separate frontiers: an observed block does NOT close
// the residual heuristic. In particular, the last displayed row is not a cut.
function extendFormation(state: BlockFormation, events: StoredEvent[]): void {
  const observed = new Map<number, PendingBlock>();
  const heuristic: PendingBlock[] = [];
  for (const block of state.formed) {
    if (block.source === "heuristic") heuristic.push(block);
    else observed.set(block.startMs, block);
  }
  let pending = heuristic[heuristic.length - 1];
  let wi = 0;
  for (const event of events) {
    const ms = event.ms;
    while (wi < state.windows.length && (state.windows[wi] as ResolvedWindow).end <= ms) wi++;
    const w = state.windows[wi];
    if (w !== undefined && w.start <= ms) {
      let block = observed.get(w.start);
      if (block === undefined) {
        block = { startMs: w.start, endMs: w.end, source: w.source, events: [] };
        observed.set(w.start, block);
      }
      block.events.push(event);
    } else {
      const last = pending?.events[pending.events.length - 1];
      if (
        pending === undefined ||
        last === undefined ||
        ms - pending.startMs > FIVE_HOURS_MS ||
        ms - last.ms > FIVE_HOURS_MS
      ) {
        const startMs = Math.floor(ms / 3_600_000) * 3_600_000;
        pending = { startMs, endMs: startMs + FIVE_HOURS_MS, source: "heuristic", events: [] };
        heuristic.push(pending);
      }
      pending.events.push(event);
    }
  }
  // Match the pure path's stable merge, including observed-before-heuristic
  // ties. A new hour-floored residual can sort BEFORE the last observed row.
  state.formed = [
    ...state.windows.flatMap((w) => {
      const block = observed.get(w.start);
      return block === undefined ? [] : [block];
    }),
    ...heuristic,
  ].sort((a, b) => a.startMs - b.startMs);
}

// One membership cache for BOTH block consumers, constructed inside buildApp
// over its live store accessor. Filter/pricing keys belong to the separate
// flush cache; timed wire fields are always freshly assembled. No await inside
// a query or change listener: a response uses one coherent store + samples
// snapshot. Store swaps drop the old subscription.
export function createBlockReports(deps: {
  getStore: () => EventStore;
  getSamples: () => UsageSample[];
}) {
  const flushCache = createBlockFlushCache();
  let store: EventStore | null = null;
  let unsubscribe: (() => void) | null = null;
  let state: BlockFormation | null = null;
  let additions: StoredEvent[] = [];
  let dirty = true;
  let eventTimes: number[] = [];
  let last: StoredEvent | undefined;
  let monotone = true;

  function formation(samples: UsageSample[]): BlockFormation {
    const current = deps.getStore();
    if (current !== store) {
      unsubscribe?.();
      store = current;
      state = null;
      additions = [];
      dirty = true;
      unsubscribe = current.onChanged((changes) => {
        if (dirty) return;
        for (const { event, replaced } of changes) {
          // Whole-row replacement can change any field and inherit an earlier
          // map tie rank. Refuse it even when its new timestamp looks recent.
          if (replaced !== null) {
            dirty = true;
            additions = [];
            return;
          }
          // Pure formation drops NaN rows, so they cannot affect either order
          // or grace evidence. They remain stored for the other reports.
          if (!Number.isNaN(event.ms)) additions.push(event);
        }
      });
    }

    const tail = byTimestamp(additions);
    let prev = last;
    if (tail.length > 0 && !monotone) dirty = true;
    for (const event of tail) {
      if (prev !== undefined && (event.timestamp < prev.timestamp || event.ms < prev.ms))
        dirty = true;
      prev = event;
    }

    if (!dirty && state !== null) {
      for (const event of tail) eventTimes.push(event.ms);
      // Compare VALUES after full resolution, including grace evidence from
      // the new events. Length, latest capture, and sample-array identity are
      // not evidence that old windows survived late backfill or annulment.
      const windows = resolveWindows(samples, eventTimes);
      if (sameWindows(state.windows, windows)) {
        if (tail.length > 0) extendFormation(state, tail);
        formationCounter.count += tail.length;
        last = prev;
        additions = [];
        return state;
      }
    }

    // The pure path is also the fallback for offset-bearing streams whose
    // string order regresses in epoch time. Never normalize or re-sort by ms.
    const events = current.query();
    state = formPendingBlocks(events, samples);
    formationCounter.count += events.length;
    eventTimes = [];
    last = undefined;
    monotone = true;
    for (const event of events) {
      if (Number.isNaN(event.ms)) continue;
      if (last !== undefined && event.ms < last.ms) monotone = false;
      eventTimes.push(event.ms);
      last = event;
    }
    dirty = false;
    additions = [];
    return state;
  }

  return {
    blocks(mode: CostMode, options: Omit<AggregateBlocksOptions, "samples"> = {}) {
      const now = options.now ?? Date.now();
      const samples = deps.getSamples();
      const formed = formation(samples);
      const context = flushCache.prepare(
        mode,
        options.models ?? [],
        options.machines ?? [],
        samples,
      );
      return aggregateFormedBlocks(formed, mode, { ...options, now, samples }, context);
    },
    span(now: number) {
      const samples = deps.getSamples();
      return resolveFormedBlockSpan(formation(samples), now);
    },
  };
}
