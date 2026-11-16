import { resolveDateRange, type ReportQueryInput } from "@maxprice/shared";
import { useFilters } from "@/state/filters";
import { useWeekWindow } from "@/state/use-week";
import { useSettings } from "@/state/use-settings";
import { useScope } from "@/state/use-scope";
import { useSessions } from "@/state/use-sessions";
import { useMachineAxis } from "@/state/use-machine-axis";
import { useProjectAxis } from "@/state/use-project-axis";

// The report input the filter rail describes: its date range resolved in the
// Settings timezone, the cost mode, the Organization scope (ADR-0106), the
// project selection closure-expanded across Repo identity (ADR-0062), and the
// model and machine filters. One builder, so every list that reads "the rail's
// result" sends the same input and so shares one TanStack cache entry per
// report by construction.
//
// The seam is the input rather than a query because the Projects page sends
// it to two reports, `/api/projects` for its table and `/api/sessions` for its
// session search and detail list, and the two must answer the same question.
export function useRailReportInput(): ReportQueryInput {
  const dateRange = useFilters((s) => s.dateRange);
  const { data: settings } = useSettings();
  const tz = settings?.timezone;
  const { params: scope } = useScope();
  const projects = useProjectAxis().projectParams;
  const models = useFilters((s) => s.models);
  const machines = useMachineAxis().machineParams;
  const week = useWeekWindow();
  const { since, until } = resolveDateRange(dateRange, tz, week);
  return {
    since,
    until,
    mode: settings?.costMode ?? "auto",
    tz,
    ...scope,
    projects,
    models,
    machines,
  };
}

// The rail's sessions (`/api/sessions` over `useRailReportInput`): read by the
// Projects page and the session page's identity lookup
// (`useSessionRow`), which therefore share one cache entry.
export function useRailSessions(): ReturnType<typeof useSessions> {
  return useSessions(useRailReportInput());
}
