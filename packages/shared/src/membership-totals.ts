import { z } from "zod";

// `GET /api/membership-totals` (#637): the scoped money split by Membership,
// for the split money tiles. One row per (Organization, Account) the scoped
// answer's rows resolve to, from the same store query the reports read, each
// priced as `/api/daily` prices it under the request's cost mode: `costUSD` and
// `totalTokens` are the `totals` `/api/daily` answers for that Membership's
// rows alone. `accountUuid` is the Account key (an account uuid or a Pending
// account's `pending:<hash>`), null for an Account not known (#635).
// `organizationUuid` is null for rows that resolve to no Organization, which
// only a machine with no Home holds (an owner-less row with nothing to presume
// it under), so the rows always partition the scoped money. Sorted by
// Organization uuid, then Account key, each null last.
//
// `totals` is the whole scoped answer's, bit-identical to `/api/daily`'s
// `totals.totalCost` / `totals.totalTokens` for the same query (whose own
// `totals` a 2+-project filter omits; this one never is). A consumer that
// needs the scope's total reads it here, never the rows' sum: the rows sum per
// Membership, then across Memberships, which reassociates the float additions
// `/api/daily` makes per local date, then across dates.
export const membershipTotalSchema = z.object({
  organizationUuid: z.string().nullable(),
  accountUuid: z.string().nullable(),
  costUSD: z.number(),
  totalTokens: z.number(),
});

export const membershipTotalsResponseSchema = z.object({
  memberships: z.array(membershipTotalSchema),
  totals: z.object({ costUSD: z.number(), totalTokens: z.number() }),
});

export type MembershipTotal = z.infer<typeof membershipTotalSchema>;
export type MembershipTotalsResponse = z.infer<typeof membershipTotalsResponseSchema>;
