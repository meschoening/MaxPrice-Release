// The upstream-LiteLLM → `PricingSnapshot` transform — the single shared
// implementation behind both the build-time `scripts/refresh-pricing.ts`
// regeneration and E11's runtime startup fetch.
//
// The transform is split into a pure part and an I/O part:
//
//   - `transformUpstreamPricing` — pure: raw upstream object → `PricingSnapshot`.
//     Filters to the Claude models (keys matching /claude/i), keeps only the
//     unit-price fields the cost math needs, sorts, and stamps `capturedAt`.
//   - `UPSTREAM_PRICING_URL` — the canonical raw JSON URL both fetchers use.
//
// The `fetch()` itself stays out of this module: the build script does its own
// `fetch` + write, and the sidecar's `pricing-refresh.ts` does its own
// `fetch` with an `AbortSignal` timeout. Both feed the bytes through
// `transformUpstreamPricing` so the filter/stamp logic lives in exactly one
// place.

import type { ModelPricing, PricingSnapshot } from "./snapshot";

// The canonical raw URL — the JSON file at the root of the BerriAI/litellm
// repo's default branch. Verified reachable (HTTP 200, ~1.4 MB) during E3.
export const UPSTREAM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// Magnitude sanity ceiling for a single per-token price, in USD. Per-token
// costs are tiny fractions of a dollar — today's dearest Claude model is
// ~$8.3e-5/token — so $1/token is ~12,000x the current maximum. No legitimate
// price (now, or plausibly ever) approaches it, yet it still catches absurd
// tampered/garbled values: an injected huge number, or a per-MILLION figure
// mistakenly carried as per-token (e.g. 82.5 instead of 8.25e-5). The floor is
// 0 — a real entry can legitimately be exactly 0 (free tier / unset cache
// rate), but never negative. Out-of-range prices are dropped exactly like
// non-finite ones; an entry left with no usable price is skipped below.
const MAX_PRICE_PER_TOKEN = 1;

// The unit-price fields carried into the snapshot. Everything else in an
// upstream entry (context windows, capability flags, …) is dropped to keep the
// snapshot tiny.
const PRICE_FIELDS = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_creation_input_token_cost",
  "cache_read_input_token_cost",
  "cache_creation_input_token_cost_above_1hr",
] as const satisfies ReadonlyArray<keyof ModelPricing>;

// Transform a raw upstream LiteLLM price object into a Claude-only
// `PricingSnapshot`. Pure — `capturedAt` is supplied by the caller so the
// function stays deterministic and testable (the build script and the runtime
// fetch each pass their own fetch time).
//
// Throws if `upstream` is not a plain object, or if no Claude model with
// usable pricing is found — an empty result almost always means the upstream
// shape changed, and silently producing a zero-price snapshot would be worse
// than failing loudly (the sidecar's refresh catches this and keeps the
// vendored snapshot; the build script surfaces it as an error).
export function transformUpstreamPricing(upstream: unknown, capturedAt: string): PricingSnapshot {
  if (upstream === null || typeof upstream !== "object" || Array.isArray(upstream)) {
    throw new Error("upstream pricing payload is not an object");
  }

  const models: Record<string, ModelPricing> = {};
  for (const [key, entry] of Object.entries(upstream as Record<string, unknown>)) {
    if (!/claude/i.test(key)) continue;
    if (entry === null || typeof entry !== "object") continue;

    const source = entry as Record<string, unknown>;
    const pricing: ModelPricing = {};
    for (const field of PRICE_FIELDS) {
      const value = source[field];
      // Two guards, both treating a bad value as "skip this field":
      //   1. `Number.isFinite`, not `typeof === "number"`: `NaN`/`Infinity` are
      //      `typeof "number"` and would silently propagate into `computeCost`,
      //      yielding non-finite costs across every report.
      //   2. Magnitude bound `[0, MAX_PRICE_PER_TOKEN]`: reject negative or
      //      absurdly large prices (tampered/garbled upstream data) before they
      //      can poison costs. See `MAX_PRICE_PER_TOKEN` above.
      // The `Object.keys(pricing).length > 0` guard below then skips an entry
      // left with no usable price at all; the vendored snapshot is the floor.
      if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= MAX_PRICE_PER_TOKEN
      ) {
        pricing[field] = value;
      }
    }
    // Skip entries with no usable pricing at all (e.g. routing aliases).
    if (Object.keys(pricing).length > 0) models[key] = pricing;
  }

  if (Object.keys(models).length === 0) {
    throw new Error("upstream pricing payload contained no Claude models with pricing");
  }

  const sortedModels: Record<string, ModelPricing> = {};
  for (const key of Object.keys(models).sort()) sortedModels[key] = models[key]!;

  return { capturedAt, models: sortedModels };
}
