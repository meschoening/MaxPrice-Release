import { invoke } from "@tauri-apps/api/core";
import {
  errorResponseSchema,
  gatewayCheckResponseSchema,
  gatewayId,
  gatewayIdSchema,
  gatewayManagementKeySchema,
  gatewayUrlSchema,
  normalizeGatewayUrl,
  SIDECAR_GATEWAYS_CHECK_PATH,
  SIDECAR_GATEWAYS_CONFIG_PATH,
  type GatewayCheckResponse,
  type GatewaysConfigRequest,
} from "@maxprice/shared";
import { z } from "zod";
import { getSidecarUrl } from "@/lib/sidecar";
import { insideTauri } from "@/lib/tauri";
import { usageAuthHeaders } from "@/lib/usage-credential";

// Bridges the OS keychain's Gateways and the sidecar's in-memory set
// (ADR-0141 §7; #651), as usage-credential.ts does for session keys. Each
// Gateway's management key is its own keychain entry,
// `gateway-credential/<id>`, with its URL listed in gateways.json
// (gateway_credentials.rs). On launch and on every change the renderer reads
// every Gateway and pushes the whole set to `POST /api/gateways/config`, so
// the sidecar can drain them. The operations run over an injected io
// (`GatewayIo`), one at a time; `tauriGatewayIo` is the Tauri binding, and the
// exported wrappers no-op outside Tauri, where there is no keychain.

export type GatewayCredential = { id: string; url: string; managementKey: string };

export type GatewayIo = {
  list: () => Promise<GatewayCredential[]>;
  set: (gateway: GatewayCredential) => Promise<void>;
  remove: (id: string) => Promise<void>;
  push: (body: GatewaysConfigRequest) => Promise<void>;
};

const gatewayCredentialSchema = z.object({
  id: gatewayIdSchema,
  url: gatewayUrlSchema,
  managementKey: gatewayManagementKeySchema,
});

// The keychain's answer, each entry checked; one that does not parse is
// skipped (as a corrupt Account entry is).
export function parseGatewayCredentials(raw: ReadonlyArray<unknown>): GatewayCredential[] {
  const out: GatewayCredential[] = [];
  for (const item of raw) {
    const parsed = gatewayCredentialSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function gatewayConfigBody(
  gateways: ReadonlyArray<GatewayCredential>,
): GatewaysConfigRequest {
  return { gateways: gateways.map(({ url, managementKey }) => ({ url, managementKey })) };
}

// Every read-modify-write runs after the one before it settles.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(op: () => Promise<T>): Promise<T> {
  const next = queue.then(op, op);
  queue = next.catch(() => undefined);
  return next;
}

// Read every Gateway and push the whole set.
export function syncGateways(io: GatewayIo): Promise<void> {
  return serialized(async () => {
    await io.push(gatewayConfigBody(await io.list()));
  });
}

// Store one Gateway under its normalized URL's id, then push the set. Throws
// on a URL or key the shared schemas refuse. Answers the Gateway's id.
export function writeGateway(io: GatewayIo, url: string, managementKey: string): Promise<string> {
  const normalized = gatewayUrlSchema.safeParse(url).success ? normalizeGatewayUrl(url) : null;
  if (normalized === null) return Promise.reject(new Error("not a Gateway URL"));
  if (!gatewayManagementKeySchema.safeParse(managementKey).success)
    return Promise.reject(new Error("not a management key"));
  const id = gatewayId(normalized);
  return serialized(async () => {
    await io.set({ id, url: normalized, managementKey });
    await io.push(gatewayConfigBody(await io.list()));
    return id;
  });
}

// Remove one Gateway by id, then push the set.
export function deleteGateway(io: GatewayIo, id: string): Promise<void> {
  if (!gatewayIdSchema.safeParse(id).success) return Promise.reject(new Error("not a Gateway id"));
  return serialized(async () => {
    await io.remove(id);
    await io.push(gatewayConfigBody(await io.list()));
  });
}

// Throws on a non-2xx, so a caller can surface it; the launch push swallows it.
export async function pushGatewayConfigToSidecar(body: GatewaysConfigRequest): Promise<void> {
  const base = await getSidecarUrl();
  const res = await fetch(`${base}${SIDECAR_GATEWAYS_CONFIG_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await usageAuthHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gateway config push ${res.status}`);
}

export const tauriGatewayIo: GatewayIo = {
  list: async () => parseGatewayCredentials(await invoke<unknown[]>("list_gateway_credentials")),
  set: async ({ id, url, managementKey }) => {
    await invoke("set_gateway_credential", { id, url, managementKey });
  },
  remove: async (id) => {
    await invoke("delete_gateway_credential", { id });
  },
  push: pushGatewayConfigToSidecar,
};

// The launch push (Layout). Outside Tauri it does nothing.
export async function pushGatewaysAtLaunch(): Promise<void> {
  if (!insideTauri()) return;
  await syncGateways(tauriGatewayIo);
}

// Connect a Gateway on this machine (Settings, #639). Outside Tauri, null.
export async function setGatewayCredential(
  url: string,
  managementKey: string,
): Promise<string | null> {
  if (!insideTauri()) return null;
  return writeGateway(tauriGatewayIo, url, managementKey);
}

// Remove a Gateway from this machine (Settings, #639). Outside Tauri, nothing.
export async function removeGatewayCredential(id: string): Promise<void> {
  if (!insideTauri()) return;
  await deleteGateway(tauriGatewayIo, id);
}

// Connect's checks (ADR-0141 §7, as amended on 2026-11-10): the sidecar
// reads the Gateway's credential list once with the key and holds nothing.
// Answers `{ ok: true, warnings }` (both warnings, every time) or
// `{ ok: false, failure }`: `unreachable`, `unauthorized` or `error`. A
// request the sidecar refuses (a URL or key its schema refuses, the auth
// guard) rejects with the envelope's `error`. Works outside Tauri too: it
// needs no keychain.
export async function checkGateway(
  url: string,
  managementKey: string,
): Promise<GatewayCheckResponse> {
  const base = await getSidecarUrl();
  const res = await fetch(`${base}${SIDECAR_GATEWAYS_CHECK_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await usageAuthHeaders()) },
    body: JSON.stringify({ url, managementKey }),
  });
  if (!res.ok) {
    const envelope = errorResponseSchema.safeParse(await res.json().catch(() => null));
    throw new Error(envelope.success ? envelope.data.error : `gateway check ${res.status}`);
  }
  return gatewayCheckResponseSchema.parse(await res.json());
}
