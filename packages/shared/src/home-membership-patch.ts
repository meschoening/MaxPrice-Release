import { isPendingAccountKey } from "./accounts";
import { homeMembershipOf, type Settings } from "./settings";

// Choosing the Home membership (ADR-0136 §5; #621's Home select, #639): the
// settings write that makes `organizationUuid` held by `accountUuid` the
// Anthropic Home membership.
//
// The Home membership's Account and Organization are always tracked: the
// sidecar resolves each tracked set as its list UNION the Home's
// (`resolveTrackedOrganizations`, `resolveTrackedAccounts`). So choosing a
// Membership tracks its Account and Organization by making them Home, and
// they leave the lists, which need not name them. The old Home's Account and
// Organization would fall out of both sets with it, so they join the lists
// and stay tracked: what `makeHomePatch` does for an Organization alone. A
// pick whose Organization or Account was excluded widens the sets by exactly
// that one entry (an additive change, ADR-0098 §5); nothing else moves.
//
// `trackedAccounts: null` is a file that predates Accounts (ADR-0136 §8): the
// sidecar excludes no Account until the host persists its seed, so the patch
// leaves it null rather than write a one-Account list over the upgrade set
// (`accountList`'s rule in organization-tracking.ts). Every other Provider's
// Home membership is kept.
//
// null with no Home membership yet: the sidecar then resolves no tracked set
// and excludes nothing, so writing a Home would narrow both sets to it plus the
// lists, an exclusion no confirm asked for (`makeHomePatch`'s rule). The Home
// comes from the first launch's seed instead (ADR-0136 §4). Also null when
// there is nothing to write (the pick already is Home) or the pick
// cannot be a Home membership: a Pending account's key never leaves this
// machine, and a Home membership is published (ADR-0136 §4's note), so its
// Account must be an account uuid. Built inside the settings write chain, like
// `trackPatch`.
export function homeMembershipPatch(
  settings: Pick<Settings, "homeMemberships" | "trackedOrganizations" | "trackedAccounts">,
  organizationUuid: string,
  accountUuid: string,
): Pick<Settings, "homeMemberships" | "trackedOrganizations" | "trackedAccounts"> | null {
  if (organizationUuid === "" || accountUuid === "" || isPendingAccountKey(accountUuid)) {
    return null;
  }
  const old = homeMembershipOf(settings);
  if (old === null) return null;
  if (old.organizationUuid === organizationUuid && old.accountUuid === accountUuid) return null;

  const organizations = new Set(settings.trackedOrganizations);
  organizations.add(old.organizationUuid);
  organizations.delete(organizationUuid);

  let trackedAccounts = settings.trackedAccounts;
  if (trackedAccounts !== null) {
    const accounts = new Set(trackedAccounts);
    if (old.accountUuid !== null) accounts.add(old.accountUuid);
    accounts.delete(accountUuid);
    trackedAccounts = [...accounts];
  }

  return {
    homeMemberships: {
      ...settings.homeMemberships,
      anthropic: { organizationUuid, accountUuid },
    },
    trackedOrganizations: [...organizations],
    trackedAccounts,
  };
}
