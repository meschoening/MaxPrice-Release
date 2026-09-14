import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ORGANIZATIONS_PATH,
  organizationsResponseSchema,
  type OrganizationsResponse,
} from "@maxprice/shared";
import { getSidecarUrl } from "@/lib/sidecar";
import { useSettings, useUpdateSettings } from "@/state/use-settings";

// /api/organizations — the organizations this machine knows about, for the
// Home organization select (ADR-0098). No query params → a plain useQuery
// (four-piece split per ADR-0004).

export function organizationsQueryKey(): [string] {
  return ["organizations"];
}

export function buildOrganizationsUrl(base: string): string {
  return `${base}${ORGANIZATIONS_PATH}`;
}

export async function fetchOrganizations(signal?: AbortSignal): Promise<OrganizationsResponse> {
  const base = await getSidecarUrl();
  const res = await fetch(buildOrganizationsUrl(base), { signal });
  if (!res.ok) throw new Error(`organizations ${res.status}`);
  return organizationsResponseSchema.parse(await res.json());
}

export function useOrganizations() {
  return useQuery({
    queryKey: organizationsQueryKey(),
    queryFn: ({ signal }) => fetchOrganizations(signal),
  });
}

// The first-launch seed (ADR-0098): the sidecar answers /api/organizations only
// once the first-launch home has settled, so `home` is its corpus-seeded pick
// (or the persisted setting). Persist it while the setting is null — never
// overwriting a choice — and, because it is what the sidecar is already using,
// the settings watch sees no change and nothing rebuilds.
export function useSeedHomeOrganization(): void {
  const { data: settings } = useSettings();
  const { data } = useOrganizations();
  const update = useUpdateSettings();
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || settings === undefined || data === undefined) return;
    if (settings.homeOrganization !== null || data.home === null) return;
    seeded.current = true;
    void update({ homeOrganization: data.home });
  }, [settings, data, update]);
}
