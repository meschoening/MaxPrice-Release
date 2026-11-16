import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { HubLabelDirectory } from "@maxprice/shared";
import { fetchHubLabelDirectory, hubLabelDirectoryQueryKey } from "@/lib/hub-api";

// The fleet's Label directory (#635), read for its Account labels. A hub:labels
// frame refetches it (useHubStream); the 30s interval is the backstop. No
// background flag: only the console reads it, so a hidden window has no reader.
export function useHubLabelDirectory(): UseQueryResult<HubLabelDirectory> {
  return useQuery({
    queryKey: hubLabelDirectoryQueryKey(),
    queryFn: ({ signal }) => fetchHubLabelDirectory(signal),
    refetchInterval: 30_000,
  });
}
