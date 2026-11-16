import type { SessionRow } from "@maxprice/shared";
import { useRailSessions } from "@/state/use-rail-report";

// M5 — the detail page's identity lookup. The session-events summary frame
// deliberately carries no project path (frozen wire, ADR-0012), but the T6
// strip and topbar subtitle want one. `/api/sessions` already reports it
// (`SessionRow.path`, ADR-0009), so look the row up in the rail's sessions,
// the query the Projects page reads: the same
// TanStack cache entry, warm when the user arrived through it, one shared
// fetch on a cold deep link. A session outside the rail's current date range
// (or excluded by a filter) simply misses — callers render without the row.
export function useSessionRow(sessionId: string): SessionRow | undefined {
  const query = useRailSessions();
  return query.data?.sessions.find((s) => s.sessionId === sessionId);
}
