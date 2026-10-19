// Carry-forward — how a fetched snapshot lands on the prices already known
// (ADR-0114).
//
// Upstream LiteLLM drops a model's key when the model retires, and never
// re-adds it. Installing a fetch wholesale would therefore price every event
// in a retired model at $0. Instead every install path — the runtime swap
// (`setActivePricingSnapshot`, fed by the refresh and the pricing-cache load),
// release preparation and the dev regeneration script — takes the union:
//
//   - a key the fetch lists gets the fetch's entry WHOLE. Entry-level, not
//     field-level: a field upstream removed from an entry it still lists goes.
//   - a key only `previous` holds keeps `previous`'s entry.
//   - `capturedAt` is the fetch's.
//   - keys are sorted, the transform's invariant.
//
// The merge sits after `transformUpstreamPricing`, never inside it: the
// transform stays a pure upstream slice, and `pricing-cache.json` still stores
// that raw slice (ADR-0096).

import type { ModelPricing, PricingSnapshot } from "./snapshot";

// Identity-preserving, like `withPricingOverrides`: a sorted fetch that already
// lists every previous key IS the union, so it is returned unchanged. That keeps
// `setActivePricingSnapshot(pricingSnapshot)` → `activePricingSnapshot() ===
// pricingSnapshot`, which `buildPricingStatus` reads `source` from.
export function carryForwardPricing(
  previous: PricingSnapshot,
  fetched: PricingSnapshot,
): PricingSnapshot {
  const listed = Object.keys(fetched.models);
  const carried = Object.keys(previous.models).filter((key) => !Object.hasOwn(fetched.models, key));
  if (carried.length === 0 && isSorted(listed)) return fetched;

  const models: Record<string, ModelPricing> = {};
  for (const key of [...listed, ...carried].sort()) {
    models[key] = Object.hasOwn(fetched.models, key) ? fetched.models[key]! : previous.models[key]!;
  }
  return { capturedAt: fetched.capturedAt, models };
}

function isSorted(keys: readonly string[]): boolean {
  for (let i = 1; i < keys.length; i += 1) if (keys[i - 1]! > keys[i]!) return false;
  return true;
}
