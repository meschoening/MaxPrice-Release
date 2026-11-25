import { z } from "zod";
import {
  compareMemberships,
  scopeHasMembership,
  type MembershipKey,
  type ResolvedScope,
} from "./scope";
import type { HomeMembership } from "./settings";

// The Scope's head (ADR-0136 §6): the one Membership a surface that shows one
// Membership reads, and its Organization, whose usage-limits reading
// /api/usage/current, the readout's utilization half, the quota tiles and the
// usage connection describe until those surfaces read one reading per
// Membership (#633, #638). ONE rule, here, which the sidecar's endpoints
// (`scopeHead`) and the renderer's quota surfaces
// (`useScope().quotaOrganization`) both apply, so a tile never names another
// Organization than the reading beside it (#637).
//
// Its inputs are the resolved Scope, the Home membership in force, and the
// Scope's candidate Memberships: every (Organization, Account) the Scope
// reaches that the stored rows resolve to, or the Home membership, each with
// whether the store holds rows for it in the Scope (the sidecar's
// `scope-memberships.ts`; the Usage history mints none, ADR-0145 §7). The
// candidates are the store's to know, so the rule is staged:
//   1. With no Home the head names no Organization (`null`, the poller's
//      answer that names none). Whenever the Scope holds the Home membership
//      it heads (ADR-0142 §3), rows or not, and its Organization with it: the default Scope, All, and every Scope naming
//      Home's part. A Scope whose Organization axis names one Organization
//      can be headed by no other: every candidate lies in it, and with none
//      stage 3 names it too. Settings alone tell all three
//      (`settledHeadOrganization`), so the renderer answers them without
//      asking: every Scope the topbar's Organization scope chip writes is one.
//   2. Otherwise the first candidate by `compareHeadCandidates` heads: one
//      with rows before one without, so a surface never shows an empty
//      Membership beside the one holding the usage, ties to
//      `compareMemberships`. Only the sidecar holds the candidates, so the
//      renderer asks it (`GET /api/scope-head`).
//   3. A Scope with no candidate falls back to its first Organization
//      (`headOrganization`), else Home's.

// One candidate Membership of a Scope, and whether the store holds rows for
// it in the Scope.
export type HeadCandidate = { membership: MembershipKey; rows: boolean };

// The candidates' order, head first: the Home membership, then one with rows
// before one without, then `compareMemberships`.
export function compareHeadCandidates(
  a: HeadCandidate,
  b: HeadCandidate,
  home: HomeMembership,
): number {
  const isHome = (m: MembershipKey) =>
    m.organizationUuid === home.organizationUuid && m.accountUuid === home.accountUuid;
  return (
    Number(isHome(b.membership)) - Number(isHome(a.membership)) ||
    Number(b.rows) - Number(a.rows) ||
    compareMemberships(a.membership, b.membership, home)
  );
}

// Stage 1: the head Organization settings alone can tell: `null` with no
// Home, Home's whenever the Scope holds the Home membership, the one
// Organization a one-Organization Scope names; undefined when only the
// Scope's candidates can say.
export function settledHeadOrganization(
  scope: ResolvedScope,
  home: HomeMembership | null,
): string | null | undefined {
  if (home === null) return null;
  if (scopeHasMembership(scope, home.organizationUuid, home.accountUuid ?? undefined)) {
    return home.organizationUuid;
  }
  return oneOrganizationHead(scope);
}

// Stage 1's last part: the one Organization a one-Organization Scope names.
function oneOrganizationHead(scope: ResolvedScope): string | undefined {
  return scope.organizations.length === 1 ? scope.organizations[0] : undefined;
}

// Stage 3: the Organization a Scope with no candidate heads by: Home's where
// the Scope reaches it, else its first Organization. `null` only with no Home.
export function headOrganization(scope: ResolvedScope, home: HomeMembership | null): string | null {
  if (home === null) return null;
  const { organizations } = scope;
  if (organizations.length === 0 || organizations.includes(home.organizationUuid)) {
    return home.organizationUuid;
  }
  return organizations[0] ?? home.organizationUuid;
}

// The whole rule over a Scope's candidates (in any order).
export function scopeHeadOrganization(
  scope: ResolvedScope,
  home: HomeMembership | null,
  candidates: readonly HeadCandidate[],
): string | null {
  if (home === null) return null;
  if (scopeHasMembership(scope, home.organizationUuid, home.accountUuid ?? undefined)) {
    return home.organizationUuid;
  }
  return headOrganizationWithoutHome(scope, home, candidates);
}

// The rule's rest, for a Scope its caller has found NOT to hold the Home
// membership (the sidecar's `scopeHeadOf` checks that once, for the Account
// it answers too): the one Organization a one-Organization Scope names, else
// the first candidate's (in any order), else stage 3.
export function headOrganizationWithoutHome(
  scope: ResolvedScope,
  home: HomeMembership,
  candidates: readonly HeadCandidate[],
): string {
  const named = oneOrganizationHead(scope);
  if (named !== undefined) return named;
  let head: HeadCandidate | undefined;
  for (const c of candidates) {
    if (head === undefined || compareHeadCandidates(c, head, home) < 0) head = c;
  }
  return (
    head?.membership.organizationUuid ?? headOrganization(scope, home) ?? home.organizationUuid
  );
}

// --- GET /api/scope-head ------------------------------------------------------

// The head the sidecar applies to a request's Scope params, for the renderer's
// quota surfaces when the head is not settled (stage 2): the Organization
// whose reading /api/usage/current answers for the same params, and the head
// Membership's Account (`null` when not known, or with no candidate): the Home
// membership's whenever the Scope holds it.
export const SCOPE_HEAD_PATH = "/api/scope-head";

export const scopeHeadResponseSchema = z.object({
  organizationUuid: z.string().nullable(),
  accountUuid: z.string().nullable(),
});
export type ScopeHeadResponse = z.infer<typeof scopeHeadResponseSchema>;
