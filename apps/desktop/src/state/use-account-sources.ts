import { useQuery } from "@tanstack/react-query";
import {
  accountSourcesQueryKey,
  accountSourcesResponseSchema,
  buildAccountSourcesUrl,
  type AccountSourcesResponse,
} from "@maxprice/shared";
import { getSidecarUrl } from "@/lib/sidecar";

// GET /api/account-sources (#639, ADR-0141 §8): where this machine sees each
// Account, a root's login or a held Gateway, for Settings › Accounts' "Seen
// through" line and the Accounts each Gateway row names. Open like GET
// /api/accounts. Kept fresh by live-stream.ts: `accounts:changed` (a login or
// the pair table moved) and `gateways:changed` (a credential list did). Key
// and URL live in shared (ADR-0004).
export async function fetchAccountSources(signal?: AbortSignal): Promise<AccountSourcesResponse> {
  const base = await getSidecarUrl();
  const res = await fetch(buildAccountSourcesUrl(base), { signal });
  if (!res.ok) throw new Error(`account sources ${res.status}`);
  return accountSourcesResponseSchema.parse(await res.json());
}

export function useAccountSources() {
  return useQuery({
    queryKey: accountSourcesQueryKey(),
    queryFn: ({ signal }) => fetchAccountSources(signal),
  });
}
