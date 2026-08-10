// Local pricing overrides — gap-fills for models upstream LiteLLM does not
// price yet (ADR-0027).
//
// LiteLLM lags Anthropic releases: a model can appear in Claude Code JSONL on
// release day with no upstream price entry, which would price its real spend
// at $0 across every report. Each entry here is a *published* Anthropic price
// hand-vendored for that gap — never an invented number (that stance is
// ADR-0011's and it stands).
//
// Precedence is the load-bearing rule: THE SNAPSHOT ALWAYS WINS. An override
// fills a model key only when the active snapshot lacks it, so the day
// upstream publishes the model, the upstream entry takes over automatically
// and the override becomes inert — it self-retires. A stale local number can
// never mask a corrected upstream price. Delete retired entries at leisure.
//
// Parity caveat: the golden oracle prices these models at $0. The
// frozen golden corpus predates every entry here, so parity tests are
// unaffected — but a corpus re-capture containing an overridden model would
// need this documented divergence accounted for (ADR-0027).
//
// `withPricingOverrides` is applied at the two points a snapshot becomes
// active (`resolve.ts`: module init and `setActivePricingSnapshot`), so the
// gap-fill survives both the runtime refresh swap and a `snapshot.json` regen.

import type { ModelPricing, PricingSnapshot } from "./snapshot";

// Keyed like the snapshot: the exact JSONL model string. Prices are USD per
// token, same four fields `computeCost` reads.
export const PRICING_OVERRIDES: Record<string, ModelPricing> = {
  // claude-fable-5 — released 2026-06-09; Anthropic-published launch pricing
  // ($10 / $50 / $12.50 / $1 per Mtok). Remove once upstream LiteLLM carries
  // the key (https://github.com/BerriAI/litellm — model_prices_and_context_window.json).
  "claude-fable-5": {
    input_cost_per_token: 1e-5,
    output_cost_per_token: 5e-5,
    cache_creation_input_token_cost: 1.25e-5,
    cache_read_input_token_cost: 1e-6,
  },
};

// Merge the overrides into a snapshot, snapshot-wins. Identity-preserving:
// when every override key is already present (the post-self-retirement state,
// and re-activations of an already-merged snapshot), the input object is
// returned unchanged — so `setActivePricingSnapshot(pricingSnapshot)` keeps
// `activePricingSnapshot() === pricingSnapshot`, a property the sidecar's
// refresh tests assert on every failure path.
export function withPricingOverrides(snapshot: PricingSnapshot): PricingSnapshot {
  const missing = Object.keys(PRICING_OVERRIDES).filter((key) => !(key in snapshot.models));
  if (missing.length === 0) return snapshot;

  const models: Record<string, ModelPricing> = { ...snapshot.models };
  for (const key of missing) models[key] = PRICING_OVERRIDES[key]!;

  // Keep the snapshot's sorted-keys invariant (snapshot-transform sorts).
  const sortedModels: Record<string, ModelPricing> = {};
  for (const key of Object.keys(models).sort()) sortedModels[key] = models[key]!;

  return { capturedAt: snapshot.capturedAt, models: sortedModels };
}
