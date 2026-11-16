import {
  formatCalendarDay,
  formatCost,
  machineName,
  organizationCellLabels,
  sessionProjectName,
  type SessionRow,
} from "@maxprice/shared";
import { type AccountCells, accountsText } from "../account-column";
import { modelFamilies, paintModels } from "./models";
import type { ProjectsTotal } from "./projects";
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
// last activity first, as the retired Sessions table sorted by default, and a
// Total row that is the Desktop's Projects strip filter total for the same
// range and Scope (ADR-0140 §11's #642 note), not a sum of the rows above it.

export type SessionsReport = ReportContext & {
  // The route's answer, in its order.
  rows: readonly SessionRow[];
  // The Projects strip's filter total for the same request (`projectsTotal`
  // over `/api/projects` folded as the Desktop folds it).
  total: ProjectsTotal;
  // The Account column's labels by session id (`account-column.ts`); null
  // while the column is hidden.
  accounts: AccountCells | null;
};

// A body line is a session; the Total line carries only what it prints.
type Line = { session: SessionRow } | { total: ProjectsTotal };

// A column's text for a session, and for the Total line, blank by default:
// the Total never shows a body row's value.
function text(
  session: (s: SessionRow) => string,
  total: (t: ProjectsTotal) => string = () => "",
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

// The columns, left to right. `drop` is the order they go when the terminal
// is too narrow: Input and Output together, then Models, Total tokens,
// Machine, Organization, Account, Last activity. Session, Project and Cost
// always stay. `maxprice sessions --help` says the same.
export function sessionsColumns(
  report: Pick<
    SessionsReport,
    "tz" | "now" | "spansOrganizations" | "labels" | "machines" | "accounts"
  >,
): Column<Line>[] {
  const { tz, now, labels, machines, accounts } = report;
  const machine: Column<Line>[] =
    machines === null
      ? []
      : [{ header: "Machine", text: text((s) => machineName(s.machineId, machines)), drop: 3 }];
  const account: Column<Line>[] =
    accounts === null
      ? []
      : [
          {
            header: "Account",
            text: text((s) => accountsText(accounts, accounts.byKey.get(s.sessionId) ?? [])),
            min: NAME_MIN.account,
            drop: 5,
          },
        ];
  const organization: Column<Line>[] = report.spansOrganizations
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
    ...account,
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
        (t) => formatCost(t.costRange),
      ),
      align: "right",
    },
    {
      header: "Last activity",
      text: text((s) => formatCalendarDay(s.lastActivity, tz, now)),
      align: "right",
      drop: 6,
    },
  ];
}

export function renderSessions(report: SessionsReport, out: Output): string {
  const title = reportTitle("Sessions", report);
  if (report.rows.length === 0) return `${titleLine(title, out)}\nNo sessions in this range.\n`;
  const rows: Line[] = sortSessions(report.rows).map((session) => ({ session }));
  const total: Line = { total: report.total };
  return renderTable({ title, columns: sessionsColumns(report), rows, total }, out);
}
