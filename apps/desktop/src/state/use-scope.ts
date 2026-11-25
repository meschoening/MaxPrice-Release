import { useMemo } from "react";
import { visibleScopeView, type ScopeView } from "@/lib/scope-view";
import { useAccounts } from "./use-organizations";
import { useScopeHead } from "./use-scope-head";
import { useSettings } from "./use-settings";

// The persisted Scope (`settings.scope`, #637) for the main window's report
// hooks and surfaces: `params` rides every money query beside `mode` and `tz`,
// unresolved (the sidecar resolves it), and the rest is `scopeView`'s. While
// the Account filter is hidden (fewer than two tracked Accounts) only the
// default Scope or an Organization-axis one is read (`visibleScopeView`). The
// popout reads the same view (`usePopoutData`), so both windows describe one
// Scope.
//
// `quotaOrganization` is the shared head rule's: settled from settings for
// the common Scopes, else the sidecar's answer for the same params
// (`/api/scope-head`), so the quota tiles read the Organization
// `/api/usage/current` heads for that Scope.
//
// Memoized on the settings value, the Account list and the head's answer,
// which TanStack's structural sharing keeps referentially stable until they
// change.
export function useScope(): ScopeView {
  const { data: settings } = useSettings();
  const { data: accounts } = useAccounts();
  const list = accounts?.accounts;
  const view = useMemo(() => visibleScopeView(settings, list), [settings, list]);
  const { data: head } = useScopeHead(view.params, view.headPending);
  const answered = view.headPending ? head?.organizationUuid : undefined;
  return useMemo(
    () => (answered === undefined ? view : { ...view, quotaOrganization: answered ?? undefined }),
    [view, answered],
  );
}
