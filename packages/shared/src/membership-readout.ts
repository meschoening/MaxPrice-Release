import { ACCOUNT_NOT_KNOWN, accountLabel, type AccountEntry } from "./accounts";
import { accountFilterVisible } from "./effective-scope";
import {
  mostUsedWindow,
  rankMemberships,
  type LiveWindowKind,
  type RankableMembership,
} from "./membership-rank";
import { organizationLabel } from "./organizations";
import {
  compareMemberships,
  formatMembershipToken,
  scopeHasMembership,
  type ResolvedScope,
  type ScopeState,
} from "./scope";
import { membershipReadability } from "./usage-limits";

// The Scope's Memberships and the one-number surfaces over them (#638;
// ADR-0136 §6 as amended by #610/#622, ADR-0138 §8). Pure, so the sidecar's
// `/api/readout`, the renderer's Live limit area and split bars, the Popout
// and the Blocks surfaces read one rule each:
//
// - `scopeMembershipSet`: the multi-Membership world. Every #610/#622/#638
//   surface turns on only where it holds two or more Memberships; a
//   one-Account install's set is empty under every Scope, so its tray,
//   Popout and Live stay as they were (#637's parent direction, kept as
//   built on 2026-11-10, #638's D1; ADR-0136 §6's rows count the
//   Readable memberships in this set, not in the whole Scope).
// - `scopeMembershipName`: a Membership's name, in its two parts.
// - `readoutPick`, `popoutHeadMembership`, `liveBlockMemberships`: which
//   Membership the Readout, the Popout head and the Block span read, by the
//   one most used ordering (`rankMemberships`). Only Readable memberships
//   drive any of them: a dead key's stale reading keeps its rank on the
//   surfaces that list Memberships, and never picks the one number (§8).

// One tracked Membership: a tracked Account's Membership in a tracked
// Organization (Home's included), with its `membership` token.
export interface TrackedMembership {
  token: string;
  organizationUuid: string;
  accountKey: string;
  // The Home membership.
  home: boolean;
}

// The tracked Memberships of the tracked Accounts, Home's first
// (`compareMemberships`). A null tracked Organization set (no Home) excludes
// no Organization, as the sidecar's null set excludes nothing.
export function trackedScopeMemberships(
  accounts: readonly Pick<AccountEntry, "key" | "tracked" | "memberships">[],
  state: Pick<ScopeState, "home" | "trackedOrganizations">,
): TrackedMembership[] {
  const { home, trackedOrganizations: tracked } = state;
  const out: TrackedMembership[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    if (!account.tracked) continue;
    for (const { organizationUuid } of account.memberships) {
      if (tracked !== null && !tracked.has(organizationUuid)) continue;
      const token = formatMembershipToken(organizationUuid, account.key);
      if (seen.has(token)) continue;
      seen.add(token);
      out.push({
        token,
        organizationUuid,
        accountKey: account.key,
        home:
          home !== null &&
          home.organizationUuid === organizationUuid &&
          home.accountUuid === account.key,
      });
    }
  }
  return out.sort((a, b) =>
    compareMemberships(
      { organizationUuid: a.organizationUuid, accountUuid: a.accountKey },
      { organizationUuid: b.organizationUuid, accountUuid: b.accountKey },
      home,
    ),
  );
}

// The Scope's known Memberships while the Account filter shows (two or more
// tracked Accounts, `accountFilterVisible`), else none: the tracked
// Memberships the resolved Scope holds (`scopeHasMembership`). The renderer's
// `liveScopeMemberships` and the sidecar's `/api/readout` both read it, so the
// tray, the Popout and Live switch together.
export function scopeMembershipSet(
  accounts: readonly Pick<AccountEntry, "key" | "tracked" | "memberships">[],
  state: Pick<ScopeState, "home" | "trackedOrganizations">,
  resolved: ResolvedScope,
): TrackedMembership[] {
  if (!accountFilterVisible(accounts)) return [];
  return trackedScopeMemberships(accounts, state).filter((m) =>
    scopeHasMembership(resolved, m.organizationUuid, m.accountKey),
  );
}

// Whether a set of Memberships spans two or more Accounts.
export function spansAccounts(
  memberships: readonly Pick<TrackedMembership, "accountKey">[],
): boolean {
  return new Set(memberships.map((m) => m.accountKey)).size >= 2;
}

// A Membership's name in its two parts: the Organization's label, and the
// Account's while the set it is shown among spans Accounts (`spansAccounts`),
// else null. Surfaces draw the parts apart (`MembershipNameView` in the
// renderer) so a long Organization label ellipsizes before the Account half,
// which tells two Memberships of one Organization apart (#619).
export type MembershipName = { organization: string; account: string | null };

export function scopeMembershipName(
  organization: string,
  account: string,
  acrossAccounts: boolean,
): MembershipName {
  return { organization, account: acrossAccounts ? account : null };
}

// The name on one line, `Org · Account` or `Org`: a title, a tooltip, a
// sort key.
export function membershipNameText(name: MembershipName): string {
  return name.account === null ? name.organization : `${name.organization} · ${name.account}`;
}

// A Membership's one-line name: `Org · Account` while the set it is shown
// among spans Accounts, else the Organization alone.
export function scopeMembershipLabel(
  organization: string,
  account: string,
  acrossAccounts: boolean,
): string {
  return membershipNameText(scopeMembershipName(organization, account, acrossAccounts));
}

// One Membership of the set, rankable, with its reading off `/api/accounts`.
export type ScopeMembershipReading = RankableMembership & {
  token: string;
  organizationUuid: string;
  accountKey: string;
  home: boolean;
  // Its name across the set (`scopeMembershipName`); `label` is its text.
  name: MembershipName;
  // Both halves whatever the set spans, for a surface that names a
  // Membership more briefly (the Popout's rows).
  organizationLabel: string;
  accountLabel: string;
  // When its last reading was taken, null when the roster has none.
  lastReadAt: string | null;
};

// The set's Memberships as `rankMemberships` takes them, and every surface
// that lists them builds on (the Readout, the Popout, Live's limit area, the
// Blocks tabs, the Block span's picker): each named by `scopeMembershipName`,
// with its Account's connection and its own Limits answer and reading (none
// for an Account or Membership the roster lacks).
export function scopeMembershipReadings(
  memberships: readonly TrackedMembership[],
  accounts: readonly Pick<AccountEntry, "key" | "label" | "connection" | "memberships">[],
  organizationLabels: ReadonlyMap<string, string>,
): ScopeMembershipReading[] {
  const byKey = new Map(accounts.map((a) => [a.key, a]));
  const across = spansAccounts(memberships);
  return memberships.map((m) => {
    const account = byKey.get(m.accountKey);
    const entry = account?.memberships.find((x) => x.organizationUuid === m.organizationUuid);
    const orgLabel = organizationLabel(organizationLabels, m.organizationUuid);
    const acctLabel = account?.label ?? accountLabel(m.accountKey, null);
    const name = scopeMembershipName(orgLabel, acctLabel, across);
    return {
      key: m.token,
      token: m.token,
      organizationUuid: m.organizationUuid,
      accountKey: m.accountKey,
      home: m.home,
      name,
      label: membershipNameText(name),
      organizationLabel: orgLabel,
      accountLabel: acctLabel,
      connection: account?.connection ?? "disconnected",
      limits: entry?.limits ?? null,
      reading: entry?.current ?? null,
      lastReadAt: entry?.lastReadAt ?? null,
    };
  });
}

// --- The one number -----------------------------------------------------------

// One Membership's most used live window, as the Readout words it.
export type ReadoutMembership = {
  label: string;
  window: LiveWindowKind;
  // The scoped family of a `weeklyModel` window ("Fable").
  model?: string;
  pct: number;
};

// What the Readout shows over the set (ADR-0136 §6's #610/#622 rows):
// - `single`: fewer than two Readable memberships, today's Readout exactly;
// - `percent`: two or more, and some Readable 5-hour window in flight: the
//   most used Membership's most used window (`top`), then the second;
// - `money`: two or more and no 5-hour window in flight: today's money, with
//   the most used live window (`mostUsed`, null when none is live).
// `count` is the set's Memberships, every state.
export type ReadoutPick =
  | { kind: "single" }
  | { kind: "percent"; top: ReadoutMembership; next: ReadoutMembership | null; count: number }
  | { kind: "money"; mostUsed: ReadoutMembership | null; count: number };

const isReadable = (m: RankableMembership): boolean =>
  membershipReadability(m.connection, m.limits) === "readable";

// A 5-hour window in flight: held, and its reset still ahead.
function fiveHourInFlight(m: RankableMembership, nowMs: number): boolean {
  const window = m.reading?.fiveHour;
  return window != null && Date.parse(window.resetAt) > nowMs;
}

// Readable memberships with a live window, most used first. A stale reading,
// however high, is never among them (ADR-0138 §8).
function liveReadable<T extends RankableMembership>(memberships: readonly T[], nowMs: number): T[] {
  return rankMemberships(
    memberships.filter((m) => isReadable(m) && mostUsedWindow(m.reading, nowMs) !== null),
    nowMs,
  );
}

function readoutMembership(m: RankableMembership, nowMs: number): ReadoutMembership {
  const window = mostUsedWindow(m.reading, nowMs);
  if (window === null) throw new Error(`readoutMembership: ${m.key} has no live window`);
  const model = window.kind === "weeklyModel" ? m.reading?.weeklyModel?.model : undefined;
  return {
    label: m.label,
    window: window.kind,
    ...(model === undefined ? {} : { model }),
    pct: window.utilizationPct,
  };
}

export function readoutPick(
  memberships: readonly RankableMembership[],
  nowMs: number,
): ReadoutPick {
  const readable = memberships.filter(isReadable);
  // One Readable membership keeps today's Readout. None among several is
  // money (ADR-0136 §6's "No Readable membership" row): an expired key's
  // retained reading never drives it (ADR-0138 §8).
  if (memberships.length < 2 || readable.length === 1) return { kind: "single" };
  const ranked = liveReadable(readable, nowMs);
  const count = memberships.length;
  const [top, next] = ranked;
  // Only a 5-hour window in flight switches to a percent: a weekly window is
  // open for days (#622 item 3).
  if (top !== undefined && readable.some((m) => fiveHourInFlight(m, nowMs))) {
    return {
      kind: "percent",
      top: readoutMembership(top, nowMs),
      next: next === undefined ? null : readoutMembership(next, nowMs),
      count,
    };
  }
  return {
    kind: "money",
    mostUsed: top === undefined ? null : readoutMembership(top, nowMs),
    count,
  };
}

// The Popout head (ADR-0136 §6's Popout paragraph): the most used Readable
// membership whose 5-hour window is in flight, drawn live. That is the
// Readout's Membership whenever its own 5-hour window is in flight, since it
// is the most used of all. With none in flight the head is the most used
// Readable membership with any live window (the Readout's `Most used:`),
// drawn idle; with none of those, null: today's idle head.
export function popoutHeadMembership(
  memberships: readonly RankableMembership[],
  nowMs: number,
): { key: string; idle: boolean } | null {
  const ranked = liveReadable(memberships, nowMs);
  const live = ranked.find((m) => fiveHourInFlight(m, nowMs));
  if (live !== undefined) return { key: live.key, idle: false };
  const top = ranked[0];
  return top === undefined ? null : { key: top.key, idle: true };
}

// The Memberships with a live Block: Readable, their 5-hour window in flight,
// most used first (the Block span's picker).
export function liveBlockMemberships<T extends RankableMembership>(
  memberships: readonly T[],
  nowMs: number,
): T[] {
  return rankMemberships(
    memberships.filter((m) => isReadable(m) && fiveHourInFlight(m, nowMs)),
    nowMs,
  );
}

// The ranked Popout's limit rows: the four most used, then one `+N more` row
// past four (#610's resolution). The shell sizes the window by it.
export const RANKED_POPOUT_TOP = 4;
export function rankedPopoutLimitRows(memberships: number): number {
  return Math.min(memberships, RANKED_POPOUT_TOP) + (memberships > RANKED_POPOUT_TOP ? 1 : 0);
}

// --- The Account filter's summary --------------------------------------------

// One tracked Account as the Account filter summarizes it: its label, and
// each of its Memberships by its Organization's label and whether the Scope
// holds it.
export type ScopeSummaryAccount = {
  label: string;
  memberships: readonly { label: string; selected: boolean }[];
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// What the Account filter's closed trigger says for a Scope (#637): "All
// accounts", one Account's label (with `· <Org>` or `· <N>` when it holds
// part of that Account), two whole Accounts by name, else a count. The
// Desktop's trigger and the Headless client's report header both say it
// (ADR-0118 §7). `unknownSelected`: the Scope holds an Account-not-known
// Membership, which names a selection of no tracked Account.
export function accountFilterSummary(
  accounts: readonly ScopeSummaryAccount[],
  isAll: boolean,
  unknownSelected: boolean,
): string {
  if (isAll) return "All accounts";
  const touched = accounts.filter((a) => a.memberships.some((m) => m.selected));
  const on = touched.flatMap((a) => a.memberships.filter((m) => m.selected));
  if (on.length === 0) return unknownSelected ? ACCOUNT_NOT_KNOWN : "No Memberships";
  const whole = touched.every((a) => a.memberships.every((m) => m.selected));
  if (on.length === 1) {
    const [m] = on;
    const [a] = touched;
    return a!.memberships.length === 1 ? a!.label : `${m!.label} · ${a!.label}`;
  }
  if (touched.length === 1)
    return whole ? touched[0]!.label : `${touched[0]!.label} · ${on.length}`;
  if (whole && touched.length === 2) return touched.map((a) => a.label).join(", ");
  return whole
    ? plural(touched.length, "Account", "Accounts")
    : plural(on.length, "Membership", "Memberships");
}
