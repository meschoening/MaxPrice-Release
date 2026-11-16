import type { CostMode, MembershipTotal, MembershipTotalsResponse } from "@maxprice/shared";
import { aggregateDaily } from "./daily";
import { eventAccount, eventOrganization, type Presumption } from "./presumption";
import type { StoredEvent } from "./store";

// `GET /api/membership-totals` (#637): a scoped store query result split by
// the Membership each row resolves to, the Organization resolved-or-presumed
// and the Account resolved (`eventOrganization`, `eventAccount`), the same
// resolution the store's Scope axes narrow by.
//
// Each Membership's numbers are `/api/daily`'s `totals` over its rows alone:
// the rows keep the query's timestamp order, are priced per event and summed
// per local date, then over the dates, exactly as `aggregateDaily` does. So a
// Membership's `costUSD` is, to the bit, what `/api/daily` answers for a Scope
// of that one Membership under the same filters; the rows' sum is the scoped
// daily total up to float reassociation. So `totals` is not that sum: it is
// `aggregateDaily`'s own `totals` over every row, in the query's order, and so
// bit-identical to `/api/daily`'s for the same query.
//
// A row with no Organization (no Home to presume it under) is grouped under a
// null Organization rather than dropped, so the rows partition the answer.
// Sorted by Organization uuid, then Account key, null last on each.
export function aggregateMembershipTotals(
  events: readonly StoredEvent[],
  mode: CostMode,
  timeZone: string,
  presumption: Presumption,
): MembershipTotalsResponse {
  const groups = new Map<
    string,
    { organizationUuid: string | null; accountUuid: string | null; events: StoredEvent[] }
  >();
  for (const event of events) {
    const organizationUuid = eventOrganization(event, presumption) ?? null;
    const accountUuid = eventAccount(event, presumption) ?? null;
    const key = JSON.stringify([organizationUuid, accountUuid]);
    let group = groups.get(key);
    if (group === undefined) {
      group = { organizationUuid, accountUuid, events: [] };
      groups.set(key, group);
    }
    group.events.push(event);
  }
  const memberships: MembershipTotal[] = [];
  for (const group of groups.values()) {
    const { totals } = aggregateDaily(group.events, mode, { projectFilterCount: 0, timeZone });
    memberships.push({
      organizationUuid: group.organizationUuid,
      accountUuid: group.accountUuid,
      costUSD: totals?.totalCost ?? 0,
      totalTokens: totals?.totalTokens ?? 0,
    });
  }
  // Always the totals fold, whatever the project filter count: `/api/daily`
  // omits its `totals` on a 2+-project filter, and folds the same rows when not.
  const whole = aggregateDaily([...events], mode, { projectFilterCount: 0, timeZone }).totals;
  return {
    memberships: memberships.sort(compareTotals),
    totals: { costUSD: whole?.totalCost ?? 0, totalTokens: whole?.totalTokens ?? 0 },
  };
}

const compareNullable = (a: string | null, b: string | null): number =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;

function compareTotals(a: MembershipTotal, b: MembershipTotal): number {
  return (
    compareNullable(a.organizationUuid, b.organizationUuid) ||
    compareNullable(a.accountUuid, b.accountUuid)
  );
}
