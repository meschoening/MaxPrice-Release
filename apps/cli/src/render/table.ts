import type { HubMachine } from "@maxprice/shared";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import type { Env } from "../paths";
import { colorEnabled, style, type Style } from "./style";

// The one box-table engine (#445 Variant A): every report's table is a header
// line, `<Report> · <range label>[ · <scope label>]`, then a Unicode box
// table with bold cyan column headers and, when the report has one, a bold
// yellow Total row under a rule.
//
// Fitting a terminal: a table wider than the terminal first truncates its
// name columns with `…`, the widest first, down to each one's minimum; only
// once every one is at its minimum does it drop a column, in the report's
// own drop order, and then fit again. Columns sharing a drop rank drop in
// the same step, as the sessions report's Input and Output do. So no row
// wraps. A table with nothing left to drop is printed at its minimum widths,
// wider than a terminal too narrow even for that. Piped output is never
// truncated or dropped.

// The truncatable name columns' minimum widths (#445).
export const NAME_MIN = { project: 14, organization: 13 } as const;

export type Column<R> = {
  header: string;
  // The cell's plain text. Colour comes after fitting, from `paint`.
  text: (row: R) => string;
  align?: "left" | "right";
  // A name column, truncated down to `min` before any column drops.
  min?: number;
  // The drop rank: the lowest drops first, and columns sharing it drop
  // together. Absent, the column never drops.
  drop?: number;
  // A body cell's colour, given its fitted text. The Total row is always
  // bold yellow instead.
  paint?: (text: string, style: Style) => string;
};

export type Table<R> = {
  title: string;
  columns: readonly Column<R>[];
  rows: readonly R[];
  total?: R;
};

// What a table report renders with besides its rows, from the resolved
// request (`reportContext`): the header's labels, the zone and instant Last
// activity reads its day in, and what decides the optional columns and
// names their cells.
export type ReportContext = {
  rangeLabel: string;
  // Null while only one Organization is tracked.
  scopeLabel: string | null;
  // The Timezone Last activity's day is read in, and the instant that decides
  // today.
  tz: string | undefined;
  now: number;
  // All organizations: the Organization (Organizations) column shows.
  isAll: boolean;
  // The roster's Organization labels by uuid.
  labels: ReadonlyMap<string, string>;
  // The Machine directory while the machine axis is on, which shows the
  // Machine (Machines) column; null while it is off.
  machines: HubMachine[] | null;
};

export type Output = {
  // The terminal's width, or null when stdout is not a terminal.
  width: number | null;
  style: Style;
};

// What a command renders for: the terminal's width and the colour rule when
// stdout is a terminal, and neither when it is piped.
export function terminalOutput(stream: { isTTY?: boolean; columns?: number }, env: Env): Output {
  const tty = stream.isTTY === true;
  return {
    width: tty ? stream.columns || 80 : null,
    style: style(colorEnabled(stream, env)),
  };
}

const TOKENS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

// A token count in full, en-US grouped: `6,289,349`.
export function formatTokens(n: number): string {
  return TOKENS.format(n);
}

// `items` descending by `key`, computed once per item. The decorate-sort is
// stable, so equal keys keep their given order, as the Desktop's table sorts
// (`flattenTreeRows`, `apps/desktop/src/lib/table-tree.ts`).
export function sortDescending<T>(items: readonly T[], key: (item: T) => number): T[] {
  return items
    .map((item) => ({ item, key: key(item) }))
    .sort((a, b) => b.key - a.key)
    .map((d) => d.item);
}

// Terminal cells, not UTF-16 units: a wide character takes two.
function width(text: string): number {
  return Bun.stringWidth(text);
}

// `text` cut to at most `max` cells, ending in `…` when anything was cut.
export function truncate(text: string, max: number): string {
  if (width(text) <= max) return text;
  if (max <= 0) return "";
  let out = "";
  let used = 0;
  for (const char of text) {
    const w = width(char);
    if (used + w > max - 1) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

// A table row's cells in its columns' order: each column's plain text, plus
// its header as the first row.
type Grid = string[][];

// Each `│ cell │` cell is its width plus a space either side, plus one
// border per column and the closing one.
function tableWidth(widths: readonly number[]): number {
  return widths.reduce((sum, w) => sum + w + 3, 1);
}

type Fit<R> = { columns: Column<R>[]; widths: number[] };

function fit<R>(columns: readonly Column<R>[], grid: Grid, limit: number | null): Fit<R> {
  let live = columns.map((_, i) => i);
  for (;;) {
    const natural = live.map((i) => Math.max(...grid.map((cells) => width(cells[i]!))));
    const minimum = live.map((i, k) => Math.min(natural[k]!, columns[i]!.min ?? natural[k]!));
    const kept = live.map((i) => columns[i]!);
    if (limit === null || tableWidth(natural) <= limit) return { columns: kept, widths: natural };
    if (tableWidth(minimum) <= limit) {
      // Take one cell at a time from the widest name column still above its
      // minimum, so two long names share the loss.
      const widths = [...natural];
      while (tableWidth(widths) > limit) {
        let widest = -1;
        for (let k = 0; k < widths.length; k++) {
          if (widths[k]! > minimum[k]! && (widest < 0 || widths[k]! > widths[widest]!)) widest = k;
        }
        widths[widest]! -= 1;
      }
      return { columns: kept, widths };
    }
    const ranks = kept.flatMap((c) => (c.drop === undefined ? [] : [c.drop]));
    if (ranks.length === 0) return { columns: kept, widths: minimum };
    const lowest = Math.min(...ranks);
    live = live.filter((i) => columns[i]!.drop !== lowest);
  }
}

function pad(painted: string, plain: string, w: number, align: "left" | "right"): string {
  const space = " ".repeat(Math.max(0, w - width(plain)));
  return align === "right" ? space + painted : painted + space;
}

// A report's title, `<Report> · <range label>[ · <scope label>]`: the scope
// label is null while only one Organization is tracked.
export function reportTitle(
  name: string,
  labels: Pick<ReportContext, "rangeLabel" | "scopeLabel">,
): string {
  const scope = labels.scopeLabel === null ? [] : [labels.scopeLabel];
  return [name, labels.rangeLabel, ...scope].join(" · ");
}

// A report's header line, inert and, on a terminal, cut to its width.
export function titleLine(title: string, out: Output): string {
  const text = terminalText(title);
  return out.width === null ? text : truncate(text, out.width);
}

export function renderTable<R>(table: Table<R>, out: Output): string {
  const { style: s } = out;
  const all = table.total === undefined ? table.rows : [...table.rows, table.total];
  const grid: Grid = [
    table.columns.map((c) => terminalText(c.header)),
    ...all.map((row) => table.columns.map((c) => terminalText(c.text(row)))),
  ];
  const { columns, widths } = fit(table.columns, grid, out.width);
  const index = columns.map((c) => table.columns.indexOf(c));

  const rule = (left: string, mid: string, right: string) =>
    s.dim(left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right);
  const line = (cells: string[]) => s.dim("│") + cells.join(s.dim("│")) + s.dim("│");
  const cell = (row: number, k: number, paint: (text: string) => string) => {
    const column = columns[k]!;
    const text = truncate(grid[row]![index[k]!]!, widths[k]!);
    return ` ${pad(paint(text), text, widths[k]!, column.align ?? "left")} `;
  };

  const header = line(columns.map((_, k) => cell(0, k, (text) => s.bold(s.cyan(text)))));
  const body = table.rows.map((_, r) =>
    line(columns.map((c, k) => cell(r + 1, k, (text) => (c.paint ? c.paint(text, s) : text)))),
  );
  const lines = [
    titleLine(table.title, out),
    rule("┌", "┬", "┐"),
    header,
    rule("├", "┼", "┤"),
    ...body,
  ];
  if (table.total !== undefined) {
    const row = all.length;
    lines.push(
      rule("├", "┼", "┤"),
      line(columns.map((_, k) => cell(row, k, (text) => s.bold(s.yellow(text))))),
    );
  }
  lines.push(rule("└", "┴", "┘"));
  return lines.join("\n") + "\n";
}
