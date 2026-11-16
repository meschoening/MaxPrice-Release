import { abbreviate, activeBlockOf, minuteParts } from "./active-block";
import { activeBlockTileState, type ActiveBlockTileState } from "./active-block-tile-state";
import type { BlockRow, BlocksResponse } from "./blocks";
import { corpusIsEmpty } from "./corpus-empty";
import type { CostMode } from "./cost-mode";
import type { DailyResponse } from "./daily";
import { isoFromYmd, ymdShift } from "./dates";
import type { StatusSnapshot } from "./live";
import {
  membershipLimitState,
  mostUsedWindow,
  rankMemberships,
  USE_BAD_PCT,
  usageTone,
  windowTag,
  type MembershipLimitState,
} from "./membership-rank";
import {
  membershipNameText,
  popoutHeadMembership,
  RANKED_POPOUT_TOP,
  type MembershipName,
  type ScopeMembershipReading,
} from "./membership-readout";
import { organizationLabel, organizationLabelMap, type OrganizationEntry } from "./organizations";
import type { ReportQueryInput } from "./report-url";
import type { ScopeQueryParams } from "./scope-params";
import { formatWallClock, type TimeDisplay } from "./time-format";
import type {
  ModelScopedWindow,
  UsageCurrent,
  UsageOrganizations,
  UsageWindow,
  WindowState,
} from "./usage-limits";
import { usageRingState } from "./usage-ring";

// Pure view-state for the tray popout mini-dashboard (map #168 M3; the T3
// "leaf" contract, ADR-0050). Extracted
// from the component so the state ladder — sidecar down / first launch / the
// dash with its head + rows — and every formatted string are pinnable without
// a DOM. The quantities deliberately reuse the Live page's own derivations
// (`activeBlockTileState`, the Today row's totalCost + totalTokens), so the popout can only
// disagree with Live by failing to fetch, never by re-deriving. Shared with the
// Headless client (ADR-0118 §7), whose `live` panel prints this same view.

export type PopoutHead =
  | {
      kind: "ring";
      ringFrac: number;
      // The countdown alone at this size (no "to reset" sublabel); null → "—".
      centerLabel: string | null;
      // The block's cost-so-far — the 19px/800 value.
      costText: string;
      // The block's totalTokens beside the cost ("1.2M tok"), abbreviated like
      // the Today row's tokens and drawn as the same smaller --soft run.
      tokensText: string;
      // "3h 18m · resets 7:00 PM" (no "elapsed" — the ring's countdown already
      // carries the time story). Ellipsis-guarded by CSS, not truncated here.
      metaText: string;
      // The Quota organization's label after "Active block" (#291), set only
      // while more than one Organization is tracked: the popout has no scope
      // chip, so the eyebrow names whose block this is. null on a
      // one-Organization machine, and until the roster answers.
      eyebrowTag: string | null;
    }
  | { kind: "idle" }; // the dashed "No active block" inset

export type PopoutViewState =
  // Queries not settled, OR the engine's boot scan has not landed — actions
  // only. Both mean the same thing to a reader: nothing here is a verdict yet.
  | { kind: "loading" }
  // The sidecar is unreachable — the danger inset. `stopped` is the shell's
  // confirmed exit (ADR-0112 §4): the inset names the stop and the actions
  // gain a Relaunch door. Otherwise the process is alive but not answering,
  // and the copy stays "isn't responding".
  | { kind: "down"; stopped: boolean }
  | { kind: "no-data" } // scanned and genuinely empty — the orb inset, no rows
  | {
      kind: "dash";
      head: PopoutHead;
      // The 5-hour limit row: null renders the em-dash at 0.55 opacity (the
      // ADR-0030 rule — a real fresh reading only, never a stale percent).
      // Under the idle head that em-dash also keeps the meter's empty track
      // (#320). The head decides it, not the null, which an active block's
      // stale or unknown reading shares.
      limitPct: number | null;
      // The weekly limit row, the same freshness rule (a connected reading whose
      // reset is still ahead — the This-week tile's gate), else the em-dash.
      weeklyPct: number | null;
      // The Model-scoped weekly limit row. PRESENCE is a wire fact AND an
      // opt-in — drawn iff the sample carries one (so an account that stops
      // reporting it loses the row cleanly) and Settings' `showModelLimit` is
      // on (default off); the shell sizes the window from the same two bits
      // (/api/readout's hasModelWindow × settings.json). DIMMING is a freshness
      // fact — `pct` null under the ADR-0030 rule like the other two rows.
      // Labelled from the wire ("Fable limit"), never from an assumed family.
      modelRow: { label: string; pct: number | null } | null;
      // The Today row's name: "Today", or "Today · all" under All
      // organizations, where its money is the day over every tracked
      // Organization rather than the Quota organization's alone.
      todayLabel: string;
      todayText: string;
      // Today's total tokens (the daily row's totalTokens, every token type),
      // abbreviated and drawn to the right of the cost: "41.2M tok".
      todayTokensText: string;
      // The Quota organization has no 5-hour limit: its last successful read
      // found `five_hour: null`, an absent Window state (#384). Its idle row
      // is then the bare em-dash, with no #320 track: there is no limit for a
      // window to be idle in. An idle limit, or no state yet, is false.
      noFiveHourLimit: boolean;
    };

export type PopoutViewInput = {
  // Any popout query errored — getSidecarUrl failed or a fetch died. One bit:
  // the popout explains trouble with one danger inset, not per-row apologies.
  anyError: boolean;
  // The shell confirms the sidecar exited (`sidecarExited`, asked only while a
  // query is failing). It says why `anyError` holds; it never stands alone,
  // and it is a stop only once the engine has answered this popout (`ready`
  // non-null): a sidecar that never came up failed to start, and keeps the
  // unresponsive copy while the window's Boot gate card says so.
  engineStopped: boolean;
  // Every popout query has settled (data present).
  settled: boolean;
  // /api/status `ready` + `hasData` (ADR-0047), and they are read TOGETHER by
  // `corpusIsEmpty` — never `hasData` alone. `hasData: false` before `ready`
  // means "the scan has not finished", not "there is nothing to scan", and
  // reading it as the latter is what made the popout announce a first launch
  // on a machine with 650 MB of history (issue #183). `null` until the first
  // status frame arrives.
  ready: boolean | null;
  hasData: boolean | null;
  block: BlockRow | null;
  usageWindow: UsageWindow | null;
  weeklyWindow: UsageWindow | null;
  modelWindow: ModelScopedWindow | null;
  showModelLimit: boolean;
  usageConnected: boolean;
  todayCost: number;
  todayTokens: number;
  now: number;
  display: TimeDisplay;
  // The Quota organization's label while more than one Organization is
  // tracked, else null (`popoutQuotaTag` below).
  quotaTag: string | null;
  // The scope is All organizations: the Today row spans every tracked one.
  allOrganizations: boolean;
  // The Quota organization's 5-hour Window state, from /api/status's
  // Organization map; undefined before a successful read or with no Home.
  fiveHourState: WindowState | undefined;
};

export function popoutView(input: PopoutViewInput): PopoutViewState {
  if (input.anyError) {
    return { kind: "down", stopped: input.engineStopped && input.ready !== null };
  }
  // Settled means the four fetches answered; `ready` means the answers are
  // final. Before `ready` every number below is a lower bound with nothing on
  // screen to say so, so the popout stays quiet rather than asserting either
  // an empty corpus or a $0.00 day.
  if (!input.settled || input.ready !== true) return { kind: "loading" };
  if (corpusIsEmpty(input.ready, input.hasData)) return { kind: "no-data" };

  const tile = activeBlockTileState(
    input.block,
    input.usageWindow,
    input.usageConnected,
    input.now,
  );

  const todayLabel = input.allOrganizations ? "Today · all" : "Today";
  const todayText = `$${input.todayCost.toFixed(2)}`;
  const todayTokensText = `${abbreviate(input.todayTokens)} tok`;
  const noFiveHourLimit = input.fiveHourState === "absent";
  const weeklyPct = freshPct(input.weeklyWindow, input.usageConnected, input.now);
  const modelRow =
    input.modelWindow === null || !input.showModelLimit
      ? null
      : {
          label: `${input.modelWindow.model} limit`,
          pct: freshPct(input.modelWindow, input.usageConnected, input.now),
        };
  // The Live tile's "known zeroes" shell (connected, no block, no usable
  // sample) has no compact reading at this size — the popout's idle inset
  // covers it, exactly like the disconnected empty-inset case.
  const bare = tile.kind === "empty-inset" || (tile.active === null && tile.accountWindow === null);
  if (bare) {
    return {
      kind: "dash",
      head: { kind: "idle" },
      limitPct: tile.kind === "tile" ? tile.limitPct : null,
      weeklyPct,
      modelRow,
      todayLabel,
      todayText,
      todayTokensText,
      noFiveHourLimit,
    };
  }

  return {
    kind: "dash",
    head: ringHead(tile, input.now, input.display, input.quotaTag),
    limitPct: tile.limitPct,
    weeklyPct,
    modelRow,
    todayLabel,
    todayText,
    todayTokensText,
    noFiveHourLimit,
  };
}

// The ring head over a tile with a reading (an Active block, or a live 5-hour
// window): `popoutView`'s head, and the ranked view's live one.
function ringHead(
  tile: Extract<ActiveBlockTileState, { kind: "tile" }>,
  now: number,
  display: TimeDisplay,
  eyebrowTag: string | null,
): Extract<PopoutHead, { kind: "ring" }> {
  const active = tile.active;
  const startMs = active?.startMs ?? tile.accountWindow?.startMs ?? now;
  const endMs = active?.endMs ?? tile.accountWindow?.endMs ?? now;
  return {
    kind: "ring",
    ringFrac: tile.ringFrac,
    centerLabel: tile.ringCenterLabel,
    costText: active !== null ? `$${active.block.costUSD.toFixed(2)}` : "$0.00",
    tokensText: `${abbreviate(active?.block.totalTokens ?? 0)} tok`,
    metaText: `${formatElapsed(now - startMs)} · resets ${formatWallClock(endMs, display)}`,
    eyebrowTag,
  };
}

// A limit row's reading under the ADR-0030 rule the 5-hour row already obeys:
// a connected reading whose reset is still ahead, rounded like the tiles;
// anything else is null (the em-dash), never a stale percent.
function freshPct(window: UsageWindow | null, connected: boolean, now: number): number | null {
  const ring = usageRingState(connected ? window : null, now);
  return ring.kind === "limit" && window !== null ? Math.round(window.utilizationPct) : null;
}

// "3h 18m" / "42m" — time into the block: the ActiveBlockTile's meta, which
// adds the word "elapsed", and the popout's head, which drops it per the T3
// head contract.
export function formatElapsed(ms: number): string {
  const { days, hours, mins } = minuteParts(Math.max(0, ms));
  const h = days * 24 + hours;
  return h > 0 ? `${h}h ${mins}m` : `${mins}m`;
}

// The popout's two report windows, as its hook (`use-popout-data.ts`) and the
// Headless client's `live` both request them, so the two ask the routes the
// same questions. Its fourth fetch, usage current, reads the Quota
// organization's entry (`buildUsageCurrentUrl`), and the status none.
export type PopoutQueryInputs = {
  // Today in the zone, dashless YYYYMMDD (`ymdShift`): the date the Today
  // row is picked by.
  todayYmd: string;
  // Today's row only — the Today tile's cost + tokens (ADR-0020's calendar
  // day), under the scope: every tracked Organization's day under All.
  today: ReportQueryInput;
  // The active block can straddle midnight, so the window reaches back a day.
  // Blocks are cross-project by design and the popout carries no filter rail,
  // so the input carries only the scope (ADR-0017 untouched), which the
  // sidecar resolves to the Quota organization's Blocks (ADR-0108).
  blocks: ReportQueryInput;
};

export function popoutQueryInputs(options: {
  mode: CostMode;
  // The Settings timezone; undefined is the host zone, as `ymdShift` reads it.
  tz: string | undefined;
  // The routes' Scope params (`scopeQueryParams`, or the Headless client's
  // `scopeParams`): absent for the default Scope.
  scope: ScopeQueryParams;
  // Pins "today"; the wall clock by default.
  now?: number;
}): PopoutQueryInputs {
  const { mode, tz, scope, now } = options;
  const today = ymdShift(0, tz, now);
  const yesterday = ymdShift(-1, tz, now);
  return {
    todayYmd: today,
    today: { since: today, until: today, mode, tz, ...scope },
    blocks: { since: yesterday, until: today, mode, tz, ...scope },
  };
}

// The popout's four answers: /api/status, the Today window's /api/daily, the
// blocks window's /api/blocks and the Quota organization's usage current.
// Each is undefined while its fetch is in flight.
export type PopoutResponses = {
  status: StatusSnapshot | undefined;
  today: DailyResponse | undefined;
  blocks: BlocksResponse | undefined;
  usage: UsageCurrent | undefined;
};

// What `popoutView` reads from those answers, each field as `PopoutViewInput`
// documents it.
export type PopoutReadings = Pick<
  PopoutViewInput,
  | "ready"
  | "hasData"
  | "usageConnected"
  | "block"
  | "usageWindow"
  | "weeklyWindow"
  | "modelWindow"
  | "todayCost"
  | "todayTokens"
  | "fiveHourState"
>;

// The answers as the view's readings, one mapping for the popout and the
// Headless client's `live`, so the terminal's numbers are the popout's by
// construction. An answer still in flight reads as nothing: no status frame
// (null), no block, no window, and a $0.00 day, which the view keeps off
// screen until every answer has settled. The Today row is the one whose
// date is today, never merely the first; the block is the active one, never
// a gap flagged active.
export function popoutReadings(
  { status, today, blocks, usage }: PopoutResponses,
  todayYmd: string,
  quotaOrganization: string | undefined,
): PopoutReadings {
  // The wire `date` is dashed YYYY-MM-DD; `todayYmd` is dashless.
  const todayRow = today?.daily.find((r) => r.date === isoFromYmd(todayYmd));
  return {
    ready: status?.ready ?? null,
    hasData: status?.hasData ?? null,
    usageConnected: status?.usageConnection === "connected",
    block: activeBlockOf(blocks?.blocks ?? []) ?? null,
    usageWindow: usage?.sample?.fiveHour ?? null,
    weeklyWindow: usage?.sample?.weekly ?? null,
    modelWindow: usage?.sample?.weeklyModel ?? null,
    todayCost: todayRow?.totalCost ?? 0,
    todayTokens: todayRow?.totalTokens ?? 0,
    fiveHourState: quotaWindowState(status?.organizations, quotaOrganization),
  };
}

// The Active block eyebrow's tag: the Quota organization's label, under every
// scope, while more than one Organization is tracked. The popout has no scope
// chip, so unlike the main window's tile (which tags only under All) the
// eyebrow is the one place that says whose block this is. The label is the
// collision-suffixed one over the whole roster, with the shared fallback for a
// uuid the roster lacks. The roster is /api/organizations' `organizations`;
// one not yet loaded, or failed, tags nothing: flashing `Organization <first
// 8>` before the real label would be worse than an untagged eyebrow for a
// moment. Pure; shared with the Headless client's `live`.
export function popoutQuotaTag(
  multi: boolean,
  quotaOrganization: string | undefined,
  roster: ReadonlyArray<Pick<OrganizationEntry, "uuid" | "label">> | undefined,
): string | null {
  if (!multi || quotaOrganization === undefined || roster === undefined) return null;
  return organizationLabel(organizationLabelMap(roster), quotaOrganization);
}

// The Quota organization's 5-hour Window state from the status's Organization
// map (#384): undefined with no Home, before a status frame, or before its
// first successful read. An own key only: a uuid is never a prototype name.
// Pure; `popoutReadings` reads it, and its test.
export function quotaWindowState(
  organizations: UsageOrganizations | undefined,
  quotaOrganization: string | undefined,
): WindowState | undefined {
  if (organizations === undefined || quotaOrganization === undefined) return undefined;
  if (!Object.hasOwn(organizations, quotaOrganization)) return undefined;
  return organizations[quotaOrganization]!.windowStates?.fiveHour;
}

// --- The ranked Popout (#638) -------------------------------------------------
//
// The Popout over the Scope's multi-Membership set (`scopeMembershipSet`, two
// or more Memberships): #610's "head + ranked" (ADR-0136 §6's Popout
// paragraph, #622 item 6). A head, then the four most used Memberships a row
// each, then one `+N more` row past four, then Today. The shell sizes the
// window by the same count (`rankedPopoutLimitRows`). A one-Membership Scope
// never comes here: `popoutView` draws it, unchanged.

// A row's state: `membershipLimitState`'s, with a Readable membership that
// holds no live window split out as `idle` ("—" on an empty bar, #610: an
// idle 5-hour window is no reading).
export type RankedPopoutRowState = MembershipLimitState | "idle";

export type RankedPopoutRow = {
  key: string;
  // The Popout is 236px wide: the Organization's label, with the Account's
  // only where another Membership of the set shares that Organization label
  // (the #610 prototype's `shortName`). The row ellipsizes the Organization
  // part first, so the Account half that tells the two apart stays.
  name: MembershipName;
  // The full label (`scopeMembershipLabel`), for the row's title.
  label: string;
  state: RankedPopoutRowState;
  // The most used live window's percent, rounded: a readable one, or a stale
  // one's last known (drawn greyed). Null for every other state, and for a
  // stale reading whose windows have all reset.
  pct: number | null;
  // `wk` while that window is not the 5-hour one (#610, `windowTag`).
  windowTag: "wk" | null;
  // The meter's tone (`usageTone`), a Readable reading's only: a stale
  // percent is never coloured as a live one.
  tone: "bad" | "warn" | null;
};

// The head names its Membership in the eyebrow as a row does (`name`), its
// text in the ring head's `eyebrowTag`.
export type RankedPopoutHead =
  | (Extract<PopoutHead, { kind: "ring" }> & { eyebrowName: MembershipName })
  | Extract<PopoutHead, { kind: "idle" }>
  // No 5-hour window in flight while the readout shows money (#622 item 6):
  // the `Most used:` Membership drawn idle, an empty ring with "—", named.
  | { kind: "idle-ring"; eyebrowName: MembershipName };

export type RankedPopoutMore = {
  // "+3 more": the set's Memberships past the four rows.
  text: string;
  // "2 at 90% or more" while any of them is hot (Readable, at 90% or more),
  // else "none above 41%" over the highest percent any of them shows, else
  // null when none shows one.
  note: string | null;
  hot: boolean;
};

export type RankedPopoutViewState =
  | Extract<PopoutViewState, { kind: "loading" | "down" | "no-data" }>
  | {
      kind: "ranked";
      head: RankedPopoutHead;
      rows: RankedPopoutRow[];
      more: RankedPopoutMore | null;
      todayLabel: string;
      todayText: string;
      todayTokensText: string;
    };

export type RankedPopoutViewInput = Pick<
  PopoutViewInput,
  | "anyError"
  | "engineStopped"
  | "settled"
  | "ready"
  | "hasData"
  | "todayCost"
  | "todayTokens"
  | "now"
  | "display"
  | "allOrganizations"
> & {
  memberships: readonly ScopeMembershipReading[];
  // The Active block of the Membership whose Blocks were asked for
  // (`/api/blocks?membership=<token>`), keyed by that token. Read only when
  // the token is still the head's, so a head that moved between the fetch and
  // this render never wears another Membership's block. Null when none asked.
  headBlocks: { token: string; block: BlockRow | null } | null;
};

// The ranked Popout's Blocks request: the head Membership's own
// (`membership=<token>`, the Scope's params dropped, since a Membership list
// names the Scope alone) over the popout's blocks window. Null while the
// head is drawn idle or there is none: no Active block to read. The
// Desktop's ranked Popout and the Headless client's `live` ask it alike.
export function rankedHeadBlocksInput(
  blocks: ReportQueryInput,
  head: { key: string; idle: boolean } | null,
): ReportQueryInput | null {
  if (head === null || head.idle) return null;
  const { since, until, mode, tz } = blocks;
  return { since, until, mode, tz, memberships: [head.key] };
}

export function rankedPopoutView(input: RankedPopoutViewInput): RankedPopoutViewState {
  // The ladder is `popoutView`'s.
  if (input.anyError) {
    return { kind: "down", stopped: input.engineStopped && input.ready !== null };
  }
  if (!input.settled || input.ready !== true) return { kind: "loading" };
  if (corpusIsEmpty(input.ready, input.hasData)) return { kind: "no-data" };

  const { memberships, now } = input;
  const nameOf = (m: ScopeMembershipReading): MembershipName => ({
    organization: m.organizationLabel,
    account: memberships.some((x) => x.key !== m.key && x.organizationLabel === m.organizationLabel)
      ? m.accountLabel
      : null,
  });
  const rows = rankMemberships(memberships, now).map((m) => rankedRow(m, nameOf(m), now));
  const rest = rows.slice(RANKED_POPOUT_TOP);

  return {
    kind: "ranked",
    head: rankedHead(input, nameOf),
    rows: rows.slice(0, RANKED_POPOUT_TOP),
    more: rest.length === 0 ? null : moreOf(rest),
    todayLabel: input.allOrganizations ? "Today · all" : "Today",
    todayText: `$${input.todayCost.toFixed(2)}`,
    todayTokensText: `${abbreviate(input.todayTokens)} tok`,
  };
}

// The head (ADR-0136 §6's Popout paragraph, `popoutHeadMembership`): the
// head Membership's Active block, today's ring, its eyebrow naming it; the
// `Most used:` Membership drawn idle while no 5-hour window is in flight;
// today's idle inset with no Readable membership holding a live window.
function rankedHead(
  input: RankedPopoutViewInput,
  nameOf: (m: ScopeMembershipReading) => MembershipName,
): RankedPopoutHead {
  const pick = popoutHeadMembership(input.memberships, input.now);
  const head = pick === null ? undefined : input.memberships.find((m) => m.key === pick.key);
  if (pick === null || head === undefined) return { kind: "idle" };
  const name = nameOf(head);
  if (pick.idle) return { kind: "idle-ring", eyebrowName: name };
  const block = input.headBlocks?.token === head.token ? input.headBlocks.block : null;
  const tile = activeBlockTileState(
    block,
    head.reading?.fiveHour ?? null,
    head.connection === "connected",
    input.now,
  );
  // A live head is Readable with its 5-hour window in flight, so its tile
  // always has a ring; the guard only keeps the type honest.
  if (tile.kind === "empty-inset") return { kind: "idle-ring", eyebrowName: name };
  return {
    ...ringHead(tile, input.now, input.display, membershipNameText(name)),
    eyebrowName: name,
  };
}

function rankedRow(m: ScopeMembershipReading, name: MembershipName, now: number): RankedPopoutRow {
  const limitState = membershipLimitState(m.connection, m.limits, m.reading);
  const numbers = limitState === "readable" || limitState === "stale";
  const window = numbers ? mostUsedWindow(m.reading, now) : null;
  const state: RankedPopoutRowState =
    limitState === "readable" && window === null ? "idle" : limitState;
  return {
    key: m.key,
    name,
    label: m.label,
    state,
    pct: window === null ? null : Math.round(window.utilizationPct),
    windowTag: window === null ? null : windowTag(window.kind),
    tone: state === "readable" && window !== null ? usageTone(window.utilizationPct) : null,
  };
}

// The `+N more` row over the Memberships past the four: Live's board foot's
// rule (`restOf`, `restPill`) at the Popout's width.
function moreOf(rest: readonly RankedPopoutRow[]): RankedPopoutMore {
  const hot = rest.filter((r) => r.tone === "bad").length;
  const read = rest.map((r) => r.pct).filter((p): p is number => p !== null);
  const note =
    hot > 0
      ? `${hot} at ${USE_BAD_PCT}% or more`
      : read.length > 0
        ? `none above ${Math.max(...read)}%`
        : null;
  return { text: `+${rest.length} more`, note, hot: hot > 0 };
}
