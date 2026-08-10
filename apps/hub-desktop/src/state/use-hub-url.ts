import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { getHubUrl } from "@/lib/tauri";

export function useHubUrl(): UseQueryResult<string> {
  return useQuery({ queryKey: ["hub-url"], queryFn: () => getHubUrl(), staleTime: Infinity });
}
