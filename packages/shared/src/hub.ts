import { z } from "zod";
import { usageConnectionSchema, usageSampleSchema } from "./usage-limits";

// Hub wire protocol (ADR-0035): the contract between the standalone always-on
// hub (apps/hub) and each sidecar's hub-client. Crosses MACHINE boundaries —
// two binaries built from different commits can meet on this wire — so unlike
// every other shared shape it is version-gated: the client requires an exact
// HUB_PROTOCOL_VERSION match (no shims; the failure mode is a clear "mismatch"
// connection state, never quiet misbehavior). Bump the version on ANY breaking
// change to the shapes below.
export const HUB_PROTOCOL_VERSION = 2;

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
  // unpulled rows).
  events: "hub:events",
  machines: "hub:machines",
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
// (the sidecar mirrors it into its own status while hub-connected).
export const hubStatusSchema = z.object({
  service: z.literal("maxprice-hub"),
  protocolVersion: z.number().int(),
  usageConnection: usageConnectionSchema,
  usageLastSampleAt: z.string().nullable(),
  // Protocol v2: authoritative live value, separate from append-only history.
  // null means a successful poll found no account window in flight.
  usageCurrentSample: usageSampleSchema.nullable(),
  sampleCount: z.number().int().nonnegative(),
  credentialPresent: z.boolean(),
  // Provenance + display fields (ADR-0036). All .optional() — additive; protocol
  // stayed v1 when introduced: a pre-M3 sidecar parses an M3 hub's status (and an M3
  // sidecar parses a pre-M3 hub) without these present. Same .optional()-only
  // evolution rule as UsageSample (ADR-0024).
  //   credentialUpdatedAt: ISO; when the key was last set/healed; null if never.
  //   credentialSource:    the machineId that last set/healed it, or "local"
  //                        for the console's own POST; null if never.
  //   orgId:               the tracked org id (non-secret) from the stored
  //                        credential; null if no credential. Lets the console
  //                        SHOW orgId and PREFILL the replace form's org field.
  //   startedAt:           ISO; hub process start, stamped once in serve(); the
  //                        console renders real uptime from it.
  credentialUpdatedAt: z.string().nullable().optional(),
  credentialSource: z.string().nullable().optional(),
  orgId: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  // Whether a hub password is currently set (ADR-0037). Optional — additive,
  // protocol stayed v1 when introduced (a pre-0037 hub omits it). Consumed by the operator
  // console's Access card; clients may use it for Settings copy.
  passwordProtected: z.boolean().optional(),
  // The addresses the daemon ACTUALLY bound (ADR-0038) — loopback plus the
  // tailnet IP in the default bind mode, loopback alone when the tailnet
  // interface was missing at boot. Optional — additive; protocol stayed v1 when introduced.
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
      eventCount: z.number().int().nonnegative().optional(),
      fileBytes: z.number().int().nonnegative().optional(),
      garbageLines: z.number().int().nonnegative().optional(),
      // Bytes a compact would free = fileBytes − what rewrite would write.
      // Exact (a compact re-serializes live rows verbatim), so this is the
      // superseded/unreadable/torn bytes that fall away. Optional like its
      // console-stat siblings — additive under v1 when introduced.
      reclaimableBytes: z.number().int().nonnegative().optional(),
      unreadableLines: z.number().int().nonnegative().optional(),
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
// = the engine's StoredEvent fields + the two hub-minted fleet fields.
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
  added: z.number().int().nonnegative(),
  stamps: z.array(hubEventStampSchema),
});
export type HubEventsPushResponse = z.infer<typeof hubEventsPushResponseSchema>;

// GET /api/events?since=<seq>&limit=<n> — seq-ascending, durable rows only.
export const hubEventsPullResponseSchema = z.object({
  epoch: z.string(),
  seq: z.number().int().nonnegative(), // durable watermark
  events: z.array(fleetEventSchema),
});
export type HubEventsPullResponse = z.infer<typeof hubEventsPullResponseSchema>;

// The hub:events SSE poke payload — the post-fsync durable watermark, never
// rows (ADR-0041). Passthrough for the usual additive-evolution posture.
export const hubEventsPokeSchema = z.object({ seq: z.number().int().nonnegative() }).passthrough();
export type HubEventsPoke = z.infer<typeof hubEventsPokeSchema>;

// The CLIENT'S lenient pull-envelope parse (ADR-0041 M5): rows stay `unknown`
// so one malformed row can't fail the whole envelope — event-sync safeParses
// each row against fleetEventSchema and skip-and-COUNTS failures, never
// bricking the client. The hub-side response type stays the strict
// hubEventsPullResponseSchema above.
export const hubEventsPullEnvelopeSchema = z.object({
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
  events: z.array(z.unknown()),
});
export type HubEventsPullEnvelope = z.infer<typeof hubEventsPullEnvelopeSchema>;

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
  removed: z.number().int().nonnegative(),
  sessionsMatched: z.number().int().nonnegative(),
});
export type HubEventsForgetResponse = z.infer<typeof hubEventsForgetResponseSchema>;

// Machine directory entry (ADR-0041). Directory fields required; joined stats
// (roster ∪ store aggregates) are .optional() — M4 serves the directory
// fields, M7 widens the same route with the stats.
export const hubMachineSchema = z
  .object({
    machineId: z.string(),
    name: z.string(),
    registeredAt: z.string(), // ISO
    mergedInto: z.string().nullable(), // alias chain; resolution is transitive
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
// by the client renderer (resolveMachineTarget) and the hub console
// (resolveMergeTargetName) so both walk identically (ADR-0041).
export function resolveMergeTarget(machines: HubMachine[], id: string): string {
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

// PUT /api/machines/:id (self-rename) body:
export const hubMachineRenameRequestSchema = z.object({ name: z.string().min(1) });
export type HubMachineRenameRequest = z.infer<typeof hubMachineRenameRequestSchema>;

// POST /api/machines/:id/merge body (M7): mark :id an alias of `into`.
export const hubMachineMergeRequestSchema = z.object({ into: z.string().min(1) });
export type HubMachineMergeRequest = z.infer<typeof hubMachineMergeRequestSchema>;

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
