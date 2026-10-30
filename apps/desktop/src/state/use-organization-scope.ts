import { useMemo } from "react";
import { isMultiOrganization, scopeParams, type ScopeParams } from "@maxprice/shared";
import { useSettings } from "./use-settings";

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
