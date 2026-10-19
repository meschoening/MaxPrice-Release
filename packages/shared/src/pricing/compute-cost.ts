// Native cost computation for the usage engine.
//
// `computeCost` reproduces the golden oracle to the cent. The load-bearing detail: all
// cache-creation tokens are priced at the *flat* `cache_creation_input_token_cost`
// rate. LiteLLM also publishes a time-tiered `cache_creation_input_token_cost_above_1hr`,
// but ccusage never applies it — and the E1 spike confirmed that the flat rate
// matches ccusage ($0.3418065) while the tiered rate does not ($0.4921740).
// The vendored snapshot keeps the `_above_1hr` field for a possible future
// tiered mode, but `computeCostBreakdownInto`, which prices every cost here,
// deliberately ignores it.

import type { CostMode } from "../cost-mode";
import { resolveModelKey, activePricingSnapshot } from "./resolve";

// The four token counts a cost is computed from — a structural subset of the
// parser's `UsageRecord`, so an aggregator holding `UsageRecord`s can pass one
// straight through. The folds do exactly that with each stored event, rather
// than copying its four counts into a literal per event (#416).
//
// This intentionally does NOT reuse `blocks.ts`'s `TokenCounts`: that type
// carries the blocks-wire field names (`cacheCreationInputTokens` /
// `cacheReadInputTokens`), whereas `CostTokenCounts` matches `UsageRecord`'s
// names (`cacheCreationTokens` / `cacheReadTokens`). The two are deliberately
// distinct shapes for distinct boundaries — don't "DRY them up".
export type CostTokenCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};

// Resolve the billed total for a cost mode from the stored cost and the
// computed component sum. The `??` is load-bearing: a stored cost of 0 is a
// real value in `display`/`auto`, distinct from absent.
function resolveTotal(
  mode: CostMode,
  storedCostUSD: number | undefined,
  computedTotal: number,
): number {
  switch (mode) {
    case "display":
      return storedCostUSD ?? 0;
    case "calculate":
      return computedTotal;
    case "auto":
      return storedCostUSD ?? computedTotal;
  }
}

// Resolve a USD cost for one model's token counts under the given cost mode:
//
//   - `display`   → the pre-stored `costUSD` verbatim (≈0 on current Claude
//                   Code data, which omits the field) — never recomputed.
//   - `calculate` → always `tokens × unit prices`, ignoring any stored cost.
//   - `auto`      → the stored cost when present, else the computed cost.
//
// An unresolved model's computed cost is 0; auto/display still honor stored costs.
//
// It is the total `computeCostBreakdownInto` writes for the same event, so the
// two structurally cannot drift. Nothing allocates: the breakdown is
// `computeCost`'s own, and only its total leaves.
export function computeCost(
  model: string,
  tokenCounts: CostTokenCounts,
  mode: CostMode,
  storedCostUSD: number | undefined,
): number {
  computeCostBreakdownInto(costScratch, model, tokenCounts, mode, storedCostUSD);
  return costScratch.total;
}

const costScratch = emptyCostBreakdown();

// The cost of one event split into its output + cache components, for the
// token-type group-by (ADR-0040, superseding ADR-0026's cache-only split).
// `total` is the mode-resolved cost (identical to `computeCost`); `outputCost` /
// `cacheCreationCost` / `cacheReadCost` are the corresponding slices of it. The
// renderer derives the Input band as the remainder:
// `total - outputCost - cacheCreationCost - cacheReadCost`.
//
// The slices ALWAYS reconcile to `total`: the pricing snapshot is read exactly
// once per event (one `computeCostBreakdownInto` call), so `total` and the
// slices derive from the same component sum — the invariant is structural, not
// dependent on two snapshot reads landing in the same synchronous tick. The
// components are token-priced, then scaled by `total / computedTotal`. In
// `calculate` mode, or `auto` falling through to the computed cost (Claude Code
// JSONL omits `costUSD`), that scale is 1 and the slices are exact; in
// `display` mode with no stored cost the total is 0 and every slice is 0. When
// `total` is a stored `costUSD`, the slices are apportioned so the chart's
// stacked bands still reconcile penny-exactly with the Total. computedTotal ===
// 0 (unresolved model / zero tokens) → nothing to apportion; all of `total` is
// the derived input.
export type CostBreakdown = {
  total: number;
  outputCost: number;
  cacheCreationCost: number;
  cacheReadCost: number;
};

// A zeroed breakdown, for a fold to own and price every event into.
export function emptyCostBreakdown(): CostBreakdown {
  return { total: 0, outputCost: 0, cacheCreationCost: 0, cacheReadCost: 0 };
}

// Price one event into `out`, overwriting all four fields. It allocates
// nothing, so a fold prices every event into one breakdown it owns (#416):
// `tokenCounts` may be the stored event itself, and `out` is the caller's to
// reuse. The next call overwrites it, so a caller that keeps a breakdown past
// its loop iteration copies the numbers out, into its own accumulators; it
// never holds `out` itself.
//
// An unresolved model — or a missing price field — yields 0 for the affected
// component rather than throwing. The four components sum in the order
// `input + output + cacheCreation + cacheRead`, the order the golden corpus
// pins.
export function computeCostBreakdownInto(
  out: CostBreakdown,
  model: string,
  tokenCounts: CostTokenCounts,
  mode: CostMode,
  storedCostUSD: number | undefined,
): void {
  const key = resolveModelKey(model);
  const pricing = key === null ? undefined : activePricingSnapshot().models[key];
  let input = 0;
  let output = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  if (pricing !== undefined) {
    input = tokenCounts.inputTokens * (pricing.input_cost_per_token ?? 0);
    output = tokenCounts.outputTokens * (pricing.output_cost_per_token ?? 0);
    cacheCreation =
      tokenCounts.cacheCreationTokens * (pricing.cache_creation_input_token_cost ?? 0);
    cacheRead = tokenCounts.cacheReadTokens * (pricing.cache_read_input_token_cost ?? 0);
  }
  const computedTotal = input + output + cacheCreation + cacheRead;
  const total = resolveTotal(mode, storedCostUSD, computedTotal);
  const scale = computedTotal > 0 ? total / computedTotal : 0;
  out.total = total;
  out.outputCost = output * scale;
  out.cacheCreationCost = cacheCreation * scale;
  out.cacheReadCost = cacheRead * scale;
}
