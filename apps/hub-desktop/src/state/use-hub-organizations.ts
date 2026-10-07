import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { HubOrganizationsResponse } from "@maxprice/shared";
import { fetchHubOrganizations, hubOrganizationsQueryKey } from "@/lib/hub-api";

// The Hub's roster joined with the Organization directory (#294). Status and
// directory frames refetch it (useHubStream); the 30s interval is the backstop.
// No background flag: only the console reads it, so a hidden window has no reader.
export function useHubOrganizations(): UseQueryResult<HubOrganizationsResponse> {
  return useQuery({
    queryKey: hubOrganizationsQueryKey(),
    queryFn: ({ signal }) => fetchHubOrganizations(signal),
    refetchInterval: 30_000,
  });
}
