import { homeMembershipOf, type HomeMembership, type Settings } from "./settings";

// The Scope (GLOSSARY.md, ADR-0136 §6, ADR-0140 §1): the set of Memberships
// every report describes. It is named by two axes that intersect, the Account
// axis and the Organization axis, each a list of tokens:
//   - `all`: any tracked value on that axis;
//   - `home`: that axis's part of the Home membership;
//   - a key: an Organization uuid, or an Account key (an account uuid, or a
//     Pending account's `pending:<hash>`, ADR-0137 §1).
// Tokens on one axis are a union. An axis left unnamed matches any, and naming
// neither axis means the Home membership (ADR-0136 §5's default), so a
// single-Account install's default is the Home organization it always was.
//
// One resolution rule, in `packages/shared` so the Headless client's Scope
// flags (#642) can resolve as the sidecar does; today the sidecar alone reads
// it, from the `account` and `organization` query params, so a stale value
// answers alike wherever it is read. It never refuses. On the Organization
// axis a token that names nothing tracked is dropped, and an axis left with no
// token resolves to Home's part, as a stale Organization scope always resolved
// to Home (#262 items 2 and 11). On the Account axis an explicit key is never
// dropped: it names that Account alone, tracked or not, and one no row
// resolves to matches nothing, so a stale Account selection is an empty Scope,
// never the Home default (#635). The Headless client refuses an empty Scope
// itself, before it asks (ADR-0140 §1).

// The `all` and `home` tokens, on either axis.
export const SCOPE_ALL = "all";
export const SCOPE_HOME = "home";

// What a Scope resolves against: the Home membership in force and this
// machine's two tracked sets, as ingest admits by them (ADR-0136 §3).
// `trackedOrganizations` is the resolved Organization set, Home included;
// `trackedAccounts` the resolved Account set, the Home membership's Account
// included. Either is null when its level excludes nothing.
export type ScopeState = {
  home: HomeMembership | null;
  trackedOrganizations: ReadonlySet<string> | null;
  trackedAccounts: ReadonlySet<string> | null;
};

// Home plus the tracked Organization list, empty entries dropped: the
// Organizations Settings calls tracked. Null with no Home, where nothing is
// excluded (ADR-0098's null set). `home` defaults to the file's; the
// Headless client passes the daemon's while the file names none yet.
export function trackedOrganizationSet(
  settings: Pick<Settings, "homeMemberships" | "trackedOrganizations">,
  home: HomeMembership | null = homeMembershipOf(settings),
): ReadonlySet<string> | null {
  if (home === null) return null;
  const set = new Set<string>([home.organizationUuid]);
  for (const uuid of settings.trackedOrganizations) if (uuid !== "") set.add(uuid);
  return set;
}

// The tracked Account list plus the Home membership's Account: the resolved
// set the sidecar admits by (`resolveTrackedAccounts`). Null while the file
// names no `trackedAccounts`, where nothing is excluded.
export function trackedAccountSet(
  settings: Pick<Settings, "homeMemberships" | "trackedAccounts">,
): ReadonlySet<string> | null {
  if (settings.trackedAccounts === null) return null;
  const set = new Set(settings.trackedAccounts.filter((key) => key !== ""));
  const homeAccount = homeMembershipOf(settings)?.accountUuid ?? null;
  if (homeAccount !== null) set.add(homeAccount);
  return set;
}

// What a Scope resolves against, from settings: what the sidecar's
// `createOrganizationScope` reads from the same file. The renderer and the
// Headless client both read it (ADR-0118 §7); `home` as for
// `trackedOrganizationSet`.
export function scopeStateOf(
  settings: Pick<Settings, "homeMemberships" | "trackedOrganizations" | "trackedAccounts">,
  home: HomeMembership | null = homeMembershipOf(settings),
): ScopeState {
  return {
    home,
    trackedOrganizations: trackedOrganizationSet(settings, home),
    trackedAccounts: trackedAccountSet(settings),
  };
}

// A resolved Scope as the store takes it: the `organizations` and `accounts`
// axes of a store query (`StoreQuery`), each sorted, `[]` meaning any, and
// `unknownAccount`, whether rows whose Account resolves to none (ADR-0137 §3's
// note: an Account not known) are in the Scope. Their intersection is the
// Scope's Memberships, the Unknown one of each Organization among them while
// `unknownAccount` holds. It always holds while the Account axis is any.
//
// `memberships` (#637) is the Scope named as Memberships rather than axes: the
// sorted, deduplicated `membership` tokens (`formatMembershipToken`), exactly
// the (Organization, Account) pairs the Scope holds; absent when the Scope is
// named by its axes. While it is a list the three axes above are its covering
// axes, every Organization and Account it names and Unknown when one names an
// Organization's Unknown Membership, so code that narrows by axis narrows no
// further than the list; the list itself is the exact predicate
// (`scopeHasMembership`, the store's `memberships`). `[]` holds no Membership.
export type ResolvedScope = {
  organizations: string[];
  accounts: string[];
  unknownAccount: boolean;
  memberships?: string[];
};

// The Scope that narrows nothing.
export const UNSCOPED: ResolvedScope = { organizations: [], accounts: [], unknownAccount: true };

// --- The `membership` token (#637) ------------------------------------------
//
// One Membership as a Scope token, the repeated `membership` query param:
// `<organizationUuid>~<accountKey>`, the Account key an account uuid or a
// Pending account's `pending:<hash>` (ADR-0137 §1), or `unknown` for the
// Organization's Membership whose Account is not known (#635). The Account
// axis's two-axis grammar cannot name an arbitrary set of Memberships (Alex in
// Team with Blair in Blair-max would admit Blair in Team); a list of these
// can. Neither an Organization uuid nor an Account key holds a `~`.

// The Account part naming an Organization's Unknown Membership.
export const MEMBERSHIP_UNKNOWN = "unknown";

// A token no Membership has: a Membership list holding only it is the empty
// Scope. The renderer sends an empty selection as `[MEMBERSHIP_NONE]`, since
// an absent list is the default Scope, not an empty one.
export const MEMBERSHIP_NONE = "";

const MEMBERSHIP_SEPARATOR = "~";

// The one formatter: a Membership's token, `accountKey` null for an Account
// not known.
export function formatMembershipToken(organizationUuid: string, accountKey: string | null): string {
  return `${organizationUuid}${MEMBERSHIP_SEPARATOR}${accountKey ?? MEMBERSHIP_UNKNOWN}`;
}

// The one parser: the Membership a token names, or null for a malformed one
// (no `~`, more than one, or an empty part), which names no Membership.
export function parseMembershipToken(token: string): MembershipKey | null {
  const parts = token.split(MEMBERSHIP_SEPARATOR);
  if (parts.length !== 2) return null;
  const [organizationUuid, account] = parts as [string, string];
  if (organizationUuid === "" || account === "") return null;
  return { organizationUuid, accountUuid: account === MEMBERSHIP_UNKNOWN ? null : account };
}

// Resolve the two axes' raw tokens (repeated query params, each list possibly
// empty) against `state`. Pure.
//
// - **Membership tokens** (`membershipTokens`, #637), when there is any, name
//   the Scope alone: the axis tokens beside them are ignored, never refused.
//   The Scope is exactly the Memberships they name, with or without a Home and
//   whatever is tracked, as an explicit Account key is (#635): never widened
//   to any, Unknown only where a `~unknown` token names it, and a token naming
//   nothing (a malformed one included) adds nothing, so a list naming nothing
//   matches no row rather than the Home default (`membershipScope`).
//
// - **No Home** narrows nothing on the Organization axis, nor on an Account
//   axis that is unnamed, `all` or `home`: the ADR-0098 null-set rule, which
//   the golden corpus runs. _Amended 2026-11-09 (#635):_ explicit Account keys
//   stay strict with no Home too (`noHomeScope`).
// - **The Organization axis** resolves `all` to the tracked set (never to
//   every Organization the store holds, #262 item 4: a fleet row of an
//   Organization this machine does not track stays out of All), and to nothing
//   while the tracked set is null. `home` and an untracked uuid resolve as
//   above.
// - **The Account axis** resolves `all` to any. Ingest already gates every row
//   with Account evidence on the tracked Account set, and the store's scoping
//   omits every evidence-less row whose query-time Account is excluded
//   (ADR-0137 §3), so "every tracked Account" and "any" differ only by the rows
//   with no Account at all, which a Scope that does not narrow by Account
//   counts (ADR-0137 §3's note). For the same reason Home's part widens to any
//   when, with the Accounts named beside it, it covers the whole tracked
//   Account set: on a single-Account install the Home membership is the Home
//   organization, rows with no Account included, so no number moves (ADR-0136
//   §2). `home` while the Home membership's Account is unknown is any too: an
//   unknown Account narrows nothing.
// - **Unknown** (`unknownAccount`). _Amended 2026-11-09 (#635, the
//   decision recorded in ADR-0136 §6's note):_ "All usage should still show
//   but if unsure what account it came from it should say it's unknown". An
//   Account axis holding Home's part (neither axis named, or the `home` token)
//   holds the Home membership's Account and the rows with no Account, so the
//   default Scope counts every row an install cannot attribute. An axis made
//   of explicit Account keys holds those Accounts alone, never Unknown and
//   never widened to any, even when it names every tracked Account: an
//   Account named is that Account's usage, and nothing guessed joins it. A
//   key need not be tracked (a peer's row carries its own Account evidence,
//   whatever this machine tracks), and one naming nothing, a malformed or
//   empty value included, matches no row.
export function resolveScope(
  accountTokens: readonly string[],
  organizationTokens: readonly string[],
  state: ScopeState,
  membershipTokens: readonly string[] = [],
): ResolvedScope {
  if (membershipTokens.length > 0) return membershipScope(membershipTokens);
  const { home } = state;
  if (home === null) return noHomeScope(accountTokens);
  // Neither axis named is the Home membership; one named leaves the other
  // matching any tracked value, as `all` does.
  const named = accountTokens.length > 0 || organizationTokens.length > 0;
  const axis = (tokens: readonly string[]): readonly string[] =>
    !named ? [SCOPE_HOME] : tokens.length === 0 ? [SCOPE_ALL] : tokens;
  const { accounts, unknownAccount } = resolveAccountAxis(
    axis(accountTokens),
    home,
    state.trackedAccounts,
  );
  return {
    organizations: resolveOrganizationAxis(
      axis(organizationTokens),
      home,
      state.trackedOrganizations,
    ),
    accounts,
    unknownAccount,
  };
}

// The Scope a non-empty list of `membership` tokens names (`resolveScope`):
// the canonical tokens of the Memberships they parse to, and their covering
// axes. Its Account axis is `[]` (any) only when every Membership is an
// Unknown one, where the list alone narrows.
function membershipScope(tokens: readonly string[]): ResolvedScope {
  const memberships = new Set<string>();
  const organizations = new Set<string>();
  const accounts = new Set<string>();
  let unknownAccount = false;
  for (const token of tokens) {
    const m = parseMembershipToken(token);
    if (m === null) continue;
    memberships.add(formatMembershipToken(m.organizationUuid, m.accountUuid));
    organizations.add(m.organizationUuid);
    if (m.accountUuid === null) unknownAccount = true;
    else accounts.add(m.accountUuid);
  }
  return {
    organizations: [...organizations].sort(),
    accounts: [...accounts].sort(),
    unknownAccount,
    memberships: [...memberships].sort(),
  };
}

// The Scope with no Home (ADR-0098's null-set rule): the Organization axis
// narrows nothing, and so does an Account axis holding `all` or `home` (Home's
// part, whose Account is not known, is any) or no token at all. An axis made
// of explicit Account keys alone is still those Accounts' rows and nothing
// else, as with a Home (#635): an Account named never answers every row.
function noHomeScope(accountTokens: readonly string[]): ResolvedScope {
  if (accountTokens.length === 0) return UNSCOPED;
  if (accountTokens.some((t) => t === SCOPE_ALL || t === SCOPE_HOME)) return UNSCOPED;
  return { organizations: [], accounts: [...new Set(accountTokens)].sort(), unknownAccount: false };
}

function resolveOrganizationAxis(
  tokens: readonly string[],
  home: HomeMembership,
  tracked: ReadonlySet<string> | null,
): string[] {
  if (tracked === null) return [];
  const members = new Set(tracked);
  members.add(home.organizationUuid);
  const out = new Set<string>();
  for (const token of tokens) {
    if (token === SCOPE_ALL) return [...members].sort();
    if (token === SCOPE_HOME) out.add(home.organizationUuid);
    else if (members.has(token)) out.add(token);
  }
  if (out.size === 0) out.add(home.organizationUuid);
  return [...out].sort();
}

// The Account axis and whether it holds Unknown (`ResolvedScope`): any holds
// it, and so does Home's part (the `home` token, which an unnamed axis beside
// an unnamed Organization axis stands for). Explicit keys are kept as named.
// `tokens` is never empty (`resolveScope` supplies `home` or `all`).
function resolveAccountAxis(
  tokens: readonly string[],
  home: HomeMembership,
  tracked: ReadonlySet<string> | null,
): { accounts: string[]; unknownAccount: boolean } {
  const ANY = { accounts: [], unknownAccount: true };
  const homeAccount = home.accountUuid;
  const out = new Set<string>();
  let homePart = false;
  for (const token of tokens) {
    if (token === SCOPE_ALL) return ANY;
    if (token === SCOPE_HOME) {
      if (homeAccount === null) return ANY;
      out.add(homeAccount);
      homePart = true;
    } else {
      out.add(token);
    }
  }
  if (homePart && tracked !== null && [...tracked].every((key) => out.has(key))) return ANY;
  return { accounts: [...out].sort(), unknownAccount: homePart };
}

// Whether one Membership is in a resolved Scope. An Account the event resolves
// to no key for (`undefined`), the Organization's Unknown Membership, is in a
// Scope whose Account axis is any or holds Unknown (`unknownAccount`). A Scope
// named by Memberships holds exactly those (#637).
export function scopeHasMembership(
  scope: ResolvedScope,
  organizationUuid: string,
  accountKey: string | undefined,
): boolean {
  if (scope.memberships !== undefined) {
    return scope.memberships.includes(formatMembershipToken(organizationUuid, accountKey ?? null));
  }
  if (scope.organizations.length > 0 && !scope.organizations.includes(organizationUuid)) {
    return false;
  }
  if (scope.accounts.length === 0) return true;
  if (accountKey === undefined) return scope.unknownAccount;
  return scope.accounts.includes(accountKey);
}

// A Membership as the wire names it (ADR-0136 §2): its Organization uuid, and
// its Account key, or null for an Account not known (ADR-0137 §3's note: a row
// whose Account resolves to none).
export type MembershipKey = { organizationUuid: string; accountUuid: string | null };

// The order a wide Scope's Memberships are listed in, until the most-used
// ordering (#633) replaces it: the Home membership first, then the rest of the
// Home organization, then the Home membership's Account's other Memberships,
// then by Organization uuid and Account key, an unknown Account last. The
// first is the Scope's head: the Membership a surface that shows one picks
// (ADR-0136 §6) — under the default Scope, and under All organizations, the
// Home membership.
export function compareMemberships(
  a: MembershipKey,
  b: MembershipKey,
  home: HomeMembership | null,
): number {
  const rank = (m: MembershipKey): number => {
    if (home === null) return 3;
    const inHomeOrg = m.organizationUuid === home.organizationUuid;
    // An unknown Account (null) is the Home membership's while its Account is.
    const homeAccount = m.accountUuid === home.accountUuid;
    if (inHomeOrg && homeAccount) return 0;
    if (inHomeOrg) return 1;
    if (homeAccount && home.accountUuid !== null) return 2;
    return 3;
  };
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  if (a.organizationUuid !== b.organizationUuid) {
    return a.organizationUuid < b.organizationUuid ? -1 : 1;
  }
  if (a.accountUuid === b.accountUuid) return 0;
  if (a.accountUuid === null) return 1;
  if (b.accountUuid === null) return -1;
  return a.accountUuid < b.accountUuid ? -1 : 1;
}
