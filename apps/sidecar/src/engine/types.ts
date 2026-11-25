import { z } from "zod";

// Part 4.5 — the usage engine's JSONL parser contract.
//
// Two layers live here:
//   1. Zod schemas for the raw Claude Code JSONL record shapes, modelled as a
//      discriminated union on the top-level `type` field. These are
//      deliberately permissive — Claude Code adds fields between versions, so
//      every record schema is open (no `.strict()`), and fields the engine
//      does not interpret are typed `unknown` rather than dropped.
//   2. `UsageRecord` — the parser's *output* type: one extracted assistant
//      usage event. This is the frozen contract the event store (E4) and the
//      four aggregators (E5–E8) consume. It is intentionally NOT named
//      `UsageEvent` — that name is taken by the SSE signal type in
//      `@maxprice/shared` (`packages/shared/src/live.ts`).

// ---------------------------------------------------------------------------
// Raw token-usage subtree
// ---------------------------------------------------------------------------

// The `cache_creation` split. Claude Code reports cache-creation tokens broken
// down by ephemeral TTL (5-minute vs 1-hour). The flat
// `cache_creation_input_tokens` count is the sum of the two; the split is
// retained verbatim so a future tiered-pricing implementation has it. Older
// records may omit `cache_creation` entirely.
export const cacheCreationSplitSchema = z
  .object({
    ephemeral_5m_input_tokens: z.number(),
    ephemeral_1h_input_tokens: z.number(),
  })
  .passthrough();

// The `message.usage` subtree on an assistant record. Open schema: `usage`
// carries plenty of fields the engine ignores (`server_tool_use`,
// `service_tier`, `iterations`, …) — they pass through untouched.
//
// Required vs optional mirrors the golden oracle's usage schema exactly (the
// package + pinned version are named in CONTRIBUTING.md, "Tests and the
// golden oracle"). Read from the Valibot record schema in its bundled
// `data-loader` dist module:
//   input_tokens: number                    (required)
//   output_tokens: number                   (required)
//   cache_creation_input_tokens: optional(number)
//   cache_read_input_tokens: optional(number)
// and the oracle coalesces the two cache counts to `0` at read time (`?? 0`). An
// old history record that omits a cache count must therefore be *included*
// with that count treated as 0, not warn-dropped — so the two cache counts
// are optional here and `toUsageRecord` coalesces them to 0. `cache_creation`
// (the 5m/1h split) is not in that schema at all; the engine retains it
// for future tiered pricing and so leaves it optional.
// `.finite()` on every count: `z.number()` alone accepts `NaN`/`Infinity`, and
// a non-finite token count would poison every sum it folds into. A record
// carrying one fails validation and lands in the parser's warn-and-continue
// path — the same place malformed JSONL goes. Real Claude Code JSONL never
// emits a non-finite count, so this changes nothing on the golden corpus.
export const usageSchema = z
  .object({
    input_tokens: z.number().finite(),
    output_tokens: z.number().finite(),
    cache_creation_input_tokens: z.number().finite().optional(),
    cache_read_input_tokens: z.number().finite().optional(),
    cache_creation: cacheCreationSplitSchema.optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Raw record schemas — discriminated union on `type`
// ---------------------------------------------------------------------------

// The `message` block on an assistant record. `usage` is optional here: an
// assistant record can lack it (e.g. an API-error row), and the parser's
// inclusion rule — not the schema — decides whether such a record yields a
// `UsageRecord`. Modelling `usage` as required would push otherwise-valid
// assistant records into the warn-and-continue path, conflating "malformed
// JSONL" with "assistant record we deliberately skip".
export const assistantMessageSchema = z
  .object({
    id: z.string(),
    model: z.string(),
    role: z.literal("assistant").optional(),
    usage: usageSchema.optional(),
  })
  .passthrough();

// An assistant record. `requestId`, `timestamp`, `cwd` are top-level siblings
// of `message` (NOT nested inside it). `costUSD` is an optional top-level
// number — real Claude Code JSONL omits the key entirely; an explicit `null`
// is rejected (golden parity, see fixtures/README.md "Quirks").
// `isApiErrorMessage` flags an API-error row, which the parser skips.
export const assistantRecordSchema = z
  .object({
    type: z.literal("assistant"),
    timestamp: z.string(),
    message: assistantMessageSchema,
    requestId: z.string().optional(),
    cwd: z.string().optional(),
    // `.finite()` — a non-finite `costUSD` would propagate `NaN`/`Infinity`
    // into every cost sum; reject it like any malformed field.
    costUSD: z.number().finite().optional(),
    isApiErrorMessage: z.boolean().optional(),
  })
  .passthrough();

// The Owner record (GLOSSARY.md): the line Claude Code writes when a session is
// attached to Remote Control or the desktop app, naming the Organization that
// owns the session from that line on. It is attribution evidence, never a
// usage event, and it is NOT a member of `jsonlRecordSchema` — the scan reads
// it ahead of the pre-filter (jsonl.ts) and it never reaches the union. Older
// records omit the owner fields; those are no evidence, not a reset.
// `ownerAccountUuid` names the owning Account beside the Organization, present
// only when known (ADR-0137): it is read only from a record that names an
// Organization, and such a record without it names no Account.
export const ownerRecordSchema = z
  .object({
    type: z.literal("bridge-session"),
    ownerOrganizationUuid: z.string().min(1).optional(),
    ownerAccountUuid: z.string().min(1).optional(),
  })
  .passthrough();
export type OwnerRecord = z.infer<typeof ownerRecordSchema>;

// The Login record (GLOSSARY.md, ADR-0109): the `credential_org` attachment
// Claude Code 2.1.281+ writes at a session's first query, and again at each
// change, naming the Organization of the login in use. Attribution evidence
// that outranks the Owner record; like it, never a usage event and read ahead
// of the pre-filter (jsonl.ts). A record without a nonempty uuid is no evidence.
export const loginRecordSchema = z
  .object({
    type: z.literal("attachment"),
    attachment: z
      .object({
        type: z.literal("credential_org"),
        organizationUuid: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();
export type LoginRecord = z.infer<typeof loginRecordSchema>;

// The Email record (ADR-0137 §2): the `session_context` attachment Claude Code
// writes at a session's first query, under the same claude.ai-login gate as the
// Login record, whose `context.userEmail` is a sentence embedding the login's
// email address. A re-announce adds `changed: true` and a `reason`; only
// `reason: "account_change"` (the in-process login routine's) moves the
// Account. Attribution evidence like the Login record: never a usage event, read
// ahead of the pre-filter (jsonl.ts). A sentence naming no address is no
// evidence.
export const emailRecordSchema = z
  .object({
    type: z.literal("attachment"),
    attachment: z
      .object({
        type: z.literal("session_context"),
        context: z.object({ userEmail: z.string() }).passthrough(),
        changed: z.boolean().optional(),
        reason: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type EmailRecord = z.infer<typeof emailRecordSchema>;

// Every non-assistant record kind. The engine reads none of their innards, so
// each is modelled as `{ type: <literal> }` open — enough to discriminate, no
// more. `type` values observed across the E1 fixture corpus: `user`, `system`,
// `summary`, `attachment`, `file-history-snapshot`, `ai-title`, `last-prompt`,
// `permission-mode`, `synthetic`. A `summary` record is a known Claude Code
// kind not present in the current fixtures; it is listed here so it parses
// cleanly rather than falling into the unknown-type branch.
const otherRecordType = <T extends string>(type: T) =>
  z
    .object({
      type: z.literal(type),
    })
    .passthrough();

export const userRecordSchema = otherRecordType("user");
export const systemRecordSchema = otherRecordType("system");
export const summaryRecordSchema = otherRecordType("summary");
export const attachmentRecordSchema = otherRecordType("attachment");
export const fileHistorySnapshotRecordSchema = otherRecordType("file-history-snapshot");
export const aiTitleRecordSchema = otherRecordType("ai-title");
export const lastPromptRecordSchema = otherRecordType("last-prompt");
export const permissionModeRecordSchema = otherRecordType("permission-mode");
export const syntheticRecordSchema = otherRecordType("synthetic");

// The discriminated union of every modelled record kind. A record whose `type`
// is a string the engine has never seen still fails this union — `parseLine`
// reports that as a validation failure and the reader warns-and-continues, so
// an unmodelled record kind never crashes a scan.
export const jsonlRecordSchema = z.discriminatedUnion("type", [
  assistantRecordSchema,
  userRecordSchema,
  systemRecordSchema,
  summaryRecordSchema,
  attachmentRecordSchema,
  fileHistorySnapshotRecordSchema,
  aiTitleRecordSchema,
  lastPromptRecordSchema,
  permissionModeRecordSchema,
  syntheticRecordSchema,
]);

export type Usage = z.infer<typeof usageSchema>;
export type CacheCreationSplit = z.infer<typeof cacheCreationSplitSchema>;
export type AssistantRecord = z.infer<typeof assistantRecordSchema>;
export type JsonlRecord = z.infer<typeof jsonlRecordSchema>;

// ---------------------------------------------------------------------------
// UsageRecord — the parser's frozen output contract (consumed by E4–E8)
// ---------------------------------------------------------------------------

// One extracted assistant usage event. The parser emits exactly one of these
// per qualifying JSONL line; it does NOT deduplicate — Claude Code writes
// ~2–3 content-block lines per assistant message that share `messageId` +
// `requestId` and a byte-identical token payload, and collapsing them by the
// `(messageId, requestId)` tuple is the event store's job (E4).
//
// Field provenance, all from the raw assistant record:
//   - `timestamp`       — top-level `timestamp`
//   - `messageId`       — `message.id`
//   - `requestId`       — top-level `requestId` (may be absent on older records)
//   - `model`           — `message.model`
//   - the four token counts — `message.usage.*`
//   - `cacheCreation`   — `message.usage.cache_creation` 5m/1h split, when present
//   - `costUSD`         — top-level `costUSD`, when present (never `null`)
//   - `cwd`             — top-level `cwd`, the session's working directory
//   - `organizationUuid` — the Login or Owner record in effect above it (jsonl.ts)
//   - `accountUuid` / `accountEmailHash` — the Account cursor's evidence (jsonl.ts)
export type UsageRecord = {
  timestamp: string;
  messageId: string;
  requestId: string | undefined;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  // The 5m/1h ephemeral cache-creation split, retained for future tiered
  // pricing. `undefined` when the raw record omitted `cache_creation`.
  cacheCreation:
    | {
        ephemeral5m: number;
        ephemeral1h: number;
      }
    | undefined;
  costUSD: number | undefined;
  cwd: string | undefined;
  // The Organization (GLOSSARY.md, ADR-0098, ADR-0109) this line is attributed
  // to: the file's Login cursor once a Login record precedes it, else the most
  // recent Owner record ABOVE this line in the same file; `undefined` when
  // neither precedes it — a session that was never attached. A subagent
  // transcript's rows are tagged the same way, and the store ignores that tag:
  // every subagent row inherits its parent session's owner (ADR-0109 §5).
  organizationUuid: string | undefined;
  // The Account (GLOSSARY.md, ADR-0137 §2) this line's evidence names, on the
  // same clock as `organizationUuid`, AS READ: never resolved, so at most one
  // of the two is set. From the file's first Login record on it is the Email
  // cursor's, `accountEmailHash` (emailHash's SHA-256 hex of the address,
  // never the address itself); in a file with no Login record it is the most
  // recent Owner record's `ownerAccountUuid`, `accountUuid`. Both `undefined`
  // when that source names none. The hash is resolved to a uuid through the
  // pair table at ingest, never here, so a pair learned later re-resolves a
  // cached row with no re-parse (ADR-0137 §6). A subagent's rows are tagged
  // the same way, and that tag is no evidence (ADR-0137 §2).
  accountUuid: string | undefined;
  accountEmailHash: string | undefined;
};

// A record's or a row's Account evidence, as read: `UsageRecord`'s two fields,
// at most one of them set. The parser's cursor answers it (jsonl.ts's
// `attributedAccount`) and the store's owner points carry it (store.ts).
export type AccountEvidence = Pick<UsageRecord, "accountUuid" | "accountEmailHash">;

// The evidence of a line or a row that carries none, shared because it is
// never mutated.
export const NO_ACCOUNT_EVIDENCE: AccountEvidence = {
  accountUuid: undefined,
  accountEmailHash: undefined,
};

// Whether a line or a row carries transcript evidence of its own: an
// Organization, or an Account by uuid or email hash. A matched Gateway record
// is evidence only for a line where this is false (ADR-0141 §2), so the
// store's Gateway lookup, its `hasTranscriptEvidence` and the sessions
// report's evidence fold share this one test.
export function hasOwnEvidence(
  e: Pick<UsageRecord, "organizationUuid" | "accountUuid" | "accountEmailHash">,
): boolean {
  return (
    e.organizationUuid !== undefined ||
    e.accountUuid !== undefined ||
    e.accountEmailHash !== undefined
  );
}

// The on-disk parse cache's whole-cache version (ADR-0048). The cache stores
// `UsageRecord[]` per source file and loads them WITHOUT re-validation, so any
// change to what a stored record means invalidates every cached byte. REVIEW
// DISCIPLINE: bump this integer whenever a change touches
//   - the `UsageRecord` shape (fields added/removed/re-typed),
//   - the inclusion rules (`toUsageRecord`, the synthetic/API-error skips),
//   - parse semantics (schema coercions, count coalescing, pre-filter reach).
// A version mismatch discards the whole cache — one slow boot, never a wrong
// number. Lives beside `UsageRecord` so the shape and its cache version are
// reviewed together.
// History: 1 — the original shape; 2 — ADR-0098 added `organizationUuid`;
// 3 — ADR-0109: a Login record outranks the Owner record, so a cached
// record's `organizationUuid` may be stale; 4 — ADR-0137 §6 added
// `accountUuid` and `accountEmailHash` (the cache stores an Email record's
// evidence as the email hash, never a uuid a pair resolves it to).
export const SCAN_CACHE_VERSION = 4;

// ---------------------------------------------------------------------------
// parseLine result
// ---------------------------------------------------------------------------

// `parseLine` is total — it never throws. It returns one of:
//   - `{ ok: true,  record }`  — a well-formed, schema-valid JSONL record
//   - `{ ok: false, reason }`  — a blank line, non-JSON text, or a record that
//                                failed schema validation
// The streaming reader turns every `ok: false` into a warning and continues.
export type ParseLineResult =
  | { ok: true; record: JsonlRecord }
  | { ok: false; reason: ParseFailureReason; message: string };

export type ParseFailureReason = "blank" | "invalid-json" | "schema-mismatch";
