import { QueryClient } from "@tanstack/react-query";
import { usageCurrentQueryKey } from "@/state/use-usage-current";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// The per-Organization usage readings are a small resident map: an entry
// nobody displays must still be there when the scope flips to it.
queryClient.setQueryDefaults(usageCurrentQueryKey(), { gcTime: Infinity });
