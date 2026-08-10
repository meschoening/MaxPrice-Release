import {
  jsonlRecordSchema,
  type AssistantRecord,
  type ParseLineResult,
  type UsageRecord,
} from "./types";

// Part 4.5 — the usage engine's JSONL parser.
//
// Two surfaces, both used downstream:
//   - `parseLine`          — pure, total: validates one line. E4's incremental
//                            path reuses it on lines from the watcher's
//                            tail-reader.
//   - `collectUsageRecords` — the whole-file reader E4's initial scan calls.
//
// The parser extracts assistant *usage* events and does NOT deduplicate them
// (see UsageRecord's doc comment in types.ts) — that boundary belongs to E4.

// ---------------------------------------------------------------------------
// parseLine — pure, never throws
// ---------------------------------------------------------------------------

// Parse + schema-validate a single JSONL line. Total: every input maps to a
// `ParseLineResult`, never an exception. A blank line, non-JSON text, and a
// schema-invalid record are all reported as `ok: false` with a distinguishing
// `reason` so the caller can log precisely.
export function parseLine(line: string): ParseLineResult {
  if (line.trim() === "") {
    return { ok: false, reason: "blank", message: "blank line" };
  }

  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (err) {
    return {
      ok: false,
      reason: "invalid-json",
      message: err instanceof Error ? err.message : "JSON parse failed",
    };
  }

  const parsed = jsonlRecordSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "schema-mismatch",
      message: parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; "),
    };
  }

  return { ok: true, record: parsed.data };
}

// ---------------------------------------------------------------------------
// Assistant-usage inclusion + extraction
// ---------------------------------------------------------------------------

// The loader skips assistant rows whose model is the literal
// `"<synthetic>"` placeholder Claude Code writes for synthetic messages. (A
// `type:"synthetic"` record is skipped earlier — it never reaches the
// assistant branch of the union.)
const SYNTHETIC_MODEL = "<synthetic>";

// Decide whether an assistant record is a usage event and, if so, project it
// onto the frozen `UsageRecord` shape. Returns `null` for an assistant record
// the engine deliberately excludes:
//   - no `message.usage`            — e.g. an API-error or text-only row
//   - `isApiErrorMessage: true`     — an API-error row
//   - `message.model === "<synthetic>"` — a synthetic message
// These are the golden oracle's loader skip rules; exact parity is verified
// later by the aggregator golden tests (E5–E8).
export function toUsageRecord(record: AssistantRecord): UsageRecord | null {
  if (record.isApiErrorMessage === true) return null;
  if (record.message.model === SYNTHETIC_MODEL) return null;

  const usage = record.message.usage;
  if (usage === undefined) return null;

  const split = usage.cache_creation;
  return {
    timestamp: record.timestamp,
    messageId: record.message.id,
    requestId: record.requestId,
    model: record.message.model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    // Coalesce missing cache counts to 0 — an old record that omits one is
    // valid (the schema makes them optional) and the golden oracle likewise
    // reads them as `?? 0`. See usageSchema's comment in types.ts.
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreation:
      split === undefined
        ? undefined
        : {
            ephemeral5m: split.ephemeral_5m_input_tokens,
            ephemeral1h: split.ephemeral_1h_input_tokens,
          },
    costUSD: record.costUSD,
    cwd: record.cwd,
  };
}

// ---------------------------------------------------------------------------
// Scan pre-filter
// ---------------------------------------------------------------------------

// A parsed line can only yield a `UsageRecord` when its top-level `type` is
// `"assistant"` — and for that, the raw text must contain `"type"`, optional
// JSON whitespace, `:`, optional JSON whitespace, `"assistant"`. (`\s` is a
// superset of JSON's whitespace set, which errs toward NOT skipping.) The one
// premise: no producer unicode-escapes ASCII letters inside the discriminant
// (`"type"`) — true of JSON.stringify and every standard serializer, and
// the same assumption every JSONL grep makes.
const ASSISTANT_MARKER = /"type"\s*:\s*"assistant"/;

// The scan's cheap discard test: ~49% of corpus lines are records the full
// path parses and then throws away (user/system rows, unmodeled control
// types). A marker-less line cannot parse into a top-level assistant record,
// so it can skip `JSON.parse` + Zod entirely. Conservative by construction:
//   - a false MATCH (the marker inside nested/quoted content) merely falls
//     through to the full path, which discards it exactly as before;
//   - the `endsWith("}")` guard keeps every structurally suspect line — a
//     truncated record is cut mid-write and (virtually) never ends in `}` —
//     on the full path, preserving the invalid-json warning discipline.
// The only silenced case is marker-less invalid JSON that happens to end in
// `}`, which no writer we know of produces (pinned in jsonl.test.ts).
export function preFilterSkips(line: string): boolean {
  return line.endsWith("}") && !ASSISTANT_MARKER.test(line);
}

// ---------------------------------------------------------------------------
// Whole-file reader
// ---------------------------------------------------------------------------

// Read a whole JSONL file, split it into lines, and collect one `UsageRecord`
// per qualifying assistant line.
//
// One `.text()` read, not a chunk stream: the old streaming reader's
// per-line `slice` on a shrinking buffer re-copied the file's remainder for
// every line — quadratic in line count, and the single biggest cold-start
// cost the T1 bench found (~2.7s of a ~6.9s scan). Whole-file + split is
// linear, and holds at most one session file's text at a time — bounded by
// the largest transcript, while the store keeps every parsed event in RAM
// anyway.
//
// Warn-and-continue: a skipped line that could mean lost usage (non-JSON, or a
// malformed assistant record — see `warrantsWarning`) is logged via
// `console.warn`; the reader never throws on a parse failure. A non-assistant
// record, an unmodeled control-record type, or an assistant record the
// inclusion rule excludes is silently skipped (not a failure, just not a
// usage event).
//
// `console.warn` is the warning channel by design: the sidecar already routes
// `console` to its log surface, and E4 (the only caller) wants a scan to be
// resilient, not interactive. A caller that needs structured failures can use
// `parseLine` directly.
export async function collectUsageRecords(path: string): Promise<UsageRecord[]> {
  const text = await Bun.file(path).text();
  const lines = text.split("\n");
  // A `\n`-terminated file splits into a trailing "" that is not a line; a
  // file captured mid-write leaves a real unterminated final line instead.
  const lineCount = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const records: UsageRecord[] = [];
  for (let i = 0; i < lineCount; i++) {
    const record = handleLine(path, stripCarriageReturn(lines[i] as string), i + 1);
    if (record !== null) records.push(record);
  }
  return records;
}

// Split is on `\n` only; under CRLF that leaves a trailing `\r` on every line.
// `JSON.parse` happens to tolerate it, but a frozen foundation file shouldn't
// rely on that — and Part 6 targets Windows. Strip it explicitly.
function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

// A skipped line is only worth a warning when it could cost the engine a usage
// event: a line that is not valid JSON (possibly a truncated record), or an
// *assistant* record that failed schema validation. A schema-mismatch on any
// other record type is expected and benign — Claude Code writes many
// control/metadata record types (`progress`, `agent-name`, `queue-operation`,
// …, and ~13k of them in a typical scan) the engine deliberately does not
// model, just as it silently ignores `user` / `system` records. Warning on
// each would bury a genuine problem under thousands of routine lines. A blank
// line never warns — a stray blank in a JSONL file is benign.
function warrantsWarning(
  reason: "blank" | "invalid-json" | "schema-mismatch",
  line: string,
): boolean {
  if (reason === "blank") return false;
  if (reason === "invalid-json") return true;
  // schema-mismatch: the line is valid JSON, so re-read it just enough to see
  // whether it claims to be an assistant record — the only kind whose schema
  // failure means lost usage.
  try {
    const json: unknown = JSON.parse(line);
    return (
      typeof json === "object" && json !== null && (json as { type?: unknown }).type === "assistant"
    );
  } catch {
    return false;
  }
}

// Parse one line and, if it is an included assistant usage record, return the
// extracted `UsageRecord`. Returns `null` for everything else; warns (once,
// with file + line context) on a failure that `warrantsWarning` deems
// significant.
function handleLine(path: string, line: string, lineNumber: number): UsageRecord | null {
  // The pre-filter: a line that provably cannot be an assistant record skips
  // JSON.parse + Zod (and, per the predicate's contract, warrants no warning).
  if (preFilterSkips(line)) return null;
  const result = parseLine(line);
  if (!result.ok) {
    if (warrantsWarning(result.reason, line)) {
      console.warn(`[jsonl] ${path}:${lineNumber} skipped (${result.reason}): ${result.message}`);
    }
    return null;
  }

  // The discriminated union already validated the record against
  // `assistantRecordSchema`; `type === "assistant"` narrows `JsonlRecord` to
  // `AssistantRecord` for free, with no second parse.
  if (result.record.type !== "assistant") return null;
  return toUsageRecord(result.record);
}

// Parse an in-memory batch of JSONL lines into `UsageRecord`s, applying the
// same whole-file skip rules as `handleLine`: a blank / non-JSON / schema-
// invalid line, a non-assistant record, and an assistant record the inclusion
// rule excludes all yield nothing. Unlike `handleLine` this stays silent on a
// parse failure — the watcher's incremental tail-read has no file:line context
// to warn with, and a truncation re-read replaying old lines is expected. The
// store dedups, so a replayed line is harmless.
export function parseLines(lines: string[]): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of lines) {
    const result = parseLine(line);
    if (!result.ok || result.record.type !== "assistant") continue;
    const record = toUsageRecord(result.record);
    if (record !== null) records.push(record);
  }
  return records;
}
