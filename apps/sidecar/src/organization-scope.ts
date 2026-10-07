// The Organization scope (GLOSSARY.md, #278) as the store sees it: the
// `organization` query param every money endpoint reads, resolved to the
// store's `organizations` axis (`StoreQuery.organizations`,
// `ReportFilters.organizations`). The same param also names the Quota
// organization (`quotaOrganization`, below), which /api/usage/current, the
// readout's utilization half, /api/blocks and the `block` span answer — the
// last two through `quotaSampleScope`, which Block formation reads.
//
// The resolution rule is `resolveOrganizationScope`'s (@maxprice/shared) — the
// one the renderer's `parseSettings` applies too — so a stale value answers
// here exactly as it reads there:
//   - absent is Home, and so is anything that names nothing tracked, the Home
//     uuid itself, and `all` on a machine that tracks only Home;
//   - `all` is THIS machine's resolved tracked set (`trackedNow()` in main()),
//     never every Organization the replica or the store happens to hold (#262
//     item 4) — a fleet row tagged with an Organization this machine does not
//     track stays out of All;
//   - no Home (`home === null`, the ADR-0098 null set) narrows nothing.
//
// A resolved Home becomes `[home]`, not "no filter": on a machine that tracks
// more than Home, Home's answer is Home's rows. The single-Organization machine
// keeps its unfiltered fast path anyway, because the "covers everything
// present" no-op lives in `store.query` (#261/#262) — `[Home]` there covers
// every row, so the axis drops and the answer is byte-identical to no filter.

import { ALL_ORGANIZATIONS, resolveOrganizationScope } from "@maxprice/shared";
import type { Presumption } from "./engine/presumption";

// What the scope resolves against: the installed Home and the resolved tracked
// set, both read live per request. While settings work queues, Home remains
// the installed presumption's Home; the admission set changes at arrival.
export type OrganizationScopeState = {
  home: string | null;
  tracked: ReadonlySet<string> | null;
};

// Share the store's presumption cell: settings arrival can precede its queued
// installation by an entire rebuild. Reading the requested Home would filter
// owner-less rows under a different Home from the one that resolves them.
export function createOrganizationScope(
  getPresumption: () => Presumption,
  trackedNow: () => ReadonlySet<string> | null,
): () => OrganizationScopeState {
  return () => ({ home: getPresumption().selfHome, tracked: trackedNow() });
}

// The `organizations` list one request hands the store. `[]` = no narrowing
// (no Home); otherwise sorted and never empty.
export function scopeOrganizations(
  param: string | undefined,
  { home, tracked }: OrganizationScopeState,
): string[] {
  if (home === null || tracked === null) return [];
  const scope = resolveOrganizationScope(param, home, tracked);
  if (scope === null) return [home];
  if (scope === ALL_ORGANIZATIONS) return [...tracked].sort();
  return [scope];
}

// The Quota organization (GLOSSARY.md, #262 item 6): the ONE Organization every
// quota-shaped surface describes. Money sums across All organizations; quota
// cannot, so under All it is Home, and otherwise it is whatever the scope
// resolved to — Home for anything that names nothing tracked. Resolved from
// the same param and the same `OrganizationScopeState` as
// `scopeOrganizations`, so one response never pairs its money scope with a
// different Home. `null` only when there is no Home: the poller's no-Home
// answer (`getCurrent(null)`), which names no Organization.
export function quotaOrganization(
  param: string | undefined,
  { home, tracked }: OrganizationScopeState,
): string | null {
  if (home === null) return null;
  const scope = resolveOrganizationScope(param, home, tracked ?? []);
  return scope === null || scope === ALL_ORGANIZATIONS ? home : scope;
}

// The Quota organization as Block formation takes it (the sample store's
// `SampleScope`): the Organization, and the Home its unstamped samples presume
// under — both from ONE state read, so a request never pairs one Home's samples
// with another Home's Organization. `null` exactly when `quotaOrganization` is
// (no Home): formation then reads every row and every sample.
export function quotaSampleScope(
  param: string | undefined,
  state: OrganizationScopeState,
): { organization: string; home: string } | null {
  const organization = quotaOrganization(param, state);
  return organization === null || state.home === null ? null : { organization, home: state.home };
}
