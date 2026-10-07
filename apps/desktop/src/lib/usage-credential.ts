import { invoke } from "@tauri-apps/api/core";
import {
  discoverOrgsResponseSchema,
  storedUsageCredentialSchema,
  type DiscoveredOrg,
  type StoredUsageCredential,
} from "@maxprice/shared";
import { getSidecarUrl } from "@/lib/sidecar";
import { insideTauri } from "@/lib/tauri";

// Every guarded POST on the sidecar requires an `x-maxprice-auth` header — the
// two usage endpoints, hub config, and (since ADR-0059's rescan gained a corpus
// walk plus a fleet pull) `/api/rescan`. The name is historical: this is the
// shared sidecar auth posture, not a usage-only one. But it applies only under
// Tauri, where the Rust shell minted a per-launch token and set the env var the
// sidecar enforces against (ADR-0023; review f22). Standalone-dev runs outside
// Tauri with no token and no enforcement, so we send no header there.
export async function usageAuthHeaders(): Promise<Record<string, string>> {
  if (!insideTauri()) return {};
  try {
    const token = await invoke<string>("get_usage_auth_token");
    return { "x-maxprice-auth": token };
  } catch {
    return {};
  }
}

// Bridges the OS keychain (Tauri get/set_credential commands, ADR-0023) and the
// sidecar's in-memory credential. The renderer is the only keychain client; on
// launch and on every change it reads the credential and pushes it to the
// sidecar over loopback so the poller can run.

// A key-only blob, or a legacy pre-#283 blob that parses with its `orgId`
// intact — the evidence the sidecar's one-time history stamp needs (ADR-0104).
export async function readCredential(): Promise<StoredUsageCredential | null> {
  const raw = await invoke<string | null>("get_credential");
  if (raw === null) return null;
  try {
    const parsed = storedUsageCredentialSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // corrupt keychain value — treat as not configured
  }
}

export async function writeCredential(cred: StoredUsageCredential | null): Promise<void> {
  await invoke("set_credential", { value: cred === null ? null : JSON.stringify(cred) });
}

// Push the stored blob to the sidecar, verbatim, so its poller can run. Throws
// on a non-2xx so the Settings "Connect" flow can surface failure; the
// launch-time caller should .catch() it (a down sidecar at boot is non-fatal).
export async function pushCredentialToSidecar(cred: StoredUsageCredential | null): Promise<void> {
  const base = await getSidecarUrl();
  const res = await fetch(`${base}/api/usage/credential`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await usageAuthHeaders()) },
    body: cred === null ? "null" : JSON.stringify(cred),
  });
  if (!res.ok) throw new Error(`credential push ${res.status}`);
}

// Hand a stored credential to the sidecar. A legacy blob's `orgId` leaves the
// keychain only after the sidecar acknowledges the push that carried it — the ack
// means the usage history it names is stamped (#279, ADR-0104). A failed push, or
// a crash between the ack and the rewrite, leaves the blob as it was: the next
// push stamps again, and a stamp with nothing unstamped does no I/O.
export async function syncCredential(
  stored: StoredUsageCredential,
  io: {
    push: (cred: StoredUsageCredential) => Promise<void>;
    write: (cred: StoredUsageCredential) => Promise<void>;
  } = { push: pushCredentialToSidecar, write: writeCredential },
): Promise<void> {
  await io.push(stored);
  if (stored.orgId !== undefined) await io.write({ sessionKey: stored.sessionKey });
}

// Connect replaces the key and keeps any legacy `orgId` not yet acknowledged, so
// a reconnect after a failed stamp still stamps with what the old poller read.
export function credentialForConnect(
  sessionKey: string,
  existing: StoredUsageCredential | null,
): StoredUsageCredential {
  return existing?.orgId === undefined ? { sessionKey } : { sessionKey, orgId: existing.orgId };
}

// Discover the orgs reachable with `sessionKey`, each carrying its roster hints
// and what its usage endpoint answered (`limits`, #270). The Settings "Connect"
// flow runs it before storing the key: it proves the key and seeds the roster
// with every Organization the key can see (ADR-0104). Returns
// `{ orgs: [], error: "expired" | "error" }` on failure so the UI can surface a
// targeted message without catching.
export async function discoverOrgsViaSidecar(sessionKey: string): Promise<{
  orgs: DiscoveredOrg[];
  error: string | null;
}> {
  const base = await getSidecarUrl();
  const res = await fetch(`${base}/api/usage/discover-orgs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await usageAuthHeaders()) },
    body: JSON.stringify({ sessionKey }),
  });
  if (!res.ok) return { orgs: [], error: "error" };
  const parsed = discoverOrgsResponseSchema.safeParse(await res.json());
  if (!parsed.success) return { orgs: [], error: "error" };
  // Map the wire `failureKind` channel onto this function's `error` key so the
  // sole consumer (settings/usage-connection-section.tsx) stays untouched.
  return { orgs: parsed.data.orgs, error: parsed.data.failureKind };
}
