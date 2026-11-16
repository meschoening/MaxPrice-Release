import { useQuery } from "@tanstack/react-query";
import {
  localGatewaysResponseSchema,
  SIDECAR_GATEWAYS_PATH,
  type LocalGatewaysResponse,
} from "@maxprice/shared";
import { getSidecarUrl } from "@/lib/sidecar";
import { usageAuthHeaders } from "@/lib/usage-credential";

// GET /api/gateways (ADR-0141 §5, §7; #651): the Gateways this machine holds,
// each with its state, the age of its last record and who drains it, never
// its URL path or key. Behind the sidecar's auth guard, so it sends
// `x-maxprice-auth` (use-usage-keys.ts's rule). Settings › Accounts' Gateways
// subsection reads it (#639, lib/accounts-view.ts). Kept fresh by
// live-stream.ts's `gateways:changed` poke. Four-piece split per ADR-0004;
// the key and URL live here because shared names only the path.
export function gatewaysQueryKey(): ["gateways"] {
  return ["gateways"];
}

export function buildGatewaysUrl(base: string): string {
  return `${base}${SIDECAR_GATEWAYS_PATH}`;
}

export async function fetchGateways(signal?: AbortSignal): Promise<LocalGatewaysResponse> {
  const base = await getSidecarUrl();
  const res = await fetch(buildGatewaysUrl(base), {
    signal,
    headers: await usageAuthHeaders(),
  });
  if (!res.ok) throw new Error(`gateways ${res.status}`);
  return localGatewaysResponseSchema.parse(await res.json());
}

export function useGateways() {
  return useQuery({
    queryKey: gatewaysQueryKey(),
    queryFn: ({ signal }) => fetchGateways(signal),
  });
}
