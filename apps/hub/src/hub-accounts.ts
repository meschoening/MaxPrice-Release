import {
  ANTHROPIC_PROVIDER,
  byCodeUnit,
  type HubAccount,
  type HubMachine,
  type HubMembership,
  type LabelEntry,
  type UsageConnection,
} from "@maxprice/shared";
import { LEGACY_KEY, type MembershipState } from "@maxprice/usage-core";
import type { HubKeyListing } from "./key-store";

// A key's connection as the Hub reports it (#267 item 2), from the poller's
// and the key's own discovery: the poller reads `disconnected` for no key AND
// for a key awaiting its first answer (the pending read clients skip); a
// discovery that failed or listed nothing is awaiting nothing, so with no
// answer it reads `error`. `expired`, `connected` and an all-forbidden/error
// `error` pass through.
export function hubUsageConnection(
  polled: UsageConnection,
  discoveryFailed: boolean,
): UsageConnection {
  return polled === "disconnected" && discoveryFailed ? "error" : polled;
}

export type HubAccountsInput = {
  // What the key store holds.
  keys: HubKeyListing;
  // A held key's connection, by Account key (LEGACY_KEY for the legacy one):
  // the poller's, composed with that key's discovery (`hubUsageConnection`).
  connection: (account: string) => UsageConnection;
  // Every Membership the poller reads, with its state.
  memberships: readonly MembershipState[];
  // A held key's last listing (organization-roster.json), by Account key.
  listing: (account: string) => readonly string[] | null;
  // The archive's Account tags with their Organizations (ADR-0139 §2).
  tags: ReadonlyMap<string, ReadonlySet<string>>;
  // The Accounts the published Homes and the Label directory name, each with
  // the Organizations a Home pairs it with (`fleetAccountNames`). Absent:
  // none.
  named?: ReadonlyMap<string, ReadonlySet<string>>;
};

// The Accounts the fleet names beside its event tags (ADR-0139 §2): each
// published Home membership's Account, with that Home's Organization, and
// each live Label directory account entry's, with no Organization. A cleared
// label (a tombstone) names nothing: the entry stays for the union, but the
// user has taken the name away (#635 review). Display only: the status lists them so the console can say
// which Account needs a key and the Hub page can count it. Nothing here, nor
// anything the status lists from it, attributes a row, presumes an Account
// or seeds a tracked set (option C, #634; the Hub's half of the roster is
// #660's).
export function fleetAccountNames(
  machines: readonly Pick<HubMachine, "homeMemberships">[],
  accountLabels: Readonly<Record<string, LabelEntry>>,
): Map<string, Set<string>> {
  const named = new Map<string, Set<string>>();
  const name = (account: string): Set<string> => {
    const organizations = named.get(account) ?? new Set<string>();
    named.set(account, organizations);
    return organizations;
  };
  for (const machine of machines) {
    const home = machine.homeMemberships?.anthropic;
    if (home === undefined || home.accountUuid === null) continue;
    name(home.accountUuid).add(home.organizationUuid);
  }
  for (const [account, entry] of Object.entries(accountLabels)) {
    if (entry.label !== null) name(account);
  }
  return named;
}

// One Membership as the status carries it: the poller's state when it reads
// it, else no answer (`limits: null`). `current` is present only once a read
// answered it, a null included (ADR-0139 §1).
function membershipOf(organization: string, state: MembershipState | undefined): HubMembership {
  if (state === undefined) {
    return {
      organizationUuid: organization,
      limits: null,
      windowStates: null,
      lastReadAt: null,
      lastSampleAt: null,
    };
  }
  return {
    organizationUuid: organization,
    limits: state.status?.limits ?? null,
    windowStates: state.status?.windowStates ?? null,
    lastReadAt: state.status?.lastReadAt ?? null,
    lastSampleAt: state.status?.lastSampleAt ?? null,
    ...(state.answered ? { current: state.current } : {}),
    ...(state.weeklyResetAt === null ? {} : { weeklyResetAt: state.weeklyResetAt }),
  };
}

// The Hub status's `accounts` (ADR-0139 §1–§3, §5): every keyed Account, the
// unmoved legacy key as `accountUuid: null`, every removed Account
// (`disconnected`, `setAt: null`, its `removedAt`), and every Account an event
// tag, a published Home or a live Label directory account entry names
// (`disconnected`, `setAt: null`). A keyed Account's Memberships are its
// listing's Organizations and any its key reads, with the poller's state,
// plus any pair the tags and Homes name; every other entry's are the tags'
// and Homes' pairs, with no answer. Sorted by provider, then account uuid (the legacy entry first),
// Memberships by Organization.
export function hubAccounts(input: HubAccountsInput): HubAccount[] {
  const statesOf = new Map<string, Map<string, MembershipState>>();
  for (const m of input.memberships) {
    const of = statesOf.get(m.account) ?? new Map<string, MembershipState>();
    of.set(m.organization, m);
    statesOf.set(m.account, of);
  }
  const named = input.named ?? new Map<string, ReadonlySet<string>>();
  // The pairs the tags and the published Homes name for an Account.
  const tagged = (uuid: string | null): readonly string[] =>
    uuid === null ? [] : [...(input.tags.get(uuid) ?? []), ...(named.get(uuid) ?? [])];

  function memberships(account: string, uuid: string | null, held: boolean): HubMembership[] {
    const states = held ? (statesOf.get(account) ?? new Map<string, MembershipState>()) : new Map();
    const organizations = new Set<string>([
      ...(held ? (input.listing(account) ?? []) : []),
      ...states.keys(),
      ...tagged(uuid),
    ]);
    return [...organizations].sort(byCodeUnit).map((o) => membershipOf(o, states.get(o)));
  }

  const out: HubAccount[] = [];
  const keyed = new Set<string>();
  if (input.keys.legacy !== null) {
    out.push({
      provider: ANTHROPIC_PROVIDER,
      accountUuid: null,
      connection: input.connection(LEGACY_KEY),
      setAt: input.keys.legacy.setAt,
      source: input.keys.legacy.source,
      removedAt: null,
      memberships: memberships(LEGACY_KEY, null, true),
    });
  }
  for (const key of input.keys.accounts) {
    keyed.add(key.accountUuid);
    out.push({
      provider: ANTHROPIC_PROVIDER,
      accountUuid: key.accountUuid,
      connection: input.connection(key.accountUuid),
      setAt: key.setAt,
      source: key.source,
      removedAt: null,
      memberships: memberships(key.accountUuid, key.accountUuid, true),
    });
  }
  const unkeyed = new Set<string>([
    ...Object.keys(input.keys.removed),
    ...input.tags.keys(),
    ...named.keys(),
  ]);
  for (const uuid of unkeyed) {
    if (keyed.has(uuid)) continue;
    out.push({
      provider: ANTHROPIC_PROVIDER,
      accountUuid: uuid,
      connection: "disconnected",
      setAt: null,
      source: null,
      removedAt: Object.hasOwn(input.keys.removed, uuid) ? input.keys.removed[uuid]! : null,
      memberships: memberships(uuid, uuid, false),
    });
  }
  return out.sort(
    (a, b) =>
      byCodeUnit(a.provider, b.provider) ||
      (a.accountUuid === null ? -1 : b.accountUuid === null ? 1 : 0) ||
      byCodeUnit(a.accountUuid ?? "", b.accountUuid ?? ""),
  );
}
