import { z } from "zod";
import type { UsageSample } from "@maxprice/shared";

// Outbound client for Anthropic's undocumented subscription-usage endpoint
// (ADR-0023). Best-effort, mirrors pricing-refresh.ts: injected fetch, timeout,
// never throws. Maps the upstream JSON onto the normalized UsageSample.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 10_000;
// Exported so the poller/hub can surface it and tests can assert it. The
// override exists for the fake-claude E2E rig (ADR-0035) — production callers
// omit it.
export const DEFAULT_CLAUDE_BASE_URL = "https://claude.ai/api";

// Confirmed by the Task 1 spike: each window carries `utilization` (0-100) +
// `resets_at` (ISO, +00:00 offset). `.passthrough()` keeps the many other
// upstream fields (seven_day_opus, seven_day_sonnet, extra_usage, …) from
// failing validation — we read only two. `resets_at` tolerates null
// (ADR-0029): a plausible no-window-in-flight state right after an
// out-of-band reset — never yet observed, but it must not fail the whole
// poll into a misleading "error" connection state.
const upstreamWindowSchema = z.object({
  utilization: z.number(),
  resets_at: z.string().nullable(),
});
const upstreamUsageSchema = z
  .object({ five_hour: upstreamWindowSchema, seven_day: upstreamWindowSchema })
  .passthrough();

// Orgs carry `capabilities` so the caller can pick the SUBSCRIPTION org, not an
// API-only org (the spike showed the user has both; the API org does not return
// subscription limits). `.catch([])` tolerates an org missing the field.
const upstreamOrgsSchema = z.array(
  z
    .object({
      uuid: z.string(),
      name: z.string(),
      capabilities: z.array(z.string()).catch([]),
    })
    .passthrough(),
);

export type UsageFailKind = "expired" | "error";
// `sample: null` is the successful-but-no-sample case (ADR-0029): a window
// reported `resets_at: null`, so there is nothing to persist — but auth is
// healthy and the connection stays "connected".
export type FetchUsageResult =
  | { ok: true; sample: UsageSample | null }
  | { ok: false; kind: UsageFailKind };

export type FetchUsageOptions = {
  sessionKey: string;
  orgId: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  nowIso?: () => string;
  baseUrl?: string;
  // External abort seam (F8): the poller threads its per-poll controller here
  // so stop() can cancel an in-flight fetch instead of stalling shutdown on the
  // timeout below. Composed WITH the timeout — whichever fires first wins.
  signal?: AbortSignal;
};

function authHeaders(sessionKey: string): Record<string, string> {
  // Cookie auth confirmed by the spike (ADR-0023): GET with the sessionKey
  // cookie returns 200. Both callers are bodyless GETs, so no content-type
  // header — it's meaningless here and could trip a strict WAF.
  return { cookie: `sessionKey=${sessionKey}` };
}

// The sessionKey is interpolated into the Cookie header verbatim. Reject any
// value carrying a CR/LF or other control char before it reaches the header —
// a header-injection guard, not a charset allowlist (we don't control the exact
// session-cookie charset, so an allowlist risks false-rejecting a legit value).
function isHeaderSafe(v: string): boolean {
  // No control chars (CR/LF and the rest of 0x00–0x1F). Char-code scan rather
  // than a control-char regex literal (which trips eslint's no-control-regex).
  for (let i = 0; i < v.length; i++) {
    if (v.charCodeAt(i) < 0x20) return false;
  }
  return true;
}

export async function fetchUsage(opts: FetchUsageOptions): Promise<FetchUsageResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const base = opts.baseUrl ?? DEFAULT_CLAUDE_BASE_URL;
  if (!isHeaderSafe(opts.sessionKey)) return { ok: false, kind: "error" };
  try {
    const res = await fetchImpl(`${base}/organizations/${encodeURIComponent(opts.orgId)}/usage`, {
      headers: authHeaders(opts.sessionKey),
      signal: opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, kind: "expired" };
    if (!res.ok) return { ok: false, kind: "error" };
    const parsed = upstreamUsageSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("[usage-core] usage shape mismatch:", parsed.error.message);
      return { ok: false, kind: "error" };
    }
    const u = parsed.data;
    // Conscious trade-off (ADR-0029): a partially-null payload appends no sample
    // even if `five_hour` alone is valid with util>0 — keeping `UsageSample`'s
    // required-string `weekly.resetAt` shape rather than widening it. Never yet
    // observed; revisit only if a real five_hour-valid / seven_day-null payload
    // ever shows up.
    if (u.five_hour.resets_at === null || u.seven_day.resets_at === null) {
      console.warn("[usage-core] usage poll: a window has no reset in flight — sample skipped");
      return { ok: true, sample: null };
    }
    const sample: UsageSample = {
      capturedAt: nowIso(),
      fiveHour: { utilizationPct: u.five_hour.utilization, resetAt: u.five_hour.resets_at },
      weekly: { utilizationPct: u.seven_day.utilization, resetAt: u.seven_day.resets_at },
    };
    return { ok: true, sample };
  } catch (err) {
    console.warn(
      "[usage-core] usage fetch failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, kind: "error" };
  }
}

export type DiscoveredOrg = { id: string; name: string; capabilities: string[] };
export type DiscoverOrgResult =
  | { ok: true; orgs: DiscoveredOrg[] }
  | { ok: false; kind: UsageFailKind };

export async function discoverOrg(opts: {
  sessionKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  baseUrl?: string;
}): Promise<DiscoverOrgResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = opts.baseUrl ?? DEFAULT_CLAUDE_BASE_URL;
  if (!isHeaderSafe(opts.sessionKey)) return { ok: false, kind: "error" };
  try {
    const res = await fetchImpl(`${base}/organizations`, {
      headers: authHeaders(opts.sessionKey),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, kind: "expired" };
    if (!res.ok) return { ok: false, kind: "error" };
    const parsed = upstreamOrgsSchema.safeParse(await res.json());
    if (!parsed.success || parsed.data.length === 0) return { ok: false, kind: "error" };
    return {
      ok: true,
      orgs: parsed.data.map((o) => ({ id: o.uuid, name: o.name, capabilities: o.capabilities })),
    };
  } catch (err) {
    console.warn(
      "[usage-core] org discovery failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, kind: "error" };
  }
}
