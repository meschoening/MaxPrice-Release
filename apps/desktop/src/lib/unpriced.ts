import { normalizeModelName, type ModelFamily } from "@maxprice/shared";

// #110 / ADR-0087 — joining a row's raw model names against the GLOBAL
// unpriced set the sidecar publishes on `pricing.unpricedModels`. The wire
// carries no per-row flag on purpose: the set is a property of the (store,
// snapshot) pair, and every row already names its raw models, so the join
// happens here, once, for badges, legends and cost chips alike.

export function unpricedIn(models: readonly string[], unpriced: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of models) {
    if (unpriced.has(m) && !out.includes(m)) out.push(m);
  }
  return out;
}

// Family → the raw unpriced names under it. Badges and legends show families
// (the `normalizeModelName` contract everywhere), so a family is marked when
// ANY raw member is unpriced and the tooltip names the members.
export function unpricedFamilies(
  models: readonly string[],
  unpriced: ReadonlySet<string>,
): Map<ModelFamily, string[]> {
  const out = new Map<ModelFamily, string[]>();
  for (const raw of unpricedIn(models, unpriced)) {
    const family = normalizeModelName(raw);
    const list = out.get(family);
    if (list) list.push(raw);
    else out.set(family, [raw]);
  }
  return out;
}

// The set describes missing token prices, not whether events have stored costs.
// Shared with Settings so neither surface claims every affected total is $0.
export const UNPRICED_COST_NOTE =
  "Calculated costs for these models are $0; Auto and Display use recorded costs when available.";

// The explanation every unpriced affordance carries as its `title`.
export function unpricedTitle(names: readonly string[]): string {
  return (
    `Unpriced: ${names.join(", ")} — missing from the pricing data. ${UNPRICED_COST_NOTE} ` +
    `Refresh prices in Settings; if still unpriced, a MaxPrice update is needed.`
  );
}
