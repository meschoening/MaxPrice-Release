import {
  limitWindowWords,
  membershipLimitState,
  membershipWindows,
  mostUsedWindow,
  organizationLabelParts,
  rankMemberships,
  resetIn,
  scopeMembershipReadings,
  type AccountEntry,
  type LiveWindowKind,
  type MembershipLimitState,
  type RankableMembership,
  type ScopeMembershipReading,
  type TrackedMembership,
  USE_BAD_PCT,
  usageTone,
  type WindowStateOf,
} from "@maxprice/shared";

// Live's limit area (#613 §5, #610's resolution, #637 D7, ADR-0142 §2), as
// pure data; `limit-area.tsx` draws it. It adapts to the Scope's Memberships:
//   - one: the head Membership's card (`kind: "single"`), under a `Limits ·`
//     eyebrow; null with no head, or none the roster lists, and undefined
//     while settings or the roster have not answered;
//   - two to four: a card each, most used first;
//   - five or more: one board, a row per Membership: the four most used,
//     then "‹N› more, none above ‹X›%" (or "‹H› at 90% or more"), "‹K› not
//     readable" when some of the rest are, and Show all in place.
// Ranked by the one most-used ordering (`rankMemberships`). Limits are never
// summed: every number is one Membership's own window.

export const LIMIT_CARDS_MAX = 4;

// A card's state (`membershipLimitState`); a stale card adds Reconnect.
export type LimitCardState = MembershipLimitState;

export type LimitWindowView = {
  kind: LiveWindowKind;
  label: string;
  // The percent used, or null for an idle window (no reading: "—").
  pct: number | null;
  // When it resets, for a live window.
  resetAtMs: number | null;
};

export type LimitCard = {
  key: string;
  // Its Account's key: Reconnect and Settings open that Account's Connect
  // (`settingsConnectPath`, #638's D3).
  accountKey: string;
  organizationLabel: string;
  // Shown beside the Organization while the area spans Accounts.
  accountLabel: string | null;
  // The Organization's plan word ("Ultra plan", "Team"), null when unknown
  // or when it is the label itself, an Organization the user never renamed.
  plan: string | null;
  home: boolean;
  state: LimitCardState;
  // The ring: the most used live window's percent, null with none.
  ringPct: number | null;
  tone: "bad" | "warn" | null;
  windows: LimitWindowView[];
  // The plan has no 5-hour limit (its Window state is `absent`, as on an
  // Ultra plan): no 5-hour meter, and the card says so.
  noFiveHour: boolean;
  // "Resets: 5-hour in 2h 14m · weekly in 3d 4h", null when nothing resets.
  resets: string | null;
  // When the stale reading was taken, for "last read … ago".
  lastReadAtMs: number | null;
};

export type LimitArea =
  | { kind: "single"; card: LimitCard | null | undefined }
  | { kind: "cards"; cards: LimitCard[] }
  | { kind: "board"; cards: LimitCard[]; top: number; rest: LimitRest };

// What the board's foot says of the Memberships past its top four.
export type LimitRest = {
  count: number;
  // Readable ones at 90% or more (a card's `bad` tone).
  hot: number;
  // The highest most-used percent among them, null when none reads one.
  maxPct: number | null;
  // No reading now: no key, or none readable.
  unreadable: number;
};

export type LimitAreaInput = {
  memberships: readonly TrackedMembership[];
  // The head Membership (`headMembership`): the one card's while the Scope's
  // set holds none, as on a one-Account install. Undefined while it cannot
  // be told yet.
  head: TrackedMembership | null | undefined;
  accounts: readonly AccountEntry[];
  organizationLabels: ReadonlyMap<string, string>;
  // Each Organization's plan word off the roster, by uuid.
  plans: ReadonlyMap<string, string | null>;
  // The roster's Window states (#384): an `absent` window has no limit, so
  // the card draws no meter for it.
  windowState?: WindowStateOf;
  nowMs: number;
};

// Every window of a Membership's reading, as Live's cards draw them (`membershipWindows`): 5-hour and weekly (no meter
// for one whose Organization has no such limit), then the model weekly one
// when held, labelled `weekly · <model>`. A window with no live reading is
// idle: `pct` null, drawn "—" on an empty bar.
export function windowsOf(
  reading: RankableMembership["reading"],
  organizationUuid: string,
  windowState: WindowStateOf | undefined,
  nowMs: number,
): LimitWindowView[] {
  return membershipWindows(reading, organizationUuid, windowState, nowMs).map(
    ({ kind, model, pct, resetAtMs }) => ({
      kind,
      label: limitWindowWords(kind, model),
      pct,
      resetAtMs,
    }),
  );
}

function resetsLine(windows: readonly LimitWindowView[], nowMs: number): string | null {
  const parts: string[] = [];
  for (const w of windows) {
    if (w.kind === "weeklyModel" || w.resetAtMs === null) continue;
    parts.push(`${w.label} in ${resetIn(w.resetAtMs - nowMs)}`);
  }
  return parts.length === 0 ? null : `Resets: ${parts.join(" · ")}`;
}

export function limitArea(input: LimitAreaInput): LimitArea {
  const { memberships, nowMs } = input;
  if (memberships.length <= 1) {
    const one = memberships[0] ?? input.head;
    if (one === null || one === undefined) return { kind: "single", card: one };
    const [reading] = scopeMembershipReadings([one], input.accounts, input.organizationLabels);
    return { kind: "single", card: reading === undefined ? null : cardOf(reading, input) };
  }
  const rows = scopeMembershipReadings(memberships, input.accounts, input.organizationLabels).map(
    (m) => ({ ...m, card: cardOf(m, input) }),
  );
  const cards = rankMemberships(rows, nowMs).map((r) => r.card);
  if (cards.length <= LIMIT_CARDS_MAX) return { kind: "cards", cards };
  return {
    kind: "board",
    cards,
    top: LIMIT_CARDS_MAX,
    rest: restOf(cards.slice(LIMIT_CARDS_MAX)),
  };
}

function cardOf(m: ScopeMembershipReading, input: LimitAreaInput): LimitCard {
  const { nowMs } = input;
  const state = membershipLimitState(m.connection, m.limits, m.reading);
  const numbers = state === "readable" || state === "stale";
  const windows = numbers ? windowsOf(m.reading, m.organizationUuid, input.windowState, nowMs) : [];
  const ringPct = numbers ? (mostUsedWindow(m.reading, nowMs)?.utilizationPct ?? null) : null;
  const plan = input.plans.get(m.organizationUuid) ?? null;
  return {
    key: m.token,
    accountKey: m.accountKey,
    organizationLabel: m.name.organization,
    accountLabel: m.name.account,
    plan: plan === organizationLabelParts(m.name.organization).label ? null : plan,
    home: m.home,
    state,
    ringPct,
    tone: state === "readable" ? usageTone(ringPct) : null,
    windows,
    noFiveHour: numbers && input.windowState?.(m.organizationUuid, "fiveHour") === "absent",
    resets: state === "readable" ? resetsLine(windows, nowMs) : null,
    lastReadAtMs:
      m.lastReadAt !== null && Number.isFinite(Date.parse(m.lastReadAt))
        ? Date.parse(m.lastReadAt)
        : null,
  };
}

// The Membership a one-Membership Scope's card reads: the tracked Membership
// of the head Organization (`useScope().quotaOrganization`), the Home
// membership when it is one of them. Null with no head, or while the roster
// lists no tracked Membership of it.
export function headMembership(
  tracked: readonly TrackedMembership[],
  headOrganization: string | undefined,
): TrackedMembership | null {
  if (headOrganization === undefined) return null;
  const of = tracked.filter((m) => m.organizationUuid === headOrganization);
  return of.find((m) => m.home) ?? of[0] ?? null;
}

export function restOf(rest: readonly LimitCard[]): LimitRest {
  const read = rest.map((c) => c.ringPct).filter((p): p is number => p !== null);
  return {
    count: rest.length,
    hot: rest.filter((c) => c.tone === "bad").length,
    maxPct: read.length > 0 ? Math.max(...read) : null,
    unreadable: rest.filter((c) => c.state === "not-connected" || c.state === "unreadable").length,
  };
}

// The board foot's first pill: "‹N› more, ‹H› at 90% or more" in the bad
// tone while any of the rest is hot, else "‹N› more, none above ‹X›%" in the
// good one; just "‹N› more", muted, when none of them reads a percent.
export function restPill(rest: LimitRest): { text: string; tone: "bad" | "good" | "mute" } {
  const more = `${rest.count} more`;
  if (rest.hot > 0) return { text: `${more}, ${rest.hot} at ${USE_BAD_PCT}% or more`, tone: "bad" };
  if (rest.maxPct === null) return { text: more, tone: "mute" };
  return { text: `${more}, none above ${Math.round(rest.maxPct)}%`, tone: "good" };
}

// A board row's reset: the most used live window's, "5-hour resets in 2h
// 14m"; null when no window is open.
export function mostUsedReset(card: LimitCard, nowMs: number): string | null {
  let top: { label: string; pct: number; resetAtMs: number } | null = null;
  for (const { label, pct, resetAtMs } of card.windows) {
    if (pct === null || resetAtMs === null) continue;
    if (top === null || pct > top.pct) top = { label, pct, resetAtMs };
  }
  return top === null ? null : `${top.label} resets in ${resetIn(top.resetAtMs - nowMs)}`;
}

// "last read 2h 14m ago", for a stale card's foot.
export function lastReadText(lastReadAtMs: number | null, nowMs: number): string | null {
  if (lastReadAtMs === null) return null;
  return `last read ${resetIn(nowMs - lastReadAtMs)} ago`;
}
