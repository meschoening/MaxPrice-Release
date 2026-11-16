import { invoke } from "@tauri-apps/api/core";
import {
  discoverOrgsResponseSchema,
  storedUsageCredentialSchema,
  type AccountCredential,
  type DiscoveredOrg,
  type StoredUsageCredential,
  type UsageKeyset,
} from "@maxprice/shared";
import {
  parseAccountCredentials,
  type CredentialIo,
  type HeldAccountKey,
} from "@/lib/credential-ops";
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

// Bridges the OS keychain and the sidecar's in-memory keyset (ADR-0023, and
// since #633 ADR-0138 §6, §12). The renderer is the only keychain client: each
// Account's key in its own entry (`list_account_credentials` /
// `set_account_credential`, account_credentials.rs), and the one legacy entry
// (`get_credential` / `set_credential`) until its key moves into its
// Account's. On launch and on every change it reads what the keychain holds
// and pushes the whole keyset to the sidecar over loopback so the poller can
// run. These are its Tauri bindings (`tauriCredentialIo`); the operations
// over them, each read-modify-write one at a time, are credential-ops.ts's.

// The legacy entry: a key-only blob, or a pre-#283 blob that parses with its
// `orgId` intact — the evidence the sidecar's one-time history stamp needs
// (ADR-0104).
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

// Every Account's entry (`parseAccountCredentials` skips one that does not
// parse).
export async function readAccountCredentials(): Promise<HeldAccountKey[]> {
  const raw = await invoke<Array<{ accountUuid: string; value: string }>>(
    "list_account_credentials",
  );
  return parseAccountCredentials(raw);
}

export async function writeAccountCredential(
  accountUuid: string,
  entry: AccountCredential | null,
): Promise<void> {
  await invoke("set_account_credential", {
    accountUuid,
    value: entry === null ? null : JSON.stringify(entry),
  });
}

// Push the keyset to the sidecar so its poller can run; null clears it.
// Throws on a non-2xx so Connect can surface failure; the launch-time caller
// .catch()es it (a down sidecar at boot is non-fatal).
export async function pushKeysetToSidecar(keyset: UsageKeyset | null): Promise<void> {
  const base = await getSidecarUrl();
  const res = await fetch(`${base}/api/usage/credential`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await usageAuthHeaders()) },
    body: JSON.stringify(keyset),
  });
  if (!res.ok) throw new Error(`credential push ${res.status}`);
}

// The Tauri keychain and this sidecar, the io every renderer caller passes.
export const tauriCredentialIo: CredentialIo = {
  listAccounts: readAccountCredentials,
  setAccount: writeAccountCredential,
  readLegacy: readCredential,
  writeLegacy: writeCredential,
  push: pushKeysetToSidecar,
  now: () => new Date(),
};

// Discover the orgs reachable with `sessionKey`, each carrying its roster hints
// and what its usage endpoint answered (`limits`, #270). The Settings "Connect"
// flow runs it before storing the key: it proves the key and seeds the roster
// with every Organization the key can see (ADR-0104). Returns
// `{ orgs: [], error: "expired" | "error" }` on failure so the UI can surface a
// targeted message without catching.
export async function discoverOrgsViaSidecar(sessionKey: string): Promise<{
  orgs: DiscoveredOrg[];
  error: string | null;
  // The key's Account (ADR-0138 §2); null when its `/api/account` read failed.
  account: string | null;
}> {
  const base = await getSidecarUrl();
  const res = await fetch(`${base}/api/usage/discover-orgs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await usageAuthHeaders()) },
    body: JSON.stringify({ sessionKey }),
  });
  if (!res.ok) return { orgs: [], error: "error", account: null };
  const parsed = discoverOrgsResponseSchema.safeParse(await res.json());
  if (!parsed.success) return { orgs: [], error: "error", account: null };
  // Map the wire `failureKind` channel onto this function's `error` key, as
  // the sole consumer (Settings › Accounts' Connect, lib/connect-flow.ts)
  // reads it.
  return {
    orgs: parsed.data.orgs,
    error: parsed.data.failureKind,
    account: parsed.data.account?.accountUuid ?? null,
  };
}
