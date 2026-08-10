import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { sidecarMachinesResponseSchema, type SidecarMachinesResponse } from "@maxprice/shared";
import { sidecarFetch } from "@/lib/sidecar";

// /api/machines — the sidecar's loopback machine directory + self id (ADR-0041
// M6). ADR-0004 four-piece split. No params, so the key is the bare family
// tuple; it is deliberately NOT in DATA_QUERY_KEYS — the directory is not
// cost-mode- or usage-shaped, and its one invalidator is the SSE
// `machines:changed` poke (live-stream.ts).

// Piece 1 — the query key.
export const machinesQueryKey = ["machines"] as const;

// Piece 2 — the URL builder.
export function buildMachinesUrl(): string {
  return "/api/machines";
}

// Piece 3 — the fetch. `fetchImpl` is a parameter purely for tests.
export async function fetchMachines(
  signal: AbortSignal | undefined,
  fetchImpl: typeof sidecarFetch = sidecarFetch,
): Promise<SidecarMachinesResponse> {
  const res = await fetchImpl(buildMachinesUrl(), { signal });
  if (!res.ok) throw new Error(`/api/machines ${res.status}: ${await res.text()}`);
  return sidecarMachinesResponseSchema.parse(await res.json());
}

// Piece 4 — the useQuery wrapper. `enabled` lets the machine-axis gate keep
// the loopback fetch from ever firing while the machine UI is gated off.
export function useMachines(enabled = true): UseQueryResult<SidecarMachinesResponse> {
  return useQuery<SidecarMachinesResponse>({
    queryKey: machinesQueryKey,
    queryFn: ({ signal }) => fetchMachines(signal),
    enabled,
  });
}
