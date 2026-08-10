import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { HubClientsResponse } from "@maxprice/shared";
import { fetchHubClients, hubClientsQueryKey } from "@/lib/hub-api";

// One hook, one cadence: the 5s poll — which TanStack already pauses while the
// window is hidden (no background flag: the count isn't in the tray tooltip,
// so a hidden window has no reader).
//
// `refetchOnFocus` is the popout's option (ADR-0050). Showing that window flips
// document.visibilityState, so a focus refetch corrects the last-shown count
// within one loopback round-trip; the app-wide default disables focus refetch
// and the console — always visible when it matters — has no use for it.
export function useHubClients({
  refetchOnFocus = false,
}: { refetchOnFocus?: boolean } = {}): UseQueryResult<HubClientsResponse> {
  return useQuery({
    queryKey: hubClientsQueryKey(),
    queryFn: ({ signal }) => fetchHubClients(signal),
    refetchInterval: 5_000,
    refetchOnWindowFocus: refetchOnFocus,
  });
}
