import { internRowStrings } from "@maxprice/shared";
import { emailHash } from "@maxprice/shared";
import {
  emailRecordSchema,
  jsonlRecordSchema,
  loginRecordSchema,
  NO_ACCOUNT_EVIDENCE,
  ownerRecordSchema,
  type AccountEvidence,
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
// later by the aggregator golden tests (E5–E8). `organizationUuid` and
// `account` are the attribution cursors' answers for the line
// (`attributedOrganization`, `attributedAccount`).
export function toUsageRecord(
  record: AssistantRecord,
  organizationUuid: string | undefined,
  account: AccountEvidence = NO_ACCOUNT_EVIDENCE,
): UsageRecord | null {
  if (record.isApiErrorMessage === true) return null;
  if (record.message.model === SYNTHETIC_MODEL) return null;

  const usage = record.message.usage;
  if (usage === undefined) return null;

  const split = usage.cache_creation;
  // The categorical fields are interned (#361): every record of a session
  // repeats them, and the scan cache keeps every record resident.
  return internRowStrings({
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
    organizationUuid,
    accountUuid: account.accountUuid,
    accountEmailHash: account.accountEmailHash,
  });
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
// Attribution records (ADR-0098, ADR-0109, ADR-0137)
// ---------------------------------------------------------------------------

// Each regex requires its literal, so a plain substring test ahead of it is a
// fast reject with identical results: nearly every line carries neither, and
// the cold scan runs these checks on every line of every transcript.
const OWNER_LITERAL = "bridge-session";
const OWNER_MARKER = /"type"\s*:\s*"bridge-session"/;
const LOGIN_LITERAL = "credential_org";
const LOGIN_MARKER = /"type"\s*:\s*"credential_org"/;
const EMAIL_LITERAL = "session_context";
const EMAIL_MARKER = /"type"\s*:\s*"session_context"/;
// The address inside an Email record's sentence. The local part is RFC 5322
// atext and dots, so an address holding `'`, `%` or `!` is read whole and
// hashes as its login file's address does (organizations.ts). The domain is
// dot-separated labels, so the sentence's own full stop after the address is
// not part of it. `"`, `<`, `(` and `[` are not atext, so no such bracket is
// read; the atext that also quotes is handled by `QUOTE_CLOSERS`.
const EMAIL_ADDRESS = /[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[\w-]+(?:\.[\w-]+)+/;
// Atext characters that can also open a quote around the address. One counts
// as a quote, not as the address, only when its closer follows the domain.
const QUOTE_CLOSERS: Readonly<Record<string, string>> = {
  "'": "'",
  "`": "`",
  "{": "}",
  "|": "|",
};

// The address an Email record's sentence names, or `undefined` for none.
function addressIn(sentence: string): string | undefined {
  const match = EMAIL_ADDRESS.exec(sentence);
  if (match === null) return undefined;
  const address = match[0];
  const closer = QUOTE_CLOSERS[address[0] ?? ""];
  return closer !== undefined && sentence[match.index + address.length] === closer
    ? address.slice(1)
    : address;
}
// The one re-announce reason that moves the Account: only Claude Code's
// in-process login and logout routine raises it (ADR-0137 §2).
const ACCOUNT_CHANGE = "account_change";
// The command name a user's in-session `/login` writes. JSON.stringify escapes
// none of these characters, so a raw substring test is a sound pre-check.
const SLASH_LOGIN_MARKER = "<command-name>/login</command-name>";
// A command line's text opens with its command tags: `<command-name>` first
// (2.1.263, the only real `/login` observed), or `<command-message>` first
// (older writers). A prompt that merely quotes the command name — a pasted
// code review does — has prose before it, and must not arm the gate.
const COMMAND_LINE = /^\s*<command-(?:name|message)>/;

// The attribution in effect while a file is read: two cursors on one clock,
// the Organization's and the Account's.
//
// The Organization cursor. `owner` is the Owner cursor (ADR-0098): the
// organization the most recent Owner record named. `login` is the Login cursor
// (ADR-0109): set by the file's first Login record and moved by a later one
// only when a `/login` command line came since the previous Login record
// (`loginSinceRecord`) — a change with none records a login made elsewhere,
// which does not move billing. Once `login` is set it is the file's only
// evidence; `owner` keeps updating so a tail read never has to look back.
//
// The Account cursor (ADR-0137 §2). `ownerAccount` is the `ownerAccountUuid`
// of the Owner record `owner` came from (`undefined` when that record names no
// Account). `email` is the Email cursor: the hash of the file's first Email
// record, moved by a later one only when it is an `account_change`
// re-announce, which only the process that logged in writes, so it needs no
// `/login` gate. It is read from the top of the file but counts only from the
// first Login record on; before that, and in a file with none, the Account is
// `ownerAccount`. Rule A carries over: once `login` is set, Owner records name
// no Account. `ownerSinceEmail` says the Owner record in effect was read while
// the current Email cursor already was, which is what makes the two a pair
// observation (`observedPair`).
//
// One per file for the whole-file reader; the watcher keeps one per path.
export type AttributionCursor = {
  owner: string | undefined;
  ownerAccount: string | undefined;
  login: string | undefined;
  loginSinceRecord: boolean;
  email: string | undefined;
  ownerSinceEmail: boolean;
};

export function freshCursor(): AttributionCursor {
  return {
    owner: undefined,
    ownerAccount: undefined,
    login: undefined,
    loginSinceRecord: false,
    email: undefined,
    ownerSinceEmail: false,
  };
}

// What an Owner record names: its Organization, and its Account when known.
export type OwnerEvidence = { organizationUuid: string; accountUuid: string | undefined };

// Parse one line as an Owner record. Returns what it names, or `undefined`
// when the line is not an owner record, is malformed, or names no
// Organization (the old owner-less shape) — none of which change the owner in
// effect. A record naming an Organization moves both of the Owner cursor's
// fields at once, so one naming no Account leaves none in effect (ADR-0137
// §3's "an Owner record without `ownerAccountUuid`"). Checked BEFORE
// `preFilterSkips`, which would otherwise discard the line: it ends in `}` and
// carries no assistant marker.
export function parseOwnerLine(line: string): OwnerEvidence | undefined {
  if (!line.includes(OWNER_LITERAL) || !OWNER_MARKER.test(line)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = ownerRecordSchema.safeParse(json);
  if (!parsed.success || parsed.data.ownerOrganizationUuid === undefined) return undefined;
  return {
    organizationUuid: parsed.data.ownerOrganizationUuid,
    accountUuid: parsed.data.ownerAccountUuid,
  };
}

// Parse one line as a Login record. Returns the organization it names, or
// `undefined` when the line is not one or is malformed — neither of which
// changes any cursor state. Checked BEFORE `preFilterSkips`, like the Owner
// record: an attachment line ends in `}` and carries no assistant marker.
export function parseLoginLine(line: string): string | undefined {
  if (!line.includes(LOGIN_LITERAL) || !LOGIN_MARKER.test(line)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = loginRecordSchema.safeParse(json);
  return parsed.success ? parsed.data.attachment.organizationUuid : undefined;
}

// What an Email record says: its address's hash (never the address), and
// whether it is the `account_change` re-announce (`changed: true` with that
// reason) that moves the Email cursor.
export type EmailEvidence = { emailHash: string; accountChange: boolean };

// Parse one line as an Email record (ADR-0137 §2). Returns its evidence, or
// `undefined` when the line is not one, is malformed, or its sentence names no
// address — none of which change any cursor state. Checked BEFORE
// `preFilterSkips`, like the Login record.
export function parseEmailLine(line: string): EmailEvidence | undefined {
  if (!line.includes(EMAIL_LITERAL) || !EMAIL_MARKER.test(line)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = emailRecordSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const { attachment } = parsed.data;
  const address = addressIn(attachment.context.userEmail);
  if (address === undefined) return undefined;
  return {
    emailHash: emailHash(address),
    accountChange: attachment.changed === true && attachment.reason === ACCOUNT_CHANGE,
  };
}

// Whether a line is a `/login` command line, in either shape Claude Code logs a
// local command in: a `user` record with string `message.content` (the one real
// `/login` observed, 2.1.263), or a `system` record of subtype `local_command`
// with string top-level `content` (how `/context`, `/rename` and once `/model`
// were logged on 2.1.261–2.1.281). `/login`'s shape on 2.1.281+ is unobserved,
// and a `/login` the gate missed would silently ignore the Login record it
// writes, so both shapes count. Either way the text must open with the command
// tags and name `/login`; array content (tool results) never counts.
export function isSlashLoginLine(line: string): boolean {
  if (!line.includes(SLASH_LOGIN_MARKER)) return false;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof json !== "object" || json === null) return false;
  const record = json as {
    type?: unknown;
    subtype?: unknown;
    content?: unknown;
    message?: { content?: unknown } | null;
  };
  const text =
    record.type === "user"
      ? record.message?.content
      : record.type === "system" && record.subtype === "local_command"
        ? record.content
        : undefined;
  return typeof text === "string" && COMMAND_LINE.test(text) && text.includes(SLASH_LOGIN_MARKER);
}

// Advance the cursor over one line. Returns true when the line is an Owner,
// Login or Email record, which is never a usage event. Every Login record,
// counted or ignored, closes the `/login` gate it was judged against. An Email
// record never touches that gate, and a `/login` line never touches the Email
// cursor.
export function readAttribution(cursor: AttributionCursor, line: string): boolean {
  const owner = parseOwnerLine(line);
  if (owner !== undefined) {
    cursor.owner = owner.organizationUuid;
    cursor.ownerAccount = owner.accountUuid;
    cursor.ownerSinceEmail = cursor.email !== undefined;
    return true;
  }
  const login = parseLoginLine(line);
  if (login !== undefined) {
    if (cursor.login === undefined || cursor.loginSinceRecord) cursor.login = login;
    cursor.loginSinceRecord = false;
    return true;
  }
  const email = parseEmailLine(line);
  if (email !== undefined) {
    if (cursor.email === undefined || email.accountChange) {
      cursor.email = email.emailHash;
      cursor.ownerSinceEmail = false;
    }
    return true;
  }
  if (isSlashLoginLine(line)) cursor.loginSinceRecord = true;
  return false;
}

// The Organization a usage line read now is attributed to (Rule A, ADR-0109).
export function attributedOrganization(cursor: AttributionCursor): string | undefined {
  return cursor.login ?? cursor.owner;
}

// The Account a usage line read now is attributed to (ADR-0137 §2): from the
// first Login record on, the Email cursor's only (Rule A); else the Owner
// record's.
export function attributedAccount(cursor: AttributionCursor): AccountEvidence {
  return cursor.login !== undefined
    ? { accountUuid: undefined, accountEmailHash: cursor.email }
    : { accountUuid: cursor.ownerAccount, accountEmailHash: undefined };
}

// An email hash and the account uuid it belongs to (ADR-0137 §1's third pair
// source): a usage line read while an Email record and an Owner record naming
// an Account are both in effect, the Owner record read under that Email record.
// An Owner record above the Email record in effect is no pair: it may be an
// inherited copy outranked by Rule A (the corpus's case 7, which would pair
// Blair's email with Dana). A subagent's copied records make pairs like any
// file's; whether to learn them is the caller's call, and the scan and the
// watcher never pass `onPair` for one (ADR-0137 §2: its own Email record is no
// evidence).
export type AccountPair = { emailHash: string; accountUuid: string };
export type OnAccountPair = (pair: AccountPair) => void;

function observedPair(cursor: AttributionCursor): AccountPair | undefined {
  if (!cursor.ownerSinceEmail || cursor.email === undefined) return undefined;
  if (cursor.ownerAccount === undefined) return undefined;
  return { emailHash: cursor.email, accountUuid: cursor.ownerAccount };
}

// Reports a usage line's pair observation to `onPair`, once per distinct pair
// in a row: every usage line under one pair would otherwise repeat it.
function pairReporter(onPair: OnAccountPair | undefined) {
  let last: AccountPair | undefined;
  return (cursor: AttributionCursor): void => {
    if (onPair === undefined) return;
    const pair = observedPair(cursor);
    if (pair === undefined) return;
    if (last?.emailHash === pair.emailHash && last.accountUuid === pair.accountUuid) return;
    last = pair;
    onPair(pair);
  };
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
//
// `onPair` hears each pair observation (`AccountPair`) the file's usage lines
// are read under; it never changes a record.
export async function collectUsageRecords(
  path: string,
  onPair?: OnAccountPair,
): Promise<UsageRecord[]> {
  const text = await Bun.file(path).text();
  const lines = text.split("\n");
  // A `\n`-terminated file splits into a trailing "" that is not a line; a
  // file captured mid-write leaves a real unterminated final line instead.
  const lineCount = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const records: UsageRecord[] = [];
  const cursor = freshCursor();
  const reportPair = pairReporter(onPair);
  for (let i = 0; i < lineCount; i++) {
    const record = handleLine(path, stripCarriageReturn(lines[i] as string), i + 1, cursor);
    if (record === null) continue;
    records.push(record);
    reportPair(cursor);
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
function handleLine(
  path: string,
  line: string,
  lineNumber: number,
  cursor: AttributionCursor,
): UsageRecord | null {
  // An attribution record moves the cursor and is never a usage event
  // (ADR-0098, ADR-0109, ADR-0137). A `/login` line arms the gate and falls
  // through.
  if (readAttribution(cursor, line)) return null;
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
  return toUsageRecord(result.record, attributedOrganization(cursor), attributedAccount(cursor));
}

// Parse an in-memory batch of JSONL lines into `UsageRecord`s, applying the
// same whole-file skip rules as `handleLine`: a blank / non-JSON / schema-
// invalid line, a non-assistant record, and an assistant record the inclusion
// rule excludes all yield nothing. Unlike `handleLine` this stays silent on a
// parse failure — the watcher's incremental tail-read has no file:line context
// to warn with, and a truncation re-read replaying old lines is expected. The
// store dedups, so a replayed line is harmless. Attribution records move the
// cursor exactly as they do in the whole-file reader, so a file read in tail
// chunks tags every row as one whole-file read would.
export type ParsedLines = { records: UsageRecord[]; cursor: AttributionCursor };

// `initial` is the cursor at the end of the previous read of the same file
// (the watcher's per-path memory); the returned `cursor` is what the next
// read must start from. A copy is advanced, never `initial` itself. A first
// read starts at byte 0 (tail-reader), so it sees the file's own records.
// `onPair` is `collectUsageRecords`'s.
export function parseLines(
  lines: string[],
  initial: AttributionCursor | undefined,
  onPair?: OnAccountPair,
): ParsedLines {
  const cursor: AttributionCursor = initial === undefined ? freshCursor() : { ...initial };
  const records: UsageRecord[] = [];
  const reportPair = pairReporter(onPair);
  for (const line of lines) {
    if (readAttribution(cursor, line)) continue;
    const result = parseLine(line);
    if (!result.ok || result.record.type !== "assistant") continue;
    const record = toUsageRecord(
      result.record,
      attributedOrganization(cursor),
      attributedAccount(cursor),
    );
    if (record === null) continue;
    records.push(record);
    reportPair(cursor);
  }
  return { records, cursor };
}
