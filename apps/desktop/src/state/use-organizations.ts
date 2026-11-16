import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ACCOUNTS_PATH,
  accountLabelPath,
  accountsResponseSchema,
  type AccountLabelRequest,
  errorResponseSchema,
  foldAccountsPatch,
  seedAccountsPatch,
  type AccountsResponse,
  ORGANIZATIONS_PATH,
  organizationLabelMap,
  organizationPath,
  organizationsResponseSchema,
  type OrganizationRenameRequest,
  type OrganizationsResponse,
  homeOrganizationOf,
  withHomeOrganization,
} from "@maxprice/shared";
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
    if (homeOrganizationOf(settings) !== null || data.home === null) return;
    seeded.current = true;
    const home = data.home;
    void update((current) =>
      homeOrganizationOf(current) === null
        ? { homeMemberships: withHomeOrganization(current, home) }
        : null,
    ).catch(() => {
      // useUpdateSettings already logs and toasts the failure. Re-arm without
      // triggering a render loop while the underlying write error persists.
      seeded.current = false;
    });
  }, [settings, data, update]);
}

// /api/accounts — every Account this machine knows (#631), with the Account
// seed and the Pending account folds the sidecar decided and cannot persist
// itself (ADR-0014), which `useSeedAccounts` persists. The Scope, the
// Account menu, Live's limit area and Settings › Accounts (#639,
// lib/accounts-view.ts) read its entries. Four-piece split per ADR-0004.
export function accountsQueryKey(): [string] {
  return ["accounts"];
}

export function buildAccountsUrl(base: string): string {
  return `${base}${ACCOUNTS_PATH}`;
}

export async function fetchAccounts(signal?: AbortSignal): Promise<AccountsResponse> {
  const base = await getSidecarUrl();
  const res = await fetch(buildAccountsUrl(base), { signal });
  if (!res.ok) throw new Error(`accounts ${res.status}`);
  return accountsResponseSchema.parse(await res.json());
}

export function buildAccountLabelUrl(base: string, accountUuid: string): string {
  return `${base}${accountLabelPath(accountUuid)}`;
}

// Label an Account, or clear its label back to the email as read here, else
// `Account <first 8>`, with `null` (PUT /api/accounts/:uuid/label, ADR-0136
// §7, #635). Resolves the fresh Account roster. A refusal (an empty or
// over-long label, one another Account here already shows, the Label
// directory's cap, or a target that is not an account uuid: a Pending
// account takes no label) rejects with the envelope's `error` as its
// message, so Settings can show it inline. Every window learns of it through
// the `accounts:changed` poke the sidecar emits.
export async function setAccountLabel(
  accountUuid: string,
  label: string | null,
): Promise<AccountsResponse> {
  const base = await getSidecarUrl();
  const headers = await usageAuthHeaders();
  const body: AccountLabelRequest = { label };
  const res = await fetch(buildAccountLabelUrl(base, accountUuid), {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const envelope = errorResponseSchema.safeParse(await res.json().catch(() => null));
    throw new Error(envelope.success ? envelope.data.error : `account label ${res.status}`);
  }
  return accountsResponseSchema.parse(await res.json());
}

// Kept fresh by live-stream.ts's `accounts:changed` poke, which the sidecar
// sends once its boot store installs, as a settings change starts and ends,
// when the pair table moves, and when any Membership's reading does (#637).
export function useAccounts() {
  return useQuery({
    queryKey: accountsQueryKey(),
    queryFn: ({ signal }) => fetchAccounts(signal),
  });
}

// The Account seed and the folds (#631 decision 2, ADR-0136 §4 and §8,
// ADR-0137 §1), as the Home seed above: persist what the sidecar is already
// using, so the settings watch sees no change and nothing rebuilds. The seed
// is written only while the file names no `trackedAccounts`, checked inside
// the write chain (`seedAccountsPatch`), and a fold only where the list still
// names its Pending key (`foldAccountsPatch`).
//
// The seed is one-shot, like the Home seed's latch: once queued it is never
// queued again by this hook, so a Reset, which leaves the file naming no
// list, is not undone by an answer still carrying the seed (the sidecar stops
// serving it once it has seen a list persisted, #631 review). Folds keep
// arriving as pairs are learned, so they latch only while a write is in
// flight. A failed write releases both, so a later effect can retry.
export function useSeedAccounts(): void {
  const { data: settings } = useSettings();
  const { data } = useAccounts();
  const update = useUpdateSettings();
  const latch = useRef({ seeded: false, writing: false });
  useEffect(() => {
    const state = latch.current;
    if (state.writing || settings === undefined || data === undefined) return;
    const seed = !state.seeded && settings.trackedAccounts === null ? data.seed : null;
    const folds = data.folds;
    if (seed === null && foldAccountsPatch(settings, folds) === null) return;
    state.writing = true;
    if (seed !== null) state.seeded = true;
    void update((current) => {
      if (seed !== null) {
        const patch = seedAccountsPatch(current, seed);
        if (patch !== null) return patch;
      }
      return foldAccountsPatch(current, folds);
    })
      .catch(() => {
        // useUpdateSettings already logs and toasts the failure.
        if (seed !== null) state.seeded = false;
      })
      .finally(() => {
        state.writing = false;
      });
  }, [settings, data, update]);
}
