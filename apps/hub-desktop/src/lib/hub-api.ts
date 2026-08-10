import {
  hubClientsResponseSchema,
  hubMachinesResponseSchema,
  hubStatusSchema,
  type HubClientsResponse,
  type HubMachinesResponse,
  type HubStatus,
} from "@maxprice/shared";
import { getOperatorToken, getHubUrl } from "./tauri";

// The webview's HTTP entry to its own embedded daemon (ADR-0036). Resolves the
// loopback URL + per-launch operator secret from the Tauri shell (Phase 2),
// then issues a plain fetch with `Authorization: Bearer <secret>`.
//
// It attaches NO `x-maxprice-machine` / `x-maxprice-hostname` header — the
// console is not a fleet sidecar; a header-less credential POST is what makes
// Phase 1 record `credentialSource = "local"` (the acceptance check).
export async function hubFetch(path: string, init?: RequestInit): Promise<Response> {
  const [base, token] = await Promise.all([getHubUrl(), getOperatorToken()]);
  const url = path.startsWith("http") ? path : `${base.replace(/\/$/, "")}${path}`;
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
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
export function purgeMachine(machineId: string): Promise<void> {
  return mutate(`/api/machines/${encodeURIComponent(machineId)}`, { method: "DELETE" });
}
export function compactStore(): Promise<void> {
  return mutate("/api/store/compact", { method: "POST" });
}
