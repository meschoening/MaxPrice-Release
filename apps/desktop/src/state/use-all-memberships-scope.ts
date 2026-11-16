import {
  SCOPE_ALL,
  trackedAccountSet,
  type ScopeQueryParams,
  type Settings,
} from "@maxprice/shared";
import { useScope } from "./use-scope";
import { useSettings } from "./use-settings";

// The Scope of every tracked Membership, for a query that must not follow the
// persisted Scope: the project merge picker's catalogue and the ⌘K finder's
// haystack (#640). Past one tracked Organization, or with two or more tracked
// Accounts, it names all of them (`account=all&organization=all`), so a
// session or checkout whose only usage is in another Membership is still
// there; otherwise it sends no Scope param, where every tracked Membership is
// the Home membership and the request is the default Scope's own.
export function allMembershipsScope(
  multi: boolean,
  settings: Pick<Settings, "homeMemberships" | "trackedAccounts"> | undefined,
): ScopeQueryParams {
  return multi || (settings !== undefined && (trackedAccountSet(settings)?.size ?? 0) >= 2)
    ? { account: [SCOPE_ALL], organization: [SCOPE_ALL] }
    : {};
}

export function useAllMembershipsScope(): ScopeQueryParams {
  const { multi } = useScope();
  const { data: settings } = useSettings();
  return allMembershipsScope(multi, settings);
}
