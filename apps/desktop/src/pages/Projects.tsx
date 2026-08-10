import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, Ellipsis } from "lucide-react";
import {
  deriveProjectName,
  deriveProjectPath,
  formatRelativeTime,
  parentProjectSlug,
  type CostMode,
  type ProjectAnchorSnapshot,
  type ProjectRow,
} from "@maxprice/shared";
import { resolveDateRange, useFilters } from "@/state/filters";
import { useSettings } from "@/state/use-settings";
import { useProjects } from "@/state/use-projects";
import { useMachineAxis } from "@/state/use-machine-axis";
import { useProjectAxis } from "@/state/use-project-axis";
import { useCorpusEmpty } from "@/state/use-corpus-empty";
import { useDaily } from "@/state/use-daily";
import { densifyDays } from "@/lib/daily-rows";
import { useEscapeToDeselect } from "@/state/use-escape-deselect";
import { ymdShift } from "@/lib/dates";
import { foldMachineIdList } from "@/lib/machines";
import { expandProjectFilter } from "@/lib/project-identity";
import { foldProjectRows, groupChildren } from "@/lib/projects";
import { EmptyState } from "@/components/EmptyState";
import { DataTable, type Column, type TreeSpec } from "@/components/data-table";
import { MachineChip } from "@/components/machine-chip";
import { StripPage } from "@/components/strip-page";
import { DetailStrip, StripIdentity, StripSection, StripStat } from "@/components/detail-strip";
import { ModelBadges } from "@/components/model-badges";
import { ModelSplitBar } from "@/components/model-split-bar";
import { CostChart } from "@/components/cost-chart";
import { composeSeries } from "@/lib/composed-series";
import { type GroupByAxis } from "@/lib/group-by";
import { aggregateProjectsRange, type ProjectsRangeAggregate } from "@/lib/aggregate";
import { daysSince, formatCost, RANGE_LABEL, STALE_DAYS, topModelFamily } from "@/lib/list-format";
import { abbreviate } from "@/lib/active-block";
import { ProjectMergeDialog } from "@/components/project-merge-dialog";

// Fixed axes for the compact strip charts — model split, no ghost, no project.
// Hoisted to module level for referential stability (avoids memo dep churn).
const STRIP_AXES: GroupByAxis[] = ["model"];

const projectSnapshot = (anchor: string, path: string): ProjectAnchorSnapshot => ({
  anchor,
  path,
  name: deriveProjectName(path),
});

// One line in the table: a folded project, or one of the directories it was
// folded from (ADR-0061).
//
// The wrapper exists because the two collide on identity — a group's row and its
// own-directory child both carry the parent slug, and a table needs one id per
// rendered line. Prefixing the child's id keeps a group's id the bare slug, so
// selection, `Open in Live`, and the filter value all stay slug-shaped.
type ProjectTableRow = { project: ProjectRow; child: boolean };

// Stable identities for the DataTable — hoisted so they don't churn the table's
// entries memo every render (both are pure functions of the row).
const projectRowId = (r: ProjectTableRow): string =>
  r.child ? `wt:${r.project.slug}` : r.project.slug;
// Deliberately the row's OWN text only, never its members'. The table matches
// children itself and discloses the ones that hit; folding member names in here
// would make a worktree search look like a parent match and leave the row shut
// with no indication of why it appeared.
const projectSearchKeys = (r: ProjectTableRow): string[] => [
  r.project.path,
  deriveProjectName(r.project.path),
  deriveProjectPath(r.project.path),
];

// Lift a column written against a ProjectRow onto the wrapper, so the cell
// bodies below stay about projects rather than about table plumbing.
//
// Takes `Column<ProjectRow>` rather than re-spelling its fields: the spread
// below only carries what the parameter's type admits, so an inline copy would
// make every column on this page silently drop any field later added to Column
// — with no type error anywhere.
//
// `sortValue` is required here even though `Column` now makes it optional. Every
// column that goes through this wrapper renders project data and has something
// to order by; the page's one unsortable column is the merge-action column,
// which is written inline because it reads the table row, not the project.
function projectColumn(
  c: Column<ProjectRow> & { sortValue: (row: ProjectRow) => number | string },
): Column<ProjectTableRow> {
  return {
    ...c,
    sortValue: (r) => c.sortValue(r.project),
    cell: (r) => c.cell(r.project),
  };
}

// Days a project has been inactive, only when that crosses the stale threshold.
// The Status column that used to render this as a pill is gone (it cost 110px
// to restate what "Last activity" already says); the row dim below is the whole
// stale treatment now, and it costs no horizontal space.
function staleDays(p: ProjectRow, tz: string | undefined): number | null {
  const d = daysSince(p.lastActivity, tz);
  return d != null && d >= STALE_DAYS ? d : null;
}

// The strip's compact 30-day chart window — shared by the selected-project and
// filter-totals strips so both query the same date span.
const CHART_DAYS_BACK = -29;

export function ProjectsPage(): React.ReactElement {
  const navigate = useNavigate();
  const dateRange = useFilters((s) => s.dateRange);
  const { data: settings } = useSettings();
  const costMode = settings?.costMode ?? "auto";
  const tz = settings?.timezone;
  // ADR-0062: `projectParams` is the selection closure-expanded across Repo
  // identity before it reaches the wire (both the table's query and the
  // aggregate strip's `filterProjects`); `index` is the fold context the table
  // rows fold through. The persisted selection `setProjects` writes stays raw
  // parent slugs.
  const projectAxis = useProjectAxis();
  const projects = projectAxis.projectParams;
  const models = useFilters((s) => s.models);
  const setProjects = useFilters((s) => s.setProjects);
  const machineAxis = useMachineAxis();
  const { since, until } = resolveDateRange(dateRange, tz);

  const query = useProjects({
    since,
    until,
    mode: costMode,
    tz,
    projects,
    models,
    machines: machineAxis.machineParams,
  });
  // The picker is deliberately independent of the page's current date,
  // project, model and machine filters: a dead checkout must remain available
  // as a merge source even when the visible table has no row for it.
  const allTimeQuery = useProjects({
    mode: costMode,
    tz,
    projects: [],
    models: [],
    machines: [],
  });
  // Worktrees fold into their repository (ADR-0061) and checkouts sharing a
  // Repo identity into one group (ADR-0062) before anything else looks at the
  // data, so the table, the strip totals and the row count all describe
  // projects rather than directories.
  const groups = useMemo(
    () => foldProjectRows(query.data?.projects ?? [], projectAxis.index),
    [query.data, projectAxis.index],
  );
  const rows = useMemo(() => groups.map((g) => g.row), [groups]);
  const allTimeGroups = useMemo(
    () => foldProjectRows(allTimeQuery.data?.projects ?? [], projectAxis.index),
    [allTimeQuery.data, projectAxis.index],
  );
  const mergeCatalog = useMemo(
    () => allTimeGroups.map((group) => projectSnapshot(group.row.slug, group.row.path)),
    [allTimeGroups],
  );
  const tableRows = useMemo<ProjectTableRow[]>(
    () => groups.map((g) => ({ project: g.row, child: false })),
    [groups],
  );
  const childrenBySlug = useMemo(
    () => new Map(groups.map((g) => [g.row.slug, groupChildren(g)])),
    [groups],
  );
  const tree = useMemo<TreeSpec<ProjectTableRow>>(
    () => ({
      childrenOf: (r) => {
        const kids = r.child ? undefined : childrenBySlug.get(r.project.slug);
        if (!kids) return { lead: [], rest: [] };
        return {
          lead: kids.lead.map((project) => ({ project, child: true })),
          rest: kids.rest.map((project) => ({ project, child: true })),
        };
      },
    }),
    [childrenBySlug],
  );
  // Every line the table can render, so a selected child resolves to its own row
  // for the detail strip rather than falling back to its parent's. Keeps the
  // wrapper (not the bare ProjectRow): the strip's query scope depends on the
  // parent/child bit — see stripProjects below.
  const byId = useMemo(() => {
    const m = new Map<string, ProjectTableRow>();
    for (const g of groups) {
      const top: ProjectTableRow = { project: g.row, child: false };
      m.set(projectRowId(top), top);
      for (const mem of g.members) {
        const child: ProjectTableRow = { project: mem, child: true };
        m.set(projectRowId(child), child);
      }
    }
    return m;
  }, [groups]);

  // Dedupe a project's raw machine ids through alias resolution (an aliased id
  // and its target collapse to one entry) — the Machines column source of truth.
  const foldedIds = useCallback(
    (ids: string[]): string[] => foldMachineIdList(ids, machineAxis.directory),
    [machineAxis.directory],
  );

  // The table's row id, not the project slug — a disclosed worktree selects as
  // itself, and its own-directory sibling carries the same slug.
  const [selectedId, setSelectedId] = useState<string>();
  const selected = selectedId === undefined ? undefined : byId.get(selectedId);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeSource, setMergeSource] = useState<ProjectAnchorSnapshot | null>(null);

  const openMergeDialog = (source: ProjectAnchorSnapshot | null): void => {
    setMergeSource(source);
    setMergeDialogOpen(true);
  };

  // The selected row's strip-chart scope (ADR-0062, resolving the Task-10
  // deferral at the strip's daily query): a TOP-LEVEL row is the whole Repo
  // identity, so its 30-day chart expands to every member checkout — each
  // widened to its worktrees sidecar-side — matching the folded totals beside
  // it. A CHILD row is one directory: a worktree stays exact, and a
  // checkout-own child keeps only ADR-0061's sidecar worktree widening (its
  // stats describe that checkout, so its chart must not absorb the others).
  const stripProjects = useMemo(
    () =>
      selected === undefined
        ? []
        : selected.child
          ? [selected.project.slug]
          : expandProjectFilter([selected.project.slug], projectAxis.index),
    [selected, projectAxis.index],
  );

  // Click-again toggles the selection off (back to filter totals); Esc and a
  // click on any dead space on the page do too.
  const onSelect = (r: ProjectTableRow): void => {
    const id = projectRowId(r);
    setSelectedId((prev) => (prev === id ? undefined : id));
  };
  const deselect = useCallback(() => setSelectedId(undefined), []);
  useEscapeToDeselect(deselect);

  // Range-scoped filter totals for the strip's no-selection state (ADR-0016).
  // Every stat the strip shows comes from these rows — ADR-0068 retired the
  // second, unwindowed query that used to back its all-time `sessions` count.
  const aggregate = useMemo(() => aggregateProjectsRange(rows), [rows]);

  // First-launch empty state — the engine holds no usage data at all. Captured
  // before the columns memo / early return below so the hook order is stable.
  const corpusEmpty = useCorpusEmpty();

  // Sets the filter rail's project filter to this project, then jumps to Live.
  //
  // The slug is normalised to its PARENT because both entry points — the first
  // column's arrow button and the detail strip's "Open in Live →" — are shared
  // by group rows and disclosed worktree children, and the persisted filter's
  // value space is parent slugs only (ADR-0061; the v12 → v13 migration in
  // `state/filters.ts` normalises with this same function). A raw worktree slug
  // would be unrepresentable in the rail: the option builder emits folded group
  // slugs, the selection test matches on group membership — which never contains
  // a worktree — so no checkbox reads checked, the chip prints the bare slug, and
  // only "Clear selection" could remove it. That is precisely the state the
  // migration exists to erase, and writing it here would recreate it at runtime.
  //
  // Deliberately the parent slug rather than the identity group's canonical slug
  // (ADR-0062). A parent IS representable — it is a member of its own group, so
  // the membership-overlap selection test returns true and the chip resolves the
  // group's label — and the resulting QUERY is identical either way, because
  // `use-project-axis.ts` expands a parent slug through the identity index to the
  // whole group at query-build time. The group-slug variant would buy nothing and
  // cost plumbing the group down into the cell.
  //
  // The intended consequence, stated out loud: Open in Live from a worktree row
  // scopes Live to the owning project (and, under Repo identity, its whole
  // group), not to the worktree alone. That is the only thing the rail's value
  // space can express.
  const openInLive = (slug: string): void => {
    setProjects([parentProjectSlug(slug)]);
    navigate("/live");
  };

  const columns = useMemo<Column<ProjectTableRow>[]>(
    () => [
      {
        id: "project",
        header: "Project",
        // minmax(0,…) lets the name column shrink to fit so the grid never
        // overflows its container — overflow is what clipped the right columns
        // and left their row background unpainted. The name truncates instead.
        width: "minmax(0,2fr)",
        sortValue: (r) => deriveProjectName(r.project.path),
        cell: (r) => (
          <span className="wcell">
            <span className="lead">
              <b>{deriveProjectName(r.project.path)}</b>
              <small className="num">{deriveProjectPath(r.project.path)}</small>
              {r.child && projectAxis.index.isManualSource(parentProjectSlug(r.project.slug)) ? (
                <span className="pill">Manual merge</span>
              ) : null}
            </span>
            <button
              type="button"
              title="Open in Live"
              aria-label={`Open ${deriveProjectName(r.project.path)} in Live`}
              onClick={(e) => {
                e.stopPropagation();
                openInLive(r.project.slug);
              }}
              className="row-action"
            >
              <ArrowUpRight aria-hidden />
            </button>
          </span>
        ),
      },
      projectColumn({
        id: "topModel",
        header: "Top model",
        width: "110px",
        sortValue: (p) => topModelFamily(p.modelBreakdowns) ?? "",
        cell: (p) => {
          const fam = topModelFamily(p.modelBreakdowns);
          return fam ? <ModelBadges models={[fam]} /> : <span className="text-soft">—</span>;
        },
      }),
      // The Machines column (ADR-0041 M6) — one dot per alias-folded machine;
      // present ONLY while the machine axis is enabled.
      ...(machineAxis.enabled
        ? [
            projectColumn({
              id: "machines",
              header: "Machines",
              width: "130px",
              sortValue: (p) => foldedIds(p.machines).length,
              cell: (p) => {
                const ids = foldedIds(p.machines);
                if (ids.length === 0) return <span className="text-soft">—</span>;
                if (ids.length === 1 && ids[0] !== undefined)
                  return <MachineChip id={ids[0]} machineAxis={machineAxis} />;
                return (
                  <span className="mdots">
                    {ids.map((id) => (
                      <MachineChip key={id} id={id} machineAxis={machineAxis} hideName />
                    ))}
                    <span>{ids.length} machines</span>
                  </span>
                );
              },
            }),
          ]
        : []),
      projectColumn({
        id: "sessions",
        header: "Sessions",
        numeric: true,
        width: "90px",
        sortValue: (p) => p.sessions,
        cell: (p) => abbreviate(p.sessions),
      }),
      projectColumn({
        id: "tokens",
        header: "Tokens",
        numeric: true,
        width: "100px",
        sortValue: (p) => p.totalTokens,
        cell: (p) => abbreviate(p.totalTokens),
      }),
      projectColumn({
        id: "costRange",
        // `(range)` is gone with the all-time column it contrasted against —
        // every column here answers the date range now, so range is the
        // unmarked default. Header chrome is a fixed 38px (padding 8/12 + a
        // 4px gap + the 10px sort arrow), so this fits "COST" + arrow.
        header: "Cost",
        numeric: true,
        cellClass: "cost",
        width: "90px",
        sortValue: (p) => p.costRange,
        cell: (p) => formatCost(p.costRange),
      }),
      projectColumn({
        id: "lastActivity",
        header: "Last activity",
        numeric: true,
        cellClass: "softer",
        // Mock track (132px): the uppercase header + sort arrow need the room.
        width: "132px",
        sortValue: (p) => Date.parse(p.lastActivity) || 0,
        cell: (p) => (
          <span title={`no activity since ${p.lastActivity || "—"}`}>
            {formatRelativeTime(p.lastActivity, Date.now())}
          </span>
        ),
      }),
      {
        id: "merge",
        header: "",
        width: "48px",
        // No `sortValue`: a column of action buttons has nothing to order by,
        // so its header renders inert rather than as a sort control (see
        // Column.sortValue in data-table.tsx).
        cell: (r) =>
          r.child ? null : (
            <button
              type="button"
              className="row-action"
              title="Merge project history"
              aria-label={`Merge ${deriveProjectName(r.project.path)} project history`}
              onClick={(event) => {
                event.stopPropagation();
                openMergeDialog(projectSnapshot(r.project.slug, r.project.path));
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <Ellipsis aria-hidden />
            </button>
          ),
      },
    ],
    // `tz` is captured per render; openInLive is stable enough for cells.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tz, machineAxis, foldedIds, projectAxis.index],
  );

  // An empty result while the corpus is non-empty is just a filtered-out date
  // range — that keeps the inline "No projects in this range." message instead.
  if (corpusEmpty) {
    return (
      <div className="p-6">
        <EmptyState />
      </div>
    );
  }

  return (
    <StripPage
      onBackgroundClick={deselect}
      strip={
        selected ? (
          <ProjectDetailStrip
            project={selected.project}
            filterProjects={stripProjects}
            costMode={costMode}
            tz={tz}
            filterModels={models}
            onOpenInLive={openInLive}
          />
        ) : query.isPending ? (
          // The projects query hasn't resolved yet — a quiet shell rather than
          // a false "0 projects · $0.00" aggregate. `tall` floors it at the
          // rendered two-row strip's height so settling doesn't shift the table.
          <DetailStrip selected={false} className="tall">
            <span className="text-sm text-soft">Loading…</span>
          </DetailStrip>
        ) : query.isError && rows.length === 0 ? (
          // A failed query with nothing cached: the zero aggregate would
          // assert a false "0 projects · $0.00" — say what happened instead
          // (the table body carries the danger inset).
          <DetailStrip selected={false} className="tall">
            <span className="text-sm text-soft">Couldn&apos;t load projects.</span>
          </DetailStrip>
        ) : (
          <ProjectsAggregateStrip
            aggregate={aggregate}
            rangeLabel={RANGE_LABEL[dateRange]}
            costMode={costMode}
            tz={tz}
            filterProjects={projects}
            filterModels={models}
          />
        )
      }
      table={
        <section className="panel table-panel h-full" aria-label="Projects table">
          {projectAxis.index.conflicts.length > 0 ? (
            <div className="inset warn project-merge-page-warning" role="alert">
              <span>A project merge conflict is being ignored until you resolve it.</span>
              <button type="button" className="chip warn" onClick={() => openMergeDialog(null)}>
                Resolve
              </button>
            </div>
          ) : null}
          <DataTable
            title="Projects"
            rows={tableRows}
            columns={columns}
            rowId={projectRowId}
            onSelect={onSelect}
            selectedId={selectedId}
            tree={tree}
            // 570px of fixed columns (top model 110 + sessions 90 + tokens 100
            // + cost 90 + last activity 132 + merge 48) + ≥150px for the
            // project name. Below this the table scrolls horizontally instead
            // of crushing the name. The Machines column adds its own 130px to
            // the floor when enabled (ADR-0041 M6).
            minWidth={machineAxis.enabled ? 850 : 720}
            defaultSort={{ columnId: "costRange", dir: "desc" }}
            searchKeys={projectSearchKeys}
            rowClassName={(r) => (staleDays(r.project, tz) != null ? "opacity-[0.46]" : undefined)}
            searchPlaceholder="Search projects…"
            emptyMessage={query.isPending ? "Loading…" : "No projects in this range."}
            error={query.error}
            headerAction={
              projectAxis.index.assertions.length > 0 ? (
                <button
                  type="button"
                  className="chip ghost-btn"
                  onClick={() => openMergeDialog(null)}
                >
                  Manage merges
                </button>
              ) : null
            }
          />
          <ProjectMergeDialog
            open={mergeDialogOpen}
            onOpenChange={setMergeDialogOpen}
            initialSource={mergeSource}
            catalog={mergeCatalog}
            identity={projectAxis.index}
            onMerged={(target) => setSelectedId(target.anchor)}
          />
        </section>
      }
    />
  );
}

// The selected project's strip: identity, all-time stats, the compact 30-day
// chart, the per-model split, and "Open in Live →".
function ProjectDetailStrip({
  project,
  filterProjects,
  costMode,
  tz,
  filterModels,
  onOpenInLive,
}: {
  project: ProjectRow;
  // The strip chart's project scope — the caller resolves it from the row
  // KIND (ADR-0062): a top-level row carries its identity group's expansion,
  // a child row its own slug alone.
  filterProjects: string[];
  costMode: CostMode;
  tz: string | undefined;
  filterModels: string[];
  onOpenInLive: (slug: string) => void;
}): React.ReactElement {
  // A 30-day daily window scoped to this row — the strip's compact chart.
  // Mounting only happens on selection, so the query is lazy by construction;
  // switching projects swaps the query key without remounting the component.
  const chartSince = ymdShift(CHART_DAYS_BACK, tz);
  const chartUntil = ymdShift(0, tz);
  const dailyQuery = useDaily({
    since: chartSince,
    until: chartUntil,
    mode: costMode,
    tz,
    projects: filterProjects,
    models: filterModels,
  });
  const chartRows = useMemo(
    () => densifyDays(dailyQuery.data?.daily ?? [], chartSince, chartUntil),
    [dailyQuery.data, chartSince, chartUntil],
  );
  const stripComposed = useMemo(
    () => composeSeries({ axes: STRIP_AXES, metric: "cost", rows: chartRows, prevRows: null }),
    [chartRows],
  );
  const stripLabels = useMemo(() => chartRows.map((r) => r.date), [chartRows]);

  return (
    <DetailStrip selected>
      {/* Top row: identity, stats, and the 30-day chart. Wraps internally at
          narrow widths; the split row below never moves. */}
      <div className="flex w-full min-w-0 flex-wrap items-center gap-x-[26px] gap-y-[10px]">
        <StripIdentity title={deriveProjectName(project.path)}>
          <span className="sub num">{deriveProjectPath(project.path)}</span>
        </StripIdentity>

        {/* Range-scoped, like every other number on this page — and the same
            shape as the Sessions strip, which restates its row's own cost. */}
        <StripStat label="cost">{formatCost(project.costRange)}</StripStat>
        <StripStat label="sessions">{abbreviate(project.sessions)}</StripStat>
        <StripStat label="first seen">{project.firstActivity || "—"}</StripStat>
        <StripStat label="last seen">{project.lastActivity || "—"}</StripStat>

        {/* Wider basis than the default section: 30 daily bars need the room. */}
        <StripSection label="Cost · last 30 days" className="wide">
          <CostChart
            composed={stripComposed}
            labels={stripLabels}
            metric="cost"
            axes={STRIP_AXES}
            chartStyle="bars"
            ghostOverlay={false}
            isLoading={dailyQuery.isPending}
            compact
          />
        </StripSection>
      </div>

      {/* Bottom row, always: the per-model split with the action to its right.
          Pinned as its own full-width row so the split bar doesn't migrate up
          beside the chart once the window is wide enough to fit it there. */}
      <div className="flex w-full min-w-0 items-center gap-[26px]">
        <StripSection label="Per-model split">
          <ModelSplitBar breakdowns={project.modelBreakdowns} size="md" showLegend />
        </StripSection>

        <button type="button" onClick={() => onOpenInLive(project.slug)} className="strip-action">
          Open in Live →
        </button>
      </div>
    </DetailStrip>
  );
}

// Filter totals across every project in the table, plus the same compact
// 30-day chart across all of them — the strip's height never changes between
// the aggregate and selected states.
function ProjectsAggregateStrip({
  aggregate,
  rangeLabel,
  costMode,
  tz,
  filterProjects,
  filterModels,
}: {
  aggregate: ProjectsRangeAggregate;
  rangeLabel: string;
  costMode: CostMode;
  tz: string | undefined;
  filterProjects: string[];
  filterModels: string[];
}): React.ReactElement {
  const chartSince = ymdShift(CHART_DAYS_BACK, tz);
  const chartUntil = ymdShift(0, tz);
  // Same 30-day window, across every project and model in the current filter —
  // an empty list means all projects / all models. TanStack caches by key, so
  // flipping between aggregate and selected states never refetches needlessly.
  const dailyQuery = useDaily({
    since: chartSince,
    until: chartUntil,
    mode: costMode,
    tz,
    projects: filterProjects,
    models: filterModels,
  });
  const chartRows = useMemo(
    () => densifyDays(dailyQuery.data?.daily ?? [], chartSince, chartUntil),
    [dailyQuery.data, chartSince, chartUntil],
  );
  const stripComposed = useMemo(
    () => composeSeries({ axes: STRIP_AXES, metric: "cost", rows: chartRows, prevRows: null }),
    [chartRows],
  );
  const stripLabels = useMemo(() => chartRows.map((r) => r.date), [chartRows]);

  return (
    <DetailStrip selected={false}>
      {/* Top row: identity, stats, and the 30-day chart. Wraps internally at
          narrow widths; the split row below never moves. */}
      <div className="flex w-full min-w-0 flex-wrap items-center gap-x-[26px] gap-y-[10px]">
        <StripIdentity title="All projects">
          <span className="sub num">
            {aggregate.count} projects · {rangeLabel}
          </span>
        </StripIdentity>

        <StripStat label="cost">{formatCost(aggregate.costRange)}</StripStat>
        <StripStat label="sessions">{abbreviate(aggregate.sessions)}</StripStat>

        {/* Wider basis than the default section: 30 daily bars need the room. */}
        <StripSection label="Cost · last 30 days" className="wide">
          <CostChart
            composed={stripComposed}
            labels={stripLabels}
            metric="cost"
            axes={STRIP_AXES}
            chartStyle="bars"
            ghostOverlay={false}
            isLoading={dailyQuery.isPending}
            compact
          />
        </StripSection>
      </div>

      {/* Bottom row, always: the per-model split with the hint to its right.
          Pinned as its own full-width row so the split bar doesn't migrate up
          beside the chart once the window is wide enough to fit it there. */}
      <div className="flex w-full min-w-0 items-center gap-[26px]">
        <StripSection label="Per-model split">
          <ModelSplitBar breakdowns={aggregate.breakdowns} size="md" showLegend />
        </StripSection>

        <span className="strip-hint">Select a row for details</span>
      </div>
    </DetailStrip>
  );
}
