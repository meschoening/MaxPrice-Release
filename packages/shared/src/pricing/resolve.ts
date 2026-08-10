// Model-key resolver — raw JSONL model string → pricing snapshot key.
//
// Distinct from `normalizeModelName` (raw → display family). This maps a raw
// model identity to the exact key under which its prices live in the LiteLLM
// snapshot. For current Claude Code model strings (`claude-opus-4-7`,
// `claude-sonnet-4-5`) the exact key hits directly; the alias steps exist for
// provider-prefixed and dated-suffix variants the oracle also tolerates.
//
// An unresolved model returns `null` — `computeCost` turns that into a `0`
// cost.
//
// This module also owns the *active* pricing snapshot. The active snapshot
// defaults to the vendored `snapshot.json`, but E11's startup pricing-refresh
// can swap in a fresher upstream fetch via `setActivePricingSnapshot`. Both the
// resolver's key set and `computeCost`'s price lookups read the active
// snapshot, so a swap is reflected everywhere at once.

import snapshotJson from "./snapshot.json";
import type { PricingSnapshot } from "./snapshot";
import { withPricingOverrides } from "./overrides";

// The vendored offline-floor snapshot — what ships in the binary, and what the
// active snapshot is initialised to. Always available, even with no network.
// Gap-filled with `PRICING_OVERRIDES` (ADR-0027) so a release-day model the
// vendored LiteLLM slice doesn't carry yet still prices; the raw
// `snapshot.json` on disk stays a pure upstream mirror.
export const pricingSnapshot = withPricingOverrides(snapshotJson as PricingSnapshot);

// The currently-active snapshot. Mutable module state: `setActivePricingSnapshot`
// (E11) swaps in a fresher fetch; everything else only reads it.
let activeSnapshot: PricingSnapshot = pricingSnapshot;

// The resolver's key set, derived from `activeSnapshot`. Cached (not rebuilt
// per `resolveModelKey` call) — but it MUST be rebuilt whenever the active
// snapshot is swapped, or the resolver would match against stale keys.
let snapshotKeys = new Set(Object.keys(activeSnapshot.models));

// Memoize raw-model → resolved-key. `resolveModelKey` runs once per event on
// the auto/calculate cost path, almost always over the same handful of distinct
// raw model strings, so the common-case exact match collapses to a single Map
// hit with no allocation. Key space is tiny → no leak. MUST be cleared whenever
// the active snapshot is swapped (the key set changes), so a stale resolution
// can't outlive its snapshot — see `setActivePricingSnapshot`.
const resolveCache = new Map<string, string | null>();

// Swap the active pricing snapshot. Used by the sidecar's startup
// pricing-refresh (E11) to install a fresher upstream fetch over the vendored
// floor. Rebuilds the resolver's key set and clears the resolution cache so a
// model present only in the new snapshot resolves immediately after the swap.
// The incoming snapshot is gap-filled with `PRICING_OVERRIDES` (ADR-0027) —
// snapshot-wins, so an override only survives until upstream prices the model.
export function setActivePricingSnapshot(snapshot: PricingSnapshot): void {
  activeSnapshot = withPricingOverrides(snapshot);
  snapshotKeys = new Set(Object.keys(activeSnapshot.models));
  resolveCache.clear();
}

// The currently-active snapshot — `computeCost` reads its prices, and the
// sidecar reads its `capturedAt` + model count for the status snapshot's
// `pricing` provenance object (ADR-0053). Its IDENTITY is load-bearing too:
// `buildPricingStatus` derives `source` from `activePricingSnapshot() ===
// pricingSnapshot`, which holds because `withPricingOverrides` is
// identity-preserving once every override key is present.
export function activePricingSnapshot(): PricingSnapshot {
  return activeSnapshot;
}

// A trailing `-YYYYMMDD` dated suffix, e.g. the `-20251101` in
// `claude-opus-4-5-20251101`. LiteLLM keys some models dated and some not, so
// the resolver tries both forms.
const DATED_SUFFIX = /-\d{8}$/;

// Resolve a raw model string to its key in the active pricing snapshot.
// Resolution order, first hit wins:
//   1. exact match against a snapshot key
//   2. strip a provider prefix (`anthropic/claude-…` → `claude-…`)
//   3. drop a trailing dated suffix (`claude-opus-4-5-20251101` → `claude-opus-4-5`)
// Resolution only ever *relaxes* the raw string. The reverse — inventing a
// dated variant of an undated key (`claude-opus-4-5` → `claude-opus-4-5-…`) —
// is never attempted: there is no date to invent, so an undated raw string
// only ever matches an undated snapshot key.
// Returns the resolved snapshot key, or `null` if nothing matches.
export function resolveModelKey(rawModel: string): string | null {
  if (typeof rawModel !== "string" || rawModel.length === 0) return null;

  // `Map.get` returns `undefined` for an absent key but the stored value `null`
  // for a previously-resolved unresolvable model, so `!== undefined` reads a
  // cached `null` as a hit rather than recomputing it.
  const cached = resolveCache.get(rawModel);
  if (cached !== undefined) return cached;

  // The ordered candidate list: each transform is additive over the previous.
  const candidates: string[] = [rawModel];

  // Provider prefix — `anthropic/claude-opus-4-7`, `bedrock/claude-…`. Only the
  // segment after the last slash carries the model identity.
  const slash = rawModel.lastIndexOf("/");
  if (slash !== -1) candidates.push(rawModel.slice(slash + 1));

  // Dated-suffix relaxation — try every candidate so far without its date.
  for (const candidate of [...candidates]) {
    if (DATED_SUFFIX.test(candidate)) {
      candidates.push(candidate.replace(DATED_SUFFIX, ""));
    }
  }

  let resolved: string | null = null;
  for (const candidate of candidates) {
    if (snapshotKeys.has(candidate)) {
      resolved = candidate;
      break;
    }
  }
  resolveCache.set(rawModel, resolved);
  return resolved;
}
