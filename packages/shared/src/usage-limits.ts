import { z } from "zod";

// Usage limits (CONTEXT.md): Anthropic's server-side 5-hour and weekly
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
  // The Model-scoped weekly limit (CONTEXT.md): Anthropic's weekly cap on one
  // model family's share, reported beside the all-model weekly limit as a
  // `weekly_scoped` entry of the upstream `limits[]` with a model scope. Which
  // family is scoped rides along as `model` (today "Fable"), so every surface
  // labels it from the wire and nothing assumes the family. OPTIONAL by the
  // forward-compat rule above AND by meaning: absent when the account reports
  // no scoped window — a complete sample, not a broken one.
  weeklyModel: usageWindowSchema.extend({ model: z.string() }).optional(),
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
  "expired", // 401/403 — session key needs re-pasting
  "error", // offline / non-auth failure
]);
export type UsageConnection = z.infer<typeof usageConnectionSchema>;

// GET /api/usage/current response: just the last-known sample for the rings'
// first paint (live updates arrive via the usage:sample SSE event). Connection
// state is carried separately by the status snapshot (zustand), so it is NOT
// duplicated here (review f10).
export const usageCurrentSchema = z.object({
  sample: usageReadingSchema.nullable(),
  // ADR-0083: the last-known weekly reset, independent of `sample` (which is
  // null whenever no windows are in flight).
  weeklyResetAt: z.string().nullable(),
});
export type UsageCurrent = z.infer<typeof usageCurrentSchema>;

// Credential blob stored in the OS keychain (ADR-0023): the session key plus the
// discovered org id. Pushed renderer→sidecar over loopback; never persisted by
// the sidecar.
export const usageCredentialSchema = z.object({
  sessionKey: z.string().min(1),
  orgId: z.string().min(1),
});
export type UsageCredential = z.infer<typeof usageCredentialSchema>;

// One org returned by the discovery probe — the user picks which to track.
export const discoveredOrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  capabilities: z.array(z.string()),
});
export type DiscoveredOrg = z.infer<typeof discoveredOrgSchema>;

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
