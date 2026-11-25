import { z } from "zod";

// Usage limits (GLOSSARY.md): Anthropic's server-side 5-hour and weekly
// subscription caps, read live from the usage endpoint (ADR-0023). This module
// is the NORMALIZED shape the app uses everywhere; the sidecar's usage-client
// maps the undocumented upstream JSON onto it.

// One window's reading: how much is consumed (0-100) and when it resets.
export const usageWindowSchema = z.object({
  utilizationPct: z.number(),
  resetAt: z.string(), // ISO 8601
});
export type UsageWindow = z.infer<typeof usageWindowSchema>;

// A Window state (GLOSSARY.md, #384): what a successful read said about one of
// the two primary windows. `active` — an object with a reset, a window in
// flight; `idle` — an object whose `resets_at` is null, a limit whose window
// has not started; `absent` — the literal `null`, no such limit (an Enterprise
// organization's `seven_day`). Only `absent` is "no limit": an idle window is
// a limit like any other. Keyed off the window's shape, never off
// `limits[].is_active`, which the organization-limits probe saw `true` on an
// idle window and `false` on an active one.
export const windowStateSchema = z.enum(["active", "idle", "absent"]);
export type WindowState = z.infer<typeof windowStateSchema>;
export const windowStatesSchema = z.object({
  fiveHour: windowStateSchema,
  weekly: windowStateSchema,
});
export type WindowStates = z.infer<typeof windowStatesSchema>;

// A Usage sample (GLOSSARY.md): one reading kept as a line of
// usage-history.jsonl (ADR-0024), holding the windows that were in flight when
// it was read. Each window is optional, and one is enough (ADR-0145 §2): a
// window missing from a line was not in flight at that instant, and the line
// does not say whether it was idle or the plan has none (the Window states
// say that, and stay with the live state). A plan with no 5-hour window, such
// as a verified Ultra plan, is recorded like any other; a line holding no
// window at all is malformed, and skipped like any other. `capturedAt` is when
// WE polled, not an upstream field.
//
// FORWARD-COMPAT (review f8): usage-history.jsonl outlives any single app
// version, and `loadHistory` silently SKIPS any line that fails this schema.
// A NEW field must therefore be `.optional()` (or `.default(...)`), or every
// line written before it is dropped on upgrade (ADR-0024, "Consequences").
// Loosening a field keeps every older line valid, as `weekly` (#384) and
// `fiveHour` (ADR-0145) were loosened; an older build skips the looser line on
// load, and a protocol bump (v6, v8) keeps older peers off the Hub wire that
// carries it.
const usageSampleFields = z.object({
  capturedAt: z.string(),
  fiveHour: usageWindowSchema.optional(),
  weekly: usageWindowSchema.optional(),
  // The Model-scoped weekly limit (GLOSSARY.md): Anthropic's weekly cap on one
  // model family's share, reported beside the all-model weekly limit as a
  // `weekly_scoped` entry of the upstream `limits[]` with a model scope. Which
  // family is scoped rides along as `model` (today "Fable"), so every surface
  // labels it from the wire and nothing assumes the family. Absent when the
  // account reports no scoped window in flight.
  weeklyModel: usageWindowSchema.extend({ model: z.string() }).optional(),
  // The Organization (GLOSSARY.md) requested at poll time.
  // Absent = a legacy line written
  // before samples were stamped, presumed the Home organization's at query
  // time (the store holds no Home). OPTIONAL by the forward-compat rule above.
  organizationUuid: z.string().min(1).optional(),
  // The Account (GLOSSARY.md) whose session key read it (ADR-0139 §8, #633).
  // Absent = a line written before samples carried an Account, or read by a
  // key whose Account was not yet known; resolved at query time by ADR-0137
  // §3's presumption, until the store's one-time stamp gives it the key's
  // Account. OPTIONAL by the forward-compat rule above.
  accountUuid: z.string().min(1).optional(),
});
export const usageSampleSchema = usageSampleFields.refine(
  (s) => s.fiveHour !== undefined || s.weekly !== undefined || s.weeklyModel !== undefined,
  { message: "a Usage sample holds at least one window" },
);
export type ModelScopedWindow = NonNullable<UsageSample["weeklyModel"]>;
export type UsageSample = z.infer<typeof usageSampleSchema>;

// Live windows are independent: an idle five-hour window must not erase a
// valid weekly reading. A null window is one not in flight.
export const usageReadingSchema = usageSampleFields.extend({
  fiveHour: usageWindowSchema.nullable(),
  weekly: usageWindowSchema.nullable(),
});
export type UsageReading = z.infer<typeof usageReadingSchema>;

// A history line read as live state (the first-paint fallback before a read):
// a window the line lacks is one not in flight.
export function sampleAsReading(sample: UsageSample): UsageReading {
  return { ...sample, fiveHour: sample.fiveHour ?? null, weekly: sample.weekly ?? null };
}

/**
 * The Usage sample a reading writes to the history (ADR-0145 §2): its windows
 * in flight, when at least one of the 5-hour, weekly and Model-scoped weekly
 * windows is. A reading with none in flight writes no line.
 */
export function usageSampleOf(reading: UsageReading | null): UsageSample | null {
  if (reading === null) return null;
  const { capturedAt, fiveHour, weekly, ...rest } = reading;
  if (fiveHour === null && weekly === null && rest.weeklyModel === undefined) return null;
  // The schema's key order, which is the line's byte order on disk.
  return {
    capturedAt,
    ...(fiveHour === null ? {} : { fiveHour }),
    ...(weekly === null ? {} : { weekly }),
    ...rest,
  };
}

// Connection lifecycle for the subtle status indicator (ADR-0023).
export const usageConnectionSchema = z.enum([
  "disconnected", // no credential configured
  "connected", // last poll succeeded
  "expired", // a 401, or a 403 naming a dead session — the key needs re-pasting
  // offline / non-auth failure — including an Organization refusal (#270),
  // but excluding a 403 naming a dead session:
  // that org is unreadable with this key, which is not the key expiring, and
  // the reconnect prompt must not fire for it. The organizations status map
  // carries the individual answers; Hub connection health is key-level.
  "error",
]);
export type UsageConnection = z.infer<typeof usageConnectionSchema>;

// GET /api/usage/current's body, and the local usage:sample payload less its
// `organizationUuid` (live.ts): one Organization's sample plus cadence, for
// first paint and live updates. Connection state is carried separately by the
// status snapshot (zustand), so it is NOT duplicated here (review f10).
export const usageCurrentSchema = z.object({
  sample: usageReadingSchema.nullable(),
  // ADR-0083: the last-known weekly reset, independent of `sample` (which is
  // null whenever no windows are in flight).
  weeklyResetAt: z.string().nullable(),
});
export type UsageCurrent = z.infer<typeof usageCurrentSchema>;

// The usage credential (ADR-0023 → ADR-0104, #283): the session key alone. The
// tracked set decides what a client polls; the Hub polls every Organization its
// key lists. Pushed renderer→sidecar over loopback and console/heal→Hub; never
// persisted by the sidecar. Strict: an `orgId` here is a caller still holding
// the retired shape, and the Hub refuses it rather than dropping it silently.
export const usageCredentialSchema = z.object({ sessionKey: z.string().min(1) }).strict();
export type UsageCredential = z.infer<typeof usageCredentialSchema>;

// A credential as a keychain or Hub credstore may hold it. A blob written before
// #283 also carries `orgId`: the Organization the pre-upgrade poller read, which
// is the evidence the one-time history stamp needs (#279). It is carried to the
// stamp and dropped only once the stamp is acknowledged; nothing writes it
// except Connect, carrying an unacknowledged one forward to the next push.
export const storedUsageCredentialSchema = z.object({
  sessionKey: z.string().min(1),
  orgId: z.string().min(1).optional(),
});
export type StoredUsageCredential = z.infer<typeof storedUsageCredentialSchema>;

// One Account's stored credential (ADR-0138 §2, §6, #633): the pasted key, its
// kind — a session key is the only one today, and a ChatGPT credential fits
// later without a reshape — and `setAt`, which a Hub's per-Account removal
// time is compared with (§7). `orgId` is the pre-#283 stamp evidence a legacy
// entry carried, moved with the key into its Account's entry (§12) and
// dropped once the stamp is acknowledged, as `storedUsageCredentialSchema`'s
// is. Strict: a field this does not name is a caller holding another shape.
export const ACCOUNT_CREDENTIAL_KIND = "claude-session-key";
export const accountCredentialSchema = z
  .object({
    sessionKey: z.string().min(1),
    kind: z.literal(ACCOUNT_CREDENTIAL_KIND),
    setAt: z.string().datetime({ offset: true }),
    orgId: z.string().min(1).optional(),
  })
  .strict();
export type AccountCredential = z.infer<typeof accountCredentialSchema>;

// The whole keyset a host pushes to its sidecar (ADR-0138 §6, #633): every
// Account's key, and the one legacy key whose Account is not yet known (the
// upgrade's single key before §12's move, read from its old entry). Pushing it
// replaces the sidecar's keyset; nothing persists it there. Strict, as the
// credential it replaces is.
export const usageKeysetSchema = z
  .object({
    keys: z.array(accountCredentialSchema.extend({ accountUuid: z.string().min(1) }).strict()),
    legacy: z
      .object({ sessionKey: z.string().min(1), orgId: z.string().min(1).optional() })
      .strict()
      .nullable(),
  })
  .strict();
export type UsageKeyset = z.infer<typeof usageKeysetSchema>;

// GET /api/usage/keys (#633, ADR-0138 §12): the keyset the sidecar holds, as
// its host needs it to finish the move. `keys` are the pushed Accounts' keys,
// each with its connection; `legacy` is the pushed legacy key, with the
// Account its `/api/account` resolved (null until it does: the network is
// down, or the key is expired) and its connection. A host that sees
// `legacy.accountUuid` writes that Account's entry, deletes the legacy one and
// pushes the keyset again. Never a key. Kept fresh by `usage-keys:changed`.
export const USAGE_KEYS_PATH = "/api/usage/keys";
export const usageKeysResponseSchema = z.object({
  keys: z.array(z.object({ accountUuid: z.string().min(1), connection: usageConnectionSchema })),
  legacy: z
    .object({ accountUuid: z.string().min(1).nullable(), connection: usageConnectionSchema })
    .nullable(),
});
export type UsageKeysResponse = z.infer<typeof usageKeysResponseSchema>;

// GET /api/usage/hub-keys (#642, ADR-0140 §6): what the Hub this client is
// joined to holds for each Account, as the Hub's last status reported it, for
// the Headless client's `key list` (its At Hub column) and `key remove` (the
// line saying the Hub still holds a key). Loopback only, behind the usage
// guard as GET /api/usage/keys is; not part of the hub protocol, so no
// version moves. `accounts` is null while the client holds no status from a
// Hub: none is configured, or the configured one has not answered yet. Each
// entry is one Account of the Hub's status (`hubKeyState`, hub.ts): `none`
// once its key was removed there or it is named only by an event's tag,
// `pending` while a held key awaits its first read, else the held key's
// connection. An Account the status does not list holds no key there either.
// Never a key.
export const USAGE_HUB_KEYS_PATH = "/api/usage/hub-keys";
export const hubKeyStateSchema = z.enum(["connected", "expired", "error", "pending", "none"]);
export type HubKeyState = z.infer<typeof hubKeyStateSchema>;
export const usageHubKeysResponseSchema = z.object({
  accounts: z
    .array(z.object({ accountUuid: z.string().min(1), state: hubKeyStateSchema }))
    .nullable(),
});
export type UsageHubKeysResponse = z.infer<typeof usageHubKeysResponseSchema>;

// Its TanStack key and URL (ADR-0004's split), so the SSE poke and any host
// reach it from outside React.
export function usageKeysQueryKey(): ["usage-keys"] {
  return ["usage-keys"];
}
export function buildUsageKeysUrl(base: string): string {
  return `${base}${USAGE_KEYS_PATH}`;
}

// Whether a pasted key for `keyAccount` also replaces the legacy key: the
// legacy key resolved to that same Account, or it is expired and its Account
// was never learned — ADR-0138 §12's "the next paste replaces it". A working
// legacy key not yet resolved (the network was down) stays, and moves itself.
// The Desktop client's Connect and the Headless client's `key set` both ask.
export function legacyReplacedBy(
  report: UsageKeysResponse | undefined,
  keyAccount: string,
): boolean {
  const legacy = report?.legacy ?? null;
  if (legacy === null) return false;
  if (legacy.accountUuid !== null) return legacy.accountUuid === keyAccount;
  return legacy.connection === "expired";
}

// What one org's usage endpoint answered in discovery or polling (#270/282):
// `windows` — 200 reporting at least one limit, a window in flight or an idle
// one (the Enterprise shape, an idle `five_hour` beside `seven_day: null`,
// answers this since #384). A model-scoped limit counts even with no reset
// and both primary windows absent (#395). `none` — 200 reporting no supported
// limit at all; `forbidden` — an Organization refusal, excluding a dead-session
// 403 that expires the key; `error` —
// anything else (5xx, shape mismatch, network). Readability is judged from
// THIS, never from `capabilities`: an Enterprise org carries `chat` too.
export const orgLimitsAnswerSchema = z.enum(["windows", "none", "forbidden", "error"]);
export type OrgLimitsAnswer = z.infer<typeof orgLimitsAnswerSchema>;

// Only Organizations whose endpoint has answered appear here. lastReadAt is
// the last SUCCESSFUL read (windows/none); lastSampleAt is the newest line
// of its history.
// `windowStates` is what that last successful read said about each primary
// window (#384), kept like `lastReadAt` across a failed read, and null before
// any: the per-window fact a "no limit" surface reads.
export const organizationUsageStatusSchema = z.object({
  limits: orgLimitsAnswerSchema,
  windowStates: windowStatesSchema.nullable(),
  lastReadAt: z.string().nullable(),
  lastSampleAt: z.string().nullable(),
});
export const usageOrganizationsSchema = z.record(organizationUsageStatusSchema);
export type OrganizationUsageStatus = z.infer<typeof organizationUsageStatusSchema>;
export type UsageOrganizations = z.infer<typeof usageOrganizationsSchema>;

// The newest of some ISO instants, null when none is set. Producers write
// `toISOString()`, fixed-width UTC, so string order is time order.
export function newestInstant(instants: Iterable<string | null>): string | null {
  let newest: string | null = null;
  for (const at of instants) {
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/**
 * When the Head membership's limits were last read (ADR-0145 §6), which the
 * freshness copy words ("read 5m ago"): the head Organization's status, whose
 * read is its projected Membership's, the Home membership's where the
 * Organization holds it. With no head (no Home), the newest read of any
 * Organization. Null before a read succeeds: the read time lives in memory,
 * so a restart clears it.
 */
export function headLastReadAt(
  organizations: UsageOrganizations,
  head: string | null | undefined,
): string | null {
  if (head != null) return organizations[head]?.lastReadAt ?? null;
  return newestInstant(Object.values(organizations).map((status) => status.lastReadAt));
}

// A Membership's readability (ADR-0138 §8, GLOSSARY.md): whether its Account's
// key can read that Membership's limits now. `readable` — the key works and
// the Organization's last Limits answer was `windows` or `none`; `unreadable`
// — the key works and the Organization refuses it (`forbidden`, retried
// hourly). Readability belongs only to a Membership of a working key, so null
// otherwise: no key, a dead key (that is the Account's connection, shown on
// the Account, not here), a transient `error`, or no answer yet. A key whose
// only Organizations refuse it reads `error` as a connection, and its
// Memberships are still Unreadable: only `expired` and `disconnected` say the
// key is not working.
export const membershipReadabilitySchema = z.enum(["readable", "unreadable"]);
export type MembershipReadability = z.infer<typeof membershipReadabilitySchema>;
export function membershipReadability(
  connection: UsageConnection,
  limits: OrgLimitsAnswer | null,
): MembershipReadability | null {
  if (connection === "expired" || connection === "disconnected") return null;
  if (limits === "windows" || limits === "none") return "readable";
  return limits === "forbidden" ? "unreadable" : null;
}

// The prompt beside a dead key (ADR-0138 §8): one dead key keeps today's
// words, the usage tiles' `UsageExpiredHint`; several are counted, since a
// prompt per Account would repeat itself. `count` is the number of Accounts
// whose key is expired.
export function reconnectHint(count: number): string {
  return count <= 1 ? "Session expired — reconnect" : `${count} Accounts need reconnecting`;
}

// What the listing says about an Organization that a label may use (#268's
// resolver, #287): never its `name`, which is free text that can embed the
// account email (ADR-0098 §6) and is not even parsed. Each field is null when
// the listing omits it or sends a non-string. `analyticsSubscriptionPlan` is
// not uniformly token-shaped (docs/research/organization-limits-probe), so a
// label maps it and never shows it raw.
export const organizationRosterHintsSchema = z.object({
  capabilities: z.array(z.string()),
  rateLimitTier: z.string().nullable(),
  billingType: z.string().nullable(),
  ravenType: z.string().nullable(),
  analyticsSubscriptionPlan: z.string().nullable(),
});
export type OrganizationRosterHints = z.infer<typeof organizationRosterHintsSchema>;

// One Organization as the listing returns it, before its usage endpoint is asked.
export const listedOrgSchema = z.object({ id: z.string(), hints: organizationRosterHintsSchema });
export type ListedOrg = z.infer<typeof listedOrgSchema>;

// …and with what its usage endpoint answered (#270) — Connect's discovery.
export const discoveredOrgSchema = listedOrgSchema.extend({ limits: orgLimitsAnswerSchema });
export type DiscoveredOrg = z.infer<typeof discoveredOrgSchema>;

// Capabilities that mark a subscription org (vs an API-only org). A label hint
// only: the capability vocabulary `planFromHints` (organizations.ts) reads.
// Nothing picks an Organization by it (ADR-0104) — readability is the Limits
// answer's.
export const SUBSCRIPTION_CAPS = ["claude_max", "claude_pro", "chat"];

// The listing's own failure kinds: a 401/403 on GET /organizations means the
// key cannot enumerate orgs at all, which is `expired` for our purposes. The
// per-org `forbidden` lives in `OrgLimitsAnswer` above, not here.
export const usageFailureKindSchema = z.enum(["expired", "error"]);
export type UsageFailureKind = z.infer<typeof usageFailureKindSchema>;

// POST /api/usage/discover-orgs response. `failureKind` (NOT `error`) is the
// status-kind channel — deliberately distinct from the pinned error envelope
// `{ error: string }` (packages/shared/src/error.ts), which is a human message
// on non-2xx only (ADR-0023; review f23).
//
// `account` (#633, ADR-0138 §2) is the key's Account as its `/api/account`
// names it, or null when that read failed. Never the email: the sidecar
// learns its pair (ADR-0137 §1) and drops it.
export const discoverOrgsResponseSchema = z.object({
  orgs: z.array(discoveredOrgSchema),
  failureKind: usageFailureKindSchema.nullable(),
  account: z.object({ accountUuid: z.string().min(1) }).nullable(),
});
export type DiscoverOrgsResponse = z.infer<typeof discoverOrgsResponseSchema>;

// What every surface that checks a session key says when its listing names
// no Organization, in one set of words: the Desktop client's Usage
// connection section, the Headless client's `key set` (ADR-0121 §6) and the
// Hub's (ADR-0126 §6). Any kind but `expired`, none included, reads as
// claude.ai unreachable, as each surface always has.
export function sessionKeyListingFailure(kind: string | null): string {
  return kind === "expired"
    ? "That session key looks invalid or expired."
    : "Couldn't reach Anthropic — check your connection and try again.";
}

// Claude Code's OAuth token, which both headless products' `key set` name
// and never send to claude.ai: it is not a claude.ai session key
// (ADR-0121 §10, ADR-0126 §6).
export function isClaudeCodeToken(value: string): boolean {
  return value.startsWith("sk-ant-oat");
}

export const CLAUDE_CODE_TOKEN_REFUSAL =
  "that is a Claude Code OAuth token, not a claude.ai session key";

// POST /api/usage/credential ack.
export const credentialAckSchema = z.object({ ok: z.literal(true) });
export type CredentialAck = z.infer<typeof credentialAckSchema>;
