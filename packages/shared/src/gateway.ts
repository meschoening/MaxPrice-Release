import { z } from "zod";
import { accountUuidSchema } from "./accounts";
import { organizationUuidKeySchema, sessionIdKeySchema } from "./organizations";
import { sha256Hex } from "./sha256";

// Gateways (ADR-0141): a service that serves Claude Code's requests on
// credentials it holds itself, and the Gateway records it keeps of each
// upstream attempt. Everything named here is Gateway-generic; the one adapter,
// CLIProxyAPI's, lives in usage-core (`gateway/cliproxyapi.ts`).

// ── A Gateway's identity ─────────────────────────────────────────────────────

// A Gateway is keyed by its URL (ADR-0141 §7): its management base, http or
// https, with no credentials, query or fragment in it. Normalized, the
// scheme and host are lower-cased (by URL parsing, which also drops a
// default port), the path is kept as written, and trailing slashes are
// dropped, so `HTTP://Box:8317/` and `http://box:8317` are one Gateway.
// Null for anything else.
export function normalizeGatewayUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;
  // A bare `?` or `#` parses to an empty search or hash; refuse it too.
  if (/[?#]/.test(url)) return null;
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

export const GATEWAY_URL_MAX = 2048;
export const gatewayUrlSchema = z
  .string()
  .max(GATEWAY_URL_MAX)
  .refine((url) => normalizeGatewayUrl(url) !== null, { message: "not a Gateway URL" });

// A Gateway's id (D7): the first 16 hex digits of the SHA-256 of its
// normalized URL. It names the Gateway's credential-store entry
// (`gateway-credential/<id>`), its Hub route and its `HubStatus` entry, so
// the URL itself never has to. Throws on a URL `normalizeGatewayUrl` refuses:
// callers validate with `gatewayUrlSchema` first.
export const GATEWAY_ID_PATTERN = /^[0-9a-f]{16}$/;
export const gatewayIdSchema = z.string().regex(GATEWAY_ID_PATTERN);
export function gatewayId(url: string): string {
  const normalized = normalizeGatewayUrl(url);
  if (normalized === null) throw new Error("not a Gateway URL");
  return sha256Hex(normalized).slice(0, 16);
}

// The host a surface names a Gateway by (`HubStatus.gateways[].urlHost`):
// the normalized URL's host, with its port when it is not the scheme's
// default. Throws like `gatewayId`.
export function gatewayUrlHost(url: string): string {
  const normalized = normalizeGatewayUrl(url);
  if (normalized === null) throw new Error("not a Gateway URL");
  return new URL(normalized).host;
}

// A management key goes out verbatim as `Authorization: Bearer <key>`, so it
// must be a legal header value: printable ASCII with no spaces (the hub
// password's rule, `isValidHubPassword`), at most 512 characters.
export const gatewayManagementKeySchema = z.string().regex(/^[\x21-\x7e]{1,512}$/);

// ── The reduced Gateway record ───────────────────────────────────────────────

// A Gateway record reduced to what the join (ADR-0141 §2) and the evidence
// (§1) need, and the only form a Gateway record takes on the Hub wire (§5),
// in the Hub's feed and in a client's push-up:
//
// - `executionId`: the Gateway's id of the upstream attempt, the dedup key;
// - `requestId`: the Gateway's id of the inbound request (shared by every
//   attempt of a failover);
// - `upstreamRequestId`: the upstream `Request-Id`, the exact join's key;
// - `sessionId`, `parentSessionId`: Claude Code's session, and a
//   subagent's parent session (the join's session is `parentSessionId ??
//   sessionId`);
// - the four token counts and the model, the session join's keys;
// - `timestamp`: the attempt's start, ISO UTC;
// - `organizationUuid`: the upstream `Anthropic-Organization-Id`;
// - `accountUuid`: the credential's Account, only where the reducing machine
//   resolved its email (the Hub through its own keys, a client through its
//   pair table).
//
// A failed attempt is never reduced (§2 skips it). Strict: no email and no
// email hash ever rides here (ADR-0137 §1), and a field this schema does not
// name is refused rather than carried.
const GATEWAY_ID_FIELD_MAX = 256;
const gatewayIdFieldSchema = z.string().min(1).max(GATEWAY_ID_FIELD_MAX);
// Far above any one request's tokens; bounds a hostile push.
export const GATEWAY_TOKEN_COUNT_MAX = 1_000_000_000;
const tokenCountSchema = z.number().int().nonnegative().max(GATEWAY_TOKEN_COUNT_MAX);
export const reducedGatewayRecordSchema = z
  .object({
    executionId: gatewayIdFieldSchema,
    requestId: gatewayIdFieldSchema.optional(),
    upstreamRequestId: gatewayIdFieldSchema.optional(),
    sessionId: sessionIdKeySchema.optional(),
    parentSessionId: sessionIdKeySchema.optional(),
    inputTokens: tokenCountSchema,
    outputTokens: tokenCountSchema,
    cacheReadTokens: tokenCountSchema,
    cacheCreationTokens: tokenCountSchema,
    model: z.string().min(1).max(200),
    timestamp: z.string().datetime(),
    organizationUuid: organizationUuidKeySchema.optional(),
    accountUuid: accountUuidSchema.optional(),
  })
  .strict();
export type ReducedGatewayRecord = z.infer<typeof reducedGatewayRecordSchema>;

// ── The Hub's Gateways (ADR-0141 §9) ─────────────────────────────────────────

// A Gateway's state as its drainer last found it: `draining` while its reads
// answer; `unreachable` when it does not answer; `unauthorized` when it
// refuses the management key; `statistics-off` when its credentials served
// requests but the queue gave nothing (`usage-statistics-enabled` off);
// `error` for any other failure.
export const GATEWAY_STATES = [
  "draining",
  "unreachable",
  "unauthorized",
  "statistics-off",
  "error",
] as const;
export const gatewayStateSchema = z.enum(GATEWAY_STATES);
export type GatewayState = z.infer<typeof gatewayStateSchema>;

// One Gateway the Hub holds, as `HubStatus.gateways` lists it: never its URL
// path or its key. `lastRecordAt` is when its newest record was drained, null
// before the first.
export const hubGatewaySchema = z.object({
  id: gatewayIdSchema,
  urlHost: z.string().min(1).max(GATEWAY_URL_MAX),
  state: gatewayStateSchema,
  lastRecordAt: z.string().nullable(),
});
export type HubGateway = z.infer<typeof hubGatewaySchema>;

// ── Connect (ADR-0141 §7) ────────────────────────────────────────────────────

// POST /api/gateways (on the Hub, and the sidecar's own check): connect a
// Gateway by its URL and management key. Write-only: the key is never served
// back. `DELETE /api/gateways/:id` removes one, at the Hub only.
export const HUB_GATEWAYS_PATH = "/api/gateways";
export function hubGatewayPath(id: string): string {
  return `${HUB_GATEWAYS_PATH}/${encodeURIComponent(id)}`;
}
export const gatewayConnectRequestSchema = z
  .object({ url: gatewayUrlSchema, managementKey: gatewayManagementKeySchema })
  .strict();
export type GatewayConnectRequest = z.infer<typeof gatewayConnectRequestSchema>;

// What Connect always says (D8): retention cannot be read through the two
// calls MaxPrice makes, so `retention` advises 3600 s every time, and
// `only-consumer` says MaxPrice must be the queue's only consumer (§6).
export const GATEWAY_WARNINGS = ["retention", "only-consumer"] as const;
export const gatewayWarningSchema = z.enum(GATEWAY_WARNINGS);
export type GatewayWarning = z.infer<typeof gatewayWarningSchema>;

// Why a Connect check failed: the Gateway did not answer, refused the key, or
// answered anything else unusable.
export const GATEWAY_CHECK_FAILURES = ["unreachable", "unauthorized", "error"] as const;
export const gatewayCheckFailureSchema = z.enum(GATEWAY_CHECK_FAILURES);
export type GatewayCheckFailure = z.infer<typeof gatewayCheckFailureSchema>;

export const gatewayConnectResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    gateway: hubGatewaySchema,
    warnings: z.array(gatewayWarningSchema),
  }),
  z.object({ ok: z.literal(false), failure: gatewayCheckFailureSchema }),
]);
export type GatewayConnectResponse = z.infer<typeof gatewayConnectResponseSchema>;

// ── The record feed and the push-up (ADR-0141 §5) ────────────────────────────

// GET /api/gateway-records?since=<cursor> is the Hub's 7-day feed of reduced
// records, oldest first, at most GATEWAY_RECORDS_PAGE_MAX a page; `cursor` is
// opaque and resumes after the page's last record. A full page means ask
// again from the cursor. No `since` starts at the feed's oldest record.
// POST /api/gateway-records is a client's push-up of records it drained.
export const HUB_GATEWAY_RECORDS_PATH = "/api/gateway-records";
export const GATEWAY_RECORDS_SINCE_PARAM = "since";
export const GATEWAY_RECORDS_PAGE_MAX = 500;
export function hubGatewayRecordsFeedPath(since: string | null): string {
  return since === null
    ? HUB_GATEWAY_RECORDS_PATH
    : `${HUB_GATEWAY_RECORDS_PATH}?${GATEWAY_RECORDS_SINCE_PARAM}=${encodeURIComponent(since)}`;
}
export const gatewayRecordsFeedSchema = z.object({
  records: z.array(reducedGatewayRecordSchema).max(GATEWAY_RECORDS_PAGE_MAX),
  cursor: z.string().min(1).max(256),
});
export type GatewayRecordsFeed = z.infer<typeof gatewayRecordsFeedSchema>;

// A push-up carries at most GATEWAY_RECORDS_PAGE_MAX records; a client with
// more pushes again. The ack's `accepted` lists every pushed `executionId`
// the client may now drop: each one the Hub holds after the push (newly, or
// already held, so a record pushed twice is acked twice and stored once), and
// each one it refused as already past its 7-day window. A record the ack
// leaves out stays in the client's outbox for the next push.
export const gatewayRecordsPushSchema = z
  .object({
    records: z.array(reducedGatewayRecordSchema).min(1).max(GATEWAY_RECORDS_PAGE_MAX),
  })
  .strict();
export type GatewayRecordsPush = z.infer<typeof gatewayRecordsPushSchema>;
export const gatewayRecordsAckSchema = z.object({
  accepted: z.array(gatewayIdFieldSchema).max(GATEWAY_RECORDS_PAGE_MAX),
});
export type GatewayRecordsAck = z.infer<typeof gatewayRecordsAckSchema>;

// ── A client's own Gateways (ADR-0141 §5, §7; D11) ──────────────────────────

// The sidecar's loopback routes for the Gateways its host holds. The host
// (the Desktop renderer, from its credential store; the Headless client, from
// secrets.json at boot) pushes the whole held set to POST
// /api/gateways/config, which replaces it; POST /api/gateways/check runs
// Connect's checks without holding anything; GET /api/gateways lists each
// held Gateway, never its key. All three are behind the sidecar's auth guard.
export const SIDECAR_GATEWAYS_PATH = "/api/gateways";
export const SIDECAR_GATEWAYS_CONFIG_PATH = "/api/gateways/config";
export const SIDECAR_GATEWAYS_CHECK_PATH = "/api/gateways/check";

// How many Gateways one machine may hold: far above any real fleet's, it
// bounds a push.
export const GATEWAYS_HELD_MAX = 64;
export const gatewayConfigEntrySchema = gatewayConnectRequestSchema;
export type GatewayConfigEntry = GatewayConnectRequest;
export const gatewaysConfigRequestSchema = z
  .object({ gateways: z.array(gatewayConfigEntrySchema).max(GATEWAYS_HELD_MAX) })
  .strict();
export type GatewaysConfigRequest = z.infer<typeof gatewaysConfigRequestSchema>;
export const gatewaysConfigAckSchema = z.object({ ok: z.literal(true) });
export type GatewaysConfigAck = z.infer<typeof gatewaysConfigAckSchema>;

// POST /api/gateways/check answers Connect's checks (D8): a passing check
// with its warnings, or why it failed. The Hub's Connect answer without the
// `gateway` entry, since the check holds nothing.
export const gatewayCheckResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), warnings: z.array(gatewayWarningSchema) }),
  z.object({ ok: z.literal(false), failure: gatewayCheckFailureSchema }),
]);
export type GatewayCheckResponse = z.infer<typeof gatewayCheckResponseSchema>;

// Who drains a held Gateway now (ADR-0141 §5): `hub` while the joined Hub is
// connected and its status lists the Gateway `draining` or `statistics-off`,
// else `this-machine`, the fallback drain.
export const GATEWAY_DRAINERS = ["hub", "this-machine"] as const;
export const gatewayDrainerSchema = z.enum(GATEWAY_DRAINERS);
export type GatewayDrainer = z.infer<typeof gatewayDrainerSchema>;

// One held Gateway as GET /api/gateways lists it: `state` and `lastRecordAt`
// are the Hub's (from its status) while the Hub drains it, else this
// machine's own drain's (`lastRecordAt` null before its first record this
// run). Never the URL's path or the key.
export const localGatewaySchema = hubGatewaySchema.extend({ drainedBy: gatewayDrainerSchema });
export type LocalGateway = z.infer<typeof localGatewaySchema>;
export const localGatewaysResponseSchema = z.object({
  gateways: z.array(localGatewaySchema).max(GATEWAYS_HELD_MAX),
});
export type LocalGatewaysResponse = z.infer<typeof localGatewaysResponseSchema>;
