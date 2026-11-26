import { z } from "zod";
import {
  newestInstant,
  organizationRosterHintsSchema,
  orgLimitsAnswerSchema,
  usageConnectionSchema,
  usageReadingSchema,
  usageSampleSchema,
  windowStatesSchema,
  type HubKeyState,
  type UsageConnection,
  type UsageHubKeysResponse,
  type UsageOrganizations,
  type UsageReading,
} from "./usage-limits";
import { rankMemberships } from "./membership-rank";
import { accountUuidSchema, labelEntrySchema } from "./accounts";
import {
  MEMBERSHIP_ASSERTION_DIRECTORY_MAX,
  membershipAssertionEntrySchema,
  organizationUuidKeySchema,
  sessionIdKeySchema,
} from "./organizations";
import { hubGatewaySchema } from "./gateway";

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
// v7 (ADR-0139, ADR-0137 §6): fleet event rows and Usage samples carry
// Account tags, the Hub status lists the Hub's Accounts, and the Hub holds a
// session key per Account. One bump across the map.
// v8 (ADR-0145 §4): a Usage sample may omit its five-hour window (a plan with
// none, such as a verified Ultra plan, or one idle beside a weekly window in
// flight), which a v7 peer's sample schema rejects.
export const HUB_PROTOCOL_VERSION = 8;

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
  // unpulled rows). hub:labels is the Label directory's empty changed-signal
  // `{}` the same way (#288, #635), and hub:membership-assertions the
  // Membership assertion directory's (#310, #635). hub:gateway-records is the
  // Gateway record feed's empty changed-signal `{}` (ADR-0141 §5): a client
  // pulls the feed from its cursor on it.
  events: "hub:events",
  machines: "hub:machines",
  labels: "hub:labels",
  membershipAssertions: "hub:membership-assertions",
  gatewayRecords: "hub:gateway-records",
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

// One Membership the Hub knows (ADR-0139 §1): one Account's place in one
// Organization, with what that Account's key last read of it. `limits` is its
// last Limits answer, null when nothing has answered (no key reads it, or no
// read yet); readability is derived from it and the Account's connection
// (`membershipReadability`), never stored. `current` missing: no
// authoritative answer; a present null: a successful read found no window in
// flight, its Window states saying whether each is idle or absent (#384).
// `weeklyResetAt` is the retained weekly cadence, which survives a partial or
// empty read.
export const hubMembershipSchema = z.object({
  organizationUuid: z.string().min(1),
  limits: orgLimitsAnswerSchema.nullable(),
  windowStates: windowStatesSchema.nullable(),
  lastReadAt: z.string().nullable(),
  lastSampleAt: z.string().nullable(),
  current: usageReadingSchema.nullable().optional(),
  weeklyResetAt: z.string().optional(),
});
export type HubMembership = z.infer<typeof hubMembershipSchema>;

// One Account the Hub knows (ADR-0139 §1–§3, §5): one it holds a key for, the
// unmoved legacy key (`accountUuid: null`, ADR-0138 §12), one whose key was
// removed (`disconnected`, `setAt: null`, `removedAt` set), or one the fleet
// names only by an event tag (`disconnected`, `setAt: null`, its Memberships
// the tags' pairs with `limits: null`). `connection` is its key's; `setAt`
// and `source` are when and by whom its key was set or healed ("local" for
// the console's or the terminal's push, else the healing machine's id), never
// any part of the key. No email and no label: a label is resolved where it is
// shown (`accountLabel`).
export const HUB_PROVIDERS = ["anthropic"] as const;
export const hubProviderSchema = z.enum(HUB_PROVIDERS);
export type HubProvider = z.infer<typeof hubProviderSchema>;
// The one Provider v7 carries (ADR-0136 §1): every key the Hub holds is one.
export const ANTHROPIC_PROVIDER: HubProvider = "anthropic";
export const hubAccountSchema = z.object({
  provider: hubProviderSchema,
  accountUuid: z.string().min(1).nullable(),
  connection: usageConnectionSchema,
  setAt: z.string().nullable(),
  source: z.string().nullable(),
  removedAt: z.string().nullable(),
  memberships: z.array(hubMembershipSchema),
});
export type HubAccount = z.infer<typeof hubAccountSchema>;

// The Hub's last successful read of any limits (ADR-0145 §6): the newest
// `lastReadAt` of its Accounts' Memberships, which both Hub console cards show
// as Last read. Null before a read succeeds: the read time lives in memory, so
// a Hub restart clears it.
export function hubLastReadAt(accounts: readonly HubAccount[]): string | null {
  return newestInstant(accounts.flatMap((a) => a.memberships.map((m) => m.lastReadAt)));
}

// GET /api/status response AND the hub:status SSE payload. `service` is a
// literal so a client pointed at some other HTTP server fails loudly here
// rather than misparsing. `accounts` (v7, ADR-0139 §1) is every Account the
// Hub knows with its Memberships, sorted by provider, then account uuid (the
// legacy entry first), its Memberships by Organization; a connected sidecar
// projects its per-Organization state from it (`hubMembershipProjection`).
// `usageLastSampleAt` is the newest line of the Hub's Usage history, the
// sample sync's cursor and nothing else (ADR-0145 §6).
// `samplesStampedAt` (ADR-0139 §8) is when the Hub's history last gained an
// Account stamp on a sample it already held; null until then.
export const hubStatusSchema = z.object({
  service: z.literal("maxprice-hub"),
  protocolVersion: z.number().int(),
  accounts: z.array(hubAccountSchema),
  samplesStampedAt: z.string().nullable(),
  usageLastSampleAt: z.string().nullable(),
  sampleCount: z.number().int().nonnegative(),
  // Display field (ADR-0036), optional — additive; protocol stayed v1 when
  // introduced: `startedAt`, ISO, the hub process start, stamped once in
  // serve(); the console renders real uptime from it.
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
  // The Gateways the Hub holds and drains (ADR-0141 §9): each one's id, URL
  // host, state and last record, never its key. Optional — additive inside v7
  // (ADR-0141 §9); omitted when the Hub holds no Gateway, so a Hub with none
  // serves the bytes it served before.
  gateways: z.array(hubGatewaySchema).optional(),
});
export type HubStatus = z.infer<typeof hubStatusSchema>;

// ── The Hub's Accounts, read (ADR-0139 §10) ──────────────────────────────────

// The connections of a key that may still work: what a projection prefers
// over a dead key's last reading.
const WORKING_KEY_CONNECTIONS: ReadonlySet<UsageConnection> = new Set(["connected", "error"]);

// Whether an entry of the Hub's Accounts holds a key: the legacy entry always
// does (it exists only while one is held), and an Account's does once a key
// was set for it. A removed or event-tag-named Account has none (`setAt:
// null`).
export function hubKeyHeld(account: Pick<HubAccount, "accountUuid" | "setAt">): boolean {
  return account.accountUuid === null || account.setAt !== null;
}

// A held key whose first answer is pending: it reads `disconnected` only at
// the Hub's boot or while a listing awaits its first poll (F16/ADR-0104).
export function hubKeyPending(
  account: Pick<HubAccount, "accountUuid" | "setAt" | "connection">,
): boolean {
  return hubKeyHeld(account) && account.connection === "disconnected";
}

// Whether the Hub is `keyless` (ADR-0138 §7, ADR-0039): no key on it works,
// so a connected client polls locally. No entry is `connected`, and no held
// key is in one of the two states not known not to work, each of which kept
// a client on the Hub when it held one key:
//
// - pending its first read (`hubKeyPending`): falling back there would make
//   every client's retry after a Hub restart a herd of heals and polls; if the
//   boot poll finds the key expired, the next status frame fails over;
// - `error`: a discovery that failed or listed nothing, or a claude.ai
//   outage, which a local poll would fail identically (#284).
//
// An entry with no key (removed, or named only by an event tag) counts for
// nothing either way. The one predicate: the client's fallback, its heal of
// a legacy key, and every surface read it.
export function hubKeyless(status: Pick<HubStatus, "accounts">): boolean {
  return !status.accounts.some(
    (account) =>
      account.connection === "connected" ||
      hubKeyPending(account) ||
      (hubKeyHeld(account) && account.connection === "error"),
  );
}

// Whether a client should push its local key for `accountUuid` (ADR-0138 §7,
// ADR-0139 §5): the Hub holds no working key for that Account (no entry, or
// one `disconnected` or `expired`), and the key was set after the Hub's
// removal time for it, if any (`localSetAt` later than `removedAt`; at the
// same instant the removal wins). The one heal decision: the Hub does not
// police heals. `accountUuid: null` is a client's unmoved legacy key, whose
// Account it does not know: wanted only while the Hub is keyless.
export function hubWantsKey(
  status: Pick<HubStatus, "accounts">,
  accountUuid: string | null,
  localSetAt: string | null,
): boolean {
  if (accountUuid === null) return hubKeyless(status);
  const entry = status.accounts.find(
    (account) => account.provider === ANTHROPIC_PROVIDER && account.accountUuid === accountUuid,
  );
  if (entry !== undefined && entry.connection !== "disconnected" && entry.connection !== "expired")
    return false;
  // A held key pending its first read is not known dead (`hubKeyless`'s F16).
  if (entry !== undefined && hubKeyPending(entry)) return false;
  const removedAt = entry?.removedAt ?? null;
  if (removedAt === null) return true;
  return localSetAt !== null && Date.parse(localSetAt) > Date.parse(removedAt);
}

// One Account's key at the Hub (#642, ADR-0140 §6): `none` when the Hub
// holds none for it (`hubKeyHeld`: removed, or named only by a tag),
// `pending` while a held key awaits its first read (`hubKeyPending`), else
// the held key's connection.
export function hubKeyState(
  account: Pick<HubAccount, "accountUuid" | "setAt" | "connection">,
): HubKeyState {
  if (!hubKeyHeld(account)) return "none";
  if (hubKeyPending(account)) return "pending";
  // A held key that is not pending is not `disconnected` (`hubKeyPending`).
  return account.connection as Exclude<UsageConnection, "disconnected">;
}

// GET /api/usage/hub-keys' answer from the Hub's Accounts as the client last
// read them (`HubClientHandle.hubAccounts`, null before any status): each
// Claude Account, the legacy entry left out, since it names no Account.
export function hubKeysReport(accounts: readonly HubAccount[] | null): UsageHubKeysResponse {
  if (accounts === null) return { accounts: null };
  return {
    accounts: accounts
      .filter(
        (account): account is HubAccount & { accountUuid: string } =>
          account.provider === ANTHROPIC_PROVIDER && account.accountUuid !== null,
      )
      .map((account) => ({ accountUuid: account.accountUuid, state: hubKeyState(account) })),
  };
}

// The key-level summary of several keys, for the surfaces that show one
// claude.ai state at today's look (ADR-0139 §10): connected when any key is,
// else expired when any is, else error when any is, else disconnected. For
// one key, exactly its own connection.
export function hubAccountsConnection(
  accounts: ReadonlyArray<Pick<HubAccount, "connection">>,
): UsageConnection {
  for (const state of ["connected", "expired", "error"] as const) {
    if (accounts.some((account) => account.connection === state)) return state;
  }
  return "disconnected";
}

// What a hub-connected sidecar shows per Organization (ADR-0138 §8,
// ADR-0139 §10): today's Organization-keyed state, projected from the Hub's
// Memberships. An Organization several Memberships answer for shows one:
// among the live keys' Memberships while any answered (a dead key's last
// reading never drives a live Organization), the one whose Account is the
// Home membership's (`homeAccount`), else the most used by
// `rankMemberships`. Only Memberships with an answer project: a tag-named
// pair (`limits: null`) gives nothing. `usageConnection` is
// `hubAccountsConnection`'s.
export type HubMembershipProjection = {
  usageConnection: UsageConnection;
  organizations: UsageOrganizations;
  // Missing: no authoritative answer for that Organization.
  usageCurrent: Record<string, UsageReading | null>;
  usageWeeklyResetAt: Record<string, string>;
};
export function hubMembershipProjection(
  accounts: readonly HubAccount[],
  homeAccount: string | null,
  nowMs: number,
): HubMembershipProjection {
  type Candidate = { account: HubAccount; membership: HubMembership };
  const byOrganization = new Map<string, Candidate[]>();
  for (const account of accounts) {
    for (const membership of account.memberships) {
      if (membership.limits === null) continue;
      const list = byOrganization.get(membership.organizationUuid) ?? [];
      list.push({ account, membership });
      byOrganization.set(membership.organizationUuid, list);
    }
  }
  const projection: HubMembershipProjection = {
    usageConnection: hubAccountsConnection(accounts),
    organizations: {},
    usageCurrent: {},
    usageWeeklyResetAt: {},
  };
  for (const organization of [...byOrganization.keys()].sort()) {
    const candidates = byOrganization.get(organization)!;
    const liveOnes = candidates.filter((c) => WORKING_KEY_CONNECTIONS.has(c.account.connection));
    const pool = liveOnes.length > 0 ? liveOnes : candidates;
    const chosen =
      pool.find((c) => homeAccount !== null && c.account.accountUuid === homeAccount) ??
      rankMemberships(
        pool.map((c) => ({
          ...c,
          key: `${c.account.accountUuid ?? ""}/${organization}`,
          label: c.account.accountUuid ?? "",
          connection: c.account.connection,
          limits: c.membership.limits,
          reading: c.membership.current ?? null,
        })),
        nowMs,
      )[0]!;
    const { membership } = chosen;
    projection.organizations[organization] = {
      limits: membership.limits!,
      windowStates: membership.windowStates,
      lastReadAt: membership.lastReadAt,
      lastSampleAt: membership.lastSampleAt,
    };
    if (membership.current !== undefined)
      projection.usageCurrent[organization] = membership.current;
    if (membership.weeklyResetAt !== undefined)
      projection.usageWeeklyResetAt[organization] = membership.weeklyResetAt;
  }
  return projection;
}

// The Hub page's key counts (ADR-0139 §9): how many of the Hub's Accounts per
// Provider are in each connection, and nothing else of them, no uuid, label
// or reading (ADR-0124 §4). Every Provider is present, all zeros on a Hub that
// knows no Account.
export const hubKeyCountsSchema = z.object({
  connected: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
  disconnected: z.number().int().nonnegative(),
});
export type HubKeyCounts = z.infer<typeof hubKeyCountsSchema>;
export const hubKeysSchema = z.object({ anthropic: hubKeyCountsSchema });
export type HubKeys = z.infer<typeof hubKeysSchema>;
export function hubKeyCounts(
  accounts: ReadonlyArray<Pick<HubAccount, "provider" | "connection">>,
): HubKeys {
  const keys: HubKeys = {
    anthropic: { connected: 0, expired: 0, error: 0, disconnected: 0 },
  };
  for (const account of accounts) keys[account.provider][account.connection] += 1;
  return keys;
}

// The status fields ADR-0124 §4 picks: four the Hub rows read, plus
// `service`, which keeps another server's body from parsing. The fifth, the
// claude.ai row's, is the page view's own `keys` (below).
const HUB_ROW_FIELDS = {
  service: true,
  passwordProtected: true,
  bindHosts: true,
  bindWarning: true,
  events: true,
} as const;
export type HubRowStatus = Pick<HubStatus, keyof typeof HUB_ROW_FIELDS>;

// The Hub page's data, which a Headless Hub serves at GET /page/view
// (ADR-0124 §4; apps/hub/src/page.ts): exactly what the page renders and nothing else of the
// status. A visitor learns the bound addresses,
// the bind warning, the event-archive counters and the key counts
// (`hubKeyCounts`), never an Organization id, an Account, a usage reading or
// credential provenance. `liveClients` is the Hub's own count
// of live clients, never the roster (hostnames and remote addresses stay off
// the page); `version` is the Hub's package version.
export const hubPageViewSchema = hubStatusSchema.pick(HUB_ROW_FIELDS).extend({
  keys: hubKeysSchema,
  liveClients: z.number().int().nonnegative(),
  version: z.string(),
});
export type HubPageView = z.infer<typeof hubPageViewSchema>;

// What `maxprice-hub status --json` prints (ADR-0127 §8; apps/hub/src/
// status.ts), one object, which #503's release-gate smoke is to parse. Each
// form says where the daemon lives: the data dir, absolute; the pid and the
// port serve.lock records; and whether that pid runs in
// maxprice-hub.service. Both are always known: a report names a holder that
// recorded its port, and a record with a port has a pid. A Hub that answered
// adds its page view, the Hub row's state as the shared `hubDaemonState`
// derives it from that view, and its keys (ADR-0139 §9): each key it holds and
// each Account whose key it removed, as ADR-0126 §3 reveals a key: set or
// not, when, and by whom, with its connection and the label the terminal
// resolves, never the value. A holder that recorded its port
// but did not answer within the bound is `not-responding`, with nothing it
// would have said. No other state reaches a report: with no daemon the
// command exits 3 and prints none, a holder with a pid alone is no daemon a
// report can describe, and a command never sees the console's `starting` or
// `stopped`, its reach waiting out the first and the lock telling it the
// second.
const hubStatusReportDaemon = {
  dataDir: z.string().startsWith("/"),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  inUnit: z.boolean(),
};
export const hubStatusReportKeySchema = z.object({
  provider: hubProviderSchema,
  accountUuid: z.string().min(1).nullable(),
  label: z.string().min(1),
  connection: usageConnectionSchema,
  setAt: z.string().nullable(),
  source: z.string().nullable(),
  removedAt: z.string().nullable(),
});
export type HubStatusReportKey = z.infer<typeof hubStatusReportKeySchema>;
export const hubStatusReportSchema = z.discriminatedUnion("state", [
  hubPageViewSchema.extend({
    state: z.enum(["online", "local-only", "events-down"]),
    keys: z.array(hubStatusReportKeySchema),
    ...hubStatusReportDaemon,
  }),
  z.object({
    service: z.literal("maxprice-hub"),
    state: z.literal("not-responding"),
    ...hubStatusReportDaemon,
  }),
]);
export type HubStatusReport = z.infer<typeof hubStatusReportSchema>;

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
    // v7 (ADR-0137 §6): Account evidence only — the account uuid a record's
    // Email or Owner record resolved, never a presumption and never the email
    // hash (a Pending account's rows carry none). Rides after
    // `organizationUuid`, only when present; opaque to the Hub like it, and it
    // enters only the merge rule.
    accountUuid: z.string().min(1).optional(),
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

// Rows per POST /api/events/forget, over every pair's `rows` (#777, ADR-0149):
// the same cap as the pairs, enforced the same way.
export const EVENT_FORGET_ROWS_MAX = 5000;

// A row a forget names, by its dedup identity (the `fleetDedupKey` pair).
export const forgetRowRefSchema = z.object({
  messageId: z.string(),
  requestId: z.string().optional(),
});
export type ForgetRowRef = z.infer<typeof forgetRowRefSchema>;

// A row's dedup identity as a forget names it, with no other field.
export function forgetRowRef(row: { messageId: string; requestId?: string }): ForgetRowRef {
  return row.requestId === undefined
    ? { messageId: row.messageId }
    : { messageId: row.messageId, requestId: row.requestId };
}

// One pair a forget names (#777, ADR-0149 §3). With `rows`, only the caller's
// rows with those dedup keys go, under whichever of its pairs the Hub holds
// them: the Organization repair's row-scoped forget of rows live Gateway
// evidence excluded after they reached the Hub. Without, every row of the
// pair goes, as before. A Hub built before
// `rows` strips nothing from a pair (the ref is passthrough) and forgets it
// whole, which the caller's resync re-pushes. Its removal is the same but for
// a named row it holds under another of the caller's pairs, which it keeps.
export const forgetRequestSessionSchema = forgetSessionRefSchema.extend({
  rows: z.array(forgetRowRefSchema).min(1).max(EVENT_FORGET_ROWS_MAX).optional(),
});
export type ForgetRequestSession = z.infer<typeof forgetRequestSessionSchema>;

// POST /api/events/forget body. Attribution comes from x-maxprice-machine — the
// id the HUB minted at push time — so the body never names a machine.
export const hubEventsForgetRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    epoch: z.string().min(1),
    sessions: z.array(forgetRequestSessionSchema).min(1).max(EVENT_FORGET_SESSIONS_MAX),
  })
  .refine(
    (body) =>
      body.sessions.reduce((sum, s) => sum + (s.rows?.length ?? 0), 0) <= EVENT_FORGET_ROWS_MAX,
    { message: `at most ${EVENT_FORGET_ROWS_MAX} rows per forget` },
  );
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

// One published Home membership (ADR-0139 §6): its Organization, and its
// Account, null when the machine does not know it (ADR-0136 §8). Each field
// is capped at 64, the uuids' bound, which keeps one peer from making every
// `GET /api/machines` serve megabytes; the Account is an account uuid
// (`accountUuidSchema`), so no Pending key or address is published.
export const hubHomeMembershipSchema = z.object({
  organizationUuid: organizationUuidKeySchema,
  accountUuid: accountUuidSchema.nullable(),
});
export type HubHomeMembership = z.infer<typeof hubHomeMembershipSchema>;
// A machine's Home memberships by Provider: at most one each, and v7 carries
// only Anthropic's (ADR-0136 §5). An empty map publishes no Home.
export const hubHomeMembershipsSchema = z.object({
  anthropic: hubHomeMembershipSchema.optional(),
});
export type HubHomeMemberships = z.infer<typeof hubHomeMembershipsSchema>;

// Machine directory entry (ADR-0041). Directory fields required; joined stats
// (roster ∪ store aggregates) are .optional() — M4 serves the directory
// fields, M7 widens the same route with the stats.
export const hubMachineSchema = z
  .object({
    machineId: z.string(),
    name: z.string(),
    registeredAt: z.string(), // ISO
    mergedInto: z.string().nullable(), // alias chain; resolution is transitive
    // The machine's own Home membership per Provider as it last published it
    // (#261 item 2, ADR-0103, ADR-0139 §6): how a viewer resolves the Presumed
    // membership of this machine's owner-less rows (ADR-0137 §4). Written only
    // by the machine itself through the self PUT, stored verbatim, never
    // interpreted by the Hub beyond listing its Account (ADR-0139 §2); the
    // tracked sets are never published. Absent or null = nothing published,
    // and a viewer presumes the rows under its own Home.
    homeMemberships: hubHomeMembershipsSchema.nullable().optional(),
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
// (resolveMergeTargetName) and the sidecar's presumption halves
// (publishedHomeOrganizations, viewerMergeClass) so all three walk
// identically (ADR-0041).
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
// its published Home memberships, or both. At least one key; `homeMemberships:
// null` clears the published Home (a machine with no Home), and the map is
// published whole. The Home is the directory entry's own field, caps
// included, so the Hub never accepts a value its directory loader would
// reject.
export const hubMachineSelfUpdateRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    homeMemberships: hubMachineSchema.shape.homeMemberships,
  })
  .refine((b) => b.name !== undefined || b.homeMemberships !== undefined, {
    message: "name or homeMemberships is required",
  });
export type HubMachineSelfUpdateRequest = z.infer<typeof hubMachineSelfUpdateRequestSchema>;

// POST /api/machines/:id/merge body (M7): mark :id an alias of `into`.
export const hubMachineMergeRequestSchema = z.object({ into: z.string().min(1) });
export type HubMachineMergeRequest = z.infer<typeof hubMachineMergeRequestSchema>;

// The Label directory (#288, ADR-0105 §8, ADR-0139 §7): the fleet's union of
// user-set labels, Organization labels by Organization uuid and Account
// labels by account uuid. GET answers it; POST is a client's push of its
// whole local maps and answers the merged union (push and pull in one round
// trip); PUT /organizations/:uuid and PUT /accounts/:uuid are the operator's
// renames. Newest `editedAt` wins per entry (./newest-wins.ts). Labels only:
// the Hub never interprets an Organization or an Account. An account key is
// an account uuid (`accountUuidSchema`), so no Pending account or email
// enters it.
export const LABEL_DIRECTORY_PATH = "/api/label-directory";
export const LABEL_DIRECTORY_KINDS = ["organizations", "accounts"] as const;
export type LabelDirectoryKind = (typeof LABEL_DIRECTORY_KINDS)[number];
// PUT target for one operator rename.
export function labelDirectoryEntryPath(kind: LabelDirectoryKind, uuid: string): string {
  return `${LABEL_DIRECTORY_PATH}/${kind}/${encodeURIComponent(uuid)}`;
}
// Bounds the UNION of both maps, tombstones included, not just one push or
// one map: the Hub refuses (409 "label directory is full") any POST or PUT
// whose merged union would pass it, so every answer, and every client map
// adopted from one, fits this schema. Updating a key the union holds never
// grows it.
export const LABEL_DIRECTORY_MAX = 1000;
export const hubLabelDirectorySchema = z
  .object({
    organizations: z.record(organizationUuidKeySchema, labelEntrySchema),
    accounts: z.record(accountUuidSchema, labelEntrySchema),
  })
  .refine(
    (directory) =>
      Object.keys(directory.organizations).length + Object.keys(directory.accounts).length <=
      LABEL_DIRECTORY_MAX,
    { message: `at most ${LABEL_DIRECTORY_MAX} labels` },
  );
export type HubLabelDirectory = z.infer<typeof hubLabelDirectorySchema>;

// GET /api/organizations on the Hub (#294): the console's view of the
// Organizations the Hub knows — its roster (what each key last listed, #284)
// joined with the Label directory's Organization labels. Same path as the
// sidecar's roster route, on a different server.
// Resolved here like the sidecar's: `label` is the rename, else the roster
// hints' plan word, else "Organization <first 8>", with no collision suffix
// (`displayOrganizationLabels` adds that at render time). Never the upstream
// name (ADR-0098 §6). Read by the console, and by a hub-connected client,
// which learns the listed rows into its own Organization registry (#366).
// Limits are not here (ADR-0139 §9): they belong to the status's Memberships.
export const HUB_ORGANIZATIONS_PATH = "/api/organizations";
export const hubOrganizationSchema = z.object({
  uuid: z.string().min(1),
  label: z.string().min(1),
  renamed: z.boolean(),
  // The Accounts whose key's last listing names it, sorted (ADR-0139 §9).
  // Empty: known only from a directory label (another machine's Organization,
  // or one no key lists any more), or listed only by the unmoved legacy key,
  // which has no Account to name.
  listedBy: z.array(z.string().min(1)),
  // #366: the newest listing's hints for a listed row, so a client that
  // learns the Hub's roster resolves the same default label the console
  // shows. Absent on a directory-only row. Never the upstream name
  // (ADR-0098 §6).
  hints: organizationRosterHintsSchema.optional(),
});
export type HubOrganization = z.infer<typeof hubOrganizationSchema>;
export const hubOrganizationsResponseSchema = z.object({
  organizations: z.array(hubOrganizationSchema),
});
export type HubOrganizationsResponse = z.infer<typeof hubOrganizationsResponseSchema>;

// The Membership assertion directory (#310, ADR-0107 §11, ADR-0139 §7): the
// fleet's union of Membership assertions, sessionId → { organizationUuid,
// accountUuid?, editedAt }, tombstones included. GET answers it; POST is a
// client's push of its whole local map and answers the merged union (push and
// pull in one round trip). Newest `editedAt` wins (./newest-wins.ts), the
// entry whole, Account and all. Opaque: the Hub never checks that a session,
// an Organization or an Account exists, and there is no operator edit.
export const MEMBERSHIP_ASSERTION_DIRECTORY_PATH = "/api/membership-assertion-directory";
export const hubMembershipAssertionDirectorySchema = z.object({
  assertions: z
    .record(sessionIdKeySchema, membershipAssertionEntrySchema)
    .refine((assertions) => Object.keys(assertions).length <= MEMBERSHIP_ASSERTION_DIRECTORY_MAX, {
      message: `at most ${MEMBERSHIP_ASSERTION_DIRECTORY_MAX} sessions`,
    }),
});
export type HubMembershipAssertionDirectory = z.infer<typeof hubMembershipAssertionDirectorySchema>;

// The Hub's keys (ADR-0139 §4, ADR-0138 §9): POST /api/credentials stores a
// pasted or healed key under the Account its `/api/account` names, replacing
// that Account's earlier key and clearing its removal time, and answers the
// Account; a key `/api/account` refuses is refused as expired, and an
// unreachable claude.ai is a 503, neither storing anything. The body is
// `usageCredentialSchema`, strict: the key alone. `DELETE
// /api/credentials/:accountUuid` removes that Account's key and records its
// removal time (§5); `DELETE /api/credentials/legacy` removes the unmoved
// legacy key (§3). There is no clear-all route. Write-only: the Hub never
// serves a key back out, and never keeps the email `/api/account` sends.
export const HUB_CREDENTIALS_PATH = "/api/credentials";
export const HUB_LEGACY_CREDENTIAL = "legacy";
export function hubCredentialPath(accountUuid: string | null): string {
  return `${HUB_CREDENTIALS_PATH}/${accountUuid === null ? HUB_LEGACY_CREDENTIAL : encodeURIComponent(accountUuid)}`;
}
export const hubCredentialAckSchema = z.object({
  ok: z.literal(true),
  accountUuid: z.string().min(1),
});
export type HubCredentialAck = z.infer<typeof hubCredentialAckSchema>;

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
