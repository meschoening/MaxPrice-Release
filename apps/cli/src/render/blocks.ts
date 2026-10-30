import {
  abbreviate,
  activeBlockOf,
  type BlockRow,
  blockKind,
  blockRemainingLabel,
  blockStartMs,
  formatCost,
  formatRange,
  formatWallDayMonth,
  type TimeDisplay,
} from "@maxprice/shared";
import type { Style } from "./style";
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
};

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
  if (report.rows.length === 0) return `${titleLine(title, out)}\nNo blocks in this range.\n`;
  const rows = sortBlocks(report.rows).map((b) => line(b, report.display, report.now));
  const table = renderTable({ title, columns: BLOCKS_COLUMNS, rows }, out);
  return `${table}${out.style.dim(BLOCKS_LEGEND)}\n`;
}
