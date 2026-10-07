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

// One timestamped reading — persisted per line of usage-history.jsonl (ADR-0024)
// with both windows in flight. `capturedAt` is when WE polled, not an upstream field.
//
// FORWARD-COMPAT (review f8): usage-history.jsonl is the app's first cross-upgrade
// persistent artifact — it outlives any single app version. `loadHistory` silently
// SKIPS any line that fails this schema, so adding a NEW REQUIRED field here would
// make every previously-written line (which lacks it) fail validation and be
// dropped — silently wiping all prior history on upgrade. THEREFORE: any field
// ADDED to UsageSample MUST be `.optional()` (or `.default(...)`) so old lines stay
// backward-readable. The current fields stay required — every existing line already
// has them. See ADR-0024 ("Consequences") for the recorded rule.
export const usageSampleSchema = z.object({
  capturedAt: z.string(),
  fiveHour: usageWindowSchema,
  weekly: usageWindowSchema,
  // The Model-scoped weekly limit (GLOSSARY.md): Anthropic's weekly cap on one
  // model family's share, reported beside the all-model weekly limit as a
  // `weekly_scoped` entry of the upstream `limits[]` with a model scope. Which
  // family is scoped rides along as `model` (today "Fable"), so every surface
  // labels it from the wire and nothing assumes the family. OPTIONAL by the
  // forward-compat rule above AND by meaning: absent when the account reports
  // no scoped window — a complete sample, not a broken one.
  weeklyModel: usageWindowSchema.extend({ model: z.string() }).optional(),
  // The Organization (GLOSSARY.md) requested at poll time.
  // Absent = a legacy line written
  // before samples were stamped, presumed the Home organization's at query
  // time (the store holds no Home). OPTIONAL by the forward-compat rule above.
  organizationUuid: z.string().min(1).optional(),
});
export type ModelScopedWindow = NonNullable<UsageSample["weeklyModel"]>;
export type UsageSample = z.infer<typeof usageSampleSchema>;

// Live windows are independent: an idle five-hour window must not erase a
// valid weekly reading. History keeps its complete-sample contract above.
export const usageReadingSchema = usageSampleSchema.extend({
  fiveHour: usageWindowSchema.nullable(),
  weekly: usageWindowSchema.nullable(),
});
export type UsageReading = z.infer<typeof usageReadingSchema>;

/** Only complete readings enter the block-reconstruction history. */
export function completeUsageSample(reading: UsageReading | null): UsageSample | null {
  if (reading?.fiveHour == null || reading.weekly === null) return null;
  return { ...reading, fiveHour: reading.fiveHour, weekly: reading.weekly };
}

// Connection lifecycle for the subtle status indicator (ADR-0023).
export const usageConnectionSchema = z.enum([
  "disconnected", // no credential configured
  "connected", // last poll succeeded
  "expired", // 401 — session key needs re-pasting
  // offline / non-auth failure — including a 403 from the tracked org (#270):
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

// What one org's usage endpoint answered in discovery or polling (#270/282):
// `windows` — 200 with at least one window the app reads; `none` — 200 with
// no such window (the Enterprise shape: `seven_day: null`, idle `five_hour`);
// `forbidden` — 403, this key may not read that org; `error` — anything else
// (5xx, shape mismatch, network). Readability is judged from THIS, never from
// `capabilities`: an Enterprise org carries `chat` too.
export const orgLimitsAnswerSchema = z.enum(["windows", "none", "forbidden", "error"]);
export type OrgLimitsAnswer = z.infer<typeof orgLimitsAnswerSchema>;

// Only Organizations whose endpoint has answered appear here. lastReadAt is
// the last SUCCESSFUL read (windows/none); lastSampleAt is complete history.
export const organizationUsageStatusSchema = z.object({
  limits: orgLimitsAnswerSchema,
  lastReadAt: z.string().nullable(),
  lastSampleAt: z.string().nullable(),
});
export const usageOrganizationsSchema = z.record(organizationUsageStatusSchema);
export type OrganizationUsageStatus = z.infer<typeof organizationUsageStatusSchema>;
export type UsageOrganizations = z.infer<typeof usageOrganizationsSchema>;

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
export const discoverOrgsResponseSchema = z.object({
  orgs: z.array(discoveredOrgSchema),
  failureKind: usageFailureKindSchema.nullable(),
});
export type DiscoverOrgsResponse = z.infer<typeof discoverOrgsResponseSchema>;

// POST /api/usage/credential ack.
export const credentialAckSchema = z.object({ ok: z.literal(true) });
export type CredentialAck = z.infer<typeof credentialAckSchema>;
