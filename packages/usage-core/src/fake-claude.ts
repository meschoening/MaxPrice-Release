// A scriptable stand-in for claude.ai's undocumented usage endpoints
// (ADR-0023's two GETs), for tests and the front-to-back rig (ADR-0035).
// NOT exported from the package barrel — import via
// "@maxprice/usage-core/fake-claude" so compiled binaries never
// bundle it. Run standalone: `bun packages/usage-core/src/fake-claude.ts`.

import { clientPath } from "./test-loopback";

export type FakeUsageState = {
  // null answers `five_hour: null`: a plan with no 5-hour limit, as a
  // verified Ultra plan reports on every read (#692).
  fiveHour: { utilization: number; resetsAt: string | null } | null;
  weekly: { utilization: number; resetsAt: string | null };
  // A model-scoped weekly limit, answered as the `weekly_scoped` entry of
  // `limits[]` with its model's display name (usage-client.ts). Absent: no
  // `limits[]` at all, as before.
  weeklyModel?: { model: string; utilization: number; resetsAt: string | null };
};

export type FakeMode = "ok" | "expired" | "error";

// An Organization the listing returns, and what its usage endpoint answers:
// `windows` serves the scripted usage state; `forbidden` is the 403 an
// API-only org answers (#270). The default `orgId` is always the first,
// answering `windows`; `extraOrgs` follow it (#283). `name` is the listing's
// free-text name, "Fake Org" unless given — a real one can carry the account
// email, and the app must never parse, store, send or show it (ADR-0098 §6),
// which a sentinel here lets a test prove.
//
// `state` overrides the scripted usage state for this one Membership (the
// Organization as this key reads it); without it the shared `setUsage` state
// answers, so every existing caller reads one state everywhere.
export type FakeOrg = {
  orgId: string;
  usage: "windows" | "forbidden";
  name?: string;
  // The listing's `rate_limit_tier`, sent only when set: an Ultra plan's is
  // `default_claude_max_20x` (#718).
  rateLimitTier?: string;
  state?: FakeUsageState;
};

// One more session key (#633): its own Account, as `/api/account` names it,
// and its own Organizations, as its listing names them and its usage
// endpoints answer. Two keys may list the same Organization: each answers
// for its own Membership. The default key is index 0; these follow in order.
export type FakeAccount = {
  sessionKey: string;
  accountUuid: string;
  email: string;
  orgs: readonly FakeOrg[];
};

// The rate limit the fake can answer usage reads with (ADR-0138 §11 watches
// for 429s): `count` reads answer 429 (unbounded when omitted), each with a
// `Retry-After` of `retryAfter` when given and none otherwise.
export type FakeRateLimit = { count?: number; retryAfter?: string };

// One request as the fake received it: `path` is the pathname plus any query
// string, and `atMs` is `Date.now()` in the fake's own process at arrival.
// `key` is the index of the session key the cookie named (0 the default, then
// `accounts` in order), or null when it named none the fake holds: never the
// key itself, so a test's output cannot carry one. `status` is what the fake
// answered.
export interface FakeClaudeRequest {
  readonly atMs: number;
  readonly method: string;
  readonly path: string;
  readonly key: number | null;
  readonly status: number;
}

export type FakeClaude = {
  // Base URL INCLUDING the /api suffix — pass directly as `baseUrl`.
  url: string;
  sessionKey: string;
  orgId: string;
  // The default key's Account, as `/api/account` names it.
  accountUuid: string;
  setUsage: (next: FakeUsageState) => void;
  setMode: (next: FakeMode) => void;
  // The listing alone answers 500 under "error"; usage endpoints keep
  // answering (#284: a Hub whose discovery fails).
  setListingMode: (next: "ok" | "error") => void;
  // Only these Organizations appear in the listing (null: all). Their usage
  // endpoints keep answering — the listing is what the Hub polls from.
  setListed: (ids: readonly string[] | null) => void;
  // These Organizations' usage endpoints answer 403, the default one included.
  setForbidden: (ids: readonly string[]) => void;
  // How many times a usage endpoint was hit, any Organization's, 403s
  // included (single-poller assertions).
  pollCount: () => number;
  // How many times the Organization listing was requested with the right key,
  // a listing-mode 500 included.
  listingCount: () => number;
  // Every request under /api/ in arrival order, however it was answered (a
  // 403, a 404 and an error-mode 500 included) — the poll cadence a client
  // keeps (#296). A request elsewhere is answered but never logged: no client
  // asks for one, and a loopback prober's `GET /` is not a client's (#596).
  requests: () => readonly FakeClaudeRequest[];
  // The requests one key made, by its index (see FakeClaudeRequest.key).
  requestsFor: (key: number) => readonly FakeClaudeRequest[];
  // Kills or revives one key at runtime (by its session key): a dead key is
  // answered as claude.ai answers one, on every endpoint, while the others
  // keep answering.
  setKeyDead: (sessionKey: string, dead: boolean) => void;
  // One Membership's usage state (the key by index, default 0); null returns
  // it to the shared state.
  setOrgUsage: (orgId: string, state: FakeUsageState | null, key?: number) => void;
  // Usage reads answer 429 while set (see FakeRateLimit); null clears it.
  setRateLimit: (next: FakeRateLimit | null) => void;
  stop: () => void;
};

// What claude.ai answers a dead or wrong session key, on the listing and the
// usage endpoint alike (observed 2026-10-13): a 403, not a 401, told apart
// from an Organization's own refusal (`FakeOrg.usage: "forbidden"`) by its
// error code.
const DEAD_SESSION = {
  type: "error",
  error: {
    type: "permission_error",
    message: "Invalid authorization",
    details: { error_code: "account_session_invalid", error_visibility: "user_facing" },
  },
  request_id: "req_fake",
};
// The API-only org's 403 the organization-limits probe recorded (#270): the
// same error type, with no error code.
const REFUSED_ORGANIZATION = {
  type: "error",
  error: {
    type: "permission_error",
    message: "This organization cannot read its usage",
    details: { error_visibility: "user_facing" },
  },
  request_id: "req_fake",
};

export function createFakeClaude(
  opts: {
    port?: number;
    sessionKey?: string;
    orgId?: string;
    // The default org's listing name.
    orgName?: string;
    // The default org's listing `rate_limit_tier` (`FakeOrg.rateLimitTier`).
    orgRateLimitTier?: string;
    extraOrgs?: readonly FakeOrg[];
    // The default key's Account and its address. The default is uuid-shaped,
    // as claude.ai's are: the Headless client names a secrets.json entry by
    // it, and refuses one that is not hex digits and dashes (#633).
    accountUuid?: string;
    email?: string;
    // More keys, each its own Account (#633).
    accounts?: readonly FakeAccount[];
  } = {},
): FakeClaude {
  const sessionKey = opts.sessionKey ?? "sk-test-fake";
  const orgId = opts.orgId ?? "org-fake";
  const accountUuid = opts.accountUuid ?? "acc0fa4e-0000-4000-8000-000000000001";
  const keys: readonly FakeAccount[] = [
    {
      sessionKey,
      accountUuid,
      email: opts.email ?? "fake-account@example.invalid",
      orgs: [
        { orgId, usage: "windows", name: opts.orgName, rateLimitTier: opts.orgRateLimitTier },
        ...(opts.extraOrgs ?? []),
      ],
    },
    ...(opts.accounts ?? []),
  ];
  const dead = new Set<number>();
  // Per-Membership overrides, by `${key index}\u0000${orgId}`.
  const orgUsage = new Map<string, FakeUsageState>();
  let rateLimit: { remaining: number; retryAfter?: string } | null = null;
  let mode: FakeMode = "ok";
  let listingMode: "ok" | "error" = "ok";
  let listed: readonly string[] | null = null;
  let forbidden = new Set<string>();
  let polls = 0;
  let listings = 0;
  const received: FakeClaudeRequest[] = [];
  let usage: FakeUsageState = {
    fiveHour: { utilization: 12, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() },
    weekly: { utilization: 40, resetsAt: new Date(Date.now() + 4 * 86_400_000).toISOString() },
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch(req) {
      const url = new URL(req.url);
      const key = keyIndex(req.headers.get("cookie") ?? "");
      const response = answer(url, key);
      if (clientPath(url, ["/api/"])) {
        received.push({
          atMs: Date.now(),
          method: req.method,
          path: `${url.pathname}${url.search}`,
          key,
          status: response.status,
        });
      }
      return response;
    },
  });

  // The index of the key the cookie's `sessionKey` names, or null. The whole
  // value is compared, so one key never matches another that extends it.
  function keyIndex(cookie: string): number | null {
    for (const part of cookie.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name !== "sessionKey") continue;
      const value = rest.join("=");
      const index = keys.findIndex((k) => k.sessionKey === value);
      return index === -1 ? null : index;
    }
    return null;
  }

  function answer(url: URL, key: number | null): Response {
    if (mode === "error") return new Response("upstream broken", { status: 500 });
    if (mode === "expired" || key === null || dead.has(key)) {
      return Response.json(DEAD_SESSION, { status: 403 });
    }
    const account = keys[key]!;
    if (url.pathname === "/api/account") {
      return Response.json({
        uuid: account.accountUuid,
        email_address: account.email,
        full_name: "Fake Person",
      });
    }
    if (url.pathname === "/api/organizations") {
      listings += 1;
      if (listingMode === "error") return new Response("listing broken", { status: 500 });
      return Response.json(
        account.orgs
          .filter((o) => listed === null || listed.includes(o.orgId))
          .map((o) => ({
            uuid: o.orgId,
            name: o.name ?? "Fake Org",
            capabilities: ["chat", "claude_max"],
            ...(o.rateLimitTier === undefined ? {} : { rate_limit_tier: o.rateLimitTier }),
          })),
      );
    }
    const org = account.orgs.find((o) => url.pathname === `/api/organizations/${o.orgId}/usage`);
    if (org !== undefined) {
      polls += 1;
      if (rateLimit !== null && rateLimit.remaining > 0) {
        rateLimit.remaining -= 1;
        const headers: Record<string, string> =
          rateLimit.retryAfter === undefined ? {} : { "retry-after": rateLimit.retryAfter };
        if (rateLimit.remaining === 0) rateLimit = null;
        return Response.json({ error: "rate limited" }, { status: 429, headers });
      }
      if (org.usage === "forbidden" || forbidden.has(org.orgId)) {
        return Response.json(REFUSED_ORGANIZATION, { status: 403 });
      }
      const state = orgUsage.get(`${key}\u0000${org.orgId}`) ?? org.state ?? usage;
      return Response.json({
        five_hour:
          state.fiveHour === null
            ? null
            : { utilization: state.fiveHour.utilization, resets_at: state.fiveHour.resetsAt },
        seven_day: { utilization: state.weekly.utilization, resets_at: state.weekly.resetsAt },
        ...(state.weeklyModel === undefined
          ? {}
          : {
              limits: [
                {
                  kind: "weekly_scoped",
                  percent: state.weeklyModel.utilization,
                  resets_at: state.weeklyModel.resetsAt,
                  scope: { model: { display_name: state.weeklyModel.model } },
                },
              ],
            }),
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  return {
    url: `http://127.0.0.1:${server.port}/api`,
    sessionKey,
    orgId,
    accountUuid,
    setUsage: (next) => {
      usage = next;
    },
    setMode: (next) => {
      mode = next;
    },
    setListingMode: (next) => {
      listingMode = next;
    },
    setListed: (ids) => {
      listed = ids === null ? null : [...ids];
    },
    setForbidden: (ids) => {
      forbidden = new Set(ids);
    },
    pollCount: () => polls,
    listingCount: () => listings,
    requests: () => [...received],
    requestsFor: (key) => received.filter((r) => r.key === key),
    setKeyDead: (value, isDead) => {
      const index = keys.findIndex((k) => k.sessionKey === value);
      if (index === -1) throw new Error("[fake-claude] setKeyDead: no such key");
      if (isDead) dead.add(index);
      else dead.delete(index);
    },
    setOrgUsage: (id, state, key = 0) => {
      if (state === null) orgUsage.delete(`${key}\u0000${id}`);
      else orgUsage.set(`${key}\u0000${id}`, state);
    },
    setRateLimit: (next) => {
      rateLimit =
        next === null
          ? null
          : { remaining: next.count ?? Number.POSITIVE_INFINITY, retryAfter: next.retryAfter };
    },
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const fake = createFakeClaude({ port: Number(process.env.PORT ?? 0) });
  console.log(`[fake-claude] base ${fake.url}`);
  console.log(`[fake-claude] sessionKey=${fake.sessionKey} orgId=${fake.orgId}`);
}
