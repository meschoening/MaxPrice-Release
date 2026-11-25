import {
  abbreviate,
  type MembershipWindow,
  membershipWindows,
  noFiveHourLimitWords,
  type OrganizationEntry,
  type TimeDisplay,
  type UsageReading,
  type WindowStates,
} from "@maxprice/shared";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { limitsText, type MembershipRow, resetText, tonedPct } from "./membership-limits";
import type { Style } from "./style";
import type { Output } from "./table";

// `maxprice live`: the limits first, a line per window the plan reports, then
// Today (ADR-0142 §2, §7). A snapshot of what the tray popout reads, printed
// once: one Membership's limits as `Limits · <Organization> (<plan>)`, or,
// while the Scope holds two or more Memberships, a Limits line for each. A
// percent with no fresh reading prints `—` (ADR-0030), with no reset beside
// it. Nothing is estimated, and limits are never summed across Memberships.
// The panel is never truncated: its lines are short, and a pipe keeps them
// whole.

// The popout's first-launch copy.
export const NO_DATA = "No usage yet — MaxPrice is waiting for your first Claude Code session.";
export const LIMITS = "Limits";
const DASH = "—";

// The key column's least width: `5-hour limit` and two spaces. A longer key,
// a model's limit or a Membership's name, widens the whole column.
const KEY_MIN = 14;

type Line = { key: string; value: string };

// Today's cost and tokens, as the popout's Today row prints them.
export type LiveToday = { label: string; cost: number; tokens: number };

function todayLine(today: LiveToday, s: Style): Line {
  return {
    key: terminalText(today.label),
    value: `${s.bold(`$${today.cost.toFixed(2)}`)}  ${s.dim(`${abbreviate(today.tokens)} tok`)}`,
  };
}

// Lines under one key column.
function rowsAt(lines: readonly Line[], s: Style): string[] {
  const width = Math.max(KEY_MIN, ...lines.map((l) => Bun.stringWidth(l.key) + 2));
  return lines.map(
    (l) => `  ${s.dim(l.key)}${" ".repeat(width - Bun.stringWidth(l.key))}${l.value}`,
  );
}

// --- One Membership ------------------------------------------------------------

export type LiveReport = {
  // The corpus is scanned and empty: the popout's first-launch copy.
  noData: boolean;
  // The Head membership's Organization (`scope-head.ts`): its uuid, its label
  // over the whole roster, its plan word, and what its last read said of each
  // window. Null with no Home.
  organization: {
    uuid: string;
    label: string;
    plan: string | null;
    windowStates: WindowStates | null;
  } | null;
  // Its usage current's reading, null when it holds none. It names the
  // windows the plan reports, a Model-scoped one included.
  reading: UsageReading | null;
  // The limits connection is up. Down, no percent is fresh (ADR-0030): every
  // window prints —.
  connected: boolean;
  today: LiveToday;
  now: number;
  display: TimeDisplay;
};

// The header: `Limits · <Organization> (<plan>)`, the plan only where the
// label is not already the plan word, as Settings' account cards print it.
function limitsTitle(organization: LiveReport["organization"]): string {
  if (organization === null) return LIMITS;
  const { label, plan } = organization;
  const tag = plan === null || plan === label ? "" : ` (${terminalText(plan)})`;
  return `${LIMITS} · ${terminalText(label)}${tag}`;
}

function windowKey(w: MembershipWindow): string {
  if (w.kind === "fiveHour") return "5-hour limit";
  if (w.kind === "weekly") return "Weekly limit";
  // Labelled from the wire (`Fable limit`); a Model-scoped window always
  // names its model.
  return `${terminalText(w.model ?? "Model")} limit`;
}

export function renderLive(report: LiveReport, out: Output): string {
  if (report.noData) return `${NO_DATA}\n`;
  const s = out.style;
  const { organization, now, display } = report;
  const states = organization?.windowStates ?? null;
  const windows = membershipWindows(
    report.reading,
    organization?.uuid ?? "",
    (_, window) => states?.[window],
    now,
  );
  const lines: Line[] = windows.map((w) => ({
    key: windowKey(w),
    value:
      !report.connected || w.pct === null || w.resetAtMs === null
        ? s.dim(DASH)
        : `${tonedPct(Math.round(w.pct), true, s)}  ${s.dim(resetText(w.kind, w.resetAtMs, now, display))}`,
  }));
  // A plan with no 5-hour limit says so where the limit would be (ADR-0142 §2).
  if (organization?.windowStates?.fiveHour === "absent") {
    lines.unshift({ key: "5-hour limit", value: s.dim(noFiveHourLimitWords(organization.plan)) });
  }
  lines.push(todayLine(report.today, s));
  return [s.bold(limitsTitle(organization)), ...rowsAt(lines, s)].join("\n") + "\n";
}

// --- Several Memberships (ADR-0140 §3, #642) ----------------------------------
//
// While the Scope holds two or more of the Memberships the Desktop's ranked
// Popout lists, `Limits`, then a line per Membership in the Scope, most used
// first, every window with its reset, `no 5-hour limit` where its plan has
// none, an expired key's last reading marked `stale`, else its state's words;
// then Today, the Scope's day, named for the Scope.

export type RankedLiveReport = {
  noData: boolean;
  // Every Membership in the Scope, most used first.
  rows: readonly MembershipRow[];
  roster: readonly OrganizationEntry[];
  // The header's scope label, which Today's key carries.
  scopeLabel: string | null;
  today: Omit<LiveToday, "label">;
  now: number;
  display: TimeDisplay;
};

export function renderRankedLive(report: RankedLiveReport, out: Output): string {
  if (report.noData) return `${NO_DATA}\n`;
  const s = out.style;
  const options = { roster: report.roster, now: report.now, display: report.display };
  const limits: Line[] = report.rows.map((row) => ({
    key: terminalText(row.label),
    value: limitsText(row, options, s),
  }));
  const label = report.scopeLabel === null ? "Today" : `Today · ${report.scopeLabel}`;
  const listed = rowsAt([...limits, todayLine({ ...report.today, label }, s)], s);
  return [s.bold(LIMITS), ...listed.slice(0, -1), "", listed.at(-1)!].join("\n") + "\n";
}
