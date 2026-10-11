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

// One timestamped reading — persisted per line of usage-history.jsonl (ADR-0024)
// with every window the Organization has in flight: the five-hour window
// always, and the weekly one unless the Organization reports no weekly limit
// (#384). `capturedAt` is when WE polled, not an upstream field.
//
// FORWARD-COMPAT (review f8): usage-history.jsonl is the app's first cross-upgrade
// persistent artifact — it outlives any single app version. `loadHistory` silently
// SKIPS any line that fails this schema, so adding a NEW REQUIRED field here would
// make every previously-written line (which lacks it) fail validation and be
// dropped — silently wiping all prior history on upgrade. THEREFORE: any field
// ADDED to UsageSample MUST be `.optional()` (or `.default(...)`) so old lines stay
// backward-readable. The current fields stay required — every existing line already
// has them. See ADR-0024 ("Consequences") for the recorded rule.
//
// `weekly` became OPTIONAL in #384, which loosens a field rather than adding
// one: every older line still parses. Its absence means the Organization
// reported no weekly limit on that read (an absent Window state, the Enterprise
// shape), never an idle one — an idle weekly window keeps the reading out of
// history (`completeUsageSample`). An older build skips such a line on load,
// by the same rule, and protocol v6 keeps older peers off the Hub wire that
// carries it (ADR-0024's #384 amendment).
export const usageSampleSchema = z.object({
  capturedAt: z.string(),
  fiveHour: usageWindowSchema,
  weekly: usageWindowSchema.optional(),
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

// A history line read as live state (the first-paint fallback before a read):
// a line with no weekly window is a reading with none in flight (#384).
export function sampleAsReading(sample: UsageSample): UsageReading {
  return { ...sample, weekly: sample.weekly ?? null };
}

/**
 * Only complete readings enter the block-reconstruction history: a five-hour
 * window in flight, and a weekly window in flight unless the read found the
 * Organization has none (#384). So an Enterprise organization's live five-hour
 * window is history, and its Blocks form from observed windows, while a reading
 * whose weekly window is merely idle stays live-only, as before.
 */
export function completeUsageSample(
  reading: UsageReading | null,
  windowStates: WindowStates,
): UsageSample | null {
  if (reading?.fiveHour == null) return null;
  const { weekly, ...rest } = reading;
  if (weekly !== null) return { ...rest, fiveHour: reading.fiveHour, weekly };
  return windowStates.weekly === "absent" ? { ...rest, fiveHour: reading.fiveHour } : null;
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
// `windows` — 200 reporting at least one limit, a window in flight or an idle
// one (the Enterprise shape, an idle `five_hour` beside `seven_day: null`,
// answers this since #384). A model-scoped limit counts even with no reset
// and both primary windows absent (#395). `none` — 200 reporting no supported
// limit at all; `forbidden` — 403, this key may not read that org; `error` —
// anything else (5xx, shape mismatch, network). Readability is judged from
// THIS, never from `capabilities`: an Enterprise org carries `chat` too.
export const orgLimitsAnswerSchema = z.enum(["windows", "none", "forbidden", "error"]);
export type OrgLimitsAnswer = z.infer<typeof orgLimitsAnswerSchema>;

// Only Organizations whose endpoint has answered appear here. lastReadAt is
// the last SUCCESSFUL read (windows/none); lastSampleAt is complete history.
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
