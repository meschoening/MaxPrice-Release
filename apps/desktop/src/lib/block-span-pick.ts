import {
  liveBlockMemberships,
  type MembershipName,
  type ScopeQueryParams,
  popoutHeadMembership,
  type ScopeMembershipReading,
} from "@maxprice/shared";

// Whose Active block the Live chart's Block span frames (#619 variant 1,
// #638), as pure data; `components/chart-span-note.tsx` draws the picker and
// `state/use-chart-source.ts` scopes the span's request by it.
//
// It turns on only where every #638 surface does: the Scope's known
// Memberships while two or more tracked Accounts are (`useScopeMemberships`),
// two or more of them. Otherwise `single`: a one-Account install keeps
// today's span, request and note under every Organization scope chip choice.
//   - `none`: no Membership of the Scope has a live Block (Readable, its
//     5-hour window in flight), so the span keeps today's request and its
//     "No active block" empty state;
//   - `picked`: the Memberships with a live Block, most used first
//     (`liveBlockMemberships`), each with its 5-hour percent, and the one the
//     span frames. That is the viewer's pick while it is still live, else the
//     Popout head's Membership (`popoutHeadMembership`, drawn live), else the
//     most used live one.

export type BlockSpanOption = {
  token: string;
  // The Membership's name in its two parts, and on one line.
  name: MembershipName;
  label: string;
  // The 5-hour window's utilization, rounded to a whole percent.
  pct: number;
};

export type BlockSpanPick =
  | { kind: "single" }
  | { kind: "none" }
  | { kind: "picked"; options: BlockSpanOption[]; selected: BlockSpanOption };

export function blockSpanPick(input: {
  memberships: readonly ScopeMembershipReading[];
  // The viewer's pick, a `membership` token; null before any.
  selectedToken: string | null;
  nowMs: number;
}): BlockSpanPick {
  const { memberships, selectedToken, nowMs } = input;
  if (memberships.length < 2) return { kind: "single" };
  const options = liveBlockMemberships(memberships, nowMs).map(
    (m): BlockSpanOption => ({
      token: m.token,
      name: m.name,
      label: m.label,
      pct: Math.round(m.reading?.fiveHour?.utilizationPct ?? 0),
    }),
  );
  const first = options[0];
  if (first === undefined) return { kind: "none" };
  const head = popoutHeadMembership(memberships, nowMs);
  const byToken = (token: string | null | undefined) =>
    token == null ? undefined : options.find((o) => o.token === token);
  const selected =
    byToken(selectedToken) ??
    (head !== null && !head.idle ? byToken(head.key) : undefined) ??
    first;
  return { kind: "picked", options, selected };
}

// The Membership the span's request names in place of the wide Scope: the
// pick's, on the Block span alone; undefined keeps today's request.
export function blockSpanMembership(span: string, pick: BlockSpanPick): string | undefined {
  return span === "block" && pick.kind === "picked" ? pick.selected.token : undefined;
}

// The Block span with several Memberships and none with a live Block draws
// the "No active block" empty state (#619: "When no Membership in the filter
// has an Active block, today's 'No active block' empty state stays"), never
// the wide Scope's head block, which no picker names.
export function blockSpanEmpty(span: string, pick: BlockSpanPick): boolean {
  return span === "block" && pick.kind === "none";
}

// The intraday request's Scope: the picked Membership's token alone (a
// Membership list names the Scope by itself, `scopeQueryParams`), else the
// wide Scope, the same object, so its key and URL stay today's.
export function intradayScopeFor(
  scope: ScopeQueryParams,
  blockToken: string | undefined,
): ScopeQueryParams {
  return blockToken === undefined ? scope : { memberships: [blockToken] };
}
