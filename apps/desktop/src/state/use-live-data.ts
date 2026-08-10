import { useMemo } from "react";
import type { BlockRow, DailyRow, ProjectRow, SessionRow } from "@maxprice/shared";
import { isoFromYmd, ymdShift } from "@/lib/dates";
import { resolveDateRange, useFilters } from "./filters";
import { useSettings } from "./use-settings";
import { useChartWindow } from "./use-chart-window";
import { useDaily } from "./use-daily";
import { useBlocks } from "./use-blocks";
import { useSessions } from "./use-sessions";
import { useProjects } from "./use-projects";
import { useMachineAxis } from "./use-machine-axis";
import { useProjectAxis } from "./use-project-axis";
import { typicalBlockTokens } from "@/lib/aggregate";
import { foldProjectRows } from "@/lib/projects";

// Today/yesterday/week derive from a 14-day window — covers the current and
// prior week tiles + today and yesterday tiles in one cache entry per range.
// The chart's span is a separate window. The rails follow the sidebar preset.
//
// Naming: `current` = the active period; `prev` = the same length shifted
// back by exactly that length (for the ghost overlay and week-over-week delta).
export type LiveData = {
  todayRow: DailyRow | null;
  yesterdayRow: DailyRow | null;
  weekRows: DailyRow[];
  prevWeekRows: DailyRow[];
  activeBlock: BlockRow | null;
  typicalBlockTokens: number;
  chartRows: DailyRow[];
  prevChartRows: DailyRow[];
  topSessions: SessionRow[];
  topProjects: ProjectRow[];
  isPending: boolean;
  isError: boolean;
  // The chart window's own query state — from `useChartWindow`'s slice ALONE,
  // not the OR of all five queries. The daily flat chart renders only that
  // query's rows, so its loading/error overlay must scope to it (mirroring the
  // three sibling chart components, each scoped to its single query).
  chartIsPending: boolean;
  chartIsError: boolean;
  chartError: unknown;
};

const TODAY = (tz?: string) => ymdShift(0, tz);

// The chart window's daily slice comes from `useChartWindow` (composed below),
// not computed inline here — so `useChartSource` can read it WITHOUT
// subscribing to this hook's four span-independent queries (finding #1). The
// intraday spans still reach the chart-window query with the 7-day fallback —
// `LivePage` calls `useLiveData()` for the hero tiles + rails while an intraday
// span is selected, and that window's result is simply unused then
// (`useChartSource` reads `/api/intraday` instead). An accepted minor
// inefficiency on a small local dataset.

export function useLiveData(): LiveData {
  const dateRange = useFilters((s) => s.dateRange);
  const { data: settings } = useSettings();
  const costMode = settings?.costMode ?? "auto";
  const tz = settings?.timezone;
  // ADR-0062: the project filter reaches the wire closure-expanded across Repo
  // identity — selecting one checkout of a repo queries every checkout of it —
  // and `index` folds the Top-projects rail the same way the Projects table
  // folds its rows.
  const projectAxis = useProjectAxis();
  const projects = projectAxis.projectParams;
  const models = useFilters((s) => s.models);
  // ADR-0041 (M6): the rail's machine filter narrows every Live query (blocks
  // narrows sums only, engine-side). Alias-closure-expanded, empty when gated
  // off — so a hub-less client stays byte-identical to pre-M6.
  const machineAxis = useMachineAxis();
  const machines = machineAxis.machineParams;

  const today = TODAY(tz);
  const weekStart = ymdShift(-6, tz);
  const prevWeekStart = ymdShift(-13, tz);
  const prevWeekEnd = ymdShift(-7, tz);

  const { since: railSince, until: railUntil } = resolveDateRange(dateRange, tz);

  // One 14-day daily window (prevWeekStart..today) backs both week tiles plus
  // today/yesterday — sliced locally below rather than issuing a second
  // query for the prior week.
  const weekWindowQ = useDaily({
    since: prevWeekStart,
    until: today,
    mode: costMode,
    tz,
    projects,
    models,
    machines,
  });
  // The chart's current + ghost-overlay windows (one 2×span daily fetch,
  // densified) come from `useChartWindow` — the same query `useChartSource`
  // mounts, so the two dedupe on the Live page (finding #1).
  const chart = useChartWindow();
  // Blocks stays cross-project (the 5-hour quota window spans projects), but
  // the model filter narrows each block's cost/token sums (ADR-0017) — the
  // active-block tile's cost honours the rail's model filter; its projection
  // stays all-model.
  const blocksQ = useBlocks({
    since: railSince,
    until: railUntil,
    mode: costMode,
    tz,
    models,
    machines,
  });
  const sessionsQ = useSessions({
    since: railSince,
    until: railUntil,
    mode: costMode,
    tz,
    projects,
    models,
    machines,
  });
  const projectsQ = useProjects({
    since: railSince,
    until: railUntil,
    mode: costMode,
    tz,
    projects,
    models,
    machines,
  });

  return useMemo<LiveData>(() => {
    const todayIso = isoFromYmd(today);
    const weekStartIso = isoFromYmd(weekStart);
    const prevWeekStartIso = isoFromYmd(prevWeekStart);
    const prevWeekEndIso = isoFromYmd(prevWeekEnd);
    // Slice the merged 14-day window into the two 7-day tiles. The engine omits
    // zero-spend days; these stay raw (un-densified) rows since today/yesterday
    // lookup and the week tiles tolerate gaps.
    const windowRows = weekWindowQ.data?.daily ?? [];
    const weekRows = windowRows.filter((r) => r.date >= weekStartIso && r.date <= todayIso);
    const prevWeekRows = windowRows.filter(
      (r) => r.date >= prevWeekStartIso && r.date <= prevWeekEndIso,
    );
    const blocks = blocksQ.data?.blocks ?? [];

    const yesterdayIso = isoFromYmd(ymdShift(-1, tz));

    const todayRow = weekRows.find((r) => r.date === todayIso) ?? null;
    const yesterdayRow =
      weekRows.find((r) => r.date === yesterdayIso) ??
      prevWeekRows.find((r) => r.date === yesterdayIso) ??
      null;

    const activeBlock = blocks.find((b) => b.isActive && !b.isGap) ?? null;
    // The "typical" block — median tokens across the range's completed blocks
    // (excludes the active block + gaps). Backs the Active block tile's
    // "typical" row.
    const typical = typicalBlockTokens(blocks);

    const topSessions = (sessionsQ.data?.sessions ?? [])
      .slice()
      .sort((a, b) => b.totalCost - a.totalCost)
      .slice(0, 5);
    // Fold worktrees into their repository (ADR-0061) and checkouts onto
    // their Repo identity (ADR-0062) BEFORE ranking. Ranking first would let
    // one repo's directories occupy several of the five slots while each
    // looked too small to be worth one.
    const topProjects = foldProjectRows(projectsQ.data?.projects ?? [], projectAxis.index)
      .map((g) => g.row)
      .sort((a, b) => b.costRange - a.costRange)
      .slice(0, 5);

    return {
      todayRow,
      yesterdayRow,
      weekRows,
      prevWeekRows,
      activeBlock,
      typicalBlockTokens: typical,
      chartRows: chart.chartRows,
      prevChartRows: chart.prevChartRows,
      topSessions,
      topProjects,
      isPending:
        weekWindowQ.isPending ||
        chart.chartIsPending ||
        blocksQ.isPending ||
        sessionsQ.isPending ||
        projectsQ.isPending,
      isError:
        weekWindowQ.isError ||
        chart.chartIsError ||
        blocksQ.isError ||
        sessionsQ.isError ||
        projectsQ.isError,
      chartIsPending: chart.chartIsPending,
      chartIsError: chart.chartIsError,
      chartError: chart.chartError,
    };
  }, [
    weekWindowQ.data,
    weekWindowQ.isPending,
    weekWindowQ.isError,
    chart,
    blocksQ.data,
    blocksQ.isPending,
    blocksQ.isError,
    sessionsQ.data,
    sessionsQ.isPending,
    sessionsQ.isError,
    projectsQ.data,
    projectsQ.isPending,
    projectsQ.isError,
    projectAxis.index,
    today,
    tz,
    weekStart,
    prevWeekStart,
    prevWeekEnd,
  ]);
}
