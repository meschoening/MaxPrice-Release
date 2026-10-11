import { z } from "zod";
import {
  organizationRosterHintsSchema,
  organizationUsageStatusSchema,
  usageConnectionSchema,
  usageReadingSchema,
  usageSampleSchema,
  usageOrganizationsSchema,
} from "./usage-limits";
import {
  ORGANIZATION_ASSERTION_DIRECTORY_MAX,
  organizationAssertionEntrySchema,
  organizationLabelEntrySchema,
  organizationUuidKeySchema,
  sessionIdKeySchema,
} from "./organizations";

// Hub wire protocol (ADR-0035): the contract between the standalone always-on
// hub (apps/hub) and each sidecar's hub-client. Crosses MACHINE boundaries —
// two binaries built from different commits can meet on this wire — so unlike
// every other shared shape it is version-gated: the client requires an exact
// HUB_PROTOCOL_VERSION match (no shims; the failure mode is a clear "mismatch"
// connection state, never quiet misbehavior). Bump the version on ANY breaking
// change to the shapes below.
// v5 (ADR-0103/0104): fleet event rows carry Organization evidence, an
// equal-total tagged copy supersedes an untagged one, and usage live/status
// maps carry independent Organization answers. One bump across the map.
// v6 (#384): a Usage sample may omit its weekly window (an Organization with
// no weekly limit), which a v5 peer's sample schema rejects, and each
// Organization's status carries its Window states.
export const HUB_PROTOCOL_VERSION = 6;

// The hub's fixed default port. Unlike the sidecar (ADR-0002's dynamic port +
// stdout handshake — only possible with a parent process), remote clients must
// be able to KNOW the hub's address, so the port is static config.
export const HUB_DEFAULT_PORT = 47100;

// SSE event names on the hub's /api/stream. Distinct from the sidecar's
// SSE_EVENT set — a sidecar consumes this stream as a CLIENT and re-emits
// renderer-facing events under its own names.
export const HUB_SSE_EVENT = {
  sample: "hub:sample",
  status: "hub:status",
  heartbeat: "heartbeat",
  // Fleet event sync pokes (ADR-0041): hub:events carries only the post-fsync
  // durable watermark `{ seq }`, hub:machines an empty directory-changed
  // signal `{}` — SSE is a poke, never a data channel (a data-bearing stream
  // interleaved with a mid-seed paged pull can advance the cursor past
  // unpulled rows). hub:organizations is the Organization directory's empty
  // changed-signal `{}` the same way (#288), and hub:organization-assertions
  // the Organization assertion directory's (#310).
  events: "hub:events",
  machines: "hub:machines",
  organizations: "hub:organizations",
  organizationAssertions: "hub:organization-assertions",
} as const;

// Version-detection preamble. This pair — { service, protocolVersion } — is
// VERSION-INVARIANT: it must parse identically across ALL protocol versions and
// must NEVER be extended or changed. It exists so a client can read these two
// fields FIRST and detect a version mismatch before it tries to parse the
// version-specific status shape (which may have moved fields under it). The full
// hubStatusSchema is a superset for the matching version; this schema is the
// only cross-version-stable ground truth. Keep it a strict two-field object.
//
// The `service` literal was renamed ONCE, pre-release (`ccusage-hub` →
// `maxprice-hub`, the PR #25 rebrand); no build carrying the old literal ever
// shipped. A hub/client pair straddling that rename parses the other side as
// "not our service" — intentionally the client's `fallback` state, not
// `mismatch`. The never-extend/never-change invariant binds from the first
// tagged release (v0.1.0) onward: a post-ship brand rename would be a breaking
// wire change needing explicit design, since it makes cross-brand mismatch
// detection impossible.
export const hubStatusPreambleSchema = z.object({
  service: z.literal("maxprice-hub"),
  protocolVersion: z.number().int(),
});
export type HubStatusPreamble = z.infer<typeof hubStatusPreambleSchema>;

// GET /api/status response AND the hub:status SSE payload. `service` is a
// literal so a client pointed at some other HTTP server fails loudly here
// rather than misparsing. `usageConnection` is the HUB's claude.ai connection
// at key level; a connected sidecar projects Home's displayed state from
// organizations, without letting Home's absence/unreadability trigger fallback.
export const hubStatusSchema = z.object({
  service: z.literal("maxprice-hub"),
  protocolVersion: z.number().int(),
  usageConnection: usageConnectionSchema,
  usageLastSampleAt: z.string().nullable(),
  // Missing key: no authoritative current answer. A present null means a
  // successful read found no window in flight for that Organization; its
  // status's Window states say whether each is idle or absent (#384). A
  // partial reading keeps each window independently nullable (ADR-0090/0104).
  usageCurrent: z.record(usageReadingSchema.nullable()),
  // Retained cadence survives partial/none reads, including for a new client.
  usageWeeklyResetAt: z.record(z.string()),
  organizations: usageOrganizationsSchema,
  sampleCount: z.number().int().nonnegative(),
  credentialPresent: z.boolean(),
  // Provenance + display fields (ADR-0036). All .optional() — additive; protocol
  // stayed v1 when introduced: a pre-M3 sidecar parses an M3 hub's status (and an M3
  // sidecar parses a pre-M3 hub) without these present. Same .optional()-only
  // evolution rule as UsageSample (ADR-0024).
  //   credentialUpdatedAt: ISO; when the key was last set/healed; null if never.
  //   credentialSource:    the machineId that last set/healed it, or "local"
  //                        for the console's own POST; null if never.
  //   startedAt:           ISO; hub process start, stamped once in serve(); the
  //                        console renders real uptime from it.
  credentialUpdatedAt: z.string().nullable().optional(),
  credentialSource: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  // Whether a hub password is currently set (ADR-0037). Optional — additive,
  // protocol stayed v1 when introduced (a pre-0037 hub omits it). Consumed by the operator
  // console's Access card; clients may use it for Settings copy.
  passwordProtected: z.boolean().optional(),
  // The addresses the daemon is bound to RIGHT NOW (ADR-0038) — loopback plus
  // the tailnet IPs in the default bind mode, loopback alone while no tailnet
  // interface exists. Since ADR-0074 this is live truth, not a boot record: the
  // hub re-resolves its bind every 10s and patches this field when the set
  // changes, so a hub that started before Tailscale reports loopback first and
  // the full set moments later. Optional — additive; protocol stayed v1 when introduced.
  // Consumed by the operator console: the Listening row shows what clients can
  // really connect to, and the Windows firewall warning gates on a
  // non-loopback host being present (no inbound is expected of a
  // loopback-only hub).
  bindHosts: z.array(z.string()).optional(),
  // The bind resolution's own diagnosis, verbatim (ADR-0049) — null when the
  // daemon bound exactly what was asked for. Optional — it was additive under
  // v1 when introduced. `bindHosts` alone cannot distinguish a DELIBERATE `bind:
  // "loopback"` from a `bind: "tailnet"` that found no tailnet interface: both
  // bind ["127.0.0.1"]. resolveBindHosts already tells them apart and used to
  // log the answer to stderr and drop it; carrying it lets the console paint a
  // deliberately-local hub calm rather than warning about a state its operator
  // chose. Also carries the "you bound a public address" security warning.
  bindWarning: z.string().nullable().optional(),
  // Fleet event sync capability gate (ADR-0041): presence of `events` ⇔ the
  // hub speaks event sync. `seq` is the durable watermark (the seed's
  // denominator), `epoch` the resync sentinel. The console-stat siblings are
  // optional-WITHIN so {epoch, seq} stays the capability gate — M7 populates
  // them; M4 serves only epoch+seq. All were additive under v1 when introduced.
  events: z
    .object({
      epoch: z.string(),
      seq: z.number().int().nonnegative(),
      deletionGeneration: z.number().int().nonnegative(),
      changeBytes: z.number().int().nonnegative().optional(),
      eventCount: z.number().int().nonnegative().optional(),
      fileBytes: z.number().int().nonnegative().optional(),
      // SQLite unused-page estimate; completed maintenance reports actual bytes.
      reclaimableBytes: z.number().int().nonnegative().optional(),
      lastAppendAt: z.string().nullable().optional(),
    })
    .optional(),
});
export type HubStatus = z.infer<typeof hubStatusSchema>;

// Connected-clients roster (ADR-0036). NEW in M3; consumed only by the operator
// console (Phase 3) via GET /api/clients. A live/recently-seen view since the
// daemon started — the registry is in-memory and resets on restart.
export const hubClientSchema = z.object({
  machineId: z.string(),
  hostname: z.string().nullable(), // from x-maxprice-hostname; null if not sent
  connectedAt: z.string(), // ISO; start of the current (live) or most-recent connection
  lastSeenAt: z.string(), // ISO; last request OR stream activity from this machineId
  live: z.boolean(), // true ⇔ currently holding an /api/stream subscription
  remoteAddr: z.string().nullable(), // tailnet/loopback IP if resolvable, else null
});
export type HubClient = z.infer<typeof hubClientSchema>;

export const hubClientsResponseSchema = z.object({ clients: z.array(hubClientSchema) });
export type HubClientsResponse = z.infer<typeof hubClientsResponseSchema>;

// GET /api/samples?since=<ISO> response. The producer emits capturedAt-
// ascending as a courtesy; consumers must not rely on it (merge() is
// order-independent).
export const hubSamplesResponseSchema = z.object({
  samples: z.array(usageSampleSchema),
});
export type HubSamplesResponse = z.infer<typeof hubSamplesResponseSchema>;

// POST /api/samples body — the push-up half of the two-way merge (ADR-0035): a
// client uploads samples the hub may lack (fallback-captured, or its whole
// replica when the hub is empty — seeding). Same {samples} envelope as the
// backfill response; the hub merges (capturedAt-keyed set union) and answers
// with how many were new.
//
// PROTOCOL NOTE: this endpoint COMPLETES the v1 wire ADR-0035 specified from
// the start — its addition is not a version bump (those are reserved for
// breaking shape changes). No hub build without it ever shipped; a client that
// meets one anyway gets a 404 on push, which it treats as a logged,
// retry-next-reconnect failure — degraded to down-sync-only, never quiet data
// loss (the samples stay in the local replica).
// Corollary: a matching HUB_PROTOCOL_VERSION does NOT imply this endpoint is
// present — callers must ALWAYS probe via 404 (degrade to down-sync-only); the
// version gate does not cover optional additive endpoints.
export const hubSamplesPushRequestSchema = z.object({
  samples: z.array(usageSampleSchema),
});
export type HubSamplesPushRequest = z.infer<typeof hubSamplesPushRequestSchema>;

export const hubSamplesPushResponseSchema = z.object({
  added: z.number().int().nonnegative(),
});
export type HubSamplesPushResponse = z.infer<typeof hubSamplesPushResponseSchema>;

// ── Fleet event sync (ADR-0041, M4). Additive at v1: a pre-event-sync client
//    never sends these; a pre-event-sync hub 404s the endpoints (probe, never
//    assume — the samples-push precedent). ──

export const EVENT_PUSH_BATCH_MAX = 1000; // rows per POST /api/events
export const EVENT_PULL_LIMIT_MAX = 5000; // `limit` clamp on GET /api/events

// The wire/disk row for one stored usage event, machine-tagged and seq-stamped.
// = the engine's StoredEvent fields, less its RAM-only `ms` and its `machineId`
// (the push body omits it), + the two hub-minted fleet fields.
// .passthrough() everywhere; .optional()-only evolution FOREVER (survives
// protocol bumps — the hub store outlives every client version).
export const storedEventWireSchema = z
  .object({
    timestamp: z.string(),
    messageId: z.string(),
    requestId: z.string().optional(), // absent on older records (never null)
    model: z.string(),
    inputTokens: z.number().finite(),
    outputTokens: z.number().finite(),
    cacheCreationTokens: z.number().finite(),
    cacheReadTokens: z.number().finite(),
    cacheCreation: z
      .object({ ephemeral5m: z.number(), ephemeral1h: z.number() })
      .passthrough()
      .optional(),
    costUSD: z.number().finite().optional(),
    cwd: z.string().optional(), // crosses verbatim (ADR-0009 remote paths)
    projectSlug: z.string(),
    sessionId: z.string(),
    // v5 (ADR-0103): owner evidence only — the Organization a record's owner
    // resolved, never the Home organization or a presumption. Absent means no
    // evidence. Opaque to the Hub: stored and re-served, never a reason to
    // refuse a row; it enters only the merge rule (fleet-dedup.ts).
    organizationUuid: z.string().min(1).optional(),
  })
  .passthrough();
export type StoredEventWire = z.infer<typeof storedEventWireSchema>;

export const fleetEventSchema = storedEventWireSchema
  .extend({
    machineId: z.string(), // hub-minted from x-maxprice-machine
    seq: z.number().int().positive(), // hub-minted from the store counter
  })
  .passthrough();
export type FleetEvent = z.infer<typeof fleetEventSchema>;

// POST /api/events — body carries the client's NATIVE shape (no machineId/seq).
export const hubEventsPushRequestSchema = z.object({
  epoch: z.string().min(1),
  deletionGeneration: z.number().int().nonnegative(),
  events: z.array(storedEventWireSchema).max(EVENT_PUSH_BATCH_MAX),
});
export type HubEventsPushRequest = z.infer<typeof hubEventsPushRequestSchema>;

// Ack — returned only after fsync. Losers are stamped with the incumbent's seq.
export const hubEventStampSchema = z.object({
  messageId: z.string(),
  requestId: z.string().optional(),
  seq: z.number().int().positive(),
});
export type HubEventStamp = z.infer<typeof hubEventStampSchema>;

export const hubEventsPushResponseSchema = z.object({
  epoch: z.string(),
  deletionGeneration: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  stamps: z.array(hubEventStampSchema),
});
export type HubEventsPushResponse = z.infer<typeof hubEventsPushResponseSchema>;

// The hub:events SSE poke payload — the post-fsync durable watermark, never
// rows (ADR-0041). Passthrough for the usual additive-evolution posture.
export const hubEventsPokeSchema = z.object({ seq: z.number().int().nonnegative() }).passthrough();
export type HubEventsPoke = z.infer<typeof hubEventsPokeSchema>;

// ── Client-initiated forgetting (ADR-0063). Additive at v1 like the rest of
//    event sync: a pre-forget hub 404s POST /api/events/forget, so callers
//    ALWAYS probe — a matching HUB_PROTOCOL_VERSION does not imply an optional
//    endpoint is present (the samples-push posture, stated verbatim above). ──

// Pairs per POST /api/events/forget. ~8x the busiest machine's all-time session
// count, ~34x the measured orphan set — enforced as a schema `.max()` so an
// over-cap body is a 400 and NOTHING is rewritten (never a silent truncation of
// the caller's intent). The precedent is projectIdentityPushRequestSchema's
// `.max(10_000)`: an uncapped array is an unbounded parse plus an unbounded Set
// build on the hub's loop, from a caller whose only credential is a
// self-asserted header.
export const EVENT_FORGET_SESSIONS_MAX = 5000;

// The unit is the session pair, not seqs: it is the client classifier's own
// unit (identityFromPath maps every transcript, flat or …/<session>/subagents/,
// to exactly this pair), it is readable in a log and a dialog, and it is
// independent of the replica being caught up — a stale replica names FEWER
// sessions, never the wrong rows.
export const forgetSessionRefSchema = z
  .object({ projectSlug: z.string().min(1), sessionId: z.string().min(1) })
  .passthrough();
export type ForgetSessionRef = z.infer<typeof forgetSessionRefSchema>;

// POST /api/events/forget body. Attribution comes from x-maxprice-machine — the
// id the HUB minted at push time — so the body never names a machine.
export const hubEventsForgetRequestSchema = z.object({
  operationId: z.string().uuid(),
  epoch: z.string().min(1),
  sessions: z.array(forgetSessionRefSchema).min(1).max(EVENT_FORGET_SESSIONS_MAX),
});
export type HubEventsForgetRequest = z.infer<typeof hubEventsForgetRequestSchema>;

// `removed` is the race report: it counts what the rewrite ACTUALLY dropped, so
// a value below what the client classified means rows arrived or were already
// gone — information, never a retry trigger. `sessionsMatched` separates "the
// classifier named sessions the hub never had" from "everything landed".
// `epoch` is the NEW one, so the forgetting client drives its own unlink +
// resync immediately rather than discovering the mismatch on a later pull.
export const hubEventsForgetResponseSchema = z.object({
  epoch: z.string(),
  deletionGeneration: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  sessionsMatched: z.number().int().nonnegative(),
});
export type HubEventsForgetResponse = z.infer<typeof hubEventsForgetResponseSchema>;

// ADR-0100: complete transactions, never individual operations, are the unit
// of replay. Event seq identifies a version; cursor identifies a transaction.
export const fleetDeletionSchema = z.object({
  messageId: z.string(),
  requestId: z.string().optional(),
  seq: z.number().int().positive(),
});
export type FleetDeletion = z.infer<typeof fleetDeletionSchema>;
export const fleetChangeSchema = z.object({
  cursor: z.number().int().positive(),
  deletionGeneration: z.number().int().nonnegative(),
  upserts: z.array(fleetEventSchema),
  deletes: z.array(fleetDeletionSchema),
});
export type FleetChange = z.infer<typeof fleetChangeSchema>;
export const fleetChangesPageSchema = z.object({
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
  deletionGeneration: z.number().int().nonnegative(),
  floor: z.number().int().nonnegative(),
  changes: z.array(fleetChangeSchema),
  complete: z.boolean(),
});
export type FleetChangesPage = z.infer<typeof fleetChangesPageSchema>;
export const fleetSnapshotPageSchema = z.object({
  epoch: z.string(),
  snapshot: z.string(),
  seq: z.number().int().nonnegative(),
  deletionGeneration: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  events: z.array(fleetEventSchema),
  complete: z.boolean(),
});
export type FleetSnapshotPage = z.infer<typeof fleetSnapshotPageSchema>;

// Machine directory entry (ADR-0041). Directory fields required; joined stats
// (roster ∪ store aggregates) are .optional() — M4 serves the directory
// fields, M7 widens the same route with the stats.
export const hubMachineSchema = z
  .object({
    machineId: z.string(),
    name: z.string(),
    registeredAt: z.string(), // ISO
    mergedInto: z.string().nullable(), // alias chain; resolution is transitive
    // The machine's own Home organization as it last published it (#261 item 2,
    // ADR-0103): how a viewer resolves the Presumed organization of this
    // machine's owner-less rows. Written only by the machine itself through the
    // self PUT, stored verbatim, never interpreted by the Hub; the tracked set is
    // never published. Absent or null = nothing published, and a viewer presumes
    // the rows under its own Home — exactly the pre-v5 answer. Capped at 64: an
    // Organization uuid is 36 characters, and the cap keeps one peer from making
    // every `GET /api/machines` serve megabytes.
    homeOrganization: z.string().min(1).max(64).nullable().optional(),
    live: z.boolean().optional(), // M7: roster join
    lastSeenAt: z.string().nullable().optional(), // M7: null = not seen since daemon start
    eventCount: z.number().int().nonnegative().optional(), // M7: store join
    lastEventAt: z.string().nullable().optional(), // M7
    lastPushAt: z.string().nullable().optional(), // M7: console derives posture
  })
  .passthrough();
export type HubMachine = z.infer<typeof hubMachineSchema>;

// Follow a mergedInto chain to its terminal target id. Transitive; cycle-safe
// (a malformed directory stops at the first repeat rather than spinning).
// Returns `id` itself when unmerged (mergedInto === null) or unknown; returns
// the missing target id when the chain dangles. The ONE alias resolver shared
// by the client renderer (resolveMachineTarget), the hub console
// (resolveMergeTargetName) and the sidecar's presumption map (publishedHomes)
// so all three walk identically (ADR-0041).
export function resolveMergeTarget(machines: readonly HubMachine[], id: string): string {
  const byId = new Map(machines.map((m) => [m.machineId, m]));
  let current = id;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const entry = byId.get(current);
    if (!entry || entry.mergedInto === null) return current;
    current = entry.mergedInto;
  }
  return current;
}

export const hubMachinesResponseSchema = z.object({ machines: z.array(hubMachineSchema) });
export type HubMachinesResponse = z.infer<typeof hubMachinesResponseSchema>;

// POST /api/machines/:id/name (the console's rename-any) body:
export const hubMachineRenameRequestSchema = z.object({ name: z.string().min(1) });
export type HubMachineRenameRequest = z.infer<typeof hubMachineRenameRequestSchema>;

// PUT /api/machines/:id — a machine updating its OWN entry: a self-rename,
// its published Home, or both. At least one key; `homeOrganization: null`
// clears the published Home (a machine with no Home). The Home is the directory
// entry's own field, cap included, so the Hub never accepts a value its
// directory loader would reject.
export const hubMachineSelfUpdateRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    homeOrganization: hubMachineSchema.shape.homeOrganization,
  })
  .refine((b) => b.name !== undefined || b.homeOrganization !== undefined, {
    message: "name or homeOrganization is required",
  });
export type HubMachineSelfUpdateRequest = z.infer<typeof hubMachineSelfUpdateRequestSchema>;

// POST /api/machines/:id/merge body (M7): mark :id an alias of `into`.
export const hubMachineMergeRequestSchema = z.object({ into: z.string().min(1) });
export type HubMachineMergeRequest = z.infer<typeof hubMachineMergeRequestSchema>;

// The Organization directory (#288, ADR-0105 §8): the fleet's union of
// Organization label entries. GET answers it; POST is a client's push of its
// whole local map and answers the merged union (push and pull in one round
// trip); PUT /:uuid is the operator's rename. Newest `editedAt` wins
// (./newest-wins.ts). Labels only: the Hub never interprets an Organization.
export const ORGANIZATION_DIRECTORY_PATH = "/api/organization-directory";
// Bounds the UNION, tombstones included, not just one push: the Hub refuses
// (409 "organization directory is full") any POST or PUT whose merged union
// would pass it, so every answer, and every client map adopted from one,
// fits this schema. Updating a uuid the union holds never grows it.
export const ORGANIZATION_DIRECTORY_MAX = 1000;
export const hubOrganizationDirectorySchema = z.object({
  labels: z
    .record(organizationUuidKeySchema, organizationLabelEntrySchema)
    .refine((labels) => Object.keys(labels).length <= ORGANIZATION_DIRECTORY_MAX, {
      message: `at most ${ORGANIZATION_DIRECTORY_MAX} organizations`,
    }),
});
export type HubOrganizationDirectory = z.infer<typeof hubOrganizationDirectorySchema>;

// GET /api/organizations on the Hub (#294): the console's view of the
// Organizations the Hub knows — its roster (what its key last listed, #284)
// joined with the Organization directory's labels and the live `organizations`
// status map. Same path as the sidecar's roster route, on a different server.
// Resolved here like the sidecar's: `label` is the rename, else the roster
// hints' plan word, else "Organization <first 8>", with no collision suffix
// (`displayOrganizationLabels` adds that at render time). Never the upstream
// name (ADR-0098 §6). Read by the console, and by a hub-connected client,
// which learns the listed rows into its own Organization registry (#366).
export const HUB_ORGANIZATIONS_PATH = "/api/organizations";
export const hubOrganizationSchema = z.object({
  uuid: z.string().min(1),
  label: z.string().min(1),
  renamed: z.boolean(),
  // In the roster: the key last listed it. false: known only from a
  // directory label (another machine's Organization, or one the key no longer lists).
  listed: z.boolean(),
  // #366: the roster's hints for a listed row, so a client that learns the
  // Hub's roster resolves the same default label the console shows. Absent on
  // a directory-only row. Never the upstream name (ADR-0098 §6).
  hints: organizationRosterHintsSchema.optional(),
  // The live status map's entry; else the roster's last answer with no times;
  // null when nothing has answered.
  limits: organizationUsageStatusSchema.nullable(),
});
export type HubOrganization = z.infer<typeof hubOrganizationSchema>;
export const hubOrganizationsResponseSchema = z.object({
  organizations: z.array(hubOrganizationSchema),
});
export type HubOrganizationsResponse = z.infer<typeof hubOrganizationsResponseSchema>;

// The Organization assertion directory (#310, ADR-0107 §11): the fleet's union
// of Organization assertions, sessionId → { organizationUuid, editedAt },
// tombstones included. GET answers it; POST is a client's push of its whole
// local map and answers the merged union (push and pull in one round trip).
// Newest `editedAt` wins (./newest-wins.ts). Opaque: the Hub never checks that
// a session or an Organization exists, and there is no operator edit.
export const ORGANIZATION_ASSERTION_DIRECTORY_PATH = "/api/organization-assertion-directory";
export const hubOrganizationAssertionDirectorySchema = z.object({
  assertions: z
    .record(sessionIdKeySchema, organizationAssertionEntrySchema)
    .refine(
      (assertions) => Object.keys(assertions).length <= ORGANIZATION_ASSERTION_DIRECTORY_MAX,
      { message: `at most ${ORGANIZATION_ASSERTION_DIRECTORY_MAX} sessions` },
    ),
});
export type HubOrganizationAssertionDirectory = z.infer<
  typeof hubOrganizationAssertionDirectorySchema
>;

// A hub password is sent verbatim as `Authorization: Bearer <password>`. A
// value carrying whitespace or non-ASCII bytes — e.g. the app's own status
// label pasted by mistake, whose em-dash is an illegal header byte — makes
// `fetch` throw "Header has invalid value", swallowed into a generic fallback.
// Validate at entry (client Settings AND the hub's set-password route) so a
// fumbled paste is rejected loudly instead of poisoning the keychain / stored
// hash. Printable ASCII, no spaces, 1–128 chars (ADR-0037). Lives in the wire
// section: the set-password request below references it, and both the client
// and the hub gate on it, so it is part of the cross-machine contract.
export function isValidHubPassword(password: string): boolean {
  return /^[\x21-\x7e]{1,128}$/.test(password);
}

// POST /api/password body (hub-side; ADR-0037): a string sets/replaces the hub
// password, null clears it. Gated like every /api/* route — on an open hub
// anyone who can reach it can set a password (tailnet-trust, like every other
// write); on a protected hub the current password or the console's operator
// secret is required.
export const hubPasswordSetRequestSchema = z.object({
  password: z.string().refine(isValidHubPassword, { message: "invalid password" }).nullable(),
});
export type HubPasswordSetRequest = z.infer<typeof hubPasswordSetRequestSchema>;

// ── Monorepo-local loopback contracts (renderer ↔ sidecar / sidecar-local);
//    NOT covered by HUB_PROTOCOL_VERSION. Both ends are built from the same
//    commit, so these shapes may change freely across parts — no version gate,
//    no "mismatch" state, no cross-build compatibility to preserve. ──

// The sidecar's connection state toward the hub — StatusSnapshot.hubConnection.
// `off` is the strictly-optional default: no hub configured, the app is
// bit-for-bit the pre-hub app. `fallback`, `keyless`, `mismatch`, and
// `unauthorized` all mean the LOCAL poller is on duty ([[Fallback polling]]);
// they differ in what the user should do (check the hub / get a working
// claude.ai key to it / update one side / fix the password). `keyless` is the
// reachable, protocol-compatible hub with no working claude.ai key — expired,
// never keyed, or a healed key that is also dead (ADR-0039, splitting it out
// of `fallback` exactly as ADR-0037 split `unauthorized`).
export const hubConnectionSchema = z.enum([
  "off",
  "connecting",
  "connected",
  "fallback",
  "keyless",
  "mismatch",
  "unauthorized",
]);
export type HubConnection = z.infer<typeof hubConnectionSchema>;

// POST /api/hub/config body (renderer → sidecar over loopback). url null ⇒ hub
// off. password is INDEPENDENTLY nullable (ADR-0037): url-with-null-password is
// a passwordless connect to an open hub (which ignores credentials anyway);
// password-without-url is only ever a client bug — the refine rejects it (→ the
// endpoint's 400). Strings are non-empty by construction — the renderer maps
// empty inputs to null before pushing.
export const hubConfigSchema = z
  .object({
    url: z.string().min(1).nullable(),
    password: z.string().min(1).nullable(),
    // Credential auto-heal opt-out (ADR-0035): when true (the default) and the
    // hub reports its claude.ai key dead, this client pushes its own local key
    // up to re-key the fleet's poller. Meaningful only while url is set.
    autoHeal: z.boolean().default(true),
  })
  .refine((c) => !(c.url === null && c.password !== null), {
    message: "password requires a url",
  });
export type HubConfig = z.infer<typeof hubConfigSchema>;

// GET /api/machines (sidecar loopback, ADR-0041 M5): the sidecar serves its
// CACHED machine directory plus its own machine id so names render offline.
// Monorepo-local — not covered by HUB_PROTOCOL_VERSION.
export const sidecarMachinesResponseSchema = z.object({
  self: z.string(),
  machines: z.array(hubMachineSchema),
});
export type SidecarMachinesResponse = z.infer<typeof sidecarMachinesResponseSchema>;

// Normalize a hub location typed into Settings into a fetchable absolute origin.
// A bare host ("localhost", "100.x.y.z", "my-box.tailnet.ts.net") is scheme-less
// and therefore a RELATIVE reference — server-side `fetch` (Bun, in the sidecar)
// rejects it with ERR_INVALID_URL, which the hub-client swallows into a generic
// "Hub unreachable" fallback (indistinguishable from a real dead hub). So we
// default the scheme to http:// and the port to HUB_DEFAULT_PORT whenever either
// is absent, letting a user type just a host. A full URL (explicit scheme +
// port) passes through unchanged apart from a stripped trailing slash (so
// `${url}/api/status` never double-slashes). Empty input → "" (hub off). Throws
// on input that still can't parse after defaulting (e.g. "http://") — the caller
// surfaces that inline rather than persisting an unusable value.
//
// Edge: an explicit :80 (http) / :443 (https) is folded away by URL parsing and
// so is indistinguishable from "no port" — it gets rebound to HUB_DEFAULT_PORT.
// Irrelevant here (the hub never runs on 80/443).
export function normalizeHubUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme); // throws on genuinely unparseable input
  if (url.port === "") url.port = String(HUB_DEFAULT_PORT);
  return url.toString().replace(/\/+$/, "");
}

export const hubPurgeRequestSchema = z.object({ operationId: z.string().uuid() });
export const hubCompactResponseSchema = z.object({ freedBytes: z.number().int().nonnegative() });
