import { formatCost, type DailyRow } from "@maxprice/shared";
import { modelFamilies, paintModels } from "./models";
import {
  type Column,
  formatTokens,
  type Output,
  renderTable,
  reportTitle,
  titleLine,
} from "./table";

// `maxprice daily` as #445's Variant A table: one row per day, oldest first,
// and a Total row that sums the rows in that order. The response's `totals`
// is never read (ADR-0118 §7): the sidecar leaves it out when two or more
// projects are filtered.

export type DailyTotal = Pick<
  DailyRow,
  | "inputTokens"
  | "outputTokens"
  | "cacheCreationTokens"
  | "cacheReadTokens"
  | "totalTokens"
  | "totalCost"
>;

type Line = DailyTotal & { date: string; modelsUsed: readonly string[] };

// Ascending by date. The engine already answers in that order; sorting here
// keeps the report's order its own.
export function sortDaily(rows: readonly DailyRow[]): DailyRow[] {
  return [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Every field summed over `rows` in their order, from zero: the same
// reduction as the Desktop's This Week tile (`this-week-tile.tsx`), so the
// Total's cost is the Desktop's daily total to the last float bit.
export function dailyTotal(rows: readonly DailyRow[]): DailyTotal {
  const total: DailyTotal = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
  for (const r of rows) {
    total.inputTokens += r.inputTokens;
    total.outputTokens += r.outputTokens;
    total.cacheCreationTokens += r.cacheCreationTokens;
    total.cacheReadTokens += r.cacheReadTokens;
    total.totalTokens += r.totalTokens;
    total.totalCost += r.totalCost;
  }
  return total;
}

// The columns, left to right. `drop` is the order they go when the terminal
// is too narrow: Cache read, Cache create, Input, Models, Output, Total
// tokens. Date and Cost always stay. `maxprice daily --help` says the same.
export const DAILY_COLUMNS: readonly Column<Line>[] = [
  { header: "Date", text: (r) => r.date },
  { header: "Models", text: (r) => modelFamilies(r.modelsUsed), drop: 3, paint: paintModels },
  { header: "Input", text: (r) => formatTokens(r.inputTokens), align: "right", drop: 2 },
  { header: "Output", text: (r) => formatTokens(r.outputTokens), align: "right", drop: 4 },
  {
    header: "Cache create",
    text: (r) => formatTokens(r.cacheCreationTokens),
    align: "right",
    drop: 1,
  },
  { header: "Cache read", text: (r) => formatTokens(r.cacheReadTokens), align: "right", drop: 0 },
  { header: "Total tokens", text: (r) => formatTokens(r.totalTokens), align: "right", drop: 5 },
  { header: "Cost", text: (r) => formatCost(r.totalCost), align: "right" },
];

export type DailyReport = {
  rows: readonly DailyRow[];
  rangeLabel: string;
  // Null while only one Organization is tracked.
  scopeLabel: string | null;
};

export function renderDaily(report: DailyReport, out: Output): string {
  const title = reportTitle("Daily", report);
  if (report.rows.length === 0) return `${titleLine(title, out)}\nNo usage.\n`;
  const rows = sortDaily(report.rows);
  const total: Line = { ...dailyTotal(rows), date: "Total", modelsUsed: [] };
  return renderTable({ title, columns: DAILY_COLUMNS, rows, total }, out);
}
