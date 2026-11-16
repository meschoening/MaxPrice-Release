import {
  formatMembershipToken,
  LIMIT_STATE_WORDS,
  membershipLimitState,
  mostUsedWindow,
  organizationLabelParts,
  rankMemberships,
  scopeMembershipReadings,
  type AccountEntry,
  type MembershipName,
  type MembershipTotal,
  type RankableMembership,
  type TrackedMembership,
  usageTone,
  windowTag,
  type WindowStateOf,
} from "@maxprice/shared";
import { resetIn, windowsOf, type LimitCardState, type LimitWindowView } from "./limit-area";

// The Blocks page's tab per Membership (#619 variant A, #638), as pure data;
// `pages/Blocks.tsx` draws it. It turns on only where Live's limit area does:
// the Scope's known Memberships while two or more tracked Accounts are
// (`useScopeMemberships`), so a one-Account install keeps today's page
// (`kind: "single"`) under every Organization scope chip choice.
//   - one Membership left by the Account filter: no tab row; the strip names
//     it and carries its Limits (`kind: "one"`);
//   - two or more: a tab each (`kind: "tabs"`), ranked by the one most-used
//     ordering (`rankMemberships`) among the Memberships that form Blocks in
//     the range, then those that form none, labelled "no Blocks"; at most
//     six tabs in the row, fewer when the row is too narrow to show each
//     name readably (`fittingTabCount`, #645), and an "‹N› more" menu holds
//     the rest in the same order.
// Every number is one Membership's own: its Blocks (`/api/blocks` with its
// `membership` token) and its own windows, never a sum.

// The most tabs drawn in the row; the rest go in the "‹N› more" menu.
export const BLOCKS_TABS_SHOWN = 6;

// A tab's badge: its most used live window ("82%", "61% wk" for a weekly
// one), greyed and marked when the key expired (ADR-0138 §8: a stale reading
// keeps its percent, labelled stale), else its state.
export type BlocksTabBadge =
  | {
      kind: "pct";
      text: string;
      pct: number;
      stale: boolean;
      tone: "bad" | "warn" | null;
    }
  | { kind: "state"; text: string };

export type BlocksTab = {
  token: string;
  organizationUuid: string;
  accountKey: string;
  // `Org · Account` while the Memberships span Accounts, else `Org` (Live's
  // limit-area rule): `name` in its two parts, `label` on one line.
  name: MembershipName;
  label: string;
  home: boolean;
  // Whether it has usage in the range, so forms Blocks there.
  formsBlocks: boolean;
  state: LimitCardState;
  badge: BlocksTabBadge;
  // The Limits section's meters (empty for a state with nothing to draw), and
  // its heading: "Limits · last known" for an expired key's last reading.
  windows: LimitWindowView[];
  limitsLabel: string;
  // What the Limits section says in place of meters, when it has none.
  limitsNote: string | null;
  // The Organization's plan word, null when the roster has none.
  plan: string | null;
};

export type BlocksTabsView =
  | { kind: "single" }
  | { kind: "one"; tab: BlocksTab }
  | {
      kind: "tabs";
      // In order; `MembershipTabs` splits them into the row's and the
      // menu's at the count its row fits (`splitTabs`, `fittingTabCount`).
      tabs: BlocksTab[];
      selected: BlocksTab;
    };

export type BlocksTabsInput = {
  memberships: readonly TrackedMembership[];
  accounts: readonly AccountEntry[];
  organizationLabels: ReadonlyMap<string, string>;
  // uuid → the roster's plan word.
  plans?: ReadonlyMap<string, string | null>;
  // `/api/membership-totals` for the range and Scope; undefined while it
  // loads, when every Membership is taken to form Blocks, so no tab reads
  // "no Blocks" before the answer says so.
  totals: readonly MembershipTotal[] | undefined;
  windowState?: WindowStateOf;
  selectedToken: string | null;
  nowMs: number;
};

// The Limits section's note in place of meters: the state's words
// (`LIMIT_STATE_WORDS`), capitalised; a missing key says how to mend it.
function limitsNoteOf(state: LimitCardState): string | null {
  if (state !== "not-connected" && state !== "unreadable" && state !== "no-limits") return null;
  const words = LIMIT_STATE_WORDS[state];
  const note = words[0]!.toUpperCase() + words.slice(1);
  return state === "not-connected" ? `${note} · connect this Account to read its limits` : note;
}

function badgeOf(
  formsBlocks: boolean,
  state: LimitCardState,
  reading: RankableMembership["reading"],
  nowMs: number,
): BlocksTabBadge {
  if (!formsBlocks) return { kind: "state", text: "no Blocks" };
  if (state === "not-connected" || state === "unreadable") {
    return { kind: "state", text: LIMIT_STATE_WORDS[state] };
  }
  const top = mostUsedWindow(reading, nowMs);
  if (top !== null) {
    const pct = Math.round(top.utilizationPct);
    const tag = windowTag(top.kind);
    const stale = state === "stale";
    return {
      kind: "pct",
      text: tag === null ? `${pct}%` : `${pct}% ${tag}`,
      pct,
      stale,
      tone: stale ? null : usageTone(top.utilizationPct),
    };
  }
  if (state === "readable") return { kind: "state", text: "idle" };
  return { kind: "state", text: LIMIT_STATE_WORDS[state] };
}

// The tokens of the Memberships with usage in the range.
function withUsage(totals: readonly MembershipTotal[]): Set<string> {
  const out = new Set<string>();
  for (const row of totals) {
    if (row.organizationUuid === null || row.totalTokens <= 0) continue;
    out.add(formatMembershipToken(row.organizationUuid, row.accountUuid));
  }
  return out;
}

export function blocksTabsView(input: BlocksTabsInput): BlocksTabsView {
  const { memberships, nowMs } = input;
  if (memberships.length === 0) return { kind: "single" };
  const used = input.totals === undefined ? null : withUsage(input.totals);

  const rows = scopeMembershipReadings(memberships, input.accounts, input.organizationLabels).map(
    (m) => {
      const state = membershipLimitState(m.connection, m.limits, m.reading);
      const formsBlocks = used === null || used.has(m.token);
      const numbers = state === "readable" || state === "stale";
      const tab: BlocksTab = {
        token: m.token,
        organizationUuid: m.organizationUuid,
        accountKey: m.accountKey,
        name: m.name,
        label: m.label,
        home: m.home,
        formsBlocks,
        state,
        badge: badgeOf(formsBlocks, state, m.reading, nowMs),
        windows: numbers ? windowsOf(m.reading, m.organizationUuid, input.windowState, nowMs) : [],
        limitsLabel: state === "stale" ? "Limits · last known" : "Limits",
        limitsNote: limitsNoteOf(state),
        plan: input.plans?.get(m.organizationUuid) ?? null,
      };
      return { ...m, tab };
    },
  );

  const ranked = rankMemberships(rows, nowMs).map((r) => r.tab);
  const tabs = [...ranked.filter((t) => t.formsBlocks), ...ranked.filter((t) => !t.formsBlocks)];
  const first = tabs[0];
  if (first === undefined) return { kind: "single" };
  if (tabs.length === 1) return { kind: "one", tab: first };

  const selected = tabs.find((t) => t.token === input.selectedToken) ?? first;
  return { kind: "tabs", tabs, selected };
}

// The row's tabs and the menu's for `count` places (one to six): the first in
// order, the rest in the menu in the same order. A tab picked from the menu
// takes the row's last place, so the selection is always a visible tab.
export function splitTabs<T>(
  items: readonly T[],
  selected: T,
  count: number,
): { shown: T[]; more: T[] } {
  const places = Math.max(1, Math.min(count, BLOCKS_TABS_SHOWN));
  const shown = items.slice(0, places);
  if (!shown.includes(selected)) shown[places - 1] = selected;
  const more = items.filter((t) => !shown.includes(t));
  return { shown, more };
}

// What the fit reads of the view: its tabs' tokens in order, and the selected
// one's. The view itself is rebuilt on every clock tick (`useBlocksTabs`
// takes `nowMs`), so `MembershipTabs`' fit keys on these instead; a tab's new
// name or badge text changes no token, and reaches the fit by resizing its
// measuring layer.
export function tabFitKey(view: Extract<BlocksTabsView, { kind: "tabs" }>): {
  tokens: string;
  selected: string;
} {
  return { tokens: view.tabs.map((tab) => tab.token).join("\n"), selected: view.selected.token };
}

// A tab name's readable minimum (#645): the Organization's first word, cut
// with "…" when it has more, then the Account half whole. Squeezed tabs keep
// at least this much of their name, so the Organization is still known by its
// first word and the Account, which tells two Memberships of one Organization
// apart (#619), is never cut. A fixed width cannot promise that: an Account
// labelled by its email alone is wider than any short constant, and a short
// one would waste room, so `MembershipTabs` measures this form per tab, in
// the tab's own font, as `TabMeasure.readableWidth`.
// An Organization label's collision suffix is kept whole after that word, as
// the Account is: it is all that tells two Organizations on one plan word
// apart (`organizationLabelParts`, #647).
export function readableName(name: MembershipName): MembershipName {
  const { label, suffix } = organizationLabelParts(name.organization);
  const words = label.trim().split(/\s+/);
  if (words.length < 2) return name;
  const first = `${words[0]}…`;
  return { ...name, organization: suffix === null ? first : `${first} · ${suffix}` };
}

// One tab's measured widths in px: drawn whole (`width`, its name at
// `nameWidth`, up to the tab's cap) and its name in readable form
// (`readableName`).
export type TabMeasure = { width: number; nameWidth: number; readableWidth: number };

// The tab row's measurements: its whole width, each tab in `tabs` order with
// the selected one's index, the tab list's padding and border (both sides),
// the gap between two tabs, and the "‹N› more" button with the gap before it.
export type TabRowMeasure = {
  available: number;
  tabs: readonly TabMeasure[];
  selectedIndex: number;
  listInset: number;
  gap: number;
  moreGap: number;
  moreWidth: number;
};

// The narrowest a tab may be drawn: its name cut to its readable form, never
// widened past its natural width when the name is shorter than that.
export function tabFloor(tab: TabMeasure): number {
  return tab.width - Math.max(0, tab.nameWidth - tab.readableWidth);
}

// The width the row needs for `count` places, each tab at its floor, with the
// "‹N› more" button only when some tab is left out of the row.
export function tabRowWidth(row: TabRowMeasure, count: number): number {
  const selected = row.tabs[row.selectedIndex] ?? row.tabs[0];
  if (selected === undefined) return 0;
  const { shown, more } = splitTabs(row.tabs, selected, count);
  const tabs = shown.reduce((sum, t) => sum + tabFloor(t), 0) + row.gap * (shown.length - 1);
  return row.listInset + tabs + (more.length > 0 ? row.moreGap + row.moreWidth : 0);
}

// How many tabs the row shows (#645): the most, up to six, that fit with
// every name readable (`tabRowWidth`); at least one, however narrow the row.
export function fittingTabCount(row: TabRowMeasure): number {
  for (let k = Math.min(row.tabs.length, BLOCKS_TABS_SHOWN); k > 1; k--) {
    if (tabRowWidth(row, k) <= row.available) return k;
  }
  return 1;
}

// The row's fit from its measurements (#645): how many places it shows, and
// the floor in px (`tabFloor`) each shown tab keeps, by token in `order`
// (the view's tabs). No floors when even that many tabs' floors are wider
// than the row: the one tab left then shrinks past its floor rather than
// scroll.
export function fitTabRow(
  order: readonly string[],
  row: TabRowMeasure,
): { count: number; floors: Map<string, number> } {
  const count = fittingTabCount(row);
  const floors = new Map<string, number>();
  if (tabRowWidth(row, count) <= row.available) {
    const items = order.map((token, i) => ({ token, measure: row.tabs[i]! }));
    // The selected item itself: `splitTabs` finds it in the row by identity.
    const { shown } = splitTabs(items, items[row.selectedIndex]!, count);
    for (const { token, measure } of shown) floors.set(token, tabFloor(measure));
  }
  return { count, floors };
}

// The strip's "active block" stat: its cost and when its window resets,
// "$4.20 · resets in 2h 14m"; the cost alone once its end has passed.
export function activeBlockText(costText: string, endTime: string, nowMs: number): string {
  const end = Date.parse(endTime);
  return end > nowMs ? `${costText} · resets in ${resetIn(end - nowMs)}` : costText;
}

// The strip's sub line: "Max plan · 12 blocks · Last 7 days", the plan word
// only when the roster has one. "blocks" whatever the count, as the page's
// "All blocks" strip says it.
export function membershipStripSub(plan: string | null, count: number, rangeLabel: string): string {
  const blocks = `${count} ${count === 1 ? "block" : "blocks"} · ${rangeLabel}`;
  return plan === null ? blocks : `${plan} · ${blocks}`;
}
