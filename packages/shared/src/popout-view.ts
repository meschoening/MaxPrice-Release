import { abbreviate, activeBlockOf } from "./active-block";
import { activeBlockTileState } from "./active-block-tile-state";
import type { BlockRow, BlocksResponse } from "./blocks";
import { corpusIsEmpty } from "./corpus-empty";
import type { CostMode } from "./cost-mode";
import type { DailyResponse } from "./daily";
import { isoFromYmd, ymdShift } from "./dates";
import type { StatusSnapshot } from "./live";
import { organizationLabel, organizationLabelMap, type OrganizationEntry } from "./organizations";
import type { ReportQueryInput } from "./report-url";
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

  const active = tile.active;
  const startMs = active?.startMs ?? tile.accountWindow?.startMs ?? input.now;
  const endMs = active?.endMs ?? tile.accountWindow?.endMs ?? input.now;
  const head: PopoutHead = {
    kind: "ring",
    ringFrac: tile.ringFrac,
    centerLabel: tile.ringCenterLabel,
    costText: active !== null ? `$${active.block.costUSD.toFixed(2)}` : "$0.00",
    tokensText: `${abbreviate(active?.block.totalTokens ?? 0)} tok`,
    metaText: `${formatElapsed(input.now - startMs)} · resets ${formatWallClock(endMs, input.display)}`,
    eyebrowTag: input.quotaTag,
  };

  return {
    kind: "dash",
    head,
    limitPct: tile.limitPct,
    weeklyPct,
    modelRow,
    todayLabel,
    todayText,
    todayTokensText,
    noFiveHourLimit,
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
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
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
  // The routes' `organization` param for the scope (`scopeParams`).
  organization: string | undefined;
  // Pins "today"; the wall clock by default.
  now?: number;
}): PopoutQueryInputs {
  const { mode, tz, organization, now } = options;
  const today = ymdShift(0, tz, now);
  const yesterday = ymdShift(-1, tz, now);
  return {
    todayYmd: today,
    today: { since: today, until: today, mode, tz, organization },
    blocks: { since: yesterday, until: today, mode, tz, organization },
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
