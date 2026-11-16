import {
  scopeHasMembership,
  type AccountEntry,
  type ReadoutWideScope,
  type ResolvedScope,
  type ScopeState,
} from "@maxprice/shared";

// The money Readout's wide Scope (#622 item 4, #637; `ReadoutResponse.
// wideScope`): what `todayCost` sums when the request's resolved Scope holds
// more than one Membership, as facts the shell words without resolving
// anything. Pure.
//
// - A Scope named by Memberships (`membership=` params) is exactly its list:
//   two or more are `memberships`, whatever they cover. A list is never "all":
//   it holds no Unknown Membership it does not name, where all does (D1).
// - A Scope named by its axes that covers every tracked Organization with any
//   Account (`account=all&organization=all`, or `organization=all` alone,
//   which leaves the Account axis any) is `accounts` while two or more
//   Accounts are tracked, else `organizations` while two or more Organizations
//   are, which is the v0.9.x All organizations and keeps its wording.
// - Any other Scope counts the tracked Memberships it holds, from the Account
//   roster (`accounts`: a tracked Account's Memberships in a tracked
//   Organization): two or more are `memberships`.
// - Anything else holds one Membership, or none, and is null.
//
// The tracked Account count is the resolved set's, or the roster's tracked
// Accounts while that set excludes nothing (null).
export function readoutWideScope(
  resolved: ResolvedScope,
  state: ScopeState,
  accounts: readonly Pick<AccountEntry, "key" | "tracked" | "memberships">[],
): ReadoutWideScope | null {
  if (resolved.memberships !== undefined) {
    const count = resolved.memberships.length;
    return count >= 2 ? { kind: "memberships", count } : null;
  }
  const trackedOrganizations = state.trackedOrganizations;
  const organizationTracked = (uuid: string): boolean =>
    trackedOrganizations === null || trackedOrganizations.has(uuid);
  const trackedAccounts = accounts.filter((account) => account.tracked);
  const accountCount = state.trackedAccounts?.size ?? trackedAccounts.length;

  const anyAccount = resolved.accounts.length === 0;
  const everyOrganization =
    resolved.organizations.length === 0 ||
    (trackedOrganizations !== null &&
      [...trackedOrganizations].every((uuid) => resolved.organizations.includes(uuid)));
  if (anyAccount && everyOrganization) {
    if (accountCount >= 2) return { kind: "accounts" };
    if ((trackedOrganizations?.size ?? 0) >= 2) return { kind: "organizations" };
    return null;
  }

  let count = 0;
  for (const account of trackedAccounts) {
    for (const membership of account.memberships) {
      const { organizationUuid } = membership;
      if (!organizationTracked(organizationUuid)) continue;
      if (scopeHasMembership(resolved, organizationUuid, account.key)) count += 1;
    }
  }
  return count >= 2 ? { kind: "memberships", count } : null;
}
