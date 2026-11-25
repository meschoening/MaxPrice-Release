import { abbreviate } from "./figure-format";
import { corpusIsEmpty } from "./corpus-empty";
import type { CostMode } from "./cost-mode";
import type { DailyResponse } from "./daily";
import { isoFromYmd, ymdShift } from "./dates";
import type { StatusSnapshot } from "./live";
import {
  limitWindowWords,
  membershipLimitState,
  membershipWindows,
  mostUsedWindow,
  noFiveHourLimitWords,
  planWord,
  rankMemberships,
  resetIn,
  USE_BAD_PCT,
  usageTone,
  windowTag,
  type LiveWindowKind,
  type MembershipLimitState,
  type RankableMembership,
  type WindowStateOf,
} from "./membership-rank";
import {
  liveReadable,
  membershipNameText,
  RANKED_POPOUT_TOP,
  type MembershipName,
  type ScopeMembershipReading,
} from "./membership-readout";
import {
  organizationLabel,
  organizationLabelMap,
  organizationLabelParts,
  type OrganizationEntry,
} from "./organizations";
import type { ReportQueryInput } from "./report-url";
import type { ScopeQueryParams } from "./scope-params";
import {
  membershipReadability,
  type OrgLimitsAnswer,
  type UsageConnection,
  type UsageCurrent,
  type UsageOrganizations,
  type WindowStates,
} from "./usage-limits";

// Pure view-state for the tray popout mini-dashboard (map #168 M3; the T3
// "leaf" contract, ADR-0050). Extracted from the component so the state
// ladder — sidecar down / first launch / the dash with its head + rows — and
// every formatted string are pinnable without a DOM.
//
// The head is the most used window, whatever its kind (ADR-0142 §2, the
// prototype's Popout a on #693): its ring and percent, its reset, and the
// Membership it belongs to while there are several. It reads the Readout's
// rule (`liveReadable`), so the Popout's head and the tray's figure name the
// same window. With one Membership a row per window its plan reports
// follows; with several, #610's ranked rows (`rankedPopoutView`). Today
// closes the dash.

// The head's note where the plan has no 5-hour limit: `Ultra: no 5-hour
// limit`, the plan word without its "plan"; `no 5-hour limit` with no plan
// word.
export function noFiveHourLimitMeta(plan: string | null): string {
  const name = planWord(plan);
  return name === null ? "no 5-hour limit" : `${name}: no 5-hour limit`;
}

// The one-Membership Popout's 5-hour and weekly rows: one where the
// Organization has no weekly limit (`popoutView` draws no weekly row). The
// sidecar sends it as `/api/readout`'s `popoutLimitRows`, which the shell
// sizes the window by; its model row is `hasModelWindow`'s.
export function popoutLimitRowsOf(windowStates: WindowStates | null | undefined): number {
  return windowStates?.weekly === "absent" ? 1 : 2;
}

export type PopoutHead =
  | {
      // The most used window's ring.
      kind: "ring";
      // Its percent used, 0..1.
      ringFrac: number;
      // "64%" in the ring, "64% used" beside it.
      centerLabel: string;
      valueText: string;
      // The eyebrow names the Membership while the Popout names one
      // (`Most used · Personal`), else the window (`Most used · weekly`):
      // the 236px Popout has no room for both in its letter-spaced eyebrow.
      // The Membership: several Memberships, or one while more than one
      // Organization is tracked. Null otherwise.
      name: MembershipName | null;
      // The ranked Popout's: the Membership's full name, for the eyebrow's
      // title, where `name` is briefer (`popoutNames`, #746).
      title?: string;
      // The window: `5-hour`, `weekly` or `weekly · Fable`.
      window: string;
      // "resets in 2d 3h", led by the window ("weekly · resets in 2d 3h",
      // a model window by its model, "Fable · resets in 2d 3h") while the
      // eyebrow names the Membership in its place.
      metaText: string;
      // `Ultra: no 5-hour limit` where the Membership's plan has no 5-hour
      // limit, on a line of its own; null otherwise.
      note: string | null;
    }
  // A Readable membership with no window in flight: an empty ring with "—",
  // `Nothing used`. An idle window is a limit with nothing used (ADR-0142 §2).
  | { kind: "idle"; name: MembershipName | null; title?: string }
  // No Membership whose limits can be read: the inset `No limits read —
  // connect an Account in Settings.`
  | { kind: "none" };

// One limit row of the one-Membership Popout: a window its plan reports.
export type PopoutLimitRow = {
  kind: LiveWindowKind;
  // "5-hour limit", "Weekly limit", "Fable limit".
  label: string;
  // The percent used, rounded; null draws "—" at 0.55 opacity (ADR-0030: a
  // fresh reading only, never a stale percent).
  pct: number | null;
  // An idle window: the "—" keeps the meter's empty track (#320), so the row
  // keeps its bar without the bar reading as a measured 0%. Never while the
  // limits cannot be read.
  emptyTrack: boolean;
  // Words in the meter's place: `none on Ultra` for a plan with no 5-hour
  // limit (ADR-0142 §2).
  note: string | null;
  tone: "bad" | "warn" | null;
};

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
      // The 5-hour row, then weekly unless the Organization has no weekly
      // limit, then the Model-scoped one under its opt-in. The shell sizes
      // the window by the same rows (/api/readout's `popoutLimitRows` and
      // `hasModelWindow`).
      rows: PopoutLimitRow[];
      // The Today row's name: "Today", or "Today · all" under All
      // organizations, where its money is the day over every tracked
      // Organization rather than the head Organization's alone.
      todayLabel: string;
      todayText: string;
      // Today's total tokens (the daily row's totalTokens, every token type),
      // abbreviated and drawn to the right of the cost: "41.2M tok".
      todayTokensText: string;
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
  // The head Organization's reading (/api/usage/current), or the one
  // Membership's (`PopoutResponses.membership`), null with none.
  reading: RankableMembership["reading"];
  // The usage connection (/api/status), and the head Organization's last
  // Limits answer, null before any, or the one Membership's: together,
  // whether its limits can be read (`membershipReadability`).
  usageConnection: UsageConnection;
  limits: OrgLimitsAnswer | null;
  // What its last successful read said of each window (#384): an `absent`
  // window is a limit its plan does not have. Null before any.
  windowStates: WindowStates | null;
  // Its plan word ("Ultra plan"), off the roster; null when unknown.
  plan: string | null;
  showModelLimit: boolean;
  todayCost: number;
  todayTokens: number;
  now: number;
  // The head Organization's label while more than one Organization is
  // tracked, else null (`popoutQuotaTag` below).
  quotaTag: string | null;
  // The scope is All organizations: the Today row spans every tracked one.
  allOrganizations: boolean;
};

// The ladder every Popout shares: down, loading, first launch.
function ladder(
  input: Pick<PopoutViewInput, "anyError" | "engineStopped" | "settled" | "ready" | "hasData">,
): Extract<PopoutViewState, { kind: "loading" | "down" | "no-data" }> | null {
  if (input.anyError) {
    return { kind: "down", stopped: input.engineStopped && input.ready !== null };
  }
  // Settled means the fetches answered; `ready` means the answers are final.
  // Before `ready` every number below is a lower bound with nothing on screen
  // to say so, so the popout stays quiet rather than asserting either an
  // empty corpus or a $0.00 day.
  if (!input.settled || input.ready !== true) return { kind: "loading" };
  if (corpusIsEmpty(input.ready, input.hasData)) return { kind: "no-data" };
  return null;
}

// The head over the Memberships the Popout reads (ADR-0142 §2): the most
// used window of the most used Readable membership, as the Readout picks it;
// an idle head while some Readable membership holds none in flight; the
// inset while none is Readable.
function headOf<T extends RankableMembership>(
  memberships: readonly T[],
  now: number,
  nameOf: (m: T) => MembershipName | null,
  noFiveHour: (m: T) => string | null,
  titleOf: (m: T) => string | undefined = () => undefined,
): PopoutHead {
  const [top] = liveReadable(memberships, now);
  if (top === undefined) {
    const readable = memberships.find(
      (m) => membershipReadability(m.connection, m.limits) === "readable",
    );
    return readable === undefined
      ? { kind: "none" }
      : { kind: "idle", name: nameOf(readable), title: titleOf(readable) };
  }
  const window = mostUsedWindow(top.reading, now)!;
  const reading = top.reading?.[window.kind];
  const model = window.kind === "weeklyModel" ? (top.reading?.weeklyModel?.model ?? null) : null;
  const pct = Math.round(window.utilizationPct);
  const name = nameOf(top);
  const words = limitWindowWords(window.kind, model);
  const reset = reading == null ? null : `resets in ${resetIn(Date.parse(reading.resetAt) - now)}`;
  return {
    kind: "ring",
    ringFrac: Math.min(1, Math.max(0, window.utilizationPct / 100)),
    centerLabel: `${pct}%`,
    valueText: `${pct}% used`,
    name,
    title: titleOf(top),
    window: words,
    // A model window leads the meta by its model alone (`Fable · resets in
    // 23h 55m`): `weekly · Fable` beside a countdown overruns the 236px
    // Popout's head.
    metaText: [name === null ? null : (model ?? words), reset]
      .filter((x) => x !== null)
      .join(" · "),
    note: noFiveHour(top),
  };
}

function todayRow(input: Pick<PopoutViewInput, "todayCost" | "todayTokens" | "allOrganizations">): {
  todayLabel: string;
  todayText: string;
  todayTokensText: string;
} {
  return {
    todayLabel: input.allOrganizations ? "Today · all" : "Today",
    todayText: `$${input.todayCost.toFixed(2)}`,
    todayTokensText: `${abbreviate(input.todayTokens)} tok`,
  };
}

function rowLabel(kind: LiveWindowKind, model: string | null): string {
  if (kind === "fiveHour") return "5-hour limit";
  if (kind === "weekly") return "Weekly limit";
  // Labelled from the wire ("Fable limit"), never from an assumed family.
  return `${model ?? "Model"} limit`;
}

export function popoutView(input: PopoutViewInput): PopoutViewState {
  const settled = ladder(input);
  if (settled !== null) return settled;

  const { now, windowStates } = input;
  const membership: RankableMembership = {
    key: "head",
    label: input.quotaTag ?? "",
    connection: input.usageConnection,
    limits: input.limits,
    reading: input.reading,
  };
  const readable = membershipReadability(input.usageConnection, input.limits) === "readable";
  const noFiveHour = windowStates?.fiveHour === "absent";
  const name: MembershipName | null =
    input.quotaTag === null ? null : { organization: input.quotaTag, account: null };
  const head = headOf(
    [membership],
    now,
    () => name,
    () => (noFiveHour ? noFiveHourLimitMeta(input.plan) : null),
  );

  // A row per window the plan reports (`membershipWindows`): no weekly row
  // where the Organization has no weekly limit, and the 5-hour row's note
  // where it has no 5-hour one. A reading that cannot be read draws every
  // window "—", with no empty track (ADR-0030).
  const windows = membershipWindows(
    readable ? input.reading : null,
    "head",
    (_, window) => windowStates?.[window],
    now,
  ).filter((w) => w.kind !== "weeklyModel" || input.showModelLimit);
  const rows: PopoutLimitRow[] = windows.map((w) => {
    const pct = w.pct === null ? null : Math.round(w.pct);
    return {
      kind: w.kind,
      label: rowLabel(w.kind, w.model),
      pct,
      emptyTrack: readable && pct === null,
      note: null,
      tone: usageTone(pct),
    };
  });
  // The model row can be missing from an unreadable reading: it is held, as
  // the shell sizes for it (`hasModelWindow`), so it keeps its "—".
  const model = input.reading?.weeklyModel;
  if (!readable && model != null && input.showModelLimit) {
    rows.push({
      kind: "weeklyModel",
      label: rowLabel("weeklyModel", model.model),
      pct: null,
      emptyTrack: false,
      note: null,
      tone: null,
    });
  }
  if (noFiveHour) {
    rows.unshift({
      kind: "fiveHour",
      label: "5-hour limit",
      pct: null,
      emptyTrack: false,
      note: noFiveHourLimitWords(input.plan),
      tone: null,
    });
  }
  return { kind: "dash", head, rows, ...todayRow(input) };
}

// The popout's report window, as its hook (`use-popout-data.ts`) and the
// Headless client's `live` both request it, so the two ask the routes the
// same question. Its other fetches, usage current and the status, read the
// head Organization's entry (`buildUsageCurrentUrl`) and nothing; while the
// Scope's multi-Membership set holds one or more Memberships the Desktop's
// Popout reads `/api/accounts` in usage current's place (`popoutSource`).
export type PopoutQueryInputs = {
  // Today in the zone, dashless YYYYMMDD (`ymdShift`): the date the Today
  // row is picked by.
  todayYmd: string;
  // Today's row only — the Today tile's cost + tokens (ADR-0020's calendar
  // day), under the scope: every tracked Organization's day under All.
  today: ReportQueryInput;
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
  return {
    todayYmd: today,
    today: { since: today, until: today, mode, tz, ...scope },
  };
}

// The popout's answers: /api/status, the Today window's /api/daily and the
// head Organization's usage current, each undefined while its fetch is in
// flight, and the one Membership below.
//
// `membership`: the Scope's one Membership off `/api/accounts` while the
// multi-Membership set holds exactly one (#738), as Live's card reads it.
// Its reading, its Account's connection and its Limits answer stand in for
// the head Organization's, whose projection reads the Home Account's while
// its key works; the Window states are its Organization's. Absent while the
// set is empty, as on every one-Account install: `usage` and the status are
// then the reading.
export type PopoutResponses = {
  status: StatusSnapshot | undefined;
  today: DailyResponse | undefined;
  usage: UsageCurrent | undefined;
  membership?: Pick<
    ScopeMembershipReading,
    "organizationUuid" | "connection" | "limits" | "reading"
  >;
};

// What `popoutView` reads from those answers, each field as `PopoutViewInput`
// documents it.
export type PopoutReadings = Pick<
  PopoutViewInput,
  | "ready"
  | "hasData"
  | "reading"
  | "usageConnection"
  | "limits"
  | "windowStates"
  | "todayCost"
  | "todayTokens"
>;

// The answers as the view's readings. An answer still in flight reads as
// nothing: no status frame (null), no reading, and a $0.00 day, which the
// view keeps off screen until every answer has settled. The Today row is the
// one whose date is today, never merely the first.
export function popoutReadings(
  { status, today, usage, membership }: PopoutResponses,
  todayYmd: string,
  quotaOrganization: string | undefined,
): PopoutReadings {
  // The wire `date` is dashed YYYY-MM-DD; `todayYmd` is dashless.
  const todayRow = today?.daily.find((r) => r.date === isoFromYmd(todayYmd));
  const organization = headOrganizationStatus(
    status?.organizations,
    membership?.organizationUuid ?? quotaOrganization,
  );
  return {
    ready: status?.ready ?? null,
    hasData: status?.hasData ?? null,
    ...(membership === undefined
      ? {
          reading: usage?.sample ?? null,
          usageConnection: status?.usageConnection ?? "disconnected",
          limits: organization?.limits ?? null,
        }
      : {
          reading: membership.reading,
          usageConnection: membership.connection,
          limits: membership.limits,
        }),
    windowStates: organization?.windowStates ?? null,
    todayCost: todayRow?.totalCost ?? 0,
    todayTokens: todayRow?.totalTokens ?? 0,
  };
}

// The head eyebrow's tag: the head Organization's label, under every scope,
// while more than one Organization is tracked. The popout has no scope chip,
// so the eyebrow is the one place that says whose limit this is. The label is the
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

// The head Organization's entry in the status's Organization map: undefined
// with no Home, before a status frame, or before its first read. An own key
// only: a uuid is never a prototype name.
export function headOrganizationStatus(
  organizations: UsageOrganizations | undefined,
  quotaOrganization: string | undefined,
): UsageOrganizations[string] | undefined {
  if (organizations === undefined || quotaOrganization === undefined) return undefined;
  if (!Object.hasOwn(organizations, quotaOrganization)) return undefined;
  return organizations[quotaOrganization];
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
  // (the #610 prototype's `shortName`), briefer then (`popoutNames`, #746).
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
      // The most used window over the set, its eyebrow naming the
      // Membership (`PopoutHead`).
      head: PopoutHead;
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
  | "allOrganizations"
> & {
  memberships: readonly ScopeMembershipReading[];
  // Each Organization's plan word off the roster, and its Window states
  // (#384): the head's `Ultra: no 5-hour limit`.
  plans: ReadonlyMap<string, string | null>;
  windowState: WindowStateOf | undefined;
};

export function rankedPopoutView(input: RankedPopoutViewInput): RankedPopoutViewState {
  const settled = ladder(input);
  if (settled !== null) return settled;

  const { memberships, now } = input;
  const names = popoutNames(memberships);
  const nameOf = (m: ScopeMembershipReading): MembershipName => names.get(m.key)!;
  const rows = rankMemberships(memberships, now).map((m) => rankedRow(m, nameOf(m), now));
  const rest = rows.slice(RANKED_POPOUT_TOP);
  const head = headOf(
    memberships,
    now,
    nameOf,
    (m) =>
      input.windowState?.(m.organizationUuid, "fiveHour") === "absent"
        ? noFiveHourLimitMeta(input.plans.get(m.organizationUuid) ?? null)
        : null,
    (m) => m.label,
  );

  return {
    kind: "ranked",
    head,
    rows: rows.slice(0, RANKED_POPOUT_TOP),
    more: rest.length === 0 ? null : moreOf(rest),
    ...todayRow(input),
  };
}

// The Popout's names, briefer than the set's for its 236px (#746). A
// Membership is named by its Organization's label alone, unless another
// Membership of the set shares that label; then by the label's plan word or
// rename without its collision suffix, and its Account's. The Account half
// is what tells those two apart, so the suffix, which tells namesake
// Organizations apart, goes. An Account named by its email reads its local
// part where no other Account of the Organization reads that already, by its
// own local part or its label: two members of one Team share a domain. Two
// names that would still read alike are drawn whole (`readsAs`).
function popoutNames(memberships: readonly ScopeMembershipReading[]): Map<string, MembershipName> {
  const brief = new Map<string, MembershipName>(
    memberships.map((m) => {
      const sharers = memberships.filter(
        (x) => x.key !== m.key && x.organizationLabel === m.organizationLabel,
      );
      if (sharers.length === 0)
        return [m.key, { organization: m.organizationLabel, account: null }];
      const local = emailLocalPart(m.accountLabel);
      const key = local === null ? null : readsAs(local);
      const taken = (x: ScopeMembershipReading): boolean =>
        [x.accountLabel, emailLocalPart(x.accountLabel)].some(
          (a) => a !== null && readsAs(a) === key,
        );
      const account = local !== null && !sharers.some(taken) ? local : m.accountLabel;
      return [m.key, { organization: organizationLabelParts(m.organizationLabel).label, account }];
    }),
  );
  const texts = new Map<string, number>();
  for (const name of brief.values()) {
    const text = readsAs(membershipNameText(name));
    texts.set(text, (texts.get(text) ?? 0) + 1);
  }
  return new Map(
    memberships.map((m) => {
      const name = brief.get(m.key)!;
      const alike =
        name.account !== null && (texts.get(readsAs(membershipNameText(name))) ?? 0) > 1;
      return [m.key, alike ? { organization: m.organizationLabel, account: m.accountLabel } : name];
    }),
  );
}

// A name as the head's uppercase eyebrow reads it: canonically equal
// characters alike (the Kelvin sign is a K), then capitals (`Straße` reads
// STRASSE).
function readsAs(text: string): string {
  return text.normalize("NFC").toUpperCase();
}

// An email address's local part, null for any other label.
function emailLocalPart(label: string): string | null {
  return /^([^\s@]+)@[^\s@]+$/.exec(label)?.[1] ?? null;
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
