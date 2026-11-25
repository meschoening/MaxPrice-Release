import {
  compareHeadCandidates,
  scopeHasMembership,
  type HeadCandidate,
  type HomeMembership,
  type MembershipKey,
  type ResolvedScope,
} from "@maxprice/shared";
import { eventAccount, eventOrganization, type Presumption } from "./presumption";
import type { EventStore, StoredEvent } from "./store";

// A Scope's Memberships: the candidates the shared head rule reads
// (`scopeHeadOrganization`, ADR-0142 §3), which `GET /api/scope-head`,
// `/api/usage/current`, the Week's limit-reset anchor, the Readout and the
// usage connection follow wherever the Scope does not hold the Home
// membership.
//
// A Membership is any (Organization, Account) the Scope reaches that the
// stored rows resolve to, or the Home membership, each with whether the store
// holds rows for it in the Scope. The Usage history mints none: a reading is
// no usage, and the history is a record nothing computes from (ADR-0145 §1,
// §7).

// A request for a Scope's Memberships: the resolved Scope and the Home
// membership it resolved against.
export type ScopeRequest = { scope: ResolvedScope; home: HomeMembership };

export type ScopeMemberships = {
  // The Scope's Memberships, head first (`compareHeadCandidates`): the Home
  // membership whenever the Scope holds it, then one with rows before one
  // without, then `compareMemberships`.
  memberships: HeadCandidate[];
  // Organization -> every tracked Account known to hold a Membership in it,
  // in or out of the Scope: its rows', the roster's and the Home
  // membership's. An Excluded account is none (ADR-0136 §3).
  known: ReadonlyMap<string, ReadonlySet<string>>;
};

// The Account a sample with no Account stamp resolves to at query time
// (ADR-0139 §8): the only Account the Membership roster holds in its
// Organization, else this machine's Home membership's Account, else none. A
// sample is a usage-limits READING, never usage: it moves no cost or token
// into any Scope. It is always this machine's own reading (or the Hub's
// backfill of the Organization it polled) of the limits of the key it polled
// with, so the keys this machine holds (the roster) and its own Home
// membership are the best word on whose limits it read, which they are not on
// whose usage a row is (`eventAccount`, #635). A sample stamped with an
// Account (#633) is that Account's, whatever this presumes.
export function sampleAccount(organizationUuid: string, p: Presumption): string | null {
  const holders = p.membershipRoster.get(organizationUuid);
  if (holders !== undefined && holders.size === 1) {
    for (const accountUuid of holders) return accountUuid;
  }
  return p.selfHome?.accountUuid ?? null;
}

// Constructed inside buildApp over its live store accessor. It keeps which
// Memberships the stored rows resolve to, under the presumption it read them
// with: grown by additions, dropped by any replacement or deletion, a
// presumption change or a store swap. No await inside a query or change
// listener, so an answer reads one coherent store snapshot.
// One Membership's key: its Organization and Account, `null` for the one with
// an Account not known.
const membershipKey = (organization: string, account: string | null | undefined): string =>
  JSON.stringify([organization, account ?? null]);

export function createScopeMemberships(deps: { getStore: () => EventStore }) {
  let store: EventStore | null = null;
  let unsubscribe: (() => void) | null = null;

  // The Memberships the stored rows resolve to, as (Organization, Account key
  // or undefined), each once.
  type Present = { organization: string; account: string | undefined };
  let present: Map<string, Present> | null = null;
  let presentPresumption: Presumption | null = null;

  function bindStore(): EventStore {
    const current = deps.getStore();
    if (current === store) return current;
    unsubscribe?.();
    store = current;
    present = null;
    unsubscribe = current.onChanged((changes) => {
      for (const { event, replaced } of changes) {
        // A replacement can move a row to another Membership (a tag gain is
        // one), and a deletion can leave one with no row: read them again.
        if (replaced !== null || event === null) {
          present = null;
          return;
        }
        if (Number.isNaN(event.ms)) continue;
        if (present !== null && presentPresumption !== null) notePresent(event, presentPresumption);
      }
    });
    return current;
  }

  function notePresent(event: StoredEvent, p: Presumption): void {
    const organization = eventOrganization(event, p);
    if (organization === undefined || present === null) return;
    const account = eventAccount(event, p);
    const key = membershipKey(organization, account);
    if (!present.has(key)) present.set(key, { organization, account });
  }

  function presentMemberships(current: EventStore, p: Presumption) {
    if (present === null || presentPresumption !== p) {
      present = new Map();
      presentPresumption = p;
      for (const event of current.query()) {
        if (!Number.isNaN(event.ms)) notePresent(event, p);
      }
    }
    return present.values();
  }

  function of(request: ScopeRequest): ScopeMemberships {
    const current = bindStore();
    const p = current.presumption();
    const { scope, home } = request;
    const memberships = new Map<string, HeadCandidate>();
    const add = (organization: string, account: string | undefined, rows: boolean) => {
      if (!scopeHasMembership(scope, organization, account)) return;
      const key = membershipKey(organization, account);
      const seen = memberships.get(key);
      if (seen !== undefined) {
        seen.rows ||= rows;
        return;
      }
      const membership: MembershipKey = {
        organizationUuid: organization,
        accountUuid: account ?? null,
      };
      memberships.set(key, { membership, rows });
    };
    const tracked = current.trackedAccounts();
    const known = new Map<string, Set<string>>();
    const know = (organization: string, account: string | null | undefined) => {
      if (account === null || account === undefined) return;
      if (tracked !== null && !tracked.has(account)) return;
      let accounts = known.get(organization);
      if (accounts === undefined) known.set(organization, (accounts = new Set()));
      accounts.add(account);
    };
    for (const [organization, holders] of p.membershipRoster) {
      for (const account of holders) know(organization, account);
    }
    for (const m of presentMemberships(current, p)) {
      add(m.organization, m.account, true);
      know(m.organization, m.account);
    }
    add(home.organizationUuid, home.accountUuid ?? undefined, false);
    know(home.organizationUuid, home.accountUuid);
    return {
      memberships: [...memberships.values()].sort((a, b) => compareHeadCandidates(a, b, home)),
      known,
    };
  }

  return {
    of,
    // The Scope's candidate Memberships for the shared head rule, head first.
    candidates(request: ScopeRequest): HeadCandidate[] {
      return of(request).memberships;
    },
  };
}

export type ScopeMembershipsReader = ReturnType<typeof createScopeMemberships>;
