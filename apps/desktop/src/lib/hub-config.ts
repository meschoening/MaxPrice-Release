import { invoke } from "@tauri-apps/api/core";
import { normalizeHubUrl } from "@maxprice/shared";
import { getSidecarUrl } from "@/lib/sidecar";
import { usageAuthHeaders } from "@/lib/usage-credential";
import { insideTauri } from "@/lib/tauri";

// Hub opt-in plumbing (ADR-0035/0037), mirroring usage-credential.ts: the URL
// is a settings.json field, the OPTIONAL password a keychain item; both push
// to the sidecar over loopback, which owns the actual hub connection.

export async function readHubPassword(): Promise<string | null> {
  return await invoke<string | null>("get_hub_password");
}

export async function writeHubPassword(password: string | null): Promise<void> {
  await invoke("set_hub_password", { value: password });
}

// Pure derivation of the url/password fields sent to the sidecar. An empty url
// disables the hub (both fields null). The password is independently optional
// (ADR-0037): empty/null collapses to null — a passwordless connect to an open
// hub — never to "hub off".
export function deriveHubConfigBody(
  url: string,
  password: string | null,
): { url: string | null; password: string | null } {
  // Normalize at this shared chokepoint so a hand-edited settings.json with a
  // bare host (e.g. "my-box.tailnet.ts.net") gets a scheme + default port
  // BEFORE it reaches the sidecar's fetch — an un-normalized bare host throws
  // ERR_INVALID_URL there, swallowed into the generic fallback state (F31).
  // normalizeHubUrl("") === "" preserves the hub-off path and an
  // already-normalized URL is idempotent; genuinely unparseable input falls
  // through raw so the sidecar's own error still surfaces.
  let normalizedUrl = url;
  try {
    normalizedUrl = normalizeHubUrl(url);
  } catch {
    /* keep the raw value; the sidecar surfaces the parse failure */
  }
  const effectiveUrl = normalizedUrl === "" ? null : normalizedUrl;
  const effectivePassword = password === null || password === "" ? null : password;
  if (effectiveUrl === null) return { url: null, password: null };
  return { url: effectiveUrl, password: effectivePassword };
}

// `autoHeal` rides along whenever the hub is on; the sidecar ignores it when off.
export async function pushHubConfigToSidecar(
  url: string,
  password: string | null,
  autoHeal: boolean,
): Promise<void> {
  const base = await getSidecarUrl();
  const body = deriveHubConfigBody(url, password);
  const res = await fetch(`${base}/api/hub/config`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await usageAuthHeaders()) },
    body: JSON.stringify({ ...body, autoHeal }),
  });
  if (!res.ok) throw new Error(`hub config push ${res.status}`);
}

// One place for the hub teardown sequence shared by Settings → Reset and the
// hub section's Disconnect (F36/F46): clear the keychain password (Tauri-only —
// the keychain needs the host), persist the caller's settings change, then push
// hub-off to the sidecar. Sequential awaits give the keychain → settings → push
// ordering both callers rely on; each caller supplies its own settings payload
// (an empty hubUrl for Disconnect, DEFAULT_SETTINGS for Reset). An empty url
// makes the push send both fields null; autoHeal is ignored while the hub is off.
export async function disconnectHub(updateSettings: () => Promise<unknown>): Promise<void> {
  if (insideTauri()) await writeHubPassword(null);
  await updateSettings();
  await pushHubConfigToSidecar("", null, true);
}
