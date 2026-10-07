import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { usageCurrentSchema, type UsageCurrent } from "@maxprice/shared";
import { getSidecarUrl } from "@/lib/sidecar";

// /api/usage/current — the last-known sample for the rings' first paint
// (ADR-0023); the response is `{ sample, weeklyResetAt }`, with connection state
// carried separately by the status snapshot (review f10). Live updates arrive via
// the usage:sample SSE event, which writes the reading's own Organization's entry
// (`usageCurrentQueryKey(organizationUuid)`, see live-stream.ts), so the rings
// update without polling; the bare entry is filled only by this fetch.
// Four-piece split per ADR-0004.
//
// The one param is the Quota organization's uuid (ADR-0106 §8), `organization`
// on the wire: the scoped uuid, else Home's, so every Organization keys and
// fetches its own entry, and the live stream keeps each one fresh. Only a
// machine with no Home uses the bare key and URL.

export function usageCurrentQueryKey(organization?: string): [string] | [string, string] {
  return organization === undefined ? ["usage-current"] : ["usage-current", organization];
}

export function buildUsageCurrentUrl(base: string, organization?: string): string {
  const url = `${base}/api/usage/current`;
  return organization === undefined
    ? url
    : `${url}?organization=${encodeURIComponent(organization)}`;
}

export async function fetchUsageCurrent(
  signal?: AbortSignal,
  organization?: string,
): Promise<UsageCurrent> {
  const base = await getSidecarUrl();
  const res = await fetch(buildUsageCurrentUrl(base, organization), { signal });
  if (!res.ok) throw new Error(`usage/current ${res.status}`);
  return usageCurrentSchema.parse(await res.json());
}

export function useUsageCurrent(organization?: string): UseQueryResult<UsageCurrent> {
  return useQuery({
    queryKey: usageCurrentQueryKey(organization),
    queryFn: ({ signal }) => fetchUsageCurrent(signal, organization),
  });
}
