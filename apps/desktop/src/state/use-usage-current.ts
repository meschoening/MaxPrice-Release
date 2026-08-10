import { useQuery } from "@tanstack/react-query";
import { usageCurrentSchema, type UsageCurrent } from "@maxprice/shared";
import { getSidecarUrl } from "@/lib/sidecar";

// /api/usage/current — the last-known sample for the rings' first paint
// (ADR-0023); the response is just `{ sample }` now, with connection state carried
// separately by the status snapshot (review f10). Live updates arrive via the
// usage:sample SSE event, which writes this same cache key (see live-stream.ts), so
// the rings update without polling. No query params → a plain useQuery (four-piece
// split per ADR-0004).

export function usageCurrentQueryKey(): [string] {
  return ["usage-current"];
}

export function buildUsageCurrentUrl(base: string): string {
  return `${base}/api/usage/current`;
}

export async function fetchUsageCurrent(): Promise<UsageCurrent> {
  const base = await getSidecarUrl();
  const res = await fetch(buildUsageCurrentUrl(base));
  if (!res.ok) throw new Error(`usage/current ${res.status}`);
  return usageCurrentSchema.parse(await res.json());
}

export function useUsageCurrent() {
  return useQuery({ queryKey: usageCurrentQueryKey(), queryFn: fetchUsageCurrent });
}
