import { useMemo } from "react";
import { scopeStateOf, trackedScopeMemberships } from "@maxprice/shared";
import { headMembership, limitArea, type LimitArea } from "@/lib/limit-area";
import { rosterWindowState } from "@/lib/organization-scope-view";
import { useOrganizationLabels, useOrganizations } from "./use-organizations";
import { useScope } from "./use-scope";
import { useScopeMemberships } from "./use-scope-memberships";
import { useSettings } from "./use-settings";

// Live's limit area over the Scope's Memberships (#637 D7, ADR-0142 §2):
// `limitArea` over `/api/accounts`' readings, the Organization labels, the
// roster's plan words and Window states. `kind: "single"` while the Scope
// holds one Membership: the head Membership's card, undefined until settings
// and `/api/accounts` answer.
export function useLimitArea(nowMs: number): LimitArea {
  const { memberships, accounts } = useScopeMemberships();
  const { data: settings } = useSettings();
  const { quotaOrganization } = useScope();
  const labels = useOrganizationLabels();
  const { data } = useOrganizations();
  const roster = data?.organizations;
  const head = useMemo(
    () =>
      settings === undefined || accounts === undefined
        ? undefined
        : headMembership(
            trackedScopeMemberships(accounts, scopeStateOf(settings)),
            quotaOrganization,
          ),
    [settings, accounts, quotaOrganization],
  );
  return useMemo(
    () =>
      limitArea({
        memberships,
        head,
        accounts: accounts ?? [],
        organizationLabels: labels,
        plans: new Map((roster ?? []).map((o) => [o.uuid, o.plan])),
        windowState: (uuid, window) => rosterWindowState(roster, uuid, window),
        nowMs,
      }),
    [memberships, head, accounts, labels, roster, nowMs],
  );
}
