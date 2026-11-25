import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  buildScopeHeadUrl,
  scopeHeadKey,
  scopeHeadResponseSchema,
  type ScopeHeadResponse,
  type ScopeQueryParams,
} from "@maxprice/shared";
import { getSidecarUrl } from "@/lib/sidecar";

// /api/scope-head (#637): the head the sidecar's shared rule picks for a
// Scope settings alone cannot head (`settledHeadOrganization`), from the
// Scope's candidate Memberships, which only the store knows. The ADR-0004
// four-piece split; the URL builder and key live in `@maxprice/shared`.
// "scope-head" is in `DATA_QUERY_KEYS`, so `usage:new` refreshes it with the
// reports, as its candidates gain rows.

export const scopeHeadQueryKey = scopeHeadKey;

export async function fetchScopeHead(
  scope: ScopeQueryParams,
  signal?: AbortSignal,
): Promise<ScopeHeadResponse> {
  const base = await getSidecarUrl();
  const res = await fetch(buildScopeHeadUrl(base, scope), { signal });
  if (!res.ok) throw new Error(`scope-head ${res.status}`);
  return scopeHeadResponseSchema.parse(await res.json());
}

// `enabled` false while settings head the Scope, so the common Scopes never
// ask.
export function useScopeHead(
  scope: ScopeQueryParams,
  enabled: boolean,
): UseQueryResult<ScopeHeadResponse> {
  return useQuery({
    queryKey: scopeHeadQueryKey(scope),
    queryFn: ({ signal }) => fetchScopeHead(scope, signal),
    enabled,
  });
}
