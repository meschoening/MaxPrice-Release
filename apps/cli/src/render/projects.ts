import {
  aggregateProjectsRange,
  deriveProjectName,
  deriveProjectPath,
  foldMachineIdList,
  formatCalendarDay,
  formatCost,
  groupChildren,
  hasDisclosableChildren,
  type HubMachine,
  machineName,
  type ProjectGroup,
  projectOrganizationsCell,
  type ProjectRow,
  type ProjectsRangeAggregate,
  topModelFamily,
} from "@maxprice/shared";
import { count } from "./count";
import { paintFamily } from "./models";
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

// `maxprice projects` as #445's Variant A table: one row per Project over the
// range (ADR-0068), by cost, as the Desktop's Projects table sorts by
// default, each folded from several directories followed by those
// directories, and a Total row that is the Desktop's Filter totals for the
// same projects.

export type ProjectsReport = ReportContext & {
  // `foldProjectRows` over the route's answer, in fold order.
  groups: readonly ProjectGroup[];
};

// A project, or one of the directories it was folded from.
export type ProjectLine = { project: ProjectRow; child: boolean };

export type ProjectsTotal = ProjectsRangeAggregate & { totalTokens: number };

// A body line is a project or a directory; the Total line carries only what
// it prints.
type Line = ProjectLine | { total: ProjectsTotal };

// The table's lines as the Desktop's tree lays them out with every project
// disclosed (`flattenTreeRows`): projects by cost, ties in fold order, and
// after each project folded from more than one directory, those directories,
// by the Desktop's own rule (`hasDisclosableChildren`).
// Its checkouts' own directories lead in the fold's order and never sort; its
// worktrees follow, by cost. A project of one directory has no child line.
export function projectLines(groups: readonly ProjectGroup[]): ProjectLine[] {
  return sortDescending(groups, (g) => g.row.costRange).flatMap((g) => {
    const top = { project: g.row, child: false };
    const members = groupChildren(g);
    if (!hasDisclosableChildren(members)) return [top];
    const { lead, rest } = members;
    const children = [...lead, ...sortDescending(rest, (p) => p.costRange)];
    return [top, ...children.map((project) => ({ project, child: true }))];
  });
}

// The Desktop's Filter totals for the Projects strip, plus the total tokens
// the table adds. It reduces the folded projects in fold order, not the
// cost-sorted table and never the directories beneath them, so this does
// too: float addition is not associative, and another order can move the
// cost.
export function projectsTotal(groups: readonly ProjectGroup[]): ProjectsTotal {
  const rows = groups.map((g) => g.row);
  let totalTokens = 0;
  for (const p of rows) totalTokens += p.totalTokens;
  return { ...aggregateProjectsRange(rows), totalTokens };
}

// A column's text for a project line, and for the Total line, blank by
// default: the Total never shows a body row's value.
function text(
  project: (p: ProjectRow, child: boolean) => string,
  total: (t: ProjectsTotal) => string = () => "",
): (line: Line) => string {
  return (line) => ("total" in line ? total(line.total) : project(line.project, line.child));
}

// A project's machines folded through their aliases (ADR-0041), as text:
// the Desktop draws machine chips here, and the terminal prints none as an
// em dash, one machine by name, and several as a count.
function machinesCell(ids: string[], machines: HubMachine[]): string {
  const folded = foldMachineIdList(ids, machines);
  const [only] = folded;
  if (only === undefined) return "—";
  return folded.length === 1 ? machineName(only, machines) : `${folded.length} machines`;
}

// The columns, left to right. `drop` is the order they go when the terminal
// is too narrow: Path, Top model, Sessions, Machines, Organizations, Total
// tokens, Last activity. Project and Cost always stay. `maxprice projects
// --help` says the same.
export function projectsColumns(
  report: Pick<ReportContext, "tz" | "now" | "isAll" | "labels" | "machines">,
): Column<Line>[] {
  const { tz, now, labels, machines } = report;
  const machineColumn: Column<Line>[] =
    machines === null
      ? []
      : [{ header: "Machines", text: text((p) => machinesCell(p.machines, machines)), drop: 3 }];
  const organizations: Column<Line>[] = report.isAll
    ? [
        {
          header: "Organizations",
          text: text((p) => projectOrganizationsCell(p.organizations, labels)?.text ?? "—"),
          min: NAME_MIN.organization,
          drop: 4,
        },
      ]
    : [];
  return [
    {
      header: "Project",
      text: text(
        (p, child) => (child ? `  ↳ ${deriveProjectName(p.path)}` : deriveProjectName(p.path)),
        () => "Total",
      ),
      min: NAME_MIN.project,
    },
    // Not a name column: it drops whole rather than truncating.
    {
      header: "Path",
      text: text((p) => deriveProjectPath(p.path)),
      drop: 0,
      paint: (path, s) => s.dim(path),
    },
    {
      header: "Top model",
      text: text((p) => topModelFamily(p.modelBreakdowns)?.toLowerCase() ?? "—"),
      drop: 1,
      paint: paintFamily,
    },
    ...machineColumn,
    ...organizations,
    {
      header: "Sessions",
      text: text(
        (p) => count(p.sessions),
        (t) => count(t.sessions),
      ),
      align: "right",
      drop: 2,
    },
    {
      header: "Total tokens",
      text: text(
        (p) => formatTokens(p.totalTokens),
        (t) => formatTokens(t.totalTokens),
      ),
      align: "right",
      drop: 5,
    },
    {
      header: "Cost",
      text: text(
        (p) => formatCost(p.costRange),
        (t) => formatCost(t.costRange),
      ),
      align: "right",
    },
    {
      header: "Last activity",
      text: text((p) => formatCalendarDay(p.lastActivity, tz, now)),
      align: "right",
      drop: 6,
    },
  ];
}

export function renderProjects(report: ProjectsReport, out: Output): string {
  const title = reportTitle("Projects", report);
  if (report.groups.length === 0) return `${titleLine(title, out)}\nNo projects in this range.\n`;
  const rows: readonly Line[] = projectLines(report.groups);
  const total: Line = { total: projectsTotal(report.groups) };
  return renderTable({ title, columns: projectsColumns(report), rows, total }, out);
}
