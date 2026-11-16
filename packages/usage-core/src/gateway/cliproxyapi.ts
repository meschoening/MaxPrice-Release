import { z } from "zod";
import {
  GATEWAY_WARNINGS,
  accountUuidSchema,
  emailHash,
  normalizeGatewayUrl,
  organizationUuidKeySchema,
  reducedGatewayRecordSchema,
  sessionIdKeySchema,
  type GatewayCheckFailure,
  type GatewayWarning,
  type ReducedGatewayRecord,
} from "@maxprice/shared";
import type { FetchLike } from "../usage-client";

// The CLIProxyAPI v8 adapter (ADR-0141 §7, D8): the one Gateway adapter. It
// makes two calls and no others, each with `Authorization: Bearer <management
// key>`:
//
// - GET /v8/management/credentials, the credential list (`{ files: [...] }`);
// - GET /v8/management/observability/usage/queue?count=N, which pops up to N
//   records off the usage queue, oldest first, as a JSON array.
//
// It never calls `/credentials/download`, which serves the OAuth tokens
// themselves (§7). The queue's format is CLIProxyAPI's, with no stability
// promise, so the schema below pins only the fields read and fails closed: a
// record it cannot read is dropped and counted (`unreadable`), never guessed
// at, and its line stays unmatched (§4).

export const CLIPROXYAPI_CREDENTIALS_PATH = "/v8/management/credentials";
export const CLIPROXYAPI_QUEUE_PATH = "/v8/management/observability/usage/queue";
// Records asked for per queue read. A read that returns fewer drained the
// queue; one that returns this many is followed by another, up to
// CLIPROXYAPI_DRAIN_PAGES_MAX reads a drain.
export const CLIPROXYAPI_QUEUE_PAGE = 500;
export const CLIPROXYAPI_DRAIN_PAGES_MAX = 20;
const DEFAULT_TIMEOUT_MS = 10_000;

// ── The record ───────────────────────────────────────────────────────────────

// An email as a Gateway names a credential's: `source` is the email for an
// OAuth credential but the upstream API key for an API-key one
// (source-findings §1.4), so only an address-shaped value counts.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

// A header's first value, its name compared case-insensitively.
function headerValue(headers: Record<string, string[]>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = values.find((v) => v !== "");
    if (value !== undefined) return value;
  }
  return undefined;
}

const idField = z.string().min(1).max(256);
const optionalSession = z
  .string()
  .optional()
  .transform((value) => (value === "" ? undefined : value))
  .pipe(sessionIdKeySchema.optional());
const tokenCount = reducedGatewayRecordSchema.shape.inputTokens;

// One queue record as this adapter reads it. The transform drops the email at
// parse: `source` and nothing else in the record carries one, and it leaves
// the parse only as its hash (`emailHash`, ADR-0137 §1), so a parsed record
// holds no address. The two headers read are lifted out of `response_headers`
// (any case), and the timestamp is normalized to ISO UTC.
export const cliProxyRecordSchema = z
  .object({
    execution_id: idField,
    request_id: idField.optional(),
    session_id: optionalSession,
    parent_session_id: optionalSession,
    source: z.string().optional(),
    auth_index: z.string().min(1).max(256).optional(),
    tokens: z.object({
      input_tokens: tokenCount,
      output_tokens: tokenCount,
      cache_read_tokens: tokenCount,
      cache_creation_tokens: tokenCount,
    }),
    failed: z.boolean(),
    model: reducedGatewayRecordSchema.shape.model,
    timestamp: z.string().refine((ts) => Number.isFinite(Date.parse(ts))),
    response_headers: z.record(z.array(z.string())).nullable().optional(),
  })
  .transform((raw) => ({
    executionId: raw.execution_id,
    requestId: raw.request_id,
    sessionId: raw.session_id,
    parentSessionId: raw.parent_session_id,
    sourceEmailHash:
      raw.source !== undefined && EMAIL_SHAPE.test(raw.source.trim())
        ? emailHash(raw.source)
        : undefined,
    authIndex: raw.auth_index,
    inputTokens: raw.tokens.input_tokens,
    outputTokens: raw.tokens.output_tokens,
    cacheReadTokens: raw.tokens.cache_read_tokens,
    cacheCreationTokens: raw.tokens.cache_creation_tokens,
    failed: raw.failed,
    model: raw.model,
    timestamp: new Date(Date.parse(raw.timestamp)).toISOString(),
    organizationUuid: headerValue(raw.response_headers ?? {}, "Anthropic-Organization-Id"),
    upstreamRequestId: headerValue(raw.response_headers ?? {}, "Request-Id"),
  }))
  .pipe(
    z.object({
      executionId: idField,
      requestId: idField.optional(),
      sessionId: sessionIdKeySchema.optional(),
      parentSessionId: sessionIdKeySchema.optional(),
      sourceEmailHash: z.string().optional(),
      authIndex: z.string().optional(),
      inputTokens: tokenCount,
      outputTokens: tokenCount,
      cacheReadTokens: tokenCount,
      cacheCreationTokens: tokenCount,
      failed: z.boolean(),
      model: z.string(),
      timestamp: z.string(),
      organizationUuid: organizationUuidKeySchema.optional(),
      upstreamRequestId: idField.optional(),
    }),
  );
export type CliProxyRecord = z.infer<typeof cliProxyRecordSchema>;

// ── The credential list ──────────────────────────────────────────────────────

// One credential as this adapter reads it: its `auth_index`, its email's hash
// (the address is dropped at parse), and `served`, its `success` plus
// `failed` counters when the Gateway gives them (the `statistics-off`
// inference reads them). Entries with no `auth_index` are skipped.
export type CliProxyCredential = {
  authIndex: string;
  emailHash?: string;
  served?: number;
};

const credentialEntrySchema = z.object({
  auth_index: z.string().min(1).max(256),
  email: z.string().optional(),
  success: z.number().int().nonnegative().optional(),
  failed: z.number().int().nonnegative().optional(),
});
const credentialListSchema = z.object({ files: z.array(z.unknown()) });

function readCredentials(body: unknown): CliProxyCredential[] | null {
  const list = credentialListSchema.safeParse(body);
  if (!list.success) return null;
  const out: CliProxyCredential[] = [];
  for (const file of list.data.files) {
    const entry = credentialEntrySchema.safeParse(file);
    if (!entry.success) continue;
    const { auth_index, email, success, failed } = entry.data;
    const credential: CliProxyCredential = { authIndex: auth_index };
    if (email !== undefined && EMAIL_SHAPE.test(email.trim()))
      credential.emailHash = emailHash(email);
    if (success !== undefined || failed !== undefined)
      credential.served = (success ?? 0) + (failed ?? 0);
    out.push(credential);
  }
  return out;
}

// ── Reduce (ADR-0141 §5) ─────────────────────────────────────────────────────

// A record reduced for matching and the wire, with its credential's email
// hash beside it for the machine that read it (a client's pair table may
// resolve it later; the hash never travels). Null for a failed attempt: §2
// skips it, so after a failover the attempt that succeeded names the
// Membership. A record naming no Organization is still reduced, without one.
//
// The email is the record's own `source` when it is an address, else its
// credential's by `auth_index` (`credentials`, from `listCredentials`).
// `resolve` maps an email hash to an account uuid where the caller knows one
// (the Hub through its keys' `/api/account`, a client through its pair
// table); a value that is not an account uuid is ignored.
export type ReducedCliProxyRecord = { reduced: ReducedGatewayRecord; emailHash?: string };
export function reduceCliProxyRecord(
  record: CliProxyRecord,
  opts: {
    credentials?: ReadonlyMap<string, string>;
    resolve?: (emailHash: string) => string | undefined;
  } = {},
): ReducedCliProxyRecord | null {
  if (record.failed) return null;
  const hash =
    record.sourceEmailHash ??
    (record.authIndex === undefined ? undefined : opts.credentials?.get(record.authIndex));
  const resolved = hash === undefined ? undefined : opts.resolve?.(hash);
  const accountUuid =
    resolved !== undefined && accountUuidSchema.safeParse(resolved).success ? resolved : undefined;
  const reduced: ReducedGatewayRecord = {
    executionId: record.executionId,
    ...(record.requestId === undefined ? {} : { requestId: record.requestId }),
    ...(record.upstreamRequestId === undefined
      ? {}
      : { upstreamRequestId: record.upstreamRequestId }),
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    ...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheCreationTokens: record.cacheCreationTokens,
    model: record.model,
    timestamp: record.timestamp,
    ...(record.organizationUuid === undefined ? {} : { organizationUuid: record.organizationUuid }),
    ...(accountUuid === undefined ? {} : { accountUuid }),
  };
  return hash === undefined ? { reduced } : { reduced, emailHash: hash };
}

// The credential list as `reduceCliProxyRecord`'s `credentials`: auth_index
// to email hash.
export function credentialEmailHashes(
  credentials: readonly CliProxyCredential[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of credentials) if (c.emailHash !== undefined) out.set(c.authIndex, c.emailHash);
  return out;
}

// ── The client ───────────────────────────────────────────────────────────────

// Why a read failed: the Gateway did not answer (`unreachable`: a network
// error or timeout), refused the management key (`unauthorized`: 401 or 403),
// or answered anything else unusable (`error`: another status, a body that is
// not JSON, or an envelope of the wrong shape).
export type CliProxyFailure = GatewayCheckFailure;

export type CliProxyDrain = {
  // Every record read, failed attempts included (reduce skips them).
  records: CliProxyRecord[];
  // Records the queue gave that the schema could not read: dropped.
  unreadable: number;
  // Why the drain stopped early, or null when it read the queue dry (or hit
  // CLIPROXYAPI_DRAIN_PAGES_MAX). Records already popped before a failure are
  // in `records` all the same: the queue no longer holds them.
  failure: CliProxyFailure | null;
};

export type CliProxyCredentials =
  | { ok: true; credentials: CliProxyCredential[] }
  | { ok: false; failure: CliProxyFailure };

export type CliProxyApi = {
  drain: () => Promise<CliProxyDrain>;
  listCredentials: () => Promise<CliProxyCredentials>;
};

export type CliProxyApiOptions = {
  url: string;
  managementKey: string;
  fetch?: FetchLike;
  timeoutMs?: number;
};

type Read = { ok: true; body: unknown } | { ok: false; failure: CliProxyFailure };

export function createCliProxyApi(opts: CliProxyApiOptions): CliProxyApi {
  const base = normalizeGatewayUrl(opts.url);
  if (base === null) throw new Error("not a Gateway URL");
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function read(path: string): Promise<Read> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${opts.managementKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, failure: "unreachable" };
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      return { ok: false, failure: "unauthorized" };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, failure: "error" };
    }
    try {
      return { ok: true, body: await response.json() };
    } catch {
      return { ok: false, failure: "error" };
    }
  }

  return {
    async drain() {
      const records: CliProxyRecord[] = [];
      let unreadable = 0;
      for (let page = 0; page < CLIPROXYAPI_DRAIN_PAGES_MAX; page++) {
        const result = await read(`${CLIPROXYAPI_QUEUE_PATH}?count=${CLIPROXYAPI_QUEUE_PAGE}`);
        if (!result.ok) return { records, unreadable, failure: result.failure };
        if (!Array.isArray(result.body)) return { records, unreadable, failure: "error" };
        for (const raw of result.body) {
          const parsed = cliProxyRecordSchema.safeParse(raw);
          if (parsed.success) records.push(parsed.data);
          else unreadable += 1;
        }
        if (result.body.length < CLIPROXYAPI_QUEUE_PAGE) break;
      }
      return { records, unreadable, failure: null };
    },
    async listCredentials() {
      const result = await read(CLIPROXYAPI_CREDENTIALS_PATH);
      if (!result.ok) return result;
      const credentials = readCredentials(result.body);
      return credentials === null ? { ok: false, failure: "error" } : { ok: true, credentials };
    },
  };
}

// ── Connect (ADR-0141 §7, D8) ────────────────────────────────────────────────

// The Connect check: one credential-list read, which says whether the
// Gateway answers and takes the key. It never reads the queue, since every
// read pops and a check keeps nothing it drains. Neither call shows the
// queue's retention or `usage-statistics-enabled`, so a passing check always
// carries both warnings (retention advice, and MaxPrice as the only
// consumer), and `statistics-off` is the drainer's later inference
// (`inferStatisticsOff`).
export type GatewayCheck =
  | { ok: true; warnings: GatewayWarning[] }
  | { ok: false; failure: CliProxyFailure };
export async function checkGateway(opts: CliProxyApiOptions): Promise<GatewayCheck> {
  const result = await createCliProxyApi(opts).listCredentials();
  if (!result.ok) return result;
  return { ok: true, warnings: [...GATEWAY_WARNINGS] };
}

// Whether the Gateway serves requests while its queue publishes nothing,
// which is `usage-statistics-enabled` off: some credential's served count
// (`success` + `failed`) rose between two credential-list reads, `before`
// and `after`, while the drains between them read no record at all. A
// credential absent from either read, or without counters, says nothing; a
// count that fell (the Gateway restarted) says nothing. A second consumer
// that takes every record looks the same (§6).
export function inferStatisticsOff(
  before: readonly CliProxyCredential[],
  after: readonly CliProxyCredential[],
  recordsBetween: number,
): boolean {
  if (recordsBetween > 0) return false;
  const earlier = new Map(before.map((c) => [c.authIndex, c.served]));
  return after.some((c) => {
    const was = earlier.get(c.authIndex);
    return was !== undefined && c.served !== undefined && c.served > was;
  });
}
