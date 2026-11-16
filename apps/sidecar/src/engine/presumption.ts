import {
  pendingAccountKey,
  resolveMergeTarget,
  type HomeMembership,
  type HubMachine,
} from "@maxprice/shared";
import type { StoredEvent } from "./store";

// The Presumed organization — the rule, and the value that carries it (#261,
// item 2) — and, since #309, the Organization assertions that out-rank it.
//
// An event with no owner evidence is not unattributed: it counts under the
// CONTRIBUTING machine's Home organization as published in the Machine
// directory, else the VIEWING machine's own Home (GLOSSARY.md, `Presumed
// membership`). `publishedHomeOrganizations` builds the directory half (#281):
// the published Home membership's ORGANIZATION alone, never its Account, which
// is display and wire only (ADR-0137 §4, ADR-0139 §6; 2026-11-09, #635); a
// machine that has published nothing — every machine on upgrade day —
// answers the viewer's own Home Organization exactly as before. Ahead of that presumption stands an Organization ASSERTION (#309):
// the user's claim that a session's owner-less usage belongs to a named
// Organization. It is consulted only where evidence is absent — a tagged row
// never moves — and it names a whole session, so every owner-less row of it
// (subagents included: they carry their parent's `sessionId`) answers the same.
//
// A QUERY-TIME RULE, NEVER A STORED VALUE. Nothing here writes an Organization
// onto a `StoredEvent`, onto the wire, or into the archive:
// `StoredEvent.organizationUuid` stays EVIDENCE (ADR-0098) and `undefined`
// keeps meaning "no evidence", never "no Organization". That is exactly why
// changing a Home — or an assertion — moves no row and re-walks nothing: the
// corpus is untouched and only the answer to `eventOrganization` changes.
//
// A VALUE WITH AN IDENTITY, PASSED IN — never a module global. The pricing
// snapshot is module state because it is a process-wide fact with no other
// home; the presumption is owned by the sidecar's settings state and threaded
// into the store as a thunk (`createEventStore`'s `getPresumption`), so engine
// tests stay hermetic and cannot leak a Home into each other. `createPresumption`
// mints a NEW identity per call precisely so a holder can detect a swap by
// identity rather than by comparing contents. The presumption has FOUR
// writers — the Home membership (settings), the Machine directory (fleet: the
// published Home Organizations), the
// Membership assertions (bootSidecar()'s `installAssertions`, #310), and the
// Membership roster (bootSidecar()'s `installKeyRoster`, from the held keys'
// listings, #633; the Hub's is not built, #634 left it to a follow-up
// decision ticket) — and each replaces only its own half through
// `withSelfHome` / `withMachineDirectory` / `withAssertions` /
// `withMembershipRoster`, which mint that new identity carrying the other
// writers' halves unchanged, so no swap drops another's.
//
// Since #631 the same value answers an event's ACCOUNT too (`eventAccount`,
// ADR-0137 §3–§5), beside its Organization, by a narrower rule: an Account is
// never presumed. A row takes one only from its own evidence or from a claim
// naming one, else none (Unknown), on this machine's rows and every peer's
// alike (ADR-0137 §3–§4's current-rule notes, #635). The roster settles only
// an unstamped usage-limits reading (`sampleAccount`), never a row.
// `StoredEvent.accountUuid` / `accountEmailHash` stay evidence, exactly as the
// Organization tag does.

// A Membership assertion's resolved claim (ADR-0137 §5): the Organization a
// session's owner-less usage belongs to and, optionally, the Account. An
// Organization-only claim (every claim made before ADR-0137) names no Account,
// so its rows count under none (`eventAccount`).
export type MembershipClaim = {
  readonly organizationUuid: string;
  readonly accountUuid?: string;
};

// Everything an owner-less row is answered from at query time. The name
// predates the assertion half and is kept: every cache that must rebind when
// such a row's answer changes already compares THIS value's identity, so the
// assertions ride in it rather than beside it.
export type Presumption = {
  // The viewing machine's Home membership (ADR-0136 §5, ADR-0137 §4); `null` =
  // this machine has no Home (a first launch, or the golden corpus), so an
  // owner-less row resolves to no Organization at all. Its `accountUuid` is
  // null while the Home membership's Account is unknown (a v0.9.2 settings
  // file, or a machine that knows no Account). Only its Organization presumes
  // a row; its Account presumes an unstamped reading alone (`sampleAccount`).
  readonly selfHome: HomeMembership | null;
  // machineId -> the published Home ORGANIZATION that machine's owner-less
  // rows are presumed under, `mergedInto` already resolved. Built from the
  // Machine directory by `publishedHomeOrganizations` (#281); it never names
  // the viewer's own merge class. The Account a machine publishes beside it
  // is not carried: no row's Account is presumed (ADR-0137 §4, #635).
  readonly homeOrganizationByMachine: ReadonlyMap<string, string>;
  // sessionId -> the asserted Membership (#306 items 1, 2, 5; ADR-0137 §5).
  // Consulted only for a row with no owner evidence; a subagent row carries its
  // parent's sessionId (identityFromPath), so it follows the parent's
  // assertion. The map holds the resolved claim ONLY — an edit time and a
  // tombstone are the durable file's and the directory's concern (#310),
  // settled before a map is installed. It may name any Organization or
  // Account, tracked or not; a scope that does not select it simply does not
  // select the row.
  readonly assertedBySession: ReadonlyMap<string, MembershipClaim>;
  // organizationUuid -> every Account known to hold a Membership in it: the
  // held keys' listings since #633 (the Hub's half is not built, #634), empty
  // while no key with a known Account has listed; `withMembershipRoster` is
  // its writer. It answers an unstamped usage-limits reading's Account
  // (`sampleAccount`, ADR-0139 §8) and never a usage row's (#635).
  readonly membershipRoster: ReadonlyMap<string, ReadonlySet<string>>;
};

// The one empty map every presumption that names no peer Homes shares. Shared
// because it is read-only and never mutated — a presumption's IDENTITY is the
// object `createPresumption` returns, not this.
const NO_PUBLISHED_HOME_ORGANIZATIONS: ReadonlyMap<string, string> = new Map();

// The same, for a presumption that asserts nothing — the boot value, and every
// one while no claim is live.
const NO_ASSERTIONS: ReadonlyMap<string, MembershipClaim> = new Map();

// The same, for a presumption that knows no Membership roster.
const NO_ROSTER: ReadonlyMap<string, ReadonlySet<string>> = new Map();

// #311: the dormant snapshot of a store with nothing dormant. One shared,
// never-mutated set, like NO_ASSERTIONS.
export const NO_DORMANT: ReadonlySet<string> = new Set();

// A NEW identity per call — a holder compares identity, never contents.
export function createPresumption(
  selfHome: HomeMembership | null,
  homeOrganizationByMachine: ReadonlyMap<string, string> = NO_PUBLISHED_HOME_ORGANIZATIONS,
  assertedBySession: ReadonlyMap<string, MembershipClaim> = NO_ASSERTIONS,
  membershipRoster: ReadonlyMap<string, ReadonlySet<string>> = NO_ROSTER,
): Presumption {
  return { selfHome, homeOrganizationByMachine, assertedBySession, membershipRoster };
}

// A Home membership whose Account is unknown: the Home organization alone, as
// a v0.9.2 settings file names it. `null` stays null (no Home).
export function homeOfOrganization(organizationUuid: string | null): HomeMembership | null {
  return organizationUuid === null ? null : { organizationUuid, accountUuid: null };
}

// The no-presumption value: today's behaviour, and the default everywhere. One
// identity for the process, so "nothing is presumed" never reads as a swap.
export const NO_PRESUMPTION: Presumption = createPresumption(null);

// The Home writer's swap: a new identity with the viewer's Home membership
// replaced and the other writers' halves kept as they are.
export function withSelfHome(p: Presumption, selfHome: HomeMembership | null): Presumption {
  return { ...p, selfHome };
}

// The directory writer's swap: a new identity with the published Home
// Organizations replaced and every other half kept as it is.
export function withMachineDirectory(
  p: Presumption,
  homeOrganizationByMachine: ReadonlyMap<string, string>,
): Presumption {
  return { ...p, homeOrganizationByMachine };
}

// The assertion writer's swap (bootSidecar()'s `installAssertions`, #310,
// through organization-assertions.ts's `presumptionWithAssertions`): a new
// identity with the assertions replaced and every other half kept as it is.
// Every cache that rebinds on the presumption's identity therefore rebinds on
// an assertion change too, and — like a Home change — it moves no row and walks
// nothing.
export function withAssertions(
  p: Presumption,
  assertedBySession: ReadonlyMap<string, MembershipClaim>,
): Presumption {
  return { ...p, assertedBySession };
}

// Organization-only Membership claims (ADR-0137 §5) from a sessionId ->
// organizationUuid map: what the claims made before ADR-0137 are. The local
// assertion file's own claims arrive whole, Account included, through
// organization-assertions.ts's `claims()`; this lifts a bare map (tests, and
// any caller holding Organizations alone). A new map, so the caller's is never
// shared with a presumption.
export function organizationClaims(
  byOrganization: ReadonlyMap<string, string>,
): ReadonlyMap<string, MembershipClaim> {
  const claims = new Map<string, MembershipClaim>();
  for (const [sessionId, organizationUuid] of byOrganization) {
    claims.set(sessionId, { organizationUuid });
  }
  return claims;
}

// The Membership roster's swap: a new identity with the roster replaced and
// every other half kept as it is. Its sources: each held key's listing, under
// that key's Account (#633, bootSidecar()'s `installKeyRoster`). The Hub's
// half is not built (#634). It moves only unstamped readings (`sampleAccount`).
export function withMembershipRoster(
  p: Presumption,
  membershipRoster: ReadonlyMap<string, ReadonlySet<string>>,
): Presumption {
  return { ...p, membershipRoster };
}

// The viewer's merge class (ADR-0103 §8) in a Machine directory list: the
// viewer's own id, the id its `mergedInto` chain resolves to (a reinstall's
// new id merged into the old one makes that old entry this machine's own
// history), and every machine resolving to either. The rows whose
// Organization is presumed under the viewer's own current Home:
// `publishedHomeOrganizations` leaves exactly this class out.
function viewerMergeClass(
  machines: readonly HubMachine[],
  selfMachineId: string,
): ReadonlySet<string> {
  const selfTarget = resolveMergeTarget(machines, selfMachineId);
  const viewer = new Set([selfMachineId, selfTarget]);
  for (const m of machines) {
    const target = resolveMergeTarget(machines, m.machineId);
    if (target === selfMachineId || target === selfTarget) viewer.add(m.machineId);
  }
  return viewer;
}

// machineId -> the Home organization its owner-less rows are presumed under,
// built from the Machine directory (#281): each machine resolves through
// `mergedInto` to its terminal target and takes THAT entry's published
// Anthropic Home membership's Organization. Its Account is not read: the
// directory carries it for display (ADR-0139 §2, §6), never for attribution
// (ADR-0137 §4; 2026-11-09, #635). Left out, and so presumed under the
// viewer's own Home Organization by `presumedOrganization`, are the viewer's
// merge class (`viewerMergeClass`), because own rows always use the Home this
// machine is running under, never a directory entry that may lag it; and any
// machine whose target published nothing (upgrade day). A dangling chain
// resolves to an id with no entry and so maps nothing; a cyclic walk stops at
// the first id it revisits. For a member of the cycle that is the id it
// started from, so each member keeps its own published Home; a chain entering
// the cycle from outside stops at the member it entered by, and takes that
// member's Home. `resolveMergeTarget` re-indexes the directory per call, which
// is quadratic and fine over a directory of a handful of machines.
export function publishedHomeOrganizations(
  machines: readonly HubMachine[],
  selfMachineId: string,
): ReadonlyMap<string, string> {
  const byId = new Map(machines.map((m) => [m.machineId, m]));
  const viewer = viewerMergeClass(machines, selfMachineId);
  const homes = new Map<string, string>();
  for (const m of machines) {
    if (viewer.has(m.machineId)) continue;
    const target = resolveMergeTarget(machines, m.machineId);
    const home = byId.get(target)?.homeMemberships?.anthropic?.organizationUuid;
    if (typeof home === "string" && home !== "") homes.set(m.machineId, home);
  }
  return homes.size === 0 ? NO_PUBLISHED_HOME_ORGANIZATIONS : homes;
}

// Contents equality of two maps, insertion order ignored, with `same` judging
// two values — the one comparison both "ask before you swap" writers below
// make.
function sameEntries<V>(
  a: ReadonlyMap<string, V>,
  b: ReadonlyMap<string, V>,
  same: (x: V, y: V) => boolean,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other === undefined || !same(value, other)) return false;
  }
  return true;
}

// Contents equality of two published-Home-Organization maps, insertion order
// ignored. The directory writer asks this BEFORE it swaps: a refresh moves `live` and `lastSeenAt` every time, and one whose
// Homes are unchanged must install no new identity — otherwise every sweep
// would clear every report cache. A peer's Account-only republish (#635) is no
// change here: it moves no answer.
export function samePublishedHomeOrganizations(
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
): boolean {
  return sameEntries(a, b, (x, y) => x === y);
}

// Contents equality of two assertion maps, insertion order ignored. The
// assertion writer asks this BEFORE it swaps, for the reason the directory
// writer asks `samePublishedHomeOrganizations`: a directory pull that changed no claim must
// install no new identity, or every pull would clear every report cache.
export function sameAssertions(
  a: ReadonlyMap<string, MembershipClaim>,
  b: ReadonlyMap<string, MembershipClaim>,
): boolean {
  return sameEntries(
    a,
    b,
    (x, y) => x.organizationUuid === y.organizationUuid && x.accountUuid === y.accountUuid,
  );
}

// The Organization a machine's owner-less rows are presumed to belong to: its
// published Home, else the viewer's own. `undefined` = nothing to presume, and
// a row that resolves to `undefined` is counted under no Organization at all
// rather than under an arbitrary one.
//
// #261 item 2 also says OWN rows always use the viewer's own Home. It is
// `publishedHomeOrganizations`, the ONE builder of `homeOrganizationByMachine`,
// that guarantees the viewer's merge class is never in the map: the directory
// carries THIS machine's published Home too, and a stale entry must never
// out-rank the Home this machine is actually running under. A peer that
// published no Home, or is absent from the directory, is presumed under the
// viewer's Home Organization too (ADR-0098, ADR-0103), unchanged by #635.
export function presumedOrganization(p: Presumption, machineId: string): string | undefined {
  return p.homeOrganizationByMachine.get(machineId) ?? p.selfHome?.organizationUuid;
}

// The Organization a session's owner-less rows are asserted to (#309), or
// `undefined` when no claim names it.
export function assertedOrganization(p: Presumption, sessionId: string): string | undefined {
  return p.assertedBySession.get(sessionId)?.organizationUuid;
}

// The sessions whose owner-less rows are DORMANT on this machine (#311, ADR-0107
// §12, ADR-0137 §5): every asserted session whose claim names an Organization
// outside the resolved tracked set, or an Account outside the resolved tracked
// Account set, including one this machine has never seen, since whatever is
// not tracked is Excluded. A null set excludes nothing on its level, so with
// both null nothing is dormant. An Organization-only claim names no Account,
// so only its Organization can make it dormant. Presumption never enters: a
// presumed row is Home's, and Home is always tracked. Pure; each store takes
// the result as a construction-time snapshot, so a change is a rebuild.
export function dormantSessions(
  assertedBySession: ReadonlyMap<string, MembershipClaim>,
  tracked: ReadonlySet<string> | null,
  trackedAccounts: ReadonlySet<string> | null = null,
): ReadonlySet<string> {
  if (tracked === null && trackedAccounts === null) return NO_DORMANT;
  let dormant: Set<string> | null = null;
  for (const [sessionId, claim] of assertedBySession) {
    const excludedOrganization = tracked !== null && !tracked.has(claim.organizationUuid);
    const excludedAccount =
      trackedAccounts !== null &&
      claim.accountUuid !== undefined &&
      !trackedAccounts.has(claim.accountUuid);
    if (excludedOrganization || excludedAccount) (dormant ??= new Set()).add(sessionId);
  }
  return dormant ?? NO_DORMANT;
}

// The three fields the resolution reads. Narrower than `StoredEvent` so a wire
// row (`FleetEvent`) and a replica record (`FleetRecord`, ADR-0111) resolve
// through the SAME rule without a projection: Storage's per-Organization
// Forget breakdown (#295) asks it of replica records. The tag is OPTIONAL here
// rather than `Pick`ed, because a wire row omits the key where a `StoredEvent`
// carries it as `undefined`, and both mean "no evidence". Type-only — a
// `StoredEvent` passes exactly as before.
export type OrganizationResolvable = Pick<StoredEvent, "sessionId" | "machineId"> & {
  organizationUuid?: string;
};

// The Account evidence a row carries, as the store resolved it (ADR-0137 §2):
// `accountUuid` when the evidence names an Account by uuid (an Owner record's,
// or an Email record's hash the pair table maps), else `accountEmailHash` for
// a Pending account (an Email record's hash no pair maps). Never both. Optional
// for the reason `OrganizationResolvable`'s tag is: a wire row omits the keys.
export type AccountResolvable = OrganizationResolvable & {
  accountUuid?: string;
  accountEmailHash?: string;
};

// THE Account key of a row's evidence: its uuid, or `pending:<hash>` for a
// Pending account, or `undefined` when the row carries no Account evidence.
// The key the tracked Account set, the Account axis and a Membership compare.
export function accountKeyOf(e: {
  accountUuid?: string;
  accountEmailHash?: string;
}): string | undefined {
  if (e.accountUuid !== undefined) return e.accountUuid;
  return e.accountEmailHash === undefined ? undefined : pendingAccountKey(e.accountEmailHash);
}

// THE resolution, and the only one: evidence first, assertion second,
// presumption third. Every axis, report and scope that asks "which Organization
// does this event count under?" asks it here.
export function eventOrganization(e: OrganizationResolvable, p: Presumption): string | undefined {
  return (
    e.organizationUuid ??
    assertedOrganization(p, e.sessionId) ??
    presumedOrganization(p, e.machineId)
  );
}

// THE Account resolution (ADR-0137 §2–§5), beside `eventOrganization`: every
// axis, report and scope that asks "which Account does this event count
// under?" asks it here. A query-time answer, never stored: only evidence is on
// the row. One rule for every row, this machine's and every peer's:
//
//   1. The row's own Account evidence (§2), a subagent's taken from its
//      parent's owner points by the store (ADR-0109 §5).
//   2. No Organization evidence, and a Membership assertion naming the
//      session and an Account (§5): that Account. An assertion never moves a
//      row with Organization evidence.
//   3. Otherwise none: the Account is not known (Unknown). Neither the Home
//      membership's Account, nor a key's listing (the roster), nor a peer's
//      published Account is evidence of which Account usage came from: "if
//      unsure what account it came from it should say it's unknown" (#635).
//      Unlike the Organization, the Account is never presumed.
//
// `undefined` = no Account to count under; such a row matches no Account
// selection, as an Organization-less row matches no Organization selection,
// and the Scopes that hold Unknown count it (`ResolvedScope.unknownAccount`).
export function eventAccount(e: AccountResolvable, p: Presumption): string | undefined {
  const evidence = accountKeyOf(e);
  if (evidence !== undefined) return evidence;
  if (e.organizationUuid !== undefined) return undefined;
  return p.assertedBySession.get(e.sessionId)?.accountUuid;
}

// One event's Membership as the app counts it: `eventOrganization` and
// `eventAccount` together. Either half may be `undefined`.
export function eventMembership(
  e: AccountResolvable,
  p: Presumption,
): { organizationUuid: string | undefined; accountUuid: string | undefined } {
  return { organizationUuid: eventOrganization(e, p), accountUuid: eventAccount(e, p) };
}

// Which of the three sources answered `eventOrganization` — `undefined`
// exactly when it did. The session row's `organizationResolution` summarises
// these, so a surface can tell owned usage from claimed and presumed usage
// without re-deriving the rule.
export type OrganizationResolution = "evidence" | "assigned" | "presumed";

// Mirrors `eventOrganization` step for step, testing each source the way its
// `??` does (defined, not truthy), so the two can never name different sources.
export function eventOrganizationResolution(
  e: OrganizationResolvable,
  p: Presumption,
): OrganizationResolution | undefined {
  if (e.organizationUuid !== undefined) return "evidence";
  if (assertedOrganization(p, e.sessionId) !== undefined) return "assigned";
  if (presumedOrganization(p, e.machineId) !== undefined) return "presumed";
  return undefined;
}
