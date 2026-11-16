import {
  HUB_CREDENTIALS_PATH,
  HUB_GATEWAYS_PATH,
  HUB_ORGANIZATIONS_PATH,
  HUB_PROTOCOL_VERSION,
  LABEL_DIRECTORY_PATH,
  hubCompactResponseSchema,
  hubCredentialAckSchema,
  gatewayConnectResponseSchema,
  hubCredentialPath,
  hubClientsResponseSchema,
  hubGatewayPath,
  hubLabelDirectorySchema,
  hubMachinesResponseSchema,
  hubOrganizationsResponseSchema,
  hubStatusSchema,
  type HubClientsResponse,
  type GatewayConnectRequest,
  type GatewayConnectResponse,
  type HubCredentialAck,
  type HubLabelDirectory,
  type HubMachinesResponse,
  type HubOrganizationsResponse,
  type HubStatus,
  labelDirectoryEntryPath,
} from "@maxprice/shared";
import { getOperatorToken, getHubUrl } from "./tauri";

// The webview's HTTP entry to its own embedded daemon (ADR-0036). Resolves the
// loopback URL + per-launch operator secret from the Tauri shell (Phase 2),
// then issues a plain fetch with `Authorization: Bearer <secret>`.
//
// It attaches NO `x-maxprice-machine` / `x-maxprice-hostname` header — the
// console is not a fleet sidecar; a header-less credential POST is what makes
// the Hub record the key's `source` as "local" (the acceptance check).
export async function hubFetch(path: string, init?: RequestInit): Promise<Response> {
  const [base, token] = await Promise.all([getHubUrl(), getOperatorToken()]);
  const url = path.startsWith("http") ? path : `${base.replace(/\/$/, "")}${path}`;
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("x-maxprice-protocol", String(HUB_PROTOCOL_VERSION));
  return fetch(url, { ...init, headers });
}

// --- /api/status: ADR-0004 four-piece (no query params) ---
export function hubStatusQueryKey(): readonly ["hub-status"] {
  return ["hub-status"] as const;
}
export function buildHubStatusUrl(): string {
  return "/api/status";
}
export async function fetchHubStatus(signal?: AbortSignal): Promise<HubStatus> {
  const res = await hubFetch(buildHubStatusUrl(), { signal });
  if (!res.ok) throw new Error(`/api/status ${res.status}: ${await res.text()}`);
  return hubStatusSchema.parse(await res.json());
}

// --- /api/clients: ADR-0004 four-piece ---
export function hubClientsQueryKey(): readonly ["hub-clients"] {
  return ["hub-clients"] as const;
}
export function buildHubClientsUrl(): string {
  return "/api/clients";
}
export async function fetchHubClients(signal?: AbortSignal): Promise<HubClientsResponse> {
  const res = await hubFetch(buildHubClientsUrl(), { signal });
  if (!res.ok) throw new Error(`/api/clients ${res.status}: ${await res.text()}`);
  return hubClientsResponseSchema.parse(await res.json());
}

// --- /api/machines: ADR-0004 four-piece (M7). Returns null on a 404 — the
// pre-event-sync-daemon probe; the App swaps to the M3 roster card on null.
export function hubMachinesQueryKey(): readonly ["hub-machines"] {
  return ["hub-machines"] as const;
}
export function buildHubMachinesUrl(): string {
  return "/api/machines";
}
export async function fetchHubMachines(signal?: AbortSignal): Promise<HubMachinesResponse | null> {
  const res = await hubFetch(buildHubMachinesUrl(), { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/api/machines ${res.status}: ${await res.text()}`);
  return hubMachinesResponseSchema.parse(await res.json());
}

// --- /api/organizations: ADR-0004 four-piece (#294). The Hub's roster joined
// with the Label directory's Organization labels (its Limits answers are the
// status's Memberships, ADR-0139 §9). No 404
// degrade: the console ships in its daemon's artifact, so the route is there.
export function hubOrganizationsQueryKey(): readonly ["hub-organizations"] {
  return ["hub-organizations"] as const;
}
export function buildHubOrganizationsUrl(): string {
  return HUB_ORGANIZATIONS_PATH;
}
export async function fetchHubOrganizations(
  signal?: AbortSignal,
): Promise<HubOrganizationsResponse> {
  const res = await hubFetch(buildHubOrganizationsUrl(), { signal });
  if (!res.ok) throw new Error(`${HUB_ORGANIZATIONS_PATH} ${res.status}: ${await res.text()}`);
  return hubOrganizationsResponseSchema.parse(await res.json());
}

// --- /api/label-directory: ADR-0004 four-piece (#635). The fleet's Label
// directory, read for its Account labels: the console resolves an Account's
// title through it (`hubAccountLabel`), as HubStatus carries no label
// (ADR-0139 §9). No 404 degrade, as above.
export function hubLabelDirectoryQueryKey(): readonly ["hub-label-directory"] {
  return ["hub-label-directory"] as const;
}
export function buildHubLabelDirectoryUrl(): string {
  return LABEL_DIRECTORY_PATH;
}
export async function fetchHubLabelDirectory(signal?: AbortSignal): Promise<HubLabelDirectory> {
  const res = await hubFetch(buildHubLabelDirectoryUrl(), { signal });
  if (!res.ok) throw new Error(`${LABEL_DIRECTORY_PATH} ${res.status}: ${await res.text()}`);
  return hubLabelDirectorySchema.parse(await res.json());
}

// --- operator mutations (M7). A non-2xx throws the pinned envelope's `error`
// string when parseable (the card renders "name already in use: X" inline),
// else a status-code fallback.
async function mutate(path: string, init: RequestInit): Promise<void> {
  const res = await hubFetch(path, init);
  if (res.ok) return;
  let message = `${path} ${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // keep the status fallback
  }
  throw new Error(message);
}
const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
export function renameMachine(machineId: string, name: string): Promise<void> {
  return mutate(`/api/machines/${encodeURIComponent(machineId)}/name`, jsonPost({ name }));
}
export function mergeMachine(machineId: string, into: string): Promise<void> {
  return mutate(`/api/machines/${encodeURIComponent(machineId)}/merge`, jsonPost({ into }));
}
export async function purgeMachine(machineId: string): Promise<void> {
  const key = `maxprice-purge:${machineId}`;
  const operationId = localStorage.getItem(key) ?? crypto.randomUUID();
  localStorage.setItem(key, operationId);
  await mutate(`/api/machines/${encodeURIComponent(machineId)}`, {
    ...jsonPost({ operationId }),
    method: "DELETE",
  });
  localStorage.removeItem(key);
}
// The operator's rename through the Label directory (#294, #635); a null
// label clears it back to the resolved default. The Hub's refusals carry its
// words.
export function renameOrganization(uuid: string, label: string | null): Promise<void> {
  return mutate(labelDirectoryEntryPath("organizations", uuid), {
    ...jsonPost({ label }),
    method: "PUT",
  });
}
// The operator's Account rename (ADR-0136 §7, ADR-0139 §7, #614 §2): the
// Label directory's account entry; a null label clears it back to
// `Account <first 8>`.
export function renameAccount(accountUuid: string, label: string | null): Promise<void> {
  return mutate(labelDirectoryEntryPath("accounts", accountUuid), {
    ...jsonPost({ label }),
    method: "PUT",
  });
}
// --- the Hub's keys (ADR-0139 §4). Save posts the key alone; the Hub learns
// its Account from claude.ai and answers it. Clear removes one entry: an
// Account's key by its uuid, or the unmoved legacy key (null). A refusal
// throws the Hub's status and body, the card's inline error.
async function credentialRequest(path: string, init: RequestInit): Promise<Response> {
  const res = await hubFetch(path, init);
  if (!res.ok) throw new Error(`credential ${res.status}: ${await res.text()}`);
  return res;
}
export async function saveCredential(sessionKey: string): Promise<HubCredentialAck> {
  const res = await credentialRequest(HUB_CREDENTIALS_PATH, jsonPost({ sessionKey }));
  return hubCredentialAckSchema.parse(await res.json());
}
export async function clearCredential(accountUuid: string | null): Promise<void> {
  await credentialRequest(hubCredentialPath(accountUuid), { method: "DELETE" });
}

// --- the Hub's Gateways (ADR-0141 §7, §8). Connect posts the URL and the
// management key; the Hub checks the Gateway and answers either the Gateway
// with Connect's warnings or why the check failed, both a 200. Remove is the
// Hub's alone: a client never removes a Gateway there.
export async function connectGateway(
  request: GatewayConnectRequest,
): Promise<GatewayConnectResponse> {
  const res = await hubFetch(HUB_GATEWAYS_PATH, jsonPost(request));
  if (!res.ok) throw new Error(`${HUB_GATEWAYS_PATH} ${res.status}: ${await res.text()}`);
  return gatewayConnectResponseSchema.parse(await res.json());
}
export function removeGateway(id: string): Promise<void> {
  return mutate(hubGatewayPath(id), { method: "DELETE" });
}

export async function compactStore(): Promise<{ freedBytes: number }> {
  const response = await hubFetch("/api/store/compact", { method: "POST" });
  if (!response.ok) throw new Error(`Compaction failed (${response.status})`);
  return hubCompactResponseSchema.parse(await response.json());
}
