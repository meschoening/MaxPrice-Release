import { ALL_ORGANIZATIONS, resolveOrganizationScope } from "./organization-scope";
import type { ScopeSetting } from "./settings";

// The persisted Scope (`Settings.scope`, #637) as the report inputs' Scope
// fields (`ReportQueryInput`, `IntradayHookInput`): its tokens passed through
// unresolved, the sidecar alone resolving them (`resolveScope`). The default
// Scope (`null`) sends no Scope param, so its keys and URLs are the ones every
// single-Account machine always sent, and a one-Organization value sends the
// one `organization=` param the v0.9.x Organization scope did. A Membership
// list names the Scope alone (the sidecar ignores the axes beside it), so the
// axes are left out of its key and URL.
export type ScopeQueryParams = {
  account?: string[];
  organization?: string[];
  memberships?: string[];
};

export function scopeQueryParams(scope: ScopeSetting | null | undefined): ScopeQueryParams {
  if (scope === null || scope === undefined) return {};
  if (scope.membership !== undefined) return { memberships: [...scope.membership] };
  const params: ScopeQueryParams = {};
  if (scope.account !== undefined) params.account = [...scope.account];
  if (scope.organization !== undefined) params.organization = [...scope.organization];
  return params;
}

// The Scope's params as a cache-key part, for a key that is not a report
// input (the session-events stream's): each list sorted, empty lists dropped,
// and undefined for the default Scope, so a key that names no Scope keeps its
// old shape.
export function scopeKeyPart(scope: ScopeQueryParams): ScopeQueryParams | undefined {
  const part: ScopeQueryParams = {};
  for (const field of ["account", "organization", "memberships"] as const) {
    const list = scope[field];
    if (list !== undefined && list.length > 0) part[field] = [...list].sort();
  }
  return Object.keys(part).length === 0 ? undefined : part;
}

// The Headless client's `--org` scope (ADR-0140 §1) as query params: a
// resolved Organization scope, `null` for Home, a uuid or All:
//   - `organization` rides every money query beside `mode` and `tz`. Home is
//     absent, which the sidecar reads as the Home membership (`./scope`), so a
//     single-Account machine keeps today's keys, URLs and answers. A scope
//     naming an Organization leaves the Account axis any.
//   - `quotaOrganization` is the Scope's head Organization (ADR-0136 §6
//     retired the Quota organization; `headOrganization` in the sidecar): the
//     scoped uuid, else Home's. It keys and fetches usage current, whose entry
//     is one Organization's reading until #633 reads one per Membership, so All
//     and Home read Home's uuid entry, and it names the Organization whose
//     Blocks a surface shows, `/api/blocks`' head. The bare entry is left for a
//     machine with no Home.
export interface ScopeParams {
  organization: string[] | undefined;
  quotaOrganization: string | undefined;
  isAll: boolean;
}

export function scopeParams(
  scope: string | null | undefined,
  home: string | null | undefined,
): ScopeParams {
  const homeQuota = home ?? undefined;
  if (scope === null || scope === undefined) {
    return { organization: undefined, quotaOrganization: homeQuota, isAll: false };
  }
  if (scope === ALL_ORGANIZATIONS) {
    return { organization: [ALL_ORGANIZATIONS], quotaOrganization: homeQuota, isAll: true };
  }
  return { organization: [scope], quotaOrganization: scope, isAll: false };
}

// Whether more than one Organization is tracked — Home plus at least one more
// (#312 ruling 7) — asked of the shared resolution rule itself: All resolves to
// All. No Home tracks nothing to choose between. Every Organization-assignment
// affordance sits behind it, so a single-Organization machine renders none.
export function isMultiOrganization(
  home: string | null | undefined,
  tracked: readonly string[] | undefined,
): boolean {
  return (
    resolveOrganizationScope(ALL_ORGANIZATIONS, home ?? null, tracked ?? []) === ALL_ORGANIZATIONS
  );
}
