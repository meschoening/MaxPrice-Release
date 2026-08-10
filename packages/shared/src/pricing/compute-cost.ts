// Native cost computation for the usage engine.
//
// `computeCost` reproduces the golden oracle to the cent. The load-bearing detail: all
// cache-creation tokens are priced at the *flat* `cache_creation_input_token_cost`
// rate. LiteLLM also publishes a time-tiered `cache_creation_input_token_cost_above_1hr`,
// but ccusage never applies it — and the E1 spike confirmed that the flat rate
// matches ccusage ($0.3418065) while the tiered rate does not ($0.4921740).
// The vendored snapshot keeps the `_above_1hr` field for a possible future
// tiered mode, but this function deliberately ignores it.

import type { CostMode } from "../cost-mode";
import { resolveModelKey, activePricingSnapshot } from "./resolve";

// The four token counts a cost is computed from — a structural subset of the
// parser's `UsageRecord`, so an aggregator holding `UsageRecord`s can pass one
// straight through.
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

// The four token-type cost components at list price (the `calculate` math),
// computed in one place so `computeFromTokens` and `computeCostBreakdown` agree
// to the cent. An unresolved model — or a missing price field — yields 0 for the
// affected term rather than throwing.
function costComponents(
  model: string,
  tokens: CostTokenCounts,
): { input: number; output: number; cacheCreation: number; cacheRead: number } {
  const key = resolveModelKey(model);
  const pricing = key === null ? undefined : activePricingSnapshot().models[key];
  if (pricing === undefined) {
    return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  }
  return {
    input: tokens.inputTokens * (pricing.input_cost_per_token ?? 0),
    output: tokens.outputTokens * (pricing.output_cost_per_token ?? 0),
    cacheCreation: tokens.cacheCreationTokens * (pricing.cache_creation_input_token_cost ?? 0),
    cacheRead: tokens.cacheReadTokens * (pricing.cache_read_input_token_cost ?? 0),
  };
}

function computeFromTokens(model: string, tokens: CostTokenCounts): number {
  const c = costComponents(model, tokens);
  return c.input + c.output + c.cacheCreation + c.cacheRead;
}

// Resolve the billed total for a cost mode from the stored cost and the
// computed component sum. Shared by `computeCost` and `computeCostBreakdown`
// so the two mode switches structurally cannot drift. The `??` is load-bearing:
// a stored cost of 0 is a real value in `display`/`auto`, distinct from absent.
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
// An unresolved model never crashes — it yields `0`.
export function computeCost(
  model: string,
  tokenCounts: CostTokenCounts,
  mode: CostMode,
  storedCostUSD: number | undefined,
): number {
  return resolveTotal(mode, storedCostUSD, computeFromTokens(model, tokenCounts));
}

// The cost of one event split into its output + cache components, for the
// token-type group-by (ADR-0040, superseding ADR-0026's cache-only split).
// `total` is the mode-resolved cost (identical to `computeCost`); `outputCost` /
// `cacheCreationCost` / `cacheReadCost` are the corresponding slices of it. The
// renderer derives the Input band as the remainder:
// `total - outputCost - cacheCreationCost - cacheReadCost`.
//
// The slices ALWAYS reconcile to `total`: the pricing snapshot is read exactly
// once per event (one `costComponents` call), so `total` and the slices derive
// from the same component sum — the invariant is structural, not dependent on
// two snapshot reads landing in the same synchronous tick. The components are
// token-priced, then scaled by `total / computedTotal`. In `calculate` mode, or
// `auto` falling through to the computed cost (Claude Code JSONL omits
// `costUSD`), that scale is 1 and the slices are exact; in `display` mode with
// no stored cost the total is 0 and every slice is 0. When `total` is a stored
// `costUSD`, the slices are apportioned so the chart's stacked bands still
// reconcile penny-exactly with the Total. computedTotal === 0 (unresolved model
// / zero tokens) → nothing to apportion; all of `total` is the derived input.
export type CostBreakdown = {
  total: number;
  outputCost: number;
  cacheCreationCost: number;
  cacheReadCost: number;
};

export function computeCostBreakdown(
  model: string,
  tokenCounts: CostTokenCounts,
  mode: CostMode,
  storedCostUSD: number | undefined,
): CostBreakdown {
  const c = costComponents(model, tokenCounts);
  // Same addition order as `computeFromTokens`, so the floats are bit-identical
  // to what `computeCost` resolves for the same event.
  const computedTotal = c.input + c.output + c.cacheCreation + c.cacheRead;
  const total = resolveTotal(mode, storedCostUSD, computedTotal);
  const scale = computedTotal > 0 ? total / computedTotal : 0;
  return {
    total,
    outputCost: c.output * scale,
    cacheCreationCost: c.cacheCreation * scale,
    cacheReadCost: c.cacheRead * scale,
  };
}
