import { useMemo } from "react";
import { chartWindow, type LiveChartSlice } from "@/lib/chart-source";
import { densifyDays } from "@/lib/daily-rows";
import { useFilters } from "./filters";
import { useSettings } from "./use-settings";
import { useDaily } from "./use-daily";
import { useMachineAxis } from "./use-machine-axis";
import { useProjectAxis } from "./use-project-axis";

// The Live cost chart's daily-flat data slice, split out of `useLiveData` so the
// chart's data source (`useChartSource`) can read the chart window WITHOUT
// subscribing to the four span-independent Live queries (week window, blocks,
// sessions, projects). `useLiveData`'s single memo returns a fresh object
// whenever ANY of its queries' data changes — a `block:tick` every ~30s churned
// the whole `live` object and, through it, the chart's intraday source and the
// downstream `composeSeries` memo, even though the chart data was unchanged
// (architecture review 2026-07-18, finding #1). This hook memoizes on the
// chart-window query's data + window bounds ALONE, so a block tick can't churn
// it, and it runs the densify once instead of twice per render.
//
// The chart-window query is the SAME `useDaily` call (same key + URL) that
// `useLiveData` composes below — so on the Live page, where both are mounted,
// TanStack dedupes them into one fetch.
export function useChartWindow(): LiveChartSlice {
  const span = useFilters((s) => s.span);
  const { data: settings } = useSettings();
  const costMode = settings?.costMode ?? "auto";
  const tz = settings?.timezone;
  // ADR-0062: closure-expanded across Repo identity before it reaches the wire.
  const projects = useProjectAxis().projectParams;
  const models = useFilters((s) => s.models);
  // ADR-0041 (M6): the rail's machine filter narrows the chart window too,
  // alias-closure-expanded (empty when gated off — a hub-less client stays
  // byte-identical to pre-M6).
  const machineAxis = useMachineAxis();
  const machines = machineAxis.machineParams;

  const { chartStart, chartUntil, prevChartStart, prevChartEnd } = chartWindow(span, tz);

  // The DOUBLED window (previous period + current) in one fetch, sliced into the
  // two densified series below so a ghost toggle never refetches (ADR-0034).
  // When span is 7d the current and prev windows coincide and TanStack dedupes.
  const chartWindowQ = useDaily({
    since: prevChartStart,
    until: chartUntil,
    mode: costMode,
    tz,
    projects,
    models,
    machines,
  });

  return useMemo<LiveChartSlice>(() => {
    // Densify each slice from the one merged window so the prev overlay can
    // position-align — see composed-series' `prevRows.length === n` guard.
    const rows = chartWindowQ.data?.daily ?? [];
    return {
      chartRows: densifyDays(rows, chartStart, chartUntil),
      prevChartRows: densifyDays(rows, prevChartStart, prevChartEnd),
      chartIsPending: chartWindowQ.isPending,
      chartIsError: chartWindowQ.isError,
      chartError: chartWindowQ.error,
    };
  }, [
    chartWindowQ.data,
    chartWindowQ.isPending,
    chartWindowQ.isError,
    chartWindowQ.error,
    chartStart,
    chartUntil,
    prevChartStart,
    prevChartEnd,
  ]);
}
