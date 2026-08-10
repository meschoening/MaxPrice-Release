import type { CostBreakdown, ModelBreakdown } from "@maxprice/shared";
import type { StoredEvent } from "./store";

// Part 4.5 — the shared model-rollup primitives for the engine aggregators.
//
// `daily`, `sessions`, and `projects` all fold a `StoredEvent[]` into per-key
// buckets the same way: add the four token counts + the event's cost into a
// running total, and merge the same into a first-seen-ordered per-model
// `ModelBreakdown` map. That fold — ~20 identical lines — lived three times.
// This module is its single home: a `ModelRollup` accumulator, an
// `emptyModelRollup` constructor, and `foldModelUsage` to fold one event in.
//
// `byTimestamp` lives here too. It guarantees timestamp-ascending order, but
// the same three aggregators (and `blocks`) all need it for the same reason —
// see below — so it is one export rather than four copies.
//
// `blocks` does NOT share the rollup: a block carries a `Set<string>` of model
// names and a verbose-named `TokenCounts`, not a per-model `ModelBreakdown`
// map, so its fold is structurally different. `blocks` imports only
// `byTimestamp`. The same divergence is the pricing-entry-point split
// (ADR-0026): all five rollup fold sites — `daily`, `intraday`, `sessions`,
// `projects`, `session-events` — call `computeCostBreakdown`, while `blocks`
// deliberately stays on plain `computeCost` because it bypasses this rollup
// and never accumulates the cache-cost slices. Of the five, only `daily` /
// `intraday` carry the ROW-level slices to the wire (`DailyRow` / `BucketRow`,
// via `flushRollup`); `session-events` also calls `flushRollup` but its summary
// frame picks fields explicitly, discarding the row-level slices; `sessions` /
// `projects` never call `flushRollup` and hand-build their rows. The PER-MODEL
// slices (ADR-0033) are different: they live on each `ModelBreakdown` entry,
// so every consumer's `modelBreakdowns` carries them to the wire.

// A mutable accumulator folding many events that share one grouping key (a
// calendar day for `daily`, a `sessionId` for `sessions`, a project slug for
// `projects`). `daily` and `projects` use it as their whole bucket; `sessions`
// composes it — `Bucket = ModelRollup & { projectSlug; lastActivity; events }`.
// `models` is a `Map` so first-seen insertion order is preserved: that order
// is the wire order for `modelsUsed` / `modelBreakdowns`.
export type ModelRollup = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCost: number;
  cacheCreationCost: number;
  cacheReadCost: number;
  outputCost: number;
  // model string → its running per-model breakdown. Insertion-ordered.
  models: Map<string, ModelBreakdown>;
};

// A fresh zeroed rollup.
export function emptyModelRollup(): ModelRollup {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalCost: 0,
    cacheCreationCost: 0,
    cacheReadCost: 0,
    outputCost: 0,
    models: new Map(),
  };
}

// Fold one event into a rollup: add its four token counts, add the (already
// computed) `cost` breakdown, and merge the token counts + cost into the
// event's per-model breakdown — created first-seen if absent. `cost` is a
// `CostBreakdown` (ADR-0026) rather than a plain number so the rollup accumulates
// the two cache-cost slices (`cacheCreationCost` / `cacheReadCost`) plus the
// ADR-0040 `outputCost` alongside the total. The per-model breakdown carries the
// same slices (ADR-0033, ADR-0040) — the composable group-by's model × cache
// cross-product needs an exact per-model cache-cost split. `cost` is a parameter
// rather than computed here because
// `projects` folds one event into two rollups (its windowed `range` and its
// `allTime`) from a single `computeCostBreakdown` call.
export function foldModelUsage(rollup: ModelRollup, event: StoredEvent, cost: CostBreakdown): void {
  rollup.inputTokens += event.inputTokens;
  rollup.outputTokens += event.outputTokens;
  rollup.cacheCreationTokens += event.cacheCreationTokens;
  rollup.cacheReadTokens += event.cacheReadTokens;
  rollup.totalCost += cost.total;
  rollup.cacheCreationCost += cost.cacheCreationCost;
  rollup.cacheReadCost += cost.cacheReadCost;
  rollup.outputCost += cost.outputCost;

  const breakdown = rollup.models.get(event.model);
  if (breakdown) {
    breakdown.inputTokens += event.inputTokens;
    breakdown.outputTokens += event.outputTokens;
    breakdown.cacheCreationTokens += event.cacheCreationTokens;
    breakdown.cacheReadTokens += event.cacheReadTokens;
    breakdown.cost += cost.total;
    // ADR-0033: per-model cache-cost slices ride the same CostBreakdown the
    // rollup already receives — two adds, no extra pricing work. ADR-0040 adds
    // the output slice on the same footing.
    breakdown.cacheCreationCost = (breakdown.cacheCreationCost ?? 0) + cost.cacheCreationCost;
    breakdown.cacheReadCost = (breakdown.cacheReadCost ?? 0) + cost.cacheReadCost;
    breakdown.outputCost = (breakdown.outputCost ?? 0) + cost.outputCost;
  } else {
    rollup.models.set(event.model, {
      modelName: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      cacheReadTokens: event.cacheReadTokens,
      cost: cost.total,
      cacheCreationCost: cost.cacheCreationCost,
      cacheReadCost: cost.cacheReadCost,
      outputCost: cost.outputCost,
    });
  }
}

// The eleven token/cost/model fields every per-bucket wire row carries (eight
// base + the ADR-0026 `cacheCreationCost` / `cacheReadCost` split + the ADR-0040
// `outputCost`). Both
// `DailyRow` and `BucketRow` are exactly this shape PLUS one time-key field
// (`date` / `bucketStart`) — see `flushRollup` below. (The three additive slice
// fields (`cacheCreationCost` / `cacheReadCost` / `outputCost`) are
// `.optional()` on the wire schemas; the engine always populates.)
// `DailyRow` / `BucketRow` are the ONLY wire shapes that carry the slices —
// see the module header for how the other rollup consumers drop them.
export type RollupTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  cacheCreationCost: number;
  cacheReadCost: number;
  outputCost: number;
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
};

// Flush a finished rollup into the wire fields shared by `DailyRow` and
// `BucketRow`. `daily`'s `flushRow` and `intraday`'s `flushWindow` each
// spread this and add their own time-key field (`date` / `bucketStart`) — the
// per-row body was a verbatim copy otherwise.
//
// `totalTokens` is the sum of all four token counts (verified against the E1
// golden: a `28368`-token row is `18 + 850 + 5500 + 22000`). `modelsUsed` /
// `modelBreakdowns` follow the rollup's first-seen insertion order.
export function flushRollup(rollup: ModelRollup): RollupTotals {
  return {
    inputTokens: rollup.inputTokens,
    outputTokens: rollup.outputTokens,
    cacheCreationTokens: rollup.cacheCreationTokens,
    cacheReadTokens: rollup.cacheReadTokens,
    totalTokens:
      rollup.inputTokens +
      rollup.outputTokens +
      rollup.cacheCreationTokens +
      rollup.cacheReadTokens,
    totalCost: rollup.totalCost,
    cacheCreationCost: rollup.cacheCreationCost,
    cacheReadCost: rollup.cacheReadCost,
    outputCost: rollup.outputCost,
    modelsUsed: Array.from(rollup.models.keys()),
    modelBreakdowns: Array.from(rollup.models.values()),
  };
}

// Return `events` in ascending timestamp order. The `modelsUsed` /
// `modelBreakdowns` ordering is first-seen, deterministic only when events are
// folded in timestamp order; every aggregator runs its fold over a
// `byTimestamp` result for this reason.
//
// The engine's hot path feeds this a `store.query` result, which is ALREADY
// timestamp-ascending (the store's documented `query` contract). So the common
// case is a single O(N) ordered-check that returns the input untouched — NOT
// an O(N log N) re-sort per aggregator call. Only a genuinely out-of-order
// input (a unit test hand-building events directly) falls through to a sorted
// copy, which keeps every aggregator correct regardless of how it is called.
//
// The comparator below — plain `<` / `>` on the raw timestamp string — is
// DELIBERATELY IDENTICAL to the one `engine/store.ts`'s `sortedEvents()` uses
// to build the snapshot this function is normally handed, and that identity is
// the invariant. Both the ordered-check and the fallback sort must use the
// store's rule, because a DIVERGENT comparator would declare a store-sorted
// array "out of order" and then re-sort the whole corpus under different rules.
// That is not hypothetical: this used to be `localeCompare`, whose ICU
// collation treats punctuation (`-`, `:`, `.`) specially, so it disagrees with
// code-unit order on exactly the characters an ISO-8601 timestamp is made of.
// A silent re-sort changes fold order, and with it the first-seen `modelsUsed`
// ordering and the float-summation artifacts the golden corpus pins. If
// `store.ts` ever changes its comparator, this one changes with it.
//
// Dropping `localeCompare` also removes ~70k ICU comparisons per fold on the
// calibration corpus: the ordered-check runs once per adjacent pair over the
// full array, on every intraday / daily / sessions / projects / blocks fold.
export function byTimestamp(events: StoredEvent[]): StoredEvent[] {
  for (let i = 1; i < events.length; i += 1) {
    const prev = events[i - 1];
    const curr = events[i];
    if (prev !== undefined && curr !== undefined && prev.timestamp > curr.timestamp) {
      return [...events].sort((a, b) =>
        a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
      );
    }
  }
  return events;
}
