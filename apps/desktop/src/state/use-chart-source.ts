import { useMemo } from "react";
import {
  enabledFor,
  resolveChartRequest,
  resolveChartSource,
  type ChartSource,
} from "@/lib/chart-source";
import type { GroupByAxis } from "@/lib/group-by";
import { useFilters, type ChartStyle, type Span } from "./filters";
import { useSettings, useTimeDisplay } from "./use-settings";
import { useChartWindow } from "./use-chart-window";
import { useDailyByProject } from "./use-daily-by-project";
import { useDailyByMachine } from "./use-daily-by-machine";
import { useIntraday } from "./use-intraday";
import { useMachineAxis } from "./use-machine-axis";
import { useProjectAxis } from "./use-project-axis";

// The Live cost chart's ONE data-source hook (architecture review 2026-07-18,
// candidate 1): span × chart style × group-by axes × ghost in, the resolved
// `ChartSource` out. Replaces the six per-combo data-source components, whose
// laziness mechanism was conditional MOUNTING (only the active combo's hook
// existed). One component must call every hook unconditionally (rules of
// hooks), so laziness is TanStack `enabled` gating instead: the three gated
// source queries (intraday / daily-project / daily-machine) all mount, only the
// active one ever fetches — same fetches, byte-identical URLs and query keys (a
// disabled query holds its key without touching the network, and its
// `status: "pending"` never leaks — the resolver reads status from the active
// source alone). The fourth source, daily-flat, reads the chart-window slice
// (`useChartWindow`) rather than a query of its own.
//
// The daily-flat slice comes from `useChartWindow`, NOT `useLiveData`: the chart
// only needs the chart-window rows, and subscribing to the whole `useLiveData`
// object churned this hook's assembly (and the downstream compose) on every
// block tick even when the chart data was unchanged (finding #1). The
// chart-window query dedupes with `useLiveData`'s own — both mounted on the
// Live page — so it costs no extra fetch and needs no gate.
export function useChartSource(input: {
  span: Span;
  chartStyle: ChartStyle;
  axes: GroupByAxis[];
  ghostOverlay: boolean;
}): ChartSource {
  const { span, chartStyle, axes, ghostOverlay } = input;
  const { data: settings } = useSettings();
  const costMode = settings?.costMode ?? "auto";
  const tz = settings?.timezone;
  // ADR-0060. The while-loading fallback (`?? DEFAULT_SETTINGS.timeFormat`) is
  // stated ONCE, in `useTimeDisplay` — writing it a second time here is exactly
  // the divergence that hook exists to prevent. Its internal `useSettings()`
  // hits the same cached query as the one above, so it costs no extra fetch.
  //
  // What rides the memo's dep array below is still the `timeFormat` PRIMITIVE,
  // never the `display` object: that array is hand-maintained under a disabled
  // exhaustive-deps rule, and a value React is free to recompute is the more
  // fragile thing to key on than the primitive it was derived from.
  const display = useTimeDisplay();
  const timeFormat = display.timeFormat;
  // ADR-0062: `projectParams` is the selection closure-expanded across Repo
  // identity before it reaches the wire; `index` is the fold context the
  // assembly hands every per-project series fold — it IS the IdentityIndex the
  // folds declare, not a structural stand-in, and the axis memo keeps it
  // reference-stable between directory changes.
  const projectAxis = useProjectAxis();
  const projects = projectAxis.projectParams;
  const models = useFilters((s) => s.models);
  // ADR-0041 (M6): the rail's machine filter narrows every combo; the machine
  // group-by folds through the directory. `axes` is the EFFECTIVE selection,
  // so `machine` only ever appears here while the axis is gated on.
  const machineAxis = useMachineAxis();
  const chart = useChartWindow();

  // Derived FRESH each render, never memoized: `today`'s adaptive line bucket
  // (ADR-0022) reads the clock, and its step cadence is "the next refetch-
  // driven render" (ADR-0020) — a memo keyed on the chart controls would pin
  // the mount-time rung all day. Cheap: a few compares + four ymdShift calls.
  const request = resolveChartRequest({ span, chartStyle, axes, ghostOverlay, clock: { tz } });
  // Which of the three gated source queries fetches — only the active one; the
  // daily-flat path reads `chart` (the chart-window slice) instead of a query.
  const enabled = enabledFor(request.kind);

  const intradayQ = useIntraday(
    {
      span,
      mode: costMode,
      tz,
      projects,
      models,
      machines: machineAxis.machineParams,
      bucketMs: request.intraday.bucketMs,
      includePrevious: request.intraday.includePrevious,
      includeByProject: request.intraday.includeByProject,
      includeByMachine: request.intraday.includeByMachine,
    },
    { enabled: enabled.intraday },
  );
  // The daily by-project / by-machine queries fetch the DOUBLED window —
  // previous period + current — and slice renderer-side (ADR-0034): fetched
  // ghost-independent so a ghost toggle never refetches and the top-N
  // candidate pool never shifts with it.
  const dailyByProjectQ = useDailyByProject(
    {
      since: request.window.prevChartStart,
      until: request.window.chartUntil,
      mode: costMode,
      tz,
      projects,
      models,
      machines: machineAxis.machineParams,
    },
    { enabled: enabled.dailyProject },
  );
  const dailyByMachineQ = useDailyByMachine(
    {
      since: request.window.prevChartStart,
      until: request.window.chartUntil,
      mode: costMode,
      tz,
      projects,
      models,
      machines: machineAxis.machineParams,
      // The nested per-machine project sub-maps only when the project axis
      // rides along (ADR-0041 M6).
      byProject: request.projectOn,
    },
    { enabled: enabled.dailyMachine },
  );

  // The assembly memo keys on the request's render-stable fields plus each
  // query's data/status — NOT the `request` object itself, which is fresh
  // every render by design (see above; its only render-unstable field,
  // `intraday.bucketMs`, feeds the query key alone and is never read by the
  // assembly). Granular query-field deps mirror the retired six components'
  // memos: TanStack's result object is new each render, but `.data` is stable.
  return useMemo(
    () =>
      resolveChartSource({
        span,
        ghostOverlay,
        display,
        request,
        live: chart,
        intraday: intradayQ,
        dailyByProject: dailyByProjectQ,
        dailyByMachine: dailyByMachineQ,
        machineCtx: machineAxis,
        identityCtx: projectAxis.index,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `request`, the query results, and `machineAxis` are keyed by their assembly-relevant fields (rationale above)
    [
      span,
      ghostOverlay,
      tz,
      // ADR-0060. The exhaustive-deps rule is DISABLED on this hook, so nothing
      // but this line makes the chart re-label when the user flips the setting;
      // omit it and every bucket keeps its mount-time format until an unrelated
      // dep happens to change. `timeFormat` (the primitive), never the `display`
      // object it came from — see the rationale where it is read.
      timeFormat,
      request.kind,
      request.projectOn,
      request.machineOn,
      request.intraday.withDate,
      request.window.chartStart,
      request.window.chartUntil,
      request.window.prevChartStart,
      request.window.prevChartEnd,
      chart.chartRows,
      chart.prevChartRows,
      chart.chartIsPending,
      chart.chartIsError,
      chart.chartError,
      intradayQ.data,
      intradayQ.isPending,
      intradayQ.isError,
      intradayQ.error,
      dailyByProjectQ.data,
      dailyByProjectQ.isPending,
      dailyByProjectQ.isError,
      dailyByProjectQ.error,
      dailyByMachineQ.data,
      dailyByMachineQ.isPending,
      dailyByMachineQ.isError,
      dailyByMachineQ.error,
      machineAxis,
      // ADR-0062: a changed Identity directory must refold the series. The
      // axis memo recreates `index` (and with it this reference) whenever the
      // directory rows, self id, or selection change.
      projectAxis.index,
    ],
  );
}
