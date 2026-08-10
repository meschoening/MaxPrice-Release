import { invoke } from "@tauri-apps/api/core";
import {
  discoverOrgsResponseSchema,
  usageCredentialSchema,
  type UsageCredential,
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

export async function readCredential(): Promise<UsageCredential | null> {
  const raw = await invoke<string | null>("get_credential");
  if (raw === null) return null;
  try {
    const parsed = usageCredentialSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // corrupt keychain value — treat as not configured
  }
}

export async function writeCredential(cred: UsageCredential | null): Promise<void> {
  await invoke("set_credential", { value: cred === null ? null : JSON.stringify(cred) });
}

// Push the current credential to the sidecar so its poller can run. Throws on a
// non-2xx so the Settings "Connect" flow can surface failure; the launch-time
// caller should .catch() it (a down sidecar at boot is non-fatal).
export async function pushCredentialToSidecar(cred: UsageCredential | null): Promise<void> {
  const base = await getSidecarUrl();
  const res = await fetch(`${base}/api/usage/credential`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await usageAuthHeaders()) },
    body: cred === null ? "null" : JSON.stringify(cred),
  });
  if (!res.ok) throw new Error(`credential push ${res.status}`);
}

// Discover the orgs reachable with `sessionKey`. Used by the Settings
// "Connect" flow to resolve the org id before storing the credential
// (ADR-0023). Returns `{ orgs: [], error: "expired" | "error" }` on failure
// so the UI can surface a targeted message without catching.
export async function discoverOrgsViaSidecar(sessionKey: string): Promise<{
  orgs: Array<{ id: string; name: string; capabilities: string[] }>;
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
