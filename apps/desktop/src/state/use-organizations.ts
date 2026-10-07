import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  errorResponseSchema,
  ORGANIZATIONS_PATH,
  organizationPath,
  organizationsResponseSchema,
  type OrganizationRenameRequest,
  type OrganizationsResponse,
} from "@maxprice/shared";
import { organizationLabelMap } from "@/lib/organization-scope-view";
import { getSidecarUrl } from "@/lib/sidecar";
import { usageAuthHeaders } from "@/lib/usage-credential";
import { useSettings, useUpdateSettings } from "@/state/use-settings";

// /api/organizations — the Settings roster (#287): every Organization this
// machine knows about with its resolved label, which the Home organization
// select (ADR-0098) also reads. No query params → a plain useQuery (four-piece
// split per ADR-0004). PUT /api/organizations/:uuid renames one.

export function organizationsQueryKey(): [string] {
  return ["organizations"];
}

export function buildOrganizationsUrl(base: string): string {
  return `${base}${ORGANIZATIONS_PATH}`;
}

export function buildOrganizationUrl(base: string, uuid: string): string {
  return `${base}${organizationPath(uuid)}`;
}

export async function fetchOrganizations(signal?: AbortSignal): Promise<OrganizationsResponse> {
  const base = await getSidecarUrl();
  const res = await fetch(buildOrganizationsUrl(base), { signal });
  if (!res.ok) throw new Error(`organizations ${res.status}`);
  return organizationsResponseSchema.parse(await res.json());
}

// Rename an Organization, or clear its rename with `null`. Resolves the fresh
// roster. A refusal (an empty or over-long label, one another Organization
// already uses, an unknown Organization) rejects with the envelope's `error`
// as its message, so the caller can show it inline. Every window learns of a
// rename through the `organizations:changed` poke the sidecar emits for it
// (live-stream.ts).
export async function renameOrganization(
  uuid: string,
  label: string | null,
): Promise<OrganizationsResponse> {
  const base = await getSidecarUrl();
  const headers = await usageAuthHeaders();
  const body: OrganizationRenameRequest = { label };
  const res = await fetch(buildOrganizationUrl(base, uuid), {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const envelope = errorResponseSchema.safeParse(await res.json().catch(() => null));
    throw new Error(envelope.success ? envelope.data.error : `organization rename ${res.status}`);
  }
  return organizationsResponseSchema.parse(await res.json());
}

// Kept fresh by live-stream.ts, never by a poll (ADR-0105): the sidecar's
// `organizations:changed` poke as a settings edit starts applying and again
// once its walk ends — so `tracked` and `reingesting` follow the edit — after
// a rename or an adopted Hub label (#288), and after a listing that changed
// the registry, the fleet's pull of the Hub's roster or the key listing
// (#366), so a learned row appears without a reload; plus every invalidation
// round's poke, which is also how a poke lost while the stream was down is
// caught up. Status frames also poke when a Limits answer changes or the
// roster still holds an older answer.
export function useOrganizations() {
  return useQuery({
    queryKey: organizationsQueryKey(),
    queryFn: ({ signal }) => fetchOrganizations(signal),
  });
}

// uuid → the Organization label to render, collision-suffixed across the
// whole roster. Empty until the roster answers; `organizationLabel` supplies
// the fallback for a uuid it lacks.
//
// The map keeps its identity until a uuid or label changes. The roster also
// carries each Organization's Limits status, whose `lastReadAt` and
// `lastSampleAt` move with every usage read, and the tables' column and search
// memos dep on this map — so it is memoized on the uuid/label pairs, the only
// fields it reads, never on the response object.
export function useOrganizationLabels(): Map<string, string> {
  const { data } = useOrganizations();
  const roster = data?.organizations;
  const pairsKey = (roster ?? []).map(({ uuid, label }) => `${uuid}\u0000${label}`).join("\u0001");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `pairsKey` holds every field the map reads from `roster`
  return useMemo(() => organizationLabelMap(roster ?? []), [pairsKey]);
}

// The first-launch seed (ADR-0098): the sidecar answers /api/organizations only
// once the first-launch home has settled, so `home` is its corpus-seeded pick
// (or the persisted setting). Persist it while the setting is null — never
// overwriting a choice — and, because it is what the sidecar is already using,
// the settings watch sees no change and nothing rebuilds. A failed write
// releases the latch so a later effect can retry; pending writes stay latched.
export function useSeedHomeOrganization(): void {
  const { data: settings } = useSettings();
  const { data } = useOrganizations();
  const update = useUpdateSettings();
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || settings === undefined || data === undefined) return;
    if (settings.homeOrganization !== null || data.home === null) return;
    seeded.current = true;
    const home = data.home;
    void update((current) =>
      current.homeOrganization === null ? { homeOrganization: home } : null,
    ).catch(() => {
      // useUpdateSettings already logs and toasts the failure. Re-arm without
      // triggering a render loop while the underlying write error persists.
      seeded.current = false;
    });
  }, [settings, data, update]);
}
