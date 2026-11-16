import {
  ACCOUNT_NOT_KNOWN,
  accountLabel,
  apportionCents,
  byCodeUnit,
  displayedCents,
  formatCost,
  organizationLabel,
  scopeMembershipSet,
  scopeStateOf,
  type AccountEntry,
  type MembershipTotal,
  type ScopeSetting,
  type Settings,
  type TrackedMembership,
} from "@maxprice/shared";
import { resolvedScopeOf } from "./scope-view";

// The split bar under the Today and This week tiles (#613 §4, #637 D6), as
// pure data; `money-split.tsx` draws it. The rule counts the Scope's known
// Memberships (`scopeMembershipSet`): by Account
// while they span two or more Accounts, by Organization while they are one
// Account's two or more, and no bar for one (the default Scope, the Home
// membership with its Unknown usage, is one).
//
// The tile's number is never computed here: it stays its own source's exact
// total (ADR-0020/0031 parity). The bar's widths are the rows' exact values
// (`/api/membership-totals`); the amounts it prints are the tile's displayed
// cents apportioned by largest remainder (`apportionCents`), so they always
// sum to the tile to the cent, each within a cent of its exact value, which
// the segment's title carries unrounded.

export type SplitRule = "none" | "account" | "organization";

// The Memberships Live's split bars and limit area show, and their split
// (`useScopeMemberships`): the Scope's known Memberships while the Account
// filter shows (two or more tracked Accounts, `accountFilterVisible` over
// `/api/accounts`), else none. The shared rule (`scopeMembershipSet`), which
// the tray readout's sidecar half reads too, so the tray, the Popout and Live
// switch together (#638). A single-Account user sees no split bars and
// keeps the Active Block tile and This week's meter under every Organization
// scope chip choice, All organizations included (#613 §8, ADR-0106 §9's #637
// note): Live is exactly as it was before #637. Empty, with no split, until
// settings and `/api/accounts` answer.
export function liveScopeMemberships(
  accounts: readonly AccountEntry[] | undefined,
  settings: ScopeMembershipSettings | undefined,
  selection: ScopeSetting | null,
): { memberships: TrackedMembership[]; rule: SplitRule } {
  if (settings === undefined || accounts === undefined) {
    return { memberships: [], rule: "none" };
  }
  const memberships = scopeMembershipSet(
    accounts,
    scopeStateOf(settings),
    resolvedScopeOf(selection, settings),
  );
  return { memberships, rule: splitRule(memberships) };
}

type ScopeMembershipSettings = Pick<
  Settings,
  "homeMemberships" | "trackedOrganizations" | "trackedAccounts"
>;

export function splitRule(
  memberships: readonly Pick<TrackedMembership, "accountKey">[],
): SplitRule {
  if (memberships.length < 2) return "none";
  return new Set(memberships.map((m) => m.accountKey)).size >= 2 ? "account" : "organization";
}

// The legend names this many segments; the rest fold into one "more" segment
// (all of them shown when only one would fold).
export const SPLIT_TOP = 3;

// The words for rows that resolve to no Organization (only a machine with no
// Home holds them) under the Organization split.
export const ORGANIZATION_NOT_KNOWN = "Organization not known";

export type SplitSegment = {
  key: string;
  label: string;
  // The rows' exact dollars: the bar's width and the title's figure.
  exactUsd: number;
  // The apportioned cents the legend prints.
  cents: number;
  // A palette slot for a named segment (0-based, by rank), or the neutral kinds.
  tone: number | "unknown" | "more";
  // How many segments a "more" segment folds.
  folded?: number;
};

export type MoneySplit = {
  by: "account" | "organization";
  segments: SplitSegment[];
  // The tile's displayed cents, which the segments' `cents` sum to.
  totalCents: number;
};

export type MoneySplitInput = {
  rule: SplitRule;
  rows: readonly MembershipTotal[] | undefined;
  // The tile's own exact total, the authority for the displayed cents.
  totalUsd: number;
  accounts: readonly { key: string; label: string }[];
  organizationLabels: ReadonlyMap<string, string>;
};

// What a tile's split needs besides its own total.
export type SplitInput = Omit<MoneySplitInput, "totalUsd">;

type Group = { key: string; label: string; exactUsd: number; unknown: boolean };

export function moneySplit(input: MoneySplitInput): MoneySplit | null {
  const { rule, rows, totalUsd } = input;
  if (rule === "none" || rows === undefined) return null;
  const totalCents = displayedCents(totalUsd);
  if (totalCents <= 0) return null;

  const accountLabels = new Map(input.accounts.map((a) => [a.key, a.label]));
  const groups = new Map<string, Group>();
  for (const row of rows) {
    let key: string;
    let label: string;
    let unknown = false;
    if (rule === "account") {
      if (row.accountUuid === null) {
        key = "unknown";
        label = ACCOUNT_NOT_KNOWN;
        unknown = true;
      } else {
        key = `account:${row.accountUuid}`;
        label = accountLabels.get(row.accountUuid) ?? accountLabel(row.accountUuid, null);
      }
    } else if (row.organizationUuid === null) {
      key = "unknown";
      label = ORGANIZATION_NOT_KNOWN;
      unknown = true;
    } else {
      // One Account's Memberships: an Organization's Account-not-known usage
      // in the Scope is that Organization's money too.
      key = `organization:${row.organizationUuid}`;
      label = organizationLabel(input.organizationLabels, row.organizationUuid);
    }
    const group = groups.get(key) ?? { key, label, exactUsd: 0, unknown };
    group.exactUsd += row.costUSD;
    groups.set(key, group);
  }

  // Named segments by money, most first, ties by label then key; the unknown
  // one last, and only when it holds money.
  const named = [...groups.values()]
    .filter((g) => !g.unknown && g.exactUsd > 0)
    .sort(
      (a, b) =>
        (b.exactUsd === a.exactUsd ? 0 : b.exactUsd > a.exactUsd ? 1 : -1) ||
        byCodeUnit(a.label, b.label) ||
        byCodeUnit(a.key, b.key),
    );
  const unknown = groups.get("unknown");
  const ordered = [...named, ...(unknown !== undefined && unknown.exactUsd > 0 ? [unknown] : [])];
  if (ordered.length === 0) return null;
  const cents = apportionCents(
    totalCents,
    ordered.map((g) => g.exactUsd),
  );

  const shown = named.length <= SPLIT_TOP + 1 ? named.length : SPLIT_TOP;
  const segments: SplitSegment[] = named.slice(0, shown).map((g, i) => ({
    key: g.key,
    label: g.label,
    exactUsd: g.exactUsd,
    cents: cents[i]!,
    tone: i,
  }));
  if (shown < named.length) {
    const rest = named.slice(shown);
    segments.push({
      key: "more",
      label: `${rest.length} more`,
      exactUsd: rest.reduce((s, g) => s + g.exactUsd, 0),
      cents: cents.slice(shown, named.length).reduce((s, c) => s + c, 0),
      tone: "more",
      folded: rest.length,
    });
  }
  if (ordered.length > named.length) {
    segments.push({
      key: "unknown",
      label: unknown!.label,
      exactUsd: unknown!.exactUsd,
      cents: cents[named.length]!,
      tone: "unknown",
    });
  }
  return { by: rule, segments, totalCents };
}

// A segment's whole cents in the one money format (`formatCost`).
export function centsText(cents: number): string {
  return formatCost(cents / 100);
}

// The exact dollars, unrounded, for a segment's title.
export function exactText(usd: number): string {
  const text = String(usd);
  return `$${/e/i.test(text) ? usd.toFixed(12) : text}`;
}

export function segmentTitle(segment: SplitSegment): string {
  return `${segment.label}: ${centsText(segment.cents)} (exact ${exactText(segment.exactUsd)})`;
}
