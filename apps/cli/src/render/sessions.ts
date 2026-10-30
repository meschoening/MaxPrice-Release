import {
  aggregateSessions,
  formatCalendarDay,
  formatCost,
  machineName,
  organizationCellLabels,
  sessionProjectName,
  type SessionRow,
  type SessionsAggregate,
} from "@maxprice/shared";
import { modelFamilies, paintModels } from "./models";
import {
  type Column,
  formatTokens,
  NAME_MIN,
  type Output,
  type ReportContext,
  renderTable,
  reportTitle,
  sortDescending,
  titleLine,
} from "./table";

// `maxprice sessions` as #445's Variant A table: one row per session, newest
// last activity first, as the Desktop's Sessions table sorts by default, and
// a Total row that is the Desktop's Filter totals for the same rows.

export type SessionsReport = ReportContext & {
  // The route's answer, in its order.
  rows: readonly SessionRow[];
};

// A body line is a session; the Total line carries only what it prints.
type Line = { session: SessionRow } | { total: SessionsAggregate };

// A column's text for a session, and for the Total line, blank by default:
// the Total never shows a body row's value.
function text(
  session: (s: SessionRow) => string,
  total: (t: SessionsAggregate) => string = () => "",
): (line: Line) => string {
  return (line) => ("session" in line ? session(line.session) : total(line.total));
}

// Descending by last activity, as the Desktop's default sort keys it.
// Sessions on the same day keep the route's order, as they do in the
// Desktop's table.
export function sortSessions(rows: readonly SessionRow[]): SessionRow[] {
  return sortDescending(rows, (row) => Date.parse(row.lastActivity) || 0);
}

// The Organization cell's one line: the Desktop's cell leads with the
// session's label (a partly owned session's owned half) and reads its
// owner-less half beneath, which a terminal row prints in parentheses.
function organizationCell(s: SessionRow, labels: ReadonlyMap<string, string>): string {
  const { label, ownerlessLabel } = organizationCellLabels(s, labels);
  if (label === null) return "—";
  return ownerlessLabel === undefined ? label : `${label} (owner-less part · ${ownerlessLabel})`;
}

// The Desktop's Filter totals for the Sessions strip. It reduces the route's
// answer in the route's order, not the sorted table, so this does too:
// float addition is not associative, and another order can move the cost.
export function sessionsTotal(rows: readonly SessionRow[]): SessionsAggregate {
  return aggregateSessions([...rows]);
}

// The columns, left to right. `drop` is the order they go when the terminal
// is too narrow: Input and Output together, then Models, Total tokens,
// Machine, Organization, Last activity. Session, Project and Cost always
// stay. `maxprice sessions --help` says the same.
export function sessionsColumns(
  report: Pick<ReportContext, "tz" | "now" | "isAll" | "labels" | "machines">,
): Column<Line>[] {
  const { tz, now, labels, machines } = report;
  const machine: Column<Line>[] =
    machines === null
      ? []
      : [{ header: "Machine", text: text((s) => machineName(s.machineId, machines)), drop: 3 }];
  const organization: Column<Line>[] = report.isAll
    ? [
        {
          header: "Organization",
          text: text((s) => organizationCell(s, labels)),
          min: NAME_MIN.organization,
          drop: 4,
        },
      ]
    : [];
  return [
    {
      header: "Session",
      text: text(
        (s) => s.sessionId.slice(0, 8),
        () => "Total",
      ),
    },
    { header: "Project", text: text(sessionProjectName), min: NAME_MIN.project },
    ...machine,
    ...organization,
    {
      header: "Models",
      text: text((s) => modelFamilies(s.modelsUsed)),
      drop: 1,
      paint: paintModels,
    },
    { header: "Input", text: text((s) => formatTokens(s.inputTokens)), align: "right", drop: 0 },
    { header: "Output", text: text((s) => formatTokens(s.outputTokens)), align: "right", drop: 0 },
    {
      header: "Total tokens",
      text: text(
        (s) => formatTokens(s.totalTokens),
        (t) => formatTokens(t.totalTokens),
      ),
      align: "right",
      drop: 2,
    },
    {
      header: "Cost",
      text: text(
        (s) => formatCost(s.totalCost),
        (t) => formatCost(t.totalCost),
      ),
      align: "right",
    },
    {
      header: "Last activity",
      text: text((s) => formatCalendarDay(s.lastActivity, tz, now)),
      align: "right",
      drop: 5,
    },
  ];
}

export function renderSessions(report: SessionsReport, out: Output): string {
  const title = reportTitle("Sessions", report);
  if (report.rows.length === 0) return `${titleLine(title, out)}\nNo sessions in this range.\n`;
  const rows: Line[] = sortSessions(report.rows).map((session) => ({ session }));
  const total: Line = { total: sessionsTotal(report.rows) };
  return renderTable({ title, columns: sessionsColumns(report), rows, total }, out);
}
