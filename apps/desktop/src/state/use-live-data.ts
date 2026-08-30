import { useMemo } from "react";
import type { BlockRow, DailyRow, ProjectRow, SessionRow } from "@maxprice/shared";
import { isoFromYmd, ymdShift } from "@/lib/dates";
import { resolveDateRange, useFilters } from "./filters";
import { useSettings } from "./use-settings";
import { useNowTick } from "./use-now-tick";
import { useWeekWindow } from "./use-week";
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
// An ANCHORED Week (ADR-0083) switches only the two week tiles onto their own
// instant-bounded queries; today/yesterday keep the 14-day window.
// The chart's span is a separate window. The rails follow the sidebar preset.
//
// Naming: `current` = the active period; `prev` = the same length shifted
// back by exactly that length (for the ghost overlay and week-over-week delta).
export type LiveData = {
  todayRow: DailyRow | null;
  yesterdayRow: DailyRow | null;
  weekRows: DailyRow[];
  prevWeekRows: DailyRow[];
  // The rolling week's first local date (YYYY-MM-DD, today − 6 days in the
  // Timezone). The This-week tile's sub-line reads THIS, not `weekRows[0]`:
  // the engine omits zero-spend days, so a quiet weekend shifted the tag onto
  // the first day with spend and misreported where the week began.
  rollingWeekStart: string;
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

  // ADR-0083: the resolved Week drives the `week` preset's rail window and
  // the This-week tile's source below.
  const week = useWeekWindow();
  const anchored = week.kind === "anchored";
  const now = useNowTick(60_000);
  const { since: railSince, until: railUntil } = resolveDateRange(dateRange, tz, week);

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
  // An anchored week's two tiles: the current window from the anchor to now
  // (an instant `since`, no `until` — an open right edge), and the previous
  // window to the SAME time-into-week, so the delta compares like with like
  // rather than a whole prior week against a partial current one. Both are
  // called unconditionally and parked while the week is rolling (the
  // `use-chart-source` gating idiom).
  const anchoredWeekQ = useDaily(
    {
      since: anchored ? new Date(week.startMs).toISOString() : undefined,
      mode: costMode,
      tz,
      projects,
      models,
      machines,
    },
    { enabled: anchored },
  );
  // Both sides of "prior week to date" pin to the instant the CURRENT week's
  // rows were fetched, not to a free 1/min clock. `dailyKey` normalizes
  // `since`/`until` into the TanStack key, so a ticking `until` minted a new
  // key every 60s — and with it a `data: undefined` blank on the delta chip, a
  // bounded-window `/api/daily` fold that bypasses the report cache by
  // construction (ADR-0057: only an unbounded window is cached), and one leaked
  // cache entry, once a minute, for as long as Live is open on an anchored
  // week. Off `dataUpdatedAt` the key moves only when the comparison actually
  // moves — i.e. on ADR-0058's invalidation rounds — and the tile is only as
  // fresh as that fetch anyway, so this is also MORE like-with-like than a wall
  // clock. No loop: the prev query's own fetch never touches the current one's
  // `dataUpdatedAt`. It reads 0 before the first successful fetch, hence the
  // `now` fallback; the result is still clamped at the anchor because the two
  // 1/min ticks share no phase, so a just-passed custom anchor could otherwise
  // read a `now` a beat older than its own start. Deliberately NOT quantized to
  // a coarse boundary: flooring would end the prior window short of the current
  // one's true elapsed and under-count the reference (ADR-0083 §6).
  const elapsedMs = anchored
    ? Math.max(anchoredWeekQ.dataUpdatedAt || now, week.startMs) - week.startMs
    : 0;
  const anchoredPrevWeekQ = useDaily(
    {
      since: anchored ? new Date(week.prevStartMs).toISOString() : undefined,
      until: anchored ? new Date(week.prevStartMs + elapsedMs).toISOString() : undefined,
      mode: costMode,
      tz,
      projects,
      models,
      machines,
    },
    // `keepPrevious`: the key still moves whenever the current week refetches,
    // and without a placeholder each move blanks `data` to `undefined` — which
    // is what rendered the flat "— vs prior week to date" chip. Holding the
    // last window's rows across the swap keeps the delta on screen; it is at
    // worst one round stale, which is exactly what the tile beside it is.
    { enabled: anchored, keepPrevious: true },
  );
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
    const rollingWeekRows = windowRows.filter((r) => r.date >= weekStartIso && r.date <= todayIso);
    const rollingPrevWeekRows = windowRows.filter(
      (r) => r.date >= prevWeekStartIso && r.date <= prevWeekEndIso,
    );
    // Anchored: each response is already instant-bounded, so it IS the tile.
    const weekRows = anchored ? (anchoredWeekQ.data?.daily ?? []) : rollingWeekRows;
    const prevWeekRows = anchored ? (anchoredPrevWeekQ.data?.daily ?? []) : rollingPrevWeekRows;
    const blocks = blocksQ.data?.blocks ?? [];

    const yesterdayIso = isoFromYmd(ymdShift(-1, tz));

    const todayRow = rollingWeekRows.find((r) => r.date === todayIso) ?? null;
    const yesterdayRow =
      rollingWeekRows.find((r) => r.date === yesterdayIso) ??
      rollingPrevWeekRows.find((r) => r.date === yesterdayIso) ??
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
      rollingWeekStart: weekStartIso,
      activeBlock,
      typicalBlockTokens: typical,
      chartRows: chart.chartRows,
      prevChartRows: chart.prevChartRows,
      topSessions,
      topProjects,
      // A parked query reports `isPending` (status pending, fetchStatus idle),
      // so the anchored pair only counts while it is the tile's source.
      isPending:
        weekWindowQ.isPending ||
        (anchored && (anchoredWeekQ.isPending || anchoredPrevWeekQ.isPending)) ||
        chart.chartIsPending ||
        blocksQ.isPending ||
        sessionsQ.isPending ||
        projectsQ.isPending,
      isError:
        weekWindowQ.isError ||
        (anchored && (anchoredWeekQ.isError || anchoredPrevWeekQ.isError)) ||
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
    anchored,
    anchoredWeekQ.data,
    anchoredWeekQ.isPending,
    anchoredWeekQ.isError,
    anchoredPrevWeekQ.data,
    anchoredPrevWeekQ.isPending,
    anchoredPrevWeekQ.isError,
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
