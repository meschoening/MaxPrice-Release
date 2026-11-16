import {
  ACCOUNT_NOT_KNOWN,
  accountFilterSummary,
  accountLabel,
  byCodeUnit,
  formatMembershipToken,
  membershipReadability,
  mostUsedWindow,
  organizationLabel,
  parseMembershipToken,
  pendingHashOf,
  resolveScope,
  scopeHasMembership,
  scopeQueryParams,
  scopeStateOf,
  trackedOrganizationSet,
  type AccountEntry,
  type AccountMembership,
  type MembershipTotal,
  type ScopeSetting,
  type Settings,
} from "@maxprice/shared";
import { scopeForSelection, trackedMemberships } from "./scope-view";

// The rail's Account menu (#637, #620 items 1–8), as pure data: which
// Accounts it lists, how they rank, what each row says and which Memberships
// are checked, and the Scope a click writes. `account-filter.tsx` renders it.

// --- Avatar ------------------------------------------------------------------

// An Account's avatar letter: the first of its user label, else of its email,
// else of its id (the account uuid, or the hash after a Pending key's
// `pending:`). Not the first of its shown label, because every default label
// is `Account <first 8>` (ADR-0136 §7's `accountLabel`): two Accounts with no
// email or label would both draw "A". A default label means neither a user
// label nor an email was there to show.
export function accountMark(entry: Pick<AccountEntry, "key" | "email" | "label">): string {
  const noEmail = entry.email === null || entry.email === "";
  const named = !(noEmail && entry.label === accountLabel(entry.key, null));
  const source = named ? entry.label : (pendingHashOf(entry.key) ?? entry.key);
  return (source.trim()[0] ?? "?").toUpperCase();
}

// --- Providers ---------------------------------------------------------------

export type ProviderId = "anthropic" | "openai";

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  anthropic: "Claude",
  openai: "ChatGPT",
};

// An Account's Provider. `/api/accounts` carries no provider field: every
// Account the sidecar knows today is Anthropic's (the Codex map brings the
// second Provider and the field), so this answers `anthropic` for every entry
// and the Provider switch, which needs two, never renders in the product yet.
// One function, so the field's arrival is one edit.
export function providerOf(account: Pick<AccountEntry, "key">): ProviderId {
  void account;
  return "anthropic";
}

// --- The model ---------------------------------------------------------------

// Past six Accounts (under the Provider choice) the menu gains its search and
// folds after the top five (#620 item 2).
export const MENU_FOLD_AFTER = 6;
export const MENU_TOP = 5;

export type MenuOrder = "used" | "free";

// One checkable Membership in the menu.
export interface MenuMembership {
  token: string;
  organizationUuid: string;
  // The Account key, null for the Membership with an Account not known.
  accountKey: string | null;
  // The Organization's label.
  label: string;
  home: boolean;
  selected: boolean;
  // Its money in the rail's range, never narrowed by the menu's selection.
  costUSD: number;
}

// One row: a tracked Account, or the "Account not known" row.
export interface MenuAccount {
  key: string;
  provider: ProviderId;
  label: string;
  // The avatar's letter (`accountMark`); a Pending account draws "@" instead.
  mark: string;
  // The line under the label: the email (when the label is not already it),
  // "Known by email only" for a Pending account, or the Unknown row's note.
  sub: string | null;
  pending: boolean;
  // The "Account not known" row.
  unknown: boolean;
  memberships: MenuMembership[];
  // Its most used Membership's most used live window, null when none of its
  // Memberships reads one (no key, an expired key with no readable answer,
  // Pending, Unreadable, or no limits).
  usePct: number | null;
  costUSD: number;
}

export interface AccountMenuModel {
  // The tracked Accounts, unranked (`rankAccounts` orders them).
  accounts: MenuAccount[];
  // The "Account not known" row: an Organization's Membership for each the
  // range has such usage in or the Scope holds; null when there is none.
  unknown: MenuAccount | null;
  // The Providers the tracked Accounts span, in first-seen order.
  providers: ProviderId[];
  // Every listed Membership is checked: the "all accounts" state, with no
  // Selected section.
  isAll: boolean;
  // The persisted Scope is the default (null).
  isDefault: boolean;
  // Tokens a Membership list holds that no row lists (one naming an
  // Organization or Account no longer tracked): a toggle keeps them as
  // written. Every Account-not-known Membership the Scope holds has a row
  // (`unknown`), so none is carried unseen.
  carry: string[];
  // Accounts seen but not tracked: the footer's count.
  untrackedCount: number;
  // Every tracked Account, the readout's denominator.
  trackedAccountCount: number;
}

type MenuSettings = Pick<
  Settings,
  "scope" | "homeMemberships" | "trackedOrganizations" | "trackedAccounts"
>;

export interface AccountMenuInput {
  accounts: readonly AccountEntry[];
  settings: MenuSettings;
  // `/api/membership-totals` for the rail's range and other filters under
  // every Membership (`account=all&organization=all`); undefined while loading.
  totals: readonly MembershipTotal[] | undefined;
  organizationLabels: ReadonlyMap<string, string>;
  nowMs: number;
}

// Whether a Membership's reading may rank it: readable, or a stale one whose
// last answer was readable (`rankMemberships`' rule, ADR-0138 §8).
function rankable(connection: AccountEntry["connection"], m: AccountMembership): boolean {
  if (membershipReadability(connection, m.limits) === "readable") return true;
  return connection === "expired" && (m.limits === "windows" || m.limits === "none");
}

// An Account's use (#620 item 4): its most used Membership's most used live
// window (`mostUsedWindow`), over the Memberships `rankMemberships` would rank.
export function accountUse(
  account: Pick<AccountEntry, "connection" | "memberships" | "pending">,
  nowMs: number,
): number | null {
  if (account.pending) return null;
  let best: number | null = null;
  for (const m of account.memberships) {
    if (!rankable(account.connection, m)) continue;
    const window = mostUsedWindow(m.current, nowMs);
    if (window !== null && (best === null || window.utilizationPct > best)) {
      best = window.utilizationPct;
    }
  }
  return best;
}

const sum = (ms: readonly MenuMembership[]): number => ms.reduce((s, m) => s + m.costUSD, 0);

export function accountMenuModel(input: AccountMenuInput): AccountMenuModel {
  const { settings, totals = [], organizationLabels, nowMs } = input;
  const tracked = input.accounts.filter((a) => a.tracked);
  const trackedOrgs = trackedOrganizationSet(settings);
  const known = trackedMemberships(tracked, settings);
  const cost = new Map<string, number>();
  for (const row of totals) {
    if (row.organizationUuid === null) continue;
    const token = formatMembershipToken(row.organizationUuid, row.accountUuid);
    cost.set(token, (cost.get(token) ?? 0) + row.costUSD);
  }

  const params = scopeQueryParams(settings.scope);
  const resolved = resolveScope(
    params.account ?? [],
    params.organization ?? [],
    scopeStateOf(settings),
    params.memberships ?? [],
  );
  const isSelected = (organizationUuid: string, accountKey: string | null): boolean =>
    scopeHasMembership(resolved, organizationUuid, accountKey ?? undefined);
  const membership = (
    organizationUuid: string,
    accountKey: string | null,
    home: boolean,
  ): MenuMembership => {
    const token = formatMembershipToken(organizationUuid, accountKey);
    return {
      token,
      organizationUuid,
      accountKey,
      label: organizationLabel(organizationLabels, organizationUuid),
      home,
      selected: isSelected(organizationUuid, accountKey),
      costUSD: cost.get(token) ?? 0,
    };
  };

  const accounts: MenuAccount[] = tracked.map((entry) => {
    const memberships = known
      .filter((m) => m.accountKey === entry.key)
      .map((m) => membership(m.organizationUuid, m.accountKey, m.home));
    // A Membership the range has money for but no listing names yet (a
    // Pending account's, known from evidence alone) still gets its checkbox.
    for (const row of totals) {
      if (row.accountUuid !== entry.key || row.organizationUuid === null) continue;
      if (trackedOrgs !== null && !trackedOrgs.has(row.organizationUuid)) continue;
      if (memberships.some((m) => m.organizationUuid === row.organizationUuid)) continue;
      memberships.push(membership(row.organizationUuid, entry.key, false));
    }
    return {
      key: entry.key,
      provider: providerOf(entry),
      label: entry.label,
      mark: accountMark(entry),
      sub: entry.pending
        ? "Known by email only"
        : entry.email !== null && entry.email !== entry.label
          ? entry.email
          : null,
      pending: entry.pending,
      unknown: false,
      memberships,
      usePct: accountUse(entry, nowMs),
      costUSD: sum(memberships),
    };
  });

  // [proposed, #637] The "Account not known" row: the usage whose Account no
  // evidence names (ADR-0137 §3's note, #635), one Membership per
  // Organization: each the range has money for, so that checking every row
  // is all accounts' total with nothing hidden or counted twice, and each the
  // current Scope holds, at $0 too (the default's Home Organization, every
  // tracked one under all accounts), so that nothing is selected unseen.
  const organizations = new Set<string>([
    ...(trackedOrgs ?? []),
    ...accounts.flatMap((a) => a.memberships.map((m) => m.organizationUuid)),
  ]);
  const unknownOrganizations: string[] = [];
  for (const row of totals) {
    if (row.accountUuid !== null || row.organizationUuid === null) continue;
    if (!unknownOrganizations.includes(row.organizationUuid)) {
      unknownOrganizations.push(row.organizationUuid);
    }
  }
  const heldUnknown = [...organizations]
    .filter((org) => isSelected(org, null) && !unknownOrganizations.includes(org))
    .sort(
      (a, b) =>
        byCodeUnit(
          organizationLabel(organizationLabels, a),
          organizationLabel(organizationLabels, b),
        ) || byCodeUnit(a, b),
    );
  const unknownMemberships = [...unknownOrganizations, ...heldUnknown].map((org) =>
    membership(org, null, false),
  );
  const unknown: MenuAccount | null =
    unknownMemberships.length === 0
      ? null
      : {
          key: "unknown",
          provider: "anthropic",
          label: ACCOUNT_NOT_KNOWN,
          mark: "?",
          sub: "No evidence names its Account",
          pending: false,
          unknown: true,
          memberships: unknownMemberships,
          usePct: null,
          costUSD: sum(unknownMemberships),
        };

  const listed = [...accounts, ...(unknown ? [unknown] : [])].flatMap((a) => a.memberships);
  const listedTokens = new Set(listed.map((m) => m.token));
  // What a list holds beyond the rows: tokens naming no listed Membership
  // (an Organization or Account no longer tracked, left in a hand-edited
  // file), kept by a toggle as written.
  const candidates = new Set<string>();
  for (const token of params.memberships ?? []) {
    const m = parseMembershipToken(token);
    if (m !== null) candidates.add(formatMembershipToken(m.organizationUuid, m.accountUuid));
  }
  const carry = [...candidates].filter((t) => !listedTokens.has(t)).sort();

  const providers: ProviderId[] = [];
  for (const a of accounts) if (!providers.includes(a.provider)) providers.push(a.provider);

  return {
    accounts,
    unknown,
    providers,
    isAll: listed.length > 0 && listed.every((m) => m.selected),
    isDefault: settings.scope === null,
    carry,
    untrackedCount: input.accounts.length - tracked.length,
    trackedAccountCount: tracked.length,
  };
}

// --- Ranking -----------------------------------------------------------------

// Most used: highest use first; Most free: most headroom first, so lowest use
// first. An Account with no readable limit sorts last in both, then by label
// and key in code-unit order, as `rankMemberships` breaks its ties. Settings ›
// Accounts ranks its tracked cards by the same rule, "used" (ADR-0141 §8), so
// it takes anything with a use, a label and a key.
export function rankAccounts<T extends Pick<MenuAccount, "usePct" | "label" | "key">>(
  accounts: readonly T[],
  order: MenuOrder,
): T[] {
  return [...accounts].sort((a, b) => {
    if (a.usePct === null || b.usePct === null) {
      if (a.usePct !== b.usePct) return a.usePct === null ? 1 : -1;
    } else if (a.usePct !== b.usePct) {
      return order === "used" ? b.usePct - a.usePct : a.usePct - b.usePct;
    }
    return byCodeUnit(a.label, b.label) || byCodeUnit(a.key, b.key);
  });
}

// "‹u›% used" or "‹f›% free", or "no limits read".
export function usageText(usePct: number | null, order: MenuOrder): string {
  if (usePct === null) return "no limits read";
  return order === "used" ? `${Math.round(usePct)}% used` : `${Math.round(100 - usePct)}% free`;
}

// The fold line under the top five (#620 item 2): "‹N› more · none above
// ‹X›% used", under Most free "none more than ‹Y›% free", and "· ‹K› with no
// limits read" when some have none.
export function foldLine(folded: readonly MenuAccount[], order: MenuOrder): string {
  const read = folded.map((a) => a.usePct).filter((u): u is number => u !== null);
  const unread = folded.length - read.length;
  let line = `${folded.length} more`;
  if (read.length > 0) {
    line +=
      order === "used"
        ? ` · none above ${Math.round(Math.max(...read))}% used`
        : ` · none more than ${Math.round(100 - Math.min(...read))}% free`;
  }
  if (unread > 0) line += ` · ${unread} with no limits read`;
  return line;
}

// --- Search ------------------------------------------------------------------

// #621's matcher: the Account label, the email and the Organization labels,
// case-insensitive. An Organization match names the Memberships it opens.
export function matchAccount(
  account: MenuAccount,
  query: string,
): { matches: boolean; memberships: ReadonlySet<string> } {
  const q = query.trim().toLowerCase();
  const memberships = new Set<string>();
  if (q === "") return { matches: true, memberships };
  for (const m of account.memberships) {
    if (m.label.toLowerCase().includes(q)) memberships.add(m.token);
  }
  const own =
    account.label.toLowerCase().includes(q) ||
    (!account.pending && !account.unknown && (account.sub ?? "").toLowerCase().includes(q));
  return { matches: own || memberships.size > 0, memberships };
}

// --- Writes ------------------------------------------------------------------

const allTokens = (model: AccountMenuModel): string[] =>
  [...model.accounts, ...(model.unknown ? [model.unknown] : [])].flatMap((a) =>
    a.memberships.map((m) => m.token),
  );

// The Scope a set of listed tokens writes: every listed Membership is all
// accounts (#637: a selection equal to every Membership, the Account-not-known
// ones included, is "all"); anything less is a strict list (#635).
function write(model: AccountMenuModel, tokens: ReadonlySet<string>): ScopeSetting | null {
  const every = allTokens(model);
  if (every.length > 0 && every.every((t) => tokens.has(t))) {
    return scopeForSelection({ kind: "all" });
  }
  return scopeForSelection({ kind: "memberships", tokens: [...tokens] });
}

// A checkbox: when every one of `tokens` is checked they all leave, else they
// all join. What the Scope holds beyond the rows (`carry`) is kept.
export function toggleScope(
  model: AccountMenuModel,
  tokens: readonly string[],
): ScopeSetting | null {
  const selected = new Set(
    [...model.accounts, ...(model.unknown ? [model.unknown] : [])].flatMap((a) =>
      a.memberships.filter((m) => m.selected).map((m) => m.token),
    ),
  );
  const allOn = tokens.every((t) => selected.has(t));
  for (const t of tokens) {
    if (allOn) selected.delete(t);
    else selected.add(t);
  }
  const listedTokens = new Set(allTokens(model));
  const next = write(model, selected);
  if (next === null || next.membership === undefined) return next;
  // Keep the unlisted tokens only in a list: `all` already holds them.
  const carried = model.carry.filter((t) => !listedTokens.has(t));
  return scopeForSelection({ kind: "memberships", tokens: [...next.membership, ...carried] });
}

// "only": exactly these Memberships.
export function onlyScope(model: AccountMenuModel, tokens: readonly string[]): ScopeSetting | null {
  return write(model, new Set(tokens));
}

// "Clear": all accounts (#620 item 3).
export function clearScope(): ScopeSetting | null {
  return scopeForSelection({ kind: "all" });
}

// --- Readout and trigger -----------------------------------------------------

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// "‹N› of ‹M› Memberships · ‹n› of ‹m› Accounts": the Memberships over every
// row the menu lists, the Account-not-known ones included, so N counts each
// checked box; the Accounts over the tracked Accounts (an Account not known
// is no Account).
export function readoutLine(model: AccountMenuModel): string {
  const memberships = [...model.accounts, ...(model.unknown ? [model.unknown] : [])].flatMap(
    (a) => a.memberships,
  );
  const on = memberships.filter((m) => m.selected).length;
  const accountsOn = model.accounts.filter((a) => a.memberships.some((m) => m.selected)).length;
  return `${on} of ${plural(memberships.length, "Membership", "Memberships")} · ${accountsOn} of ${plural(model.trackedAccountCount, "Account", "Accounts")}`;
}

// What the closed trigger says (`accountFilterSummary`, shared with the
// Headless client's report header).
export function triggerSummary(model: AccountMenuModel): string {
  return accountFilterSummary(
    model.accounts,
    model.isAll,
    model.unknown?.memberships.some((m) => m.selected) === true,
  );
}
