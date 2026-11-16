import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  buildUsageKeysUrl,
  usageKeysQueryKey,
  usageKeysResponseSchema,
  type UsageKeysResponse,
} from "@maxprice/shared";
import { getSidecarUrl } from "@/lib/sidecar";
import { moveLegacy } from "@/lib/credential-ops";
import { tauriCredentialIo, usageAuthHeaders } from "@/lib/usage-credential";

// GET /api/usage/keys (#633, ADR-0138 §12): the keyset the sidecar holds, each
// key's connection and the legacy key's resolved Account. Never a key. Behind
// the usage guard, so it sends `x-maxprice-auth`. Kept fresh by live-stream.ts's
// `usage-keys:changed` poke. Key and URL live in shared (ADR-0004).
export async function fetchUsageKeys(signal?: AbortSignal): Promise<UsageKeysResponse> {
  const base = await getSidecarUrl();
  const res = await fetch(buildUsageKeysUrl(base), {
    signal,
    headers: await usageAuthHeaders(),
  });
  if (!res.ok) throw new Error(`usage keys ${res.status}`);
  return usageKeysResponseSchema.parse(await res.json());
}

export function useUsageKeys() {
  return useQuery({
    queryKey: usageKeysQueryKey(),
    queryFn: ({ signal }) => fetchUsageKeys(signal),
  });
}

// How many held keys are expired, the legacy key included: the count the
// reconnect hint names (ADR-0138 §8).
export function expiredKeyCount(report: UsageKeysResponse | undefined): number {
  if (report === undefined) return 0;
  const keys = report.keys.filter((k) => k.connection === "expired").length;
  return keys + (report.legacy?.connection === "expired" ? 1 : 0);
}

// The upgrade's move (ADR-0138 §12): once the sidecar reports the legacy
// key's Account, move it into that Account's entry (`moveLegacy`). The
// sidecar retries the resolution at each boot and after each successful read,
// and each resolution reaches here through `usage-keys:changed`. Latched while
// a move is in flight. A failed move (a keychain write) leaves the legacy entry
// as it was, and the next boot's report, resolved again, retries it.
export function useLegacyMove(): void {
  const { data } = useUsageKeys();
  const moving = useRef(false);
  const accountUuid = data?.legacy?.accountUuid ?? null;
  useEffect(() => {
    if (accountUuid === null || moving.current) return;
    moving.current = true;
    void moveLegacy(accountUuid, tauriCredentialIo)
      .catch(() => {
        /* the legacy entry stays; the next report retries */
      })
      .finally(() => {
        moving.current = false;
      });
  }, [accountUuid]);
}
