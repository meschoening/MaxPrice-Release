import { useMemo } from "react";
import { ALL_ORGANIZATIONS, resolveOrganizationScope } from "@maxprice/shared";
import { useSettings } from "./use-settings";

// The Organization scope as query params (ADR-0106). The settings cache holds
// the RESOLVED scope — `parseSettings` has already turned junk, an untracked
// uuid and a stale `all` into `null` — so this only maps it:
//   - `organization` rides every money query beside `mode` and `tz`. Home is
//     absent, so a single-Organization machine keeps today's keys and URLs.
//   - `quotaOrganization` is the Quota organization's uuid: the scoped uuid,
//     else Home's. It keys and fetches usage current, whose entry is one
//     Organization's reading, so All and Home read Home's uuid entry. The bare
//     entry is left for a machine with no Home.
export interface ScopeParams {
  organization: string | undefined;
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
    return { organization: ALL_ORGANIZATIONS, quotaOrganization: homeQuota, isAll: true };
  }
  return { organization: scope, quotaOrganization: scope, isAll: false };
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

export interface OrganizationScope extends ScopeParams {
  multi: boolean;
}

export function useOrganizationScope(): OrganizationScope {
  const { data: settings } = useSettings();
  const scope = settings?.organizationScope ?? null;
  const home = settings?.homeOrganization ?? null;
  const multi = isMultiOrganization(home, settings?.trackedOrganizations);
  return useMemo(() => ({ ...scopeParams(scope, home), multi }), [scope, home, multi]);
}
