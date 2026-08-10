import type { SessionRow } from "@maxprice/shared";
import { resolveDateRange, useFilters } from "@/state/filters";
import { useSettings } from "@/state/use-settings";
import { useSessions } from "@/state/use-sessions";
import { useMachineAxis } from "@/state/use-machine-axis";
import { useProjectAxis } from "@/state/use-project-axis";

// M5 — the detail page's identity lookup. The session-events summary frame
// deliberately carries no project path (frozen wire, ADR-0012), but the T6
// strip and topbar subtitle want one. `/api/sessions` already reports it
// (`SessionRow.path`, ADR-0009), so look the row up there — with EXACTLY the
// input the Sessions list page builds, so this is the same TanStack cache
// entry: warm (free) when the user arrived through the list, one shared fetch
// on a cold deep link. A session outside the rail's current date range (or
// excluded by a filter) simply misses — callers render without the row.
export function useSessionRow(sessionId: string): SessionRow | undefined {
  const dateRange = useFilters((s) => s.dateRange);
  const { data: settings } = useSettings();
  const tz = settings?.timezone;
  // ADR-0062 — the same closure-expanded params the list page builds, so the
  // two stay ONE cache entry (the whole point of this hook).
  const projects = useProjectAxis().projectParams;
  const models = useFilters((s) => s.models);
  const machineAxis = useMachineAxis();
  const { since, until } = resolveDateRange(dateRange, tz);

  const query = useSessions({
    since,
    until,
    mode: settings?.costMode ?? "auto",
    tz,
    projects,
    models,
    machines: machineAxis.machineParams,
  });

  return query.data?.sessions.find((s) => s.sessionId === sessionId);
}
