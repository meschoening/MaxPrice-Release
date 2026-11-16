import { terminalText } from "@maxprice/usage-core/terminal-text";
import {
  ACCOUNT_NOT_KNOWN,
  abbreviate,
  activeBlockOf,
  type BlockRow,
  type BlocksAggregate,
  blockKind,
  blockRemainingLabel,
  blockStartMs,
  formatCost,
  formatRange,
  formatWallDayMonth,
  type OrganizationEntry,
  type TimeDisplay,
} from "@maxprice/shared";
import { limitsText, type MembershipRow } from "./membership-limits";
import { style, type Style } from "./style";
import { type Column, formatTokens, type Output, renderTable, titleLine } from "./table";

// `maxprice blocks` as #445's Variant A table: one row per block, gaps
// included, in the Desktop's Blocks table's order, and a legend line for the
// window marks under it. No Total row (#445), so nothing here reduces the
// rows.

// A window's mark, the text form of the Desktop's provenance dot
// (ADR-0028/0029): none on an observed window, `~` on a heuristic one, `×`
// on an annulled one. A gap row carries none, as the Desktop draws no dot on
// a gap.
const MARK: Record<BlockRow["windowSource"], string> = {
  observed: "",
  heuristic: " ~",
  annulled: " ×",
};

export const BLOCKS_LEGEND = "~ heuristic window (no limits sample)   × annulled";

const ACTIVE = "● active";
const DASH = "—";

// A row as the table prints it: its window label and its time left need the
// display and the clock, which a column's `text` is not given.
type Line = BlockRow & { windowLabel: string; remaining: string };

// "Oct 18 9:36 PM – 2:36 AM": the day the window starts, then its range. A
// malformed start reads as 0 and a malformed end as the start, as the
// Desktop's own window label guards them.
function windowLabel(b: BlockRow, display: TimeDisplay): string {
  const s = blockStartMs(b);
  const e = Date.parse(b.endTime) || s;
  return `${formatWallDayMonth(s, display)} ${formatRange(s, e, display)}`;
}

function line(b: BlockRow, display: TimeDisplay, now: number): Line {
  return {
    ...b,
    windowLabel: windowLabel(b, display),
    remaining: blockKind(b) === "active" ? blockRemainingLabel(b, now) : "",
  };
}

function statusText(l: Line): string {
  const kind = blockKind(l);
  if (kind !== "active") return kind;
  return l.remaining === "" ? ACTIVE : `${ACTIVE} ${l.remaining}`;
}

function paintWindow(text: string, s: Style): string {
  return text.endsWith(MARK.heuristic) || text.endsWith(MARK.annulled)
    ? text.slice(0, -1) + s.dim(text.slice(-1))
    : text;
}

function paintStatus(text: string, s: Style): string {
  if (!text.startsWith(ACTIVE)) return s.dim(text);
  const remaining = text.slice(ACTIVE.length);
  return s.green(ACTIVE) + (remaining === "" ? "" : s.dim(remaining));
}

// The Desktop table's order: its pinned row, the active block, first, then
// its default sort, Window descending, which is each block's start instant
// (`blockStartMs`). The sort is stable, so blocks that start together keep
// the route's order.
export function sortBlocks(rows: readonly BlockRow[]): BlockRow[] {
  const active = activeBlockOf(rows);
  const rest = rows.filter((b) => b !== active).sort((a, b) => blockStartMs(b) - blockStartMs(a));
  return active === undefined ? rest : [active, ...rest];
}

// The columns, left to right. `drop` is the order they go when the terminal
// is too narrow: Total tokens, Burn rate, Projected, 5h limit. Window, Status
// and Cost always stay. `maxprice blocks --help` says the same.
export const BLOCKS_COLUMNS: readonly Column<Line>[] = [
  {
    header: "Window",
    text: (l) => l.windowLabel + (l.isGap ? "" : MARK[l.windowSource]),
    paint: paintWindow,
  },
  { header: "Status", text: statusText, paint: paintStatus },
  {
    header: "Burn rate",
    text: (l) => (l.burnRate === null ? DASH : `${abbreviate(l.burnRate.tokensPerMinute)}/min`),
    align: "right",
    drop: 1,
  },
  { header: "Total tokens", text: (l) => formatTokens(l.totalTokens), align: "right", drop: 0 },
  { header: "Cost", text: (l) => formatCost(l.costUSD), align: "right" },
  {
    header: "Projected",
    text: (l) => (l.projection === null ? DASH : formatCost(l.projection.totalCost)),
    align: "right",
    drop: 2,
  },
  {
    header: "5h limit",
    text: (l) => (l.fiveHourLimitPct === null ? DASH : `${Math.round(l.fiveHourLimitPct)}%`),
    align: "right",
    drop: 3,
  },
];

export type BlocksReport = {
  rows: readonly BlockRow[];
  rangeLabel: string;
  // Null while only one Organization is tracked.
  scopeLabel: string | null;
  // The Quota organization's label under All organizations (ADR-0108), else
  // null.
  quotaLabel: string | null;
  display: TimeDisplay;
  now: number;
  // The usage whose Account is not known outside these Blocks
  // (`unknownAccountUsage`, #635), else null.
  unknown: BlocksAggregate | null;
};

// #635: one line under the table naming the usage whose Account is not known,
// which forms its Organization's Unknown Membership and so is in none of
// these Blocks, as the Desktop's Blocks strip names it. The owner's rule: all
// usage still shows, and usage whose Account is unsure says so.
export function unknownAccountLine(unknown: BlocksAggregate, s: Style): string {
  const amount = `${formatCost(unknown.totalCost)} · ${formatTokens(unknown.totalTokens)} tokens`;
  return `${ACCOUNT_NOT_KNOWN}: ${amount}${s.dim(", outside these Blocks' limits")}\n`;
}

export function blocksTitle(
  report: Pick<BlocksReport, "rangeLabel" | "scopeLabel" | "quotaLabel">,
): string {
  return [
    "Blocks",
    report.rangeLabel,
    ...(report.scopeLabel === null ? [] : [report.scopeLabel]),
    ...(report.quotaLabel === null ? [] : [`quota: ${report.quotaLabel}`]),
  ].join(" · ");
}

export function renderBlocks(report: BlocksReport, out: Output): string {
  const title = blocksTitle(report);
  const unknown = report.unknown === null ? "" : unknownAccountLine(report.unknown, out.style);
  if (report.rows.length === 0) {
    return `${titleLine(title, out)}\nNo blocks in this range.\n${unknown}`;
  }
  const rows = sortBlocks(report.rows).map((b) => line(b, report.display, report.now));
  const table = renderTable({ title, columns: BLOCKS_COLUMNS, rows }, out);
  return `${table}${out.style.dim(BLOCKS_LEGEND)}\n${unknown}`;
}

// --- One section per Membership (ADR-0140 §3, #642) --------------------------
//
// While the Scope's Membership set holds two or more (`scopeMembershipSet`:
// two or more tracked Accounts, the Desktop's gate), `blocks` prints what
// the Desktop's Blocks page shows a tab at a time: under the report's title,
// a section per Membership that forms Blocks, most used first
// (`rankMemberships`, the tabs' order), each headed by the Membership's name
// (`Org · Account` while the set spans Accounts), its plan and its windows,
// over its own Blocks' table. The Memberships that form none share one line
// after them, in the same order, as the tabs label them "no Blocks". The
// usage whose Account is not known forms no tracked Membership, so has no
// section, and the line under the sections names it as the one-table
// report does.

export type MembershipBlocksSection = {
  row: MembershipRow;
  // Its Blocks, as /api/blocks formed them for it.
  blocks: readonly BlockRow[];
};

export type MembershipBlocksReport = {
  rangeLabel: string;
  scopeLabel: string | null;
  // Most used first: those that form Blocks, then those that form none.
  sections: readonly MembershipBlocksSection[];
  roster: readonly OrganizationEntry[];
  display: TimeDisplay;
  now: number;
  // The usage of every Membership whose Account is not known, in no section,
  // else null.
  unknown: BlocksAggregate | null;
};

export const NO_BLOCKS = "No Blocks";

const PLAIN = style(false);

// A section's header: `Third · Blair (Max plan): 5-hour 82% · weekly 61%`,
// the plan only when the roster has one, and the windows as the Blocks
// strip's Limits name them, with no reset.
export function sectionTitle(
  row: MembershipRow,
  roster: readonly OrganizationEntry[],
  display: TimeDisplay,
  now: number,
): string {
  const plan = roster.find((o) => o.uuid === row.organizationUuid)?.plan ?? null;
  const limits = limitsText(row, { roster, now, display, resets: false }, PLAIN);
  return `${row.label}${plan === null ? "" : ` (${plan})`}: ${limits}`;
}

export function renderMembershipBlocks(report: MembershipBlocksReport, out: Output): string {
  const { display, now, roster } = report;
  const title = blocksTitle({ ...report, quotaLabel: null });
  const forming = report.sections.filter((section) => section.blocks.length > 0);
  const none = report.sections.filter((section) => section.blocks.length === 0);
  const tables = forming.map((section) =>
    renderTable(
      {
        title: sectionTitle(section.row, roster, display, now),
        columns: BLOCKS_COLUMNS,
        rows: sortBlocks(section.blocks).map((b) => line(b, display, now)),
      },
      out,
    ),
  );
  const body = tables.length === 0 ? "" : `\n${tables.join("\n")}${out.style.dim(BLOCKS_LEGEND)}\n`;
  const noBlocks =
    none.length === 0
      ? ""
      : `${NO_BLOCKS}: ${none.map((section) => terminalText(section.row.label)).join(", ")}\n`;
  const unknown = report.unknown === null ? "" : unknownAccountLine(report.unknown, out.style);
  return `${titleLine(title, out)}\n${body}${noBlocks}${unknown}`;
}
