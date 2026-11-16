import { useMemo } from "react";
import { blocksTabsView, type BlocksTabsView } from "@/lib/blocks-tabs";
import { rosterWindowState } from "@/lib/organization-scope-view";
import { useMembershipTotals } from "./use-membership-totals";
import { useOrganizationLabels, useOrganizations } from "./use-organizations";
import { useScope } from "./use-scope";
import { useScopeMemberships } from "./use-scope-memberships";
import { useSettings } from "./use-settings";

// The Blocks page's Membership tabs (#619 A, #638) over the Scope's
// Memberships (`useScopeMemberships`): `kind: "single"` on a one-Account
// install, or while `/api/accounts` and settings load. Which Memberships form
// Blocks in the range comes from `/api/membership-totals` under the range and
// the Scope alone: the model and machine filters narrow a Block's sums, never
// its formation (ADR-0017, ADR-0041), so they never move a tab to "no Blocks".
export function useBlocksTabs(input: {
  since: string | undefined;
  until: string | undefined;
  selectedToken: string | null;
  nowMs: number;
}): BlocksTabsView {
  const { memberships, accounts } = useScopeMemberships();
  const { data: settings } = useSettings();
  const { params: scope } = useScope();
  const labels = useOrganizationLabels();
  const { data } = useOrganizations();
  const roster = data?.organizations;
  const totalsQ = useMembershipTotals(
    {
      since: input.since,
      until: input.until,
      mode: settings?.costMode ?? "auto",
      tz: settings?.timezone,
      ...scope,
    },
    { enabled: memberships.length >= 2 },
  );
  const totals = totalsQ.data?.memberships;
  const { selectedToken, nowMs } = input;
  return useMemo(
    () =>
      blocksTabsView({
        memberships,
        accounts: accounts ?? [],
        organizationLabels: labels,
        plans: new Map((roster ?? []).map((o) => [o.uuid, o.plan])),
        totals,
        windowState: (uuid, window) => rosterWindowState(roster, uuid, window),
        selectedToken,
        nowMs,
      }),
    [memberships, accounts, labels, roster, totals, selectedToken, nowMs],
  );
}
