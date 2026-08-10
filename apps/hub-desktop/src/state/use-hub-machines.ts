import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { HubMachinesResponse } from "@maxprice/shared";
import { fetchHubMachines, hubMachinesQueryKey } from "@/lib/hub-api";

// null data ⇔ the daemon 404'd /api/machines (pre-event-sync) — the App
// degrades to the M3 roster card. Polled like the roster (live/lastSeen/push
// stats drift without directory pokes).
export function useHubMachines(): UseQueryResult<HubMachinesResponse | null> {
  return useQuery({
    queryKey: hubMachinesQueryKey(),
    queryFn: ({ signal }) => fetchHubMachines(signal),
    refetchInterval: 5_000,
  });
}
