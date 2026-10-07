import { resolveMergeTarget, type HubMachine } from "@maxprice/shared";
import type { StoredEvent } from "./store";

// The Presumed organization — the rule, and the value that carries it (#261,
// item 2) — and, since #309, the Organization assertions that out-rank it.
//
// An event with no owner evidence is not unattributed: it counts under the
// CONTRIBUTING machine's Home organization as published in the Machine
// directory, else the VIEWING machine's own Home (GLOSSARY.md, `Presumed
// organization`). `publishedHomes` builds the directory half (#281); a machine
// that has published nothing — every machine on upgrade day — answers the
// viewer's own Home exactly as before, so no number moves until a peer
// publishes. Ahead of that presumption stands an Organization ASSERTION (#309):
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
// identity rather than by comparing contents. The presumption has THREE
// writers — the Home (settings), the Machine directory (fleet), and the
// Organization assertions (main()'s `installAssertions`, #310) — and each
// replaces only its own half through `withSelfHome` / `withPublishedHomes` /
// `withAssertions`, which mint that new identity carrying the other writers'
// halves unchanged, so no swap drops another's.

// Everything an owner-less row is answered from at query time. The name
// predates the assertion half and is kept: every cache that must rebind when
// such a row's answer changes already compares THIS value's identity, so the
// assertions ride in it rather than beside it.
export type Presumption = {
  // The viewing machine's Home organization; `null` = this machine has no Home
  // (a first launch, or the golden corpus), so an owner-less row resolves to no
  // Organization at all.
  readonly selfHome: string | null;
  // machineId -> the published Home that machine's owner-less rows are presumed
  // under, `mergedInto` already resolved. Built from the Machine directory by
  // `publishedHomes` (#281); it never names the viewer itself nor anything in
  // the viewer's merge class.
  readonly homeByMachine: ReadonlyMap<string, string>;
  // sessionId -> the asserted Organization (#306 items 1, 2, 5). Consulted only
  // for a row with no owner evidence; a subagent row carries its parent's
  // sessionId (identityFromPath), so it follows the parent's assertion. The map
  // holds the resolved claim ONLY — an edit time and a tombstone are the
  // durable file's and the directory's concern (#310), settled before a map is
  // installed. It may name any Organization, tracked or not; a scope that does
  // not select it simply does not select the row.
  readonly assertedBySession: ReadonlyMap<string, string>;
};

// The one empty map every presumption that names no peer Homes shares. Shared
// because it is read-only and never mutated — a presumption's IDENTITY is the
// object `createPresumption` returns, not this.
const NO_PUBLISHED_HOMES: ReadonlyMap<string, string> = new Map();

// The same, for a presumption that asserts nothing — the boot value, and every
// one while no claim is live.
const NO_ASSERTIONS: ReadonlyMap<string, string> = new Map();

// #311: the dormant snapshot of a store with nothing dormant. One shared,
// never-mutated set, like NO_ASSERTIONS.
export const NO_DORMANT: ReadonlySet<string> = new Set();

// A NEW identity per call — a holder compares identity, never contents.
export function createPresumption(
  selfHome: string | null,
  homeByMachine: ReadonlyMap<string, string> = NO_PUBLISHED_HOMES,
  assertedBySession: ReadonlyMap<string, string> = NO_ASSERTIONS,
): Presumption {
  return { selfHome, homeByMachine, assertedBySession };
}

// The no-presumption value: today's behaviour, and the default everywhere. One
// identity for the process, so "nothing is presumed" never reads as a swap.
export const NO_PRESUMPTION: Presumption = createPresumption(null);

// The Home writer's swap: a new identity with the viewer's Home replaced and
// the directory's published Homes and the assertions kept as they are.
export function withSelfHome(p: Presumption, selfHome: string | null): Presumption {
  return createPresumption(selfHome, p.homeByMachine, p.assertedBySession);
}

// The directory writer's swap: a new identity with the published Homes
// replaced and the viewer's Home and the assertions kept as they are.
export function withPublishedHomes(
  p: Presumption,
  homeByMachine: ReadonlyMap<string, string>,
): Presumption {
  return createPresumption(p.selfHome, homeByMachine, p.assertedBySession);
}

// The assertion writer's swap (main()'s `installAssertions`, #310, through
// organization-assertions.ts's `presumptionWithAssertions`): a new identity
// with the assertions replaced and both Home halves kept as they are. Every
// cache that rebinds on the presumption's identity therefore rebinds on an
// assertion change too, and — like a Home change — it moves no row and walks
// nothing.
export function withAssertions(
  p: Presumption,
  assertedBySession: ReadonlyMap<string, string>,
): Presumption {
  return createPresumption(p.selfHome, p.homeByMachine, assertedBySession);
}

// machineId -> the Home its owner-less rows are presumed under, built from the
// Machine directory (#281): each machine resolves through `mergedInto` to its
// terminal target and takes THAT entry's published Home. Left out — and so
// presumed under the viewer's own Home by `presumedOrganization` — are the
// viewer itself and anything in its merge class (whatever resolves to the
// viewer, or to the id the viewer is itself merged into: a reinstall's new id
// merged into the old one makes that old entry this machine's own history),
// because own rows always use the Home this machine is running under, never a
// directory entry that may lag it; and any machine whose target published
// nothing (upgrade day: today's answer, so no number moves until a peer
// publishes). A dangling chain resolves to an id with no entry and so maps
// nothing; a cyclic walk stops at the first id it revisits. For a member of
// the cycle that is the id it started from, so each member keeps its own
// published Home; a chain entering the cycle from outside stops at the member
// it entered by, and takes that member's Home. `resolveMergeTarget`
// re-indexes the directory per call, which is quadratic and fine over a
// directory of a handful of machines.
export function publishedHomes(
  machines: readonly HubMachine[],
  selfMachineId: string,
): ReadonlyMap<string, string> {
  const byId = new Map(machines.map((m) => [m.machineId, m]));
  const selfTarget = resolveMergeTarget(machines, selfMachineId);
  const homes = new Map<string, string>();
  for (const m of machines) {
    if (m.machineId === selfMachineId) continue;
    const target = resolveMergeTarget(machines, m.machineId);
    if (target === selfMachineId || target === selfTarget) continue;
    const home = byId.get(target)?.homeOrganization;
    if (typeof home === "string" && home !== "") homes.set(m.machineId, home);
  }
  return homes.size === 0 ? NO_PUBLISHED_HOMES : homes;
}

// Contents equality of two string-to-string maps, insertion order ignored —
// the one comparison both "ask before you swap" writers below make.
function sameEntries(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

// Contents equality of two published-Home maps, insertion order ignored. The
// directory writer asks this BEFORE it swaps: a refresh moves `live` and
// `lastSeenAt` every time, and one whose Homes are unchanged must install no
// new identity — otherwise every sweep would clear every report cache.
export function samePublishedHomes(
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
): boolean {
  return sameEntries(a, b);
}

// Contents equality of two assertion maps, insertion order ignored. The
// assertion writer asks this BEFORE it swaps, for the reason the directory
// writer asks `samePublishedHomes`: a directory pull that changed no claim must
// install no new identity, or every pull would clear every report cache.
export function sameAssertions(
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
): boolean {
  return sameEntries(a, b);
}

// The Organization a machine's owner-less rows are presumed to belong to: its
// published Home, else the viewer's own. `undefined` = nothing to presume, and
// a row that resolves to `undefined` is counted under no Organization at all
// rather than under an arbitrary one.
//
// #261 item 2 also says OWN rows always use the viewer's own Home. This lookup
// cannot tell self from a peer — a `Presumption` carries no machine id of its
// own — so it is `publishedHomes`, the ONE builder of `homeByMachine`, that
// guarantees the viewer (and its whole merge class) is never in the map: the
// directory carries THIS machine's published Home too, and a stale entry must
// never out-rank the Home this machine is actually running under.
export function presumedOrganization(p: Presumption, machineId: string): string | undefined {
  return p.homeByMachine.get(machineId) ?? p.selfHome ?? undefined;
}

// The Organization a session's owner-less rows are asserted to (#309), or
// `undefined` when no claim names it.
export function assertedOrganization(p: Presumption, sessionId: string): string | undefined {
  return p.assertedBySession.get(sessionId);
}

// The sessions whose owner-less rows are DORMANT on this machine (#311, ADR-0107
// §12): every asserted session whose claim names an Organization outside the
// resolved tracked set, including one this machine has never seen, since
// whatever is not tracked is Excluded. A null set excludes nothing, so nothing
// is dormant. Presumption never enters: a presumed row is Home's, and Home is
// always tracked. Pure; each store takes the result as a construction-time
// snapshot, so a change is a rebuild.
export function dormantSessions(
  assertedBySession: ReadonlyMap<string, string>,
  tracked: ReadonlySet<string> | null,
): ReadonlySet<string> {
  if (tracked === null) return NO_DORMANT;
  let dormant: Set<string> | null = null;
  for (const [sessionId, organizationUuid] of assertedBySession) {
    if (!tracked.has(organizationUuid)) (dormant ??= new Set()).add(sessionId);
  }
  return dormant ?? NO_DORMANT;
}

// The three fields the resolution reads. Narrower than `StoredEvent` so a wire
// row (`FleetEvent`) resolves through the SAME rule without a projection:
// Storage's per-Organization Forget breakdown (#295) asks it of replica rows.
// The tag is OPTIONAL here rather than `Pick`ed, because a wire row omits the
// key where a `StoredEvent` carries it as `undefined`, and both mean "no
// evidence". Type-only — a `StoredEvent` passes exactly as before.
type OrganizationResolvable = Pick<StoredEvent, "sessionId" | "machineId"> & {
  organizationUuid?: string;
};

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
