import { useQuery } from "@tanstack/react-query";
import {
  errorResponseSchema,
  ORGANIZATION_ASSERTIONS_PATH,
  organizationAssertionsResponseSchema,
  organizationAssertResponseSchema,
  type OrganizationAssertionsResponse,
  type OrganizationAssertRequest,
  type OrganizationAssertResponse,
} from "@maxprice/shared";
import { getSidecarUrl } from "@/lib/sidecar";
import { usageAuthHeaders } from "@/lib/usage-credential";

// /api/organization-assertions (#310, ADR-0107 §11) — this machine's resolved
// Membership assertions: sessionId → the Organization its owner-less usage is
// claimed for, and → the Account for a claim that names one. No query params →
// a plain useQuery (four-piece split per ADR-0004). PUT claims or clears
// sessions in bulk.
//
// Read only for Settings › Accounts' "N sessions assigned · Unassign" on each
// Organization row (#672): a session asserted to an Excluded Organization is
// dormant and appears in no sessions list, so the map is the only place its
// claim shows. Tags, the chooser and Assign's Undo read the rows instead.

export function organizationAssertionsQueryKey(): [string] {
  return ["organization-assertions"];
}

export function buildOrganizationAssertionsUrl(base: string): string {
  return `${base}${ORGANIZATION_ASSERTIONS_PATH}`;
}

export async function fetchOrganizationAssertions(
  signal?: AbortSignal,
): Promise<OrganizationAssertionsResponse> {
  const base = await getSidecarUrl();
  const res = await fetch(buildOrganizationAssertionsUrl(base), { signal });
  if (!res.ok) throw new Error(`organization assertions ${res.status}`);
  return organizationAssertionsResponseSchema.parse(await res.json());
}

// Claim every listed session's owner-less usage for `organizationUuid`, and
// with `accountUuid` for that Account in it (a Membership assertion, ADR-0137
// §5: Settings › Unattributed usage, #639), or clear each claim with `null`,
// in one request. Resolves how many sessions'
// entries changed. The route is behind `usageAuthGuard`, so the per-launch
// token rides along. A refusal (an unknown Organization, a full directory, an
// invalid body) rejects with the envelope's `error` as its message, so the
// caller can toast it; a network failure rejects as `fetch` does.
//
// The caller invalidates `organizationAssertionsQueryKey()` on success. The
// reports refresh without it: the sidecar ends a write that changed a claim in
// a usage:new round, which also rereads this map (live-stream.ts).
export async function putOrganizationAssertions(
  sessionIds: string[],
  organizationUuid: string | null,
  accountUuid?: string,
): Promise<OrganizationAssertResponse> {
  const base = await getSidecarUrl();
  const headers = await usageAuthHeaders();
  const body: OrganizationAssertRequest = {
    sessionIds,
    organizationUuid,
    ...(accountUuid === undefined ? {} : { accountUuid }),
  };
  const res = await fetch(buildOrganizationAssertionsUrl(base), {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const envelope = errorResponseSchema.safeParse(await res.json().catch(() => null));
    throw new Error(
      envelope.success ? envelope.data.error : `organization assertion ${res.status}`,
    );
  }
  return organizationAssertResponseSchema.parse(await res.json());
}

// The claims, undefined until the query answers. The live stream's usage:new
// round, which ends every write that changed a claim, invalidates it.
export function useOrganizationAssertions(): OrganizationAssertionsResponse | undefined {
  const { data } = useQuery({
    queryKey: organizationAssertionsQueryKey(),
    queryFn: ({ signal }) => fetchOrganizationAssertions(signal),
  });
  return data;
}
