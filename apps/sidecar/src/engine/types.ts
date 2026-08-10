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
// `data-loader` dist module — `engine/blocks.ts`'s header cites that file by
// its full path:
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
};

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
export const SCAN_CACHE_VERSION = 1;

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
