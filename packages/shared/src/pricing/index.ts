// The pricing module — native cost computation from a vendored LiteLLM
// price snapshot. Re-exported through `packages/shared/src/index.ts`.

export type { ModelPricing, PricingSnapshot } from "./snapshot";
export {
  pricingSnapshot,
  resolveModelKey,
  unresolvedModels,
  setActivePricingSnapshot,
  activePricingSnapshot,
} from "./resolve";
export {
  computeCost,
  computeCostBreakdown,
  type CostBreakdown,
  type CostTokenCounts,
} from "./compute-cost";
export { transformUpstreamPricing, UPSTREAM_PRICING_URL } from "./snapshot-transform";

export {
  fetchPricingSnapshot,
  type PricingFetchResult,
  type RefreshPricingResult,
  type RefreshPricingOptions,
} from "./fetch-snapshot";
export { parsePricingSnapshot } from "./validate-snapshot";
