import { z } from "zod";
import type {
  DiscoveredOrg,
  ListedOrg,
  OrgLimitsAnswer,
  UsageReading,
  WindowState,
  WindowStates,
} from "@maxprice/shared";

// Outbound client for Anthropic's undocumented subscription-usage endpoint
// (ADR-0023). Best-effort, mirrors pricing-refresh.ts: injected fetch, timeout,
// never throws. Maps the upstream JSON onto the normalized UsageReading.

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
// (ADR-0029): the no-window-in-flight state, observed for real on an
// Enterprise org's `five_hour` (2026-09-17). The WHOLE window tolerates null
// too (#270): the same org's `seven_day` is the literal `null`, and that is
// "answered, no weekly window", never a shape mismatch — a tracked Enterprise
// org used to poll into a permanent "error" over it. Nullable is not optional:
// a payload missing the key outright is still the shape change ADR-0023's
// firebreak exists for. The three shapes are three Window states (#384): a
// null reset is an idle limit, a null window no limit, and `fetchUsage`
// reports which beside the reading, which keeps only windows in flight.
const upstreamWindowSchema = z
  .object({
    utilization: z.number(),
    resets_at: z.string().nullable(),
  })
  .nullable();
// The `limits[]` list (observed 2026-08-26; kinds re-confirmed by the
// 2026-09-17 probe): one entry per limit — `session` and `weekly_all` restate
// the two top-level windows, and `weekly_scoped` carries the scoped weekly
// one — each with `group`, `severity`, `is_active` beside the fields read
// here. The model-scoped entry names the family via `scope.model.display_name`
// ("Fable"; `scope.model.id` was null, so the display name is the only
// handle); an Enterprise org's `weekly_scoped` is SURFACE-scoped instead
// (`scope.model: null`, `scope.surface.display_name` set) and is skipped.
// `five_hour`/`seven_day` keep being read from their proven top-level fields;
// only the scoped window comes from here, and the whole list is optional so an
// older payload still parses. Entries are `.passthrough()` + `.catch` so one
// unexpected entry shape drops that entry rather than the poll.
const upstreamLimitSchema = z
  .object({
    kind: z.string(),
    percent: z.number(),
    resets_at: z.string().nullable(),
    scope: z
      .object({
        model: z.object({ display_name: z.string().nullable() }).passthrough().nullable(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();
const upstreamUsageSchema = z
  .object({
    five_hour: upstreamWindowSchema,
    seven_day: upstreamWindowSchema,
    limits: z.array(upstreamLimitSchema.nullable().catch(null)).optional(),
  })
  .passthrough();

// The model of a recognized scoped limit, independent of its reset. Surface
// scopes, unnamed models and malformed entries remain outside this contract.
function scopedModel(limit: z.infer<typeof upstreamLimitSchema> | null): string | null {
  if (limit === null || limit.kind !== "weekly_scoped") return null;
  const model = limit.scope?.model?.display_name;
  return typeof model === "string" && model !== "" ? model : null;
}

// The first `weekly_scoped` entry with a model scope and a reset in flight —
// the Model-scoped weekly limit. Exported for its tests.
export function modelScopedWindow(
  limits: z.infer<typeof upstreamUsageSchema>["limits"],
): UsageReading["weeklyModel"] {
  for (const limit of limits ?? []) {
    const model = scopedModel(limit);
    if (model === null || limit === null || limit.resets_at === null) continue;
    return { model, utilizationPct: limit.percent, resetAt: limit.resets_at };
  }
  return undefined;
}

// Orgs carry `capabilities` and four more fields a label may use (#268's
// resolver): roster hints. Readability is never judged from them — an
// Enterprise org carries `chat` too, so `discoverOrgs` below asks each org's
// usage endpoint (#270). The free-text `name` is never read: it can embed the
// account email (ADR-0098 §6). `.catch` makes every hint tolerate an org that
// omits it or sends another type.
const upstreamHintSchema = z.string().nullable().optional().catch(null);
const upstreamOrgsSchema = z.array(
  z
    .object({
      uuid: z.string(),
      capabilities: z.array(z.string()).catch([]),
      rate_limit_tier: upstreamHintSchema,
      billing_type: upstreamHintSchema,
      raven_type: upstreamHintSchema,
      analytics_subscription_plan: upstreamHintSchema,
    })
    .passthrough(),
);

// `expired` — 401, the session key is dead; `forbidden` — 403, this key may
// not read THIS org's usage (an API-only org answers so, with
// `x-should-retry: false`), which says nothing about the key (#270); `error` —
// everything else.
export type UsageFailKind = "expired" | "forbidden" | "error";
// Each window survives independently; null means none has a reset in flight.
// `windowStates` keeps what `sample` cannot: whether a window not in flight is
// an idle limit or no limit at all (#384).
export type FetchUsageResult =
  | {
      ok: true;
      sample: UsageReading | null;
      windowStates: WindowStates;
      // Parser-local existence, not utilization: an idle cap has no reading.
      hasModelScopedLimit: boolean;
    }
  | { ok: false; kind: UsageFailKind };

// One primary window's Window state, from its shape alone (#384).
function windowState(window: z.infer<typeof upstreamWindowSchema>): WindowState {
  if (window === null) return "absent";
  return window.resets_at === null ? "idle" : "active";
}

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
    if (res.status === 401) return { ok: false, kind: "expired" };
    if (res.status === 403) return { ok: false, kind: "forbidden" };
    if (!res.ok) return { ok: false, kind: "error" };
    const parsed = upstreamUsageSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("[usage-core] usage shape mismatch:", parsed.error.message);
      return { ok: false, kind: "error" };
    }
    const u = parsed.data;
    const sample: UsageReading = {
      capturedAt: nowIso(),
      fiveHour:
        u.five_hour?.resets_at == null
          ? null
          : {
              utilizationPct: u.five_hour.utilization,
              resetAt: u.five_hour.resets_at,
            },
      weekly:
        u.seven_day?.resets_at == null
          ? null
          : {
              utilizationPct: u.seven_day.utilization,
              resetAt: u.seven_day.resets_at,
            },
    };
    const weeklyModel = modelScopedWindow(u.limits);
    if (weeklyModel !== undefined) sample.weeklyModel = weeklyModel;
    return {
      ok: true,
      sample: sample.fiveHour === null && sample.weekly === null && !weeklyModel ? null : sample,
      windowStates: { fiveHour: windowState(u.five_hour), weekly: windowState(u.seven_day) },
      hasModelScopedLimit: u.limits?.some((limit) => scopedModel(limit) !== null) ?? false,
    };
  } catch (err) {
    console.warn(
      "[usage-core] usage fetch failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, kind: "error" };
  }
}

// The listing's failure kinds. A 403 on GET /organizations is not a per-org
// refusal — the key cannot enumerate orgs at all — so it stays `expired` here.
export type DiscoverFailKind = "expired" | "error";
export type ListOrgsResult =
  | { ok: true; orgs: ListedOrg[] }
  | { ok: false; kind: DiscoverFailKind };
// One org with what its usage endpoint answered — the wire shape of
// POST /api/usage/discover-orgs and what Connect seeds the roster with.
export type DiscoverOrgResult =
  | { ok: true; orgs: DiscoveredOrg[] }
  | { ok: false; kind: DiscoverFailKind };

export type DiscoverOrgOptions = {
  sessionKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  baseUrl?: string;
};

// The bare listing — GET /organizations, one request, no probing: each org's
// id and roster hints. It is what the Hub's poll set uses (#283), since the
// poller then observes every Organization's Limits answer on its own reads;
// Connect's `discoverOrgs` below adds the per-Organization probe.
export async function discoverOrg(opts: DiscoverOrgOptions): Promise<ListOrgsResult> {
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
      orgs: parsed.data.map(
        (o): ListedOrg => ({
          id: o.uuid,
          hints: {
            capabilities: o.capabilities,
            rateLimitTier: o.rate_limit_tier ?? null,
            billingType: o.billing_type ?? null,
            ravenType: o.raven_type ?? null,
            analyticsSubscriptionPlan: o.analytics_subscription_plan ?? null,
          },
        }),
      ),
    };
  } catch (err) {
    console.warn(
      "[usage-core] org discovery failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, kind: "error" };
  }
}

// The Limits answer a read gives, for discovery and the poller alike. A 200
// answers `windows` when it reports any limit, a window in flight or an idle
// one, and `none` only when it reports no limit at all: both primary windows
// absent and no model-scoped limit reported, idle included (#384/395).
// Before #384 `none` meant
// "nothing in flight", which an idle subscription or Enterprise organization
// answered too.
export function limitsAnswer(result: FetchUsageResult): OrgLimitsAnswer {
  if (result.ok) {
    const { fiveHour, weekly } = result.windowStates;
    const reportsLimit = fiveHour !== "absent" || weekly !== "absent" || result.hasModelScopedLimit;
    return reportsLimit ? "windows" : "none";
  }
  // A 401 here after a 200 listing is the key dying between two requests;
  // there is no better word for that org than "error", and the next poll will
  // say `expired` on its own.
  return result.kind === "forbidden" ? "forbidden" : "error";
}

// Connect's discovery (#270): list the orgs, then ask every one's usage
// endpoint what it answers, concurrently — one extra GET per org, which the
// probe found no rate-limit signal against. Connect runs it when the user
// pastes a key; a client with no Hub configured also runs it on every key
// arrival and hourly (#366, the sidecar's key-listing.ts): four requests an
// hour for a three-org key, beside the 60+ its polls already send.
// The listing's failure is discovery's failure; a single org's probe failing
// is that org's `limits: "error"` and never fails the whole discovery.
export async function discoverOrgs(opts: DiscoverOrgOptions): Promise<DiscoverOrgResult> {
  const listed = await discoverOrg(opts);
  if (!listed.ok) return listed;
  const orgs = await Promise.all(
    listed.orgs.map(async (o): Promise<DiscoveredOrg> => {
      const probe = await fetchUsage({
        sessionKey: opts.sessionKey,
        orgId: o.id,
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
        baseUrl: opts.baseUrl,
      });
      return { ...o, limits: limitsAnswer(probe) };
    }),
  );
  return { ok: true, orgs };
}
