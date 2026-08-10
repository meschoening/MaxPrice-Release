import type {
  BlockSpanWindow,
  DailyByMachineResponse,
  DailyByProjectResponse,
  DailyRow,
  HubMachine,
  IntradaySpan,
  TimeDisplay,
} from "@maxprice/shared";
import type { IntradayResponse } from "@maxprice/shared";
import type { ChartStyle, Span } from "@/state/filters";
import type { GroupByAxis } from "@/lib/group-by";
import { ymdShift } from "./dates";
import { densifyDays } from "./daily-rows";
import { isLineStyle, lineRequestFor, type TodayClock } from "./line-style";
import { blockSpanState } from "./block-span-state";
import {
  bucketRowsToDailyRows,
  intradayByMachineToMachineData,
  intradayByProjectToProjectData,
} from "./intraday-adapter";
import { foldMachineEntries, type FoldedMachine, type MachineSeriesEntry } from "./machines";
import type { IdentityIndex } from "./project-identity";
import { foldMachineProjectSeries, foldProjectSeries } from "./projects";

// The Live cost chart's ONE data-source seam (architecture review 2026-07-18,
// candidate 1): the pure resolution from (span × chart style × group-by axes ×
// ghost) to WHAT to fetch (`resolveChartRequest`) and from the fetched payloads
// to the compose inputs (`resolveChartSource`). This replaced the six per-combo
// data-source components (DailyFlat/DailyProject/DailyMachine × IntradayFlat/
// IntradayProject/IntradayMachine) that each owned a copy of this logic;
// `state/use-chart-source.ts` wraps these two functions with the actual
// queries, and `components/cost-chart-card.tsx` is the one compose→render tail.
// Both functions are pure so the query→compose join — previously spread across
// the six components and untestable — pins under plain bun tests.

// The intraday span identifiers — the spans whose bars are served by
// `/api/intraday` rather than `/api/daily`. A `Span` in this set routes the
// chart to the intraday data source; `7d` / `30d` keep the daily path.
const INTRADAY_SPAN_SET = new Set<Span>(["15m", "1h", "block", "today"]);

export function isIntradaySpan(span: Span): span is IntradaySpan {
  return INTRADAY_SPAN_SET.has(span);
}

// Map a Span to its day count for the daily-span chart windows. Only the daily
// spans (7d / 30d) have a meaningful day count; the intraday spans fall back
// to 7 (their daily window is fetched-but-unused — see use-live-data.ts).
export function spanDays(span: Span): number {
  if (span === "30d") return 30;
  if (span === "7d") return 7;
  return 7;
}

// The daily-span chart's doubled window — the previous period + the current one
// in ONE span. `[chartStart, chartUntil]` is the current window (the last
// `days - 1` days through today) and `[prevChartStart, prevChartEnd]` is the
// period immediately before it (the ghost's source). Spelled out ONCE here
// because two call sites must frame bit-identical date ranges: `resolveChart-
// Request` (the daily by-project / by-machine fetch window) and `useChartWindow`
// (the daily-flat chart window). A drift between them would frame the daily-flat
// chart and the by-project / by-machine charts over different dates (finding #9).
export function chartWindow(
  span: Span,
  tz?: string,
): { chartStart: string; chartUntil: string; prevChartStart: string; prevChartEnd: string } {
  const days = spanDays(span);
  return {
    chartStart: ymdShift(-(days - 1), tz),
    chartUntil: ymdShift(0, tz),
    prevChartStart: ymdShift(-(2 * days - 1), tz),
    prevChartEnd: ymdShift(-days, tz),
  };
}

// --- the request derivation ---------------------------------------------------

// Which of the four sources feeds the chart. The two-bit routing the six
// components encoded as JSX dispatch: line styles and intraday spans read
// `/api/intraday` (ADR-0018's line override included); daily bars route on the
// machine bit first (machine outranks project — ADR-0041 M6), then project.
export type ChartSourceKind = "daily-flat" | "daily-project" | "daily-machine" | "intraday";

export type ChartSourceRequest = {
  kind: ChartSourceKind;
  projectOn: boolean;
  machineOn: boolean;
  // The `/api/intraday` request derivation (meaningful when kind is
  // "intraday"; harmless-but-inert otherwise — the hook's intraday query is
  // disabled then).
  intraday: {
    // ADR-0018/0022: the line bucket (span floor, or today's adaptive rung);
    // bars omit it (native per-span bucket). `block` always omits it — the
    // sidecar supplies the constant `BLOCK_BUCKET_MS` (ADR-0046, pinning
    // ADR-0031's adaptive rung).
    bucketMs: number | undefined;
    withDate: boolean;
    // Bars always fetch the previous window (a ghost toggle never refetches);
    // the dense line spans fetch it only while the ghost is on (ADR-0018).
    includePrevious: boolean;
    // Mirrors the project bit exactly — the flat path's explicit `false` keeps
    // its `byProject=0` lean-payload URL byte-identical (ADR-0018).
    includeByProject: boolean;
    // `true` or ABSENT (never `false`): an undefined key drops out of the
    // TanStack query-key hash, keeping every non-machine key + URL
    // byte-identical to pre-M6 (the two-bit sourcing rule, ADR-0041).
    includeByMachine: true | undefined;
  };
  // The daily paths' doubled window — previous period + current in ONE fetch,
  // sliced renderer-side, so a ghost toggle never refetches and the top-N
  // candidate pool never shifts with it (ADR-0034).
  window: { chartStart: string; chartUntil: string; prevChartStart: string; prevChartEnd: string };
};

export function resolveChartRequest(input: {
  span: Span;
  chartStyle: ChartStyle;
  axes: GroupByAxis[];
  ghostOverlay: boolean;
  // The Settings tz (window math + today's midnight anchor) and an optional
  // pinned `now` for tests — today's adaptive line bucket reads the clock.
  clock?: TodayClock;
}): ChartSourceRequest {
  const { span, chartStyle, axes, ghostOverlay, clock } = input;
  const machineOn = axes.includes("machine");
  const projectOn = axes.includes("project");
  const intradayActive = isLineStyle(chartStyle) || isIntradaySpan(span);
  const kind: ChartSourceKind = intradayActive
    ? "intraday"
    : machineOn
      ? "daily-machine"
      : projectOn
        ? "daily-project"
        : "daily-flat";
  const { bucketMs, withDate } = lineRequestFor(span, chartStyle, clock);
  const tz = clock?.tz;
  return {
    kind,
    projectOn,
    machineOn,
    intraday: {
      bucketMs,
      withDate,
      includePrevious: isLineStyle(chartStyle) ? ghostOverlay : true,
      includeByProject: projectOn,
      includeByMachine: machineOn ? true : undefined,
    },
    window: chartWindow(span, tz),
  };
}

// The three gated source queries' `enabled` flags for a given source kind —
// each true iff the kind routes to it, so only the active query ever fetches
// (the hook's laziness mechanism). `daily-flat` gates none: its rows come from
// the chart-window slice, not one of these queries. Pure so the query wiring
// pins under test (finding #4).
export function enabledFor(kind: ChartSourceKind): {
  intraday: boolean;
  dailyProject: boolean;
  dailyMachine: boolean;
} {
  return {
    intraday: kind === "intraday",
    dailyProject: kind === "daily-project",
    dailyMachine: kind === "daily-machine",
  };
}

// --- the payload assembly -----------------------------------------------------

// The slice of one query's TanStack state the assembly reads. `error` stays
// `unknown` (TanStack's own error type) — the message extraction happens here.
export type ChartQueryState<TData> = {
  data: TData | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
};

// The daily flat path's slice of `useLiveData` — its chart-window rows plus
// the chart-window query's OWN status (never the OR of the five Live queries;
// ADR-0033 review f1).
export type LiveChartSlice = {
  chartRows: DailyRow[];
  prevChartRows: DailyRow[];
  chartIsPending: boolean;
  chartIsError: boolean;
  chartError: unknown;
};

// The machine axis's resolution context (use-machine-axis): the directory +
// self id fold wire machineIds into named targets; `folded` is the canonical
// order/color list composeSeries consumes as machineOrder.
export type MachineContext = {
  directory: HubMachine[];
  self: string | null;
  folded: FoldedMachine[];
};

// Everything the compose→render tail needs, resolved from the active source:
// the composeSeries inputs (prev* already ghost-gated — null/absent while the
// ghost is off), the block span's frame + empty flag (ADR-0031), and the
// active source's query status.
export type ChartSource = {
  rows: DailyRow[];
  prevRows: DailyRow[] | null;
  projectData?: Record<string, { path: string; rows: DailyRow[] }>;
  prevProjectData?: Record<string, { path: string; rows: DailyRow[] }>;
  machineData?: Record<string, MachineSeriesEntry>;
  prevMachineData?: Record<string, MachineSeriesEntry>;
  machineOrder?: FoldedMachine[];
  labels: string[];
  blockWindow: BlockSpanWindow | null;
  isEmpty: boolean;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | undefined;
};

function queryStatus(q: {
  isPending: boolean;
  isError: boolean;
  error: unknown;
}): Pick<ChartSource, "isLoading" | "isError" | "errorMessage"> {
  return {
    isLoading: q.isPending,
    isError: q.isError,
    errorMessage: (q.error as Error | undefined)?.message,
  };
}

export function resolveChartSource(input: {
  span: Span;
  ghostOverlay: boolean;
  // How the intraday bucket labels render (ADR-0060) — zone AND 24h/AM-PM.
  // This is a PRESENTATION input, distinct from `TodayClock` above, which is
  // the arithmetic clock the request resolver uses for window math. Only the
  // intraday branch reads it; the daily branches' labels are `YYYY-MM-DD`
  // calendar dates that carry no time of day.
  //
  // Both sides of the by-project / by-machine join are formatted from this ONE
  // value, which is what keeps the join keys agreeing when the format flips.
  display: TimeDisplay;
  request: ChartSourceRequest;
  live: LiveChartSlice;
  intraday: ChartQueryState<IntradayResponse>;
  dailyByProject: ChartQueryState<DailyByProjectResponse>;
  dailyByMachine: ChartQueryState<DailyByMachineResponse>;
  machineCtx: MachineContext;
  // The Repo identity fold context (ADR-0062) — reaches every per-project fold
  // below, plain and machine-nested alike. `undefined` is exactly the
  // pre-ADR-0062 stage-1 fold.
  identityCtx: IdentityIndex | undefined;
}): ChartSource {
  const { span, ghostOverlay, display, request, machineCtx, identityCtx } = input;
  switch (request.kind) {
    case "daily-flat": {
      // The established Part 2–4 path: useLiveData's densified chart window.
      const { live } = input;
      return {
        rows: live.chartRows,
        prevRows: ghostOverlay ? live.prevChartRows : null,
        labels: live.chartRows.map((r) => r.date),
        blockWindow: null,
        isEmpty: false,
        isLoading: live.chartIsPending,
        isError: live.chartIsError,
        errorMessage: (live.chartError as Error | undefined)?.message,
      };
    }
    case "daily-project": {
      const q = input.dailyByProject;
      // Zero rows carry the two windows' label sequences (the per-project
      // series join by label inside composeSeries).
      const rows = densifyDays([], request.window.chartStart, request.window.chartUntil);
      const prevRows = densifyDays([], request.window.prevChartStart, request.window.prevChartEnd);
      // Worktrees fold into their repository (ADR-0061) and checkouts onto
      // their Repo identity (ADR-0062) BEFORE composeSeries ranks the top-N —
      // unfolded, one repo's directories competed for the slots individually
      // and could crowd every other project off the chart.
      const projects = q.data ? foldProjectSeries(q.data.projects, identityCtx) : undefined;
      return {
        rows,
        prevRows: ghostOverlay ? prevRows : null,
        projectData: projects,
        // The same doubled-window map serves both periods — the prev join
        // picks out the prev-window dates.
        prevProjectData: ghostOverlay ? projects : undefined,
        labels: rows.map((r) => r.date),
        blockWindow: null,
        isEmpty: false,
        ...queryStatus(q),
      };
    }
    case "daily-machine": {
      const q = input.dailyByMachine;
      const rows = densifyDays([], request.window.chartStart, request.window.chartUntil);
      const prevRows = densifyDays([], request.window.prevChartStart, request.window.prevChartEnd);
      // The response's `machines` entries already carry `DailyRow[]` rows (and
      // nested `projects[].rows`); alias-fold them into per-target series.
      const machineData = q.data
        ? foldMachineProjectSeries(
            foldMachineEntries(q.data.machines, machineCtx.directory, machineCtx.self ?? ""),
            identityCtx,
          )
        : undefined;
      return {
        rows,
        prevRows: ghostOverlay ? prevRows : null,
        machineData,
        // The same folded doubled-window map serves both periods.
        prevMachineData: ghostOverlay ? machineData : undefined,
        machineOrder: machineCtx.folded,
        labels: rows.map((r) => r.date),
        blockWindow: null,
        isEmpty: false,
        ...queryStatus(q),
      };
    }
    case "intraday": {
      const q = input.intraday;
      const { withDate } = request.intraday;
      const rows = bucketRowsToDailyRows(q.data?.buckets ?? [], withDate, display);
      // No length guard on the ghost — composeSeries itself nulls it on a
      // length mismatch (e.g. a line-style ghost-off fetch's empty
      // `previousBuckets`).
      const prevRows = ghostOverlay
        ? bucketRowsToDailyRows(q.data?.previousBuckets ?? [], withDate, display)
        : null;
      // The machine × project cross rides the NESTED per-machine sub-maps —
      // a machine-bearing selection never populates top-level projectData
      // (the lean rule, ADR-0041 M6).
      const wantProject = request.projectOn && !request.machineOn;
      // Folded before ranking, exactly as on the daily path (ADR-0061 +
      // ADR-0062's identity stage).
      const projectData =
        wantProject && q.data
          ? foldProjectSeries(
              intradayByProjectToProjectData(q.data.byProject, withDate, display),
              identityCtx,
            )
          : undefined;
      const prevProjectData =
        wantProject && ghostOverlay && q.data
          ? foldProjectSeries(
              intradayByProjectToProjectData(
                q.data.byProject,
                withDate,
                display,
                "previousBuckets",
              ),
              identityCtx,
            )
          : undefined;
      const machineData =
        request.machineOn && q.data
          ? foldMachineProjectSeries(
              intradayByMachineToMachineData(
                q.data.byMachine ?? {},
                machineCtx.directory,
                machineCtx.self ?? "",
                withDate,
                display,
              ),
              identityCtx,
            )
          : undefined;
      const prevMachineData =
        request.machineOn && ghostOverlay && q.data
          ? foldMachineProjectSeries(
              intradayByMachineToMachineData(
                q.data.byMachine ?? {},
                machineCtx.directory,
                machineCtx.self ?? "",
                withDate,
                display,
                "previousBuckets",
              ),
              identityCtx,
            )
          : undefined;
      // ADR-0031: a null blockWindow on an arrived block-span response means
      // no active block — the tail renders the empty state in place of the
      // chart + foot.
      const { blockWindow, isEmpty } = blockSpanState(span, q.data);
      return {
        rows,
        prevRows,
        projectData,
        prevProjectData,
        machineData,
        prevMachineData,
        machineOrder: request.machineOn ? machineCtx.folded : undefined,
        labels: rows.map((r) => r.date),
        blockWindow,
        isEmpty,
        ...queryStatus(q),
      };
    }
  }
}
