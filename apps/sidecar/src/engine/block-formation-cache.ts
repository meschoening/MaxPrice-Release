import type { CostMode, UsageSample } from "@maxprice/shared";
import type { SampleScope } from "@maxprice/usage-core";
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
import { eventOrganization, type Presumption } from "./presumption";
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
// over its live store accessor. A request may name a Quota organization: its
// Blocks then form from that Organization's rows alone (the store's
// Organization axis: evidence, then assertion, then presumption) and from its
// samples alone, so windows, annulment and grace evidence never cross
// Organizations. No quota is the unscoped formation over every row and every
// sample. ONE slot: the Quota organization is a formation input, and so is the
// store's presumption for a scoped slot. A change of Organization always
// rebuilds it; a presumption change rebuilds only a scoped slot. Filter/pricing
// keys belong to the separate flush cache; timed wire fields are always freshly
// assembled. No await inside a query or change listener: a response uses one
// coherent store + samples snapshot. Store swaps drop the old subscription.
export function createBlockReports(deps: {
  getStore: () => EventStore;
  // No scope: every sample held. A scope: that Organization's samples,
  // unstamped lines counting as `home`'s — the sample store's `all(scope)`.
  getSamples: (scope?: SampleScope) => readonly UsageSample[];
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
  // The slot's Quota organization (`null` = none: every row) and the
  // presumption its rows were resolved under.
  let boundOrganization: string | null = null;
  let boundPresumption: Presumption | null = null;

  function formation(samples: readonly UsageSample[], organization: string | null): BlockFormation {
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
          // That holds whatever Organization either copy resolves to: a tag
          // gain is a replacement, and it can move a row out of the slot.
          if (replaced !== null || event === null) {
            dirty = true;
            additions = [];
            return;
          }
          // Pure formation drops NaN rows, so they cannot affect either order
          // or grace evidence. They remain stored for the other reports.
          if (Number.isNaN(event.ms)) continue;
          // Another Organization's row is not in the slot's stream, so it
          // neither extends nor dirties it. Resolved exactly as the scoped
          // query resolves it; a presumption swap since binding rebuilds at
          // the next request anyway.
          if (
            boundOrganization !== null &&
            boundPresumption !== null &&
            eventOrganization(event, boundPresumption) !== boundOrganization
          ) {
            continue;
          }
          additions.push(event);
        }
      });
    }
    // The Quota organization is a formation INPUT (#265 item 6), and so is the
    // presumption for a scoped slot: either moving means another
    // Organization's rows, so rebuild. The presumption is compared by
    // identity, which every writer (Home, published Homes, assertions) mints
    // anew. The unscoped formation never reads it, so a swap leaves that slot
    // alone; the bound value stays current for the listener either way.
    const presumption = current.presumption();
    if (
      organization !== boundOrganization ||
      (organization !== null && presumption !== boundPresumption)
    ) {
      state = null;
      additions = [];
      dirty = true;
    }
    boundOrganization = organization;
    boundPresumption = presumption;

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
    const events =
      organization === null ? current.query() : current.query({ organizations: [organization] });
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

  // `quota` absent or `null`: no Quota organization, the unscoped formation.
  function quotaSamples(quota: SampleScope | null): readonly UsageSample[] {
    return quota === null ? deps.getSamples() : deps.getSamples(quota);
  }

  return {
    blocks(
      mode: CostMode,
      options: Omit<AggregateBlocksOptions, "samples"> = {},
      quota: SampleScope | null = null,
    ) {
      const now = options.now ?? Date.now();
      const samples = quotaSamples(quota);
      const formed = formation(samples, quota?.organization ?? null);
      const context = flushCache.prepare(
        mode,
        options.models ?? [],
        options.machines ?? [],
        // The Quota organization keys the totals beside the sum-narrowing
        // axes, though it narrows no sum: it chose the rows the blocks formed
        // from. `AggregateBlocksOptions` deliberately has no such field — see
        // the axis note in `block-flush-cache.ts`.
        quota === null ? [] : [quota.organization],
        samples,
      );
      return aggregateFormedBlocks(formed, mode, { ...options, now, samples }, context);
    },
    span(now: number, quota: SampleScope | null = null) {
      const samples = quotaSamples(quota);
      return resolveFormedBlockSpan(formation(samples, quota?.organization ?? null), now);
    },
  };
}
