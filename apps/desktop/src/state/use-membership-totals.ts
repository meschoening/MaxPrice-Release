import {
  MEMBERSHIP_TOTALS_PATH,
  membershipTotalsKey,
  membershipTotalsResponseSchema,
  type ReportQueryInput,
} from "@maxprice/shared";
import { makeReportHook } from "./report-hook";

// /api/membership-totals (#637): the scoped money split by Membership, for the
// split money tiles. The ADR-0004 four-piece split, as `use-daily.ts`, but
// its URL piece is @maxprice/shared's `buildMembershipTotalsUrl` (the same
// URL `hook.buildUrl` builds), as `use-intraday.ts` takes shared's
// `buildIntradayUrl`: the shared builder is the one name, never re-exported.
// "membership-totals" is in `DATA_QUERY_KEYS`, so a cost-mode change and SSE
// `usage:new` refresh it with the other reports.
export type MembershipTotalsQueryInput = ReportQueryInput;

const hook = makeReportHook({
  path: MEMBERSHIP_TOTALS_PATH,
  keyBuilder: membershipTotalsKey,
  schema: membershipTotalsResponseSchema,
});

export const membershipTotalsQueryKey = hook.queryKey;
export const fetchMembershipTotals = hook.fetch;
export const useMembershipTotals = hook.useReport;
