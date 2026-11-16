import { useMemo } from "react";
import { limitArea, type LimitArea } from "@/lib/limit-area";
import { rosterWindowState } from "@/lib/organization-scope-view";
import { useOrganizationLabels, useOrganizations } from "./use-organizations";
import { useScopeMemberships } from "./use-scope-memberships";

// Live's limit area over the Scope's Memberships (#637 D7): `limitArea` over
// `/api/accounts`' readings, the Organization labels and the roster's Window
// states. `kind: "single"` while the Scope holds one Membership, or while
// `/api/accounts` has not answered.
export function useLimitArea(nowMs: number): LimitArea {
  const { memberships, accounts } = useScopeMemberships();
  const labels = useOrganizationLabels();
  const { data } = useOrganizations();
  const roster = data?.organizations;
  return useMemo(
    () =>
      limitArea({
        memberships,
        accounts: accounts ?? [],
        organizationLabels: labels,
        windowState: (uuid, window) => rosterWindowState(roster, uuid, window),
        nowMs,
      }),
    [memberships, accounts, labels, roster, nowMs],
  );
}
