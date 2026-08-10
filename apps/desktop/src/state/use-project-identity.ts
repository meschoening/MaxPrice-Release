import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  PROJECT_IDENTITY_PATH,
  sidecarProjectIdentityResponseSchema,
  type SidecarProjectIdentityResponse,
} from "@maxprice/shared";
import { sidecarFetch } from "@/lib/sidecar";

// /api/project-identity — the sidecar's loopback Identity directory + self id
// (ADR-0062). ADR-0004 four-piece split. No params, so the key is the bare
// family tuple; it is deliberately NOT in DATA_QUERY_KEYS — identity is not
// cost-mode- or usage-shaped, and its one invalidator is the SSE
// `identity:changed` poke (live-stream.ts). A changed fold reaches the reports
// as a new query key, never as a report invalidation (ADR-0062 §4).

// Piece 1 — the query key.
export const projectIdentityQueryKey = ["project-identity"] as const;

// Piece 2 — the URL builder.
export function buildProjectIdentityUrl(): string {
  return PROJECT_IDENTITY_PATH;
}

// Piece 3 — the fetch. `fetchImpl` is a parameter purely for tests.
export async function fetchProjectIdentity(
  signal: AbortSignal | undefined,
  fetchImpl: typeof sidecarFetch = sidecarFetch,
): Promise<SidecarProjectIdentityResponse> {
  const res = await fetchImpl(buildProjectIdentityUrl(), { signal });
  if (!res.ok) throw new Error(`${PROJECT_IDENTITY_PATH} ${res.status}: ${await res.text()}`);
  return sidecarProjectIdentityResponseSchema.parse(await res.json());
}

// Piece 4 — the useQuery wrapper. `enabled` mirrors useMachines: a gate can keep
// the loopback fetch from firing while the surface that needs it is off.
export function useProjectIdentity(enabled = true): UseQueryResult<SidecarProjectIdentityResponse> {
  return useQuery<SidecarProjectIdentityResponse>({
    queryKey: projectIdentityQueryKey,
    queryFn: ({ signal }) => fetchProjectIdentity(signal),
    enabled,
  });
}
