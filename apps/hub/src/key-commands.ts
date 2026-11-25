import {
  ACCOUNT_CREDENTIAL_KIND,
  ANTHROPIC_PROVIDER,
  CLAUDE_CODE_TOKEN_REFUSAL,
  HUB_CREDENTIALS_PATH,
  hubCredentialAckSchema,
  hubCredentialPath,
  hubKeyHeld,
  isClaudeCodeToken,
  isoFromDate,
  sessionKeyListingFailure,
  usageConnectionShortLabel,
  type HubProvider,
  type UsageConnection,
} from "@maxprice/shared";
import {
  discoverOrg,
  fetchAccount,
  type FetchAccountResult,
  type ListOrgsResult,
} from "@maxprice/usage-core";
import { displayPath, type Env } from "@maxprice/usage-core/home-path";
import { EXIT_INTERRUPTED } from "@maxprice/usage-core/secret-input";
import { CliError, EXIT, type Io } from "./cli";
import { requireHub } from "./config";
import {
  labelledAccounts,
  liveAccountLabels,
  liveAccounts,
  liveStatus,
  namedAs,
  offlineAccounts,
  readLabels,
  resolveName,
  shortId,
  UNFILED_KEY_LABEL,
} from "./hub-names";
import { LabelRefused, liveLabel, offlineLabel } from "./label-commands";
import { checkedLabel } from "./label-rename";
import {
  reachHub,
  type ReachOptions,
  refusal,
  type RunningHub,
  unreadable,
} from "./operator-client";
import { type SecretDeps, secretReader } from "./operator";
import { createFileKeyStore, readHubSecrets, secretsPath } from "./secrets";
import { readOnlyLockHolder } from "./serve-lock";
import { createSetupTerminal } from "./setup-terminal";
import { DASH, headlessOnly, say, terminalJson, terminalTable } from "./terminal-output";

// `maxprice-hub key set|list|remove` (ADR-0126 §6, §9, ADR-0138 §7, §9,
// ADR-0140 §6, §8): the claude.ai session keys the Hub holds, one per Account,
// in secrets.json in its data dir. A Headless Hub's, on Linux and macOS
// (ADR-0146 §4): elsewhere the Hub keeps its
// keys in the keychain and the console sets them. Each reaches the Hub as the
// operator commands do (ADR-0127 §7): a running Hub through its own routes,
// which store, list and remove the keys and apply each change at once; with
// none, the file, under serve.lock. No line, no message and no `--json` value
// carries any part of a key, nor an Account's email, which the Hub never keeps.

// What the key commands take from a test, beside the reader.
export type KeyDeps = SecretDeps & {
  // The key's Organizations, from claude.ai; discoverOrg by default, at
  // MAXPRICE_CLAUDE_BASE_URL when it is set, as `serve` lists them.
  discover?: (sessionKey: string) => Promise<ListOrgsResult>;
  // The key's Account, from claude.ai's `/api/account`, for an offline
  // write; fetchAccount by default, at the same base. Its email is dropped.
  account?: (sessionKey: string) => Promise<FetchAccountResult>;
  // The label prompt's reader, a visible line: the answer trimmed, or null
  // for Ctrl-C. Setup's terminal over stdin, prompting on stderr, by default.
  readLine?: (prompt: string) => Promise<string | null>;
  // The clock an offline write's `setAt` or removal time is read from.
  now?: () => number;
  // reachHub's bound on the reach and each request, its polling and its
  // cgroup reader.
  reach?: ReachOptions;
};

// ADR-0126 §9: elsewhere the Hub keeps its key in the keychain and the
// console sets it.
const ELSEWHERE = "re-key from the console";

// When a key was set or removed, as `key list` and setup's key step show it:
// local time to the minute, the date as daily rows write theirs
// (isoFromDate), or null for a timestamp that does not parse.
export function localMinute(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${isoFromDate(at)} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

// ── key set ─────────────────────────────────────────────────────────────────

// What `key set` did: its exit code, and the Account its key was stored
// under, once one was (null when Ctrl-C at the key prompt stored nothing).
export type KeySetResult = { code: number; accountUuid: string | null };

const labelledLine = (accountUuid: string, label: string) =>
  `Labelled Account ${shortId(accountUuid)}: ${label}`;

// A label write that failed once the key was stored, saying the key is.
// The label's own refusal (invalid or in use, `LabelRefused.ofTheLabel`,
// exit 2 anywhere else) is exit 1 here, `refused`, since the key's half
// succeeded. Any other failure is `not written`: another refusal (an unknown
// Account, a full Label directory, a write the Hub failed, each exit 2 for
// `label`) and a write of the file that threw are exit 1, and a Hub that
// sent no answer, or speaks another protocol, keeps its own code and hints.
function keptKey(error: unknown): CliError {
  if (error instanceof LabelRefused && error.ofTheLabel) {
    return new CliError(EXIT.FAILURE, `the key is stored; the label was refused: ${error.message}`);
  }
  const message = `the key is stored; the label was not written: ${
    error instanceof Error ? error.message : String(error)
  }`;
  if (error instanceof CliError && error.code !== EXIT.USAGE) {
    return new CliError(error.code, message, error.hints);
  }
  return new CliError(EXIT.FAILURE, message);
}

// The Account label, written for `accountUuid` through whatever holds the
// data dir once the prompt is answered: the running Hub's route, or the file
// under serve.lock, which no prompt ever holds.
async function writeAccountLabel(
  dataDir: string,
  env: Env,
  reach: ReachOptions | undefined,
  accountUuid: string,
  label: string,
): Promise<void> {
  const reached = await reachHub(dataDir, env, reach);
  if (reached.kind === "live") {
    await liveLabel(reached.hub, "accounts", accountUuid, label);
    return;
  }
  try {
    offlineLabel(dataDir, "accounts", accountUuid, label);
  } finally {
    reached.lock.release();
  }
}

// What `key set` takes: the environment and platform, the Account's label
// (`--label`), and a test's deps.
export type KeySetOptions = KeyDeps & {
  env?: Env;
  platform?: NodeJS.Platform;
  label?: string;
};

// What an offline write needs from claude.ai, asked with serve.lock free:
// the key's Account, and, when secrets.json held a legacy key as it was read
// before the reach, that key and whether this one replaces it.
type OfflineAnswers = {
  accountUuid: string;
  legacy: { sessionKey: string; replaced: boolean } | null;
};

// claude.ai's answers for an offline write (above), the lock free. The legacy
// key goes when this one replaces it: it is this key, it names this Account,
// or it is expired (`legacyReplacedBy`'s rule, its Account asked here since
// no daemon resolved it).
async function offlineAnswers(
  sessionKey: string,
  path: string,
  accountOf: (sessionKey: string) => Promise<FetchAccountResult>,
): Promise<OfflineAnswers> {
  const account = await accountOf(sessionKey);
  if (!account.ok) throw new CliError(EXIT.FAILURE, sessionKeyListingFailure(account.kind));
  const legacy = readHubSecrets(path).legacy;
  if (legacy === null) return { accountUuid: account.accountUuid, legacy: null };
  const legacyAccount =
    legacy.sessionKey === sessionKey ? account : await accountOf(legacy.sessionKey);
  const replaced = legacyAccount.ok
    ? legacyAccount.accountUuid === account.accountUuid
    : legacyAccount.kind === "expired";
  return { accountUuid: account.accountUuid, legacy: { sessionKey: legacy.sessionKey, replaced } };
}

// `maxprice-hub key set [--label <label>]` (ADR-0126 §6, ADR-0127 §7,
// ADR-0139 §4, ADR-0140 §8), in §6's order: the label is checked, and the key
// read and checked in this process, and only then is the Hub reached, so
// neither a prompt nor a claude.ai request is spent holding serve.lock, which
// a `serve` starting meanwhile would lose with exit 5. With a daemon running
// the key goes to its own route, POST /api/credentials, which learns its
// Account, stores it in secrets.json under that Account, its only writer
// while it runs (§4), lists and polls with it at once, and answers the
// Account. With none, this process asks claude.ai for the key's Account
// itself, and for the legacy key's when secrets.json holds one, before it
// reaches the Hub (when serve.lock is free as it looks, or, if a Hub
// stopped before the reach, with the lock let go and taken again), then
// writes the file through the daemon's own store, under the lock; the next
// start reads it. Either way the key replaces that Account's earlier one,
// and the legacy key when this one replaces it (ADR-0138 §12): offline, the
// legacy key read before the reach, and only while the file still holds it.
// A legacy key that lands meanwhile stays, for the daemon's boot to resolve.
//
// Then the Account's label: `--label`'s, written in the same reach (the
// route's PUT, or the file in the same lock hold); else, on a terminal, the
// one typed at `Label for Account <first 8> (Enter to skip):`, written once
// it is answered, the label's own refusal asking again; else none. Off a
// terminal it asks nothing. Ctrl-C at that prompt is exit 130 with the key
// kept.
export async function setKey(
  io: Io,
  { env = process.env, platform = process.platform, label, ...deps }: KeySetOptions = {},
): Promise<KeySetResult> {
  headlessOnly(platform, ELSEWHERE);
  const dataDir = requireHub(env, platform);
  let given: string | null = null;
  if (label !== undefined) {
    const checked = checkedLabel(label);
    if ("error" in checked) throw new CliError(EXIT.USAGE, checked.error);
    given = checked.label;
  }
  const sessionKey = await secretReader(deps, io)("Session key: ");
  if (sessionKey === null) return { code: EXIT_INTERRUPTED, accountUuid: null };
  if (sessionKey === "") throw new CliError(EXIT.USAGE, "no session key was given");
  // §6.2: Claude Code's credential is named, never sent to claude.ai.
  if (isClaudeCodeToken(sessionKey)) throw new CliError(EXIT.FAILURE, CLAUDE_CODE_TOKEN_REFUSAL);
  const baseUrl = env.MAXPRICE_CLAUDE_BASE_URL;
  const discover = deps.discover ?? ((key: string) => discoverOrg({ sessionKey: key, baseUrl }));
  const accountOf = deps.account ?? ((key: string) => fetchAccount({ sessionKey: key, baseUrl }));
  const listed = await discover(sessionKey);
  // The Desktop client's words, as the Headless client's `key set` gives them.
  if (!listed.ok) throw new CliError(EXIT.FAILURE, sessionKeyListingFailure(listed.kind));
  const path = secretsPath(dataDir);
  const shown = displayPath(path, env);
  // claude.ai's answers for an offline write, asked before the reach while
  // serve.lock is free, as `status` asks it (readOnlyLockHolder): a running
  // Hub asks them itself.
  let answers: OfflineAnswers | null =
    readOnlyLockHolder(dataDir, deps.reach?.readCgroup) === null
      ? await offlineAnswers(sessionKey, path, accountOf)
      : null;
  let reached = await reachHub(dataDir, env, deps.reach);
  // A Hub that stopped before the reach: the lock let go while claude.ai is
  // asked, then taken again (or a Hub that started meanwhile reached).
  while (reached.kind === "offline" && answers === null) {
    reached.lock.release();
    answers = await offlineAnswers(sessionKey, path, accountOf);
    reached = await reachHub(dataDir, env, deps.reach);
  }
  let stored: string;
  let accountUuid: string;
  // The `--label` write's failure, raised once the key's lines are out.
  let labelFailure: unknown = null;
  if (reached.kind === "live") {
    const answer = await reached.hub.request("POST", HUB_CREDENTIALS_PATH, { sessionKey });
    if (!answer.ok) {
      throw new CliError(
        EXIT.FAILURE,
        `the running Hub refused the key: ${refusal(answer, HUB_CREDENTIALS_PATH)}`,
      );
    }
    const ack = hubCredentialAckSchema.safeParse(answer.body);
    if (!ack.success) throw unreadable(HUB_CREDENTIALS_PATH);
    accountUuid = ack.data.accountUuid;
    if (given !== null) {
      try {
        await liveLabel(reached.hub, "accounts", accountUuid, given);
      } catch (error) {
        labelFailure = error;
      }
    }
    stored = `Stored in ${shown} (0600).`;
  } else {
    // Never null here: the loop above ends offline only with the answers.
    const { legacy, ...known } = answers!;
    accountUuid = known.accountUuid;
    try {
      // `set` logs nothing: its lines are the boot read's.
      const store = createFileKeyStore(path, { log: () => {}, warn: () => {} });
      const setAt = new Date((deps.now ?? Date.now)()).toISOString();
      await store.set(accountUuid, {
        sessionKey,
        kind: ACCOUNT_CREDENTIAL_KIND,
        setAt,
        source: "local",
      });
      if (
        legacy?.replaced === true &&
        readHubSecrets(path).legacy?.sessionKey === legacy.sessionKey
      ) {
        await store.removeLegacy();
      }
      if (given !== null) {
        try {
          offlineLabel(dataDir, "accounts", accountUuid, given);
        } catch (error) {
          labelFailure = error;
        }
      }
    } finally {
      reached.lock.release();
    }
    stored = `Stored in ${shown} (0600); the Hub reads it when it starts.`;
  }
  const count = listed.orgs.length;
  say(io.stdout, `Connected: ${count} Organization${count === 1 ? "" : "s"} found.`);
  say(io.stderr, stored);
  if (given !== null) {
    if (labelFailure !== null) throw keptKey(labelFailure);
    say(io.stdout, labelledLine(accountUuid, given));
    return { code: EXIT.OK, accountUuid };
  }
  if (!(deps.interactive ?? process.stdin.isTTY === true)) return { code: EXIT.OK, accountUuid };
  const readLine =
    deps.readLine ??
    ((prompt: string) =>
      createSetupTerminal({ stdin: process.stdin, out: io.stderr }).line(prompt));
  return {
    code: await askAccountLabel(io, env, platform, { readLine, reach: deps.reach }, accountUuid),
    accountUuid,
  };
}

// The label prompt `key set` asks once a key is stored, and setup's step 1
// after each key it accepts (ADR-0140 §8, §10): `Label for Account <first 8>
// (Enter to skip):`, read through `readLine`, the label written once it is
// answered, holding no lock while it waits. Enter skips. The label's own
// refusal (empty, too long, in use: `LabelRefused.ofTheLabel`) prints why on
// stderr and asks again; any other failure ends the prompt, thrown as
// keptKey words it, saying the key is stored. Ctrl-C is exit 130 with the
// key kept.
export async function askAccountLabel(
  io: Io,
  env: Env,
  platform: NodeJS.Platform,
  deps: Required<Pick<KeyDeps, "readLine">> & Pick<KeyDeps, "reach">,
  accountUuid: string,
): Promise<number> {
  const dataDir = requireHub(env, platform);
  for (;;) {
    const typed = await deps.readLine(
      `Label for Account ${shortId(accountUuid)} (Enter to skip): `,
    );
    if (typed === null) {
      say(io.stderr, "The key is stored; no label was set.");
      return EXIT_INTERRUPTED;
    }
    if (typed === "") return EXIT.OK;
    try {
      const checked = checkedLabel(typed);
      if ("error" in checked) throw new LabelRefused(true, checked.error);
      await writeAccountLabel(dataDir, env, deps.reach, accountUuid, checked.label);
      say(io.stdout, labelledLine(accountUuid, checked.label));
      return EXIT.OK;
    } catch (error) {
      // The label's own refusal asks again; anything else ends the prompt.
      if (!(error instanceof LabelRefused && error.ofTheLabel)) throw keptKey(error);
      say(io.stderr, error.message);
    }
  }
}

// `key set` as the command line runs it: its exit code alone.
export async function keySet(io: Io, options: KeySetOptions = {}): Promise<number> {
  return (await setKey(io, options)).code;
}

// ── key list ────────────────────────────────────────────────────────────────

// One row of `key list`, and its `--json` entry: an Account the Hub knows, or
// the unfiled legacy key (`accountUuid: null`). `connection` is the running
// Hub's, null with none running; `removedAt` the Account's removal time.
export type KeyListRow = {
  provider: HubProvider;
  accountUuid: string | null;
  label: string;
  connection: UsageConnection | null;
  setAt: string | null;
  source: string | null;
  removedAt: string | null;
};

// The columns ADR-0140 §6 names: Account, Id, Connection, Set at, Source. An
// Account that holds no key reads `No key`, its Source its removal time when
// it has one.
function cells(row: KeyListRow): string[] {
  const held = hubKeyHeld(row);
  return [
    row.label,
    row.accountUuid === null ? DASH : shortId(row.accountUuid),
    !held ? "No key" : row.connection === null ? DASH : usageConnectionShortLabel(row.connection),
    row.setAt === null ? DASH : (localMinute(row.setAt) ?? DASH),
    row.removedAt !== null
      ? `removed ${localMinute(row.removedAt) ?? row.removedAt}`
      : (row.source ?? DASH),
  ];
}

// `key list`'s table (terminalTable), and the held keys' in setup's step 1.
export function keyTable(rows: readonly KeyListRow[]): string {
  return terminalTable(["Account", "Id", "Connection", "Set at", "Source"], rows.map(cells));
}

// The running Hub's rows: every Account its status lists, the unfiled key
// first, in its order, labelled as `status` labels them (labelledAccounts).
export async function liveKeyRows(hub: RunningHub): Promise<KeyListRow[]> {
  const { accounts } = liveStatus(hub);
  return labelledAccounts(accounts, await liveAccountLabels(hub, accounts));
}

// The data dir's rows, with no Hub to say how any key connects: the unfiled
// key, then each Account secrets.json holds a key or a removal time for or
// the Label directory names, by uuid. Read as the files stand, changing
// neither (readLabels).
export function offlineKeyRows(dataDir: string): KeyListRow[] {
  const stored = readHubSecrets(secretsPath(dataDir));
  const labels = readLabels(dataDir);
  const held = new Map(stored.accounts.map((entry) => [entry.accountUuid, entry]));
  const rows: KeyListRow[] = [];
  if (stored.legacy !== null) {
    rows.push({
      provider: ANTHROPIC_PROVIDER,
      accountUuid: null,
      label: UNFILED_KEY_LABEL,
      connection: null,
      setAt: stored.legacy.setAt,
      source: stored.legacy.source,
      removedAt: null,
    });
  }
  for (const { id, label } of offlineAccounts(dataDir, labels)) {
    const entry = held.get(id);
    rows.push({
      provider: ANTHROPIC_PROVIDER,
      accountUuid: id,
      label,
      connection: null,
      setAt: entry?.setAt ?? null,
      source: entry?.source ?? null,
      removedAt: Object.hasOwn(stored.removed, id) ? stored.removed[id]! : null,
    });
  }
  return rows;
}

// `maxprice-hub key list [--json]` (ADR-0140 §6): every key the Hub holds and
// every Account it knows that holds none, never any part of a key. Through a
// running Hub, its status and Label directory, each key's connection
// included; with none, the data dir's files under serve.lock, read and
// changed in nothing, with one stderr line that no Hub runs to say how any
// key connects.
export async function keyList(
  json: boolean,
  io: Io,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  deps: Pick<KeyDeps, "reach"> = {},
): Promise<number> {
  headlessOnly(platform, ELSEWHERE);
  const dataDir = requireHub(env, platform);
  const reached = await reachHub(dataDir, env, deps.reach);
  let rows: KeyListRow[];
  if (reached.kind === "live") {
    rows = await liveKeyRows(reached.hub);
  } else {
    try {
      rows = offlineKeyRows(dataDir);
    } finally {
      reached.lock.release();
    }
  }
  const running = reached.kind === "live";
  if (json) {
    io.stdout.write(terminalJson({ running, keys: rows }));
    return EXIT.OK;
  }
  if (!running) {
    say(
      io.stderr,
      `No Hub is running on ${displayPath(dataDir, env)}, so no key's connection is known.`,
    );
  }
  if (rows.length === 0) {
    say(io.stdout, "No key on this Hub");
    say(io.stdout, "  Set one:  maxprice-hub key set");
    return EXIT.OK;
  }
  io.stdout.write(keyTable(rows));
  return EXIT.OK;
}

// ── key remove ──────────────────────────────────────────────────────────────

// A session key pasted where the Account goes: refused without its text,
// as the key commands never echo one (ADR-0126 §6).
function looksLikeKey(name: string): boolean {
  return name.startsWith("sk-ant-");
}

const AUTO_HEAL = "a client's auto-heal pushes back only a key set after it.";

// `maxprice-hub key remove <account>` and `key remove --unfiled` (ADR-0140
// §6, ADR-0138 §7): one Account's key, named as ADR-0140 §2 names one
// (`resolveName`), its removal time recorded so a client's auto-heal pushes
// back only a key set after it; or the unfiled legacy key, which has no
// Account to record one for. A running Hub is sent the key's DELETE, as its
// console sends one, and stops polling it at once; with none, this process
// edits secrets.json under serve.lock. `account` is null for `--unfiled`.
export async function keyRemove(
  account: string | null,
  io: Io,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  deps: Pick<KeyDeps, "reach" | "now"> = {},
): Promise<number> {
  headlessOnly(platform, ELSEWHERE);
  const dataDir = requireHub(env, platform);
  if (account !== null && looksLikeKey(account)) {
    throw new CliError(
      EXIT.USAGE,
      "that is a session key, not an Account: name the Account by its label or its uuid",
    );
  }
  const path = secretsPath(dataDir);
  const shown = displayPath(path, env);
  const reached = await reachHub(dataDir, env, deps.reach);
  if (reached.kind === "live") {
    const { hub } = reached;
    const named =
      account === null ? null : resolveName("Account", account, await liveAccounts(hub));
    const target = hubCredentialPath(named?.id ?? null);
    const answer = await hub.request("DELETE", target);
    if (answer.status === 404) {
      throw new CliError(
        EXIT.USAGE,
        named === null
          ? "the Hub holds no unfiled key"
          : `${namedAs(named)} holds no key on this Hub`,
      );
    }
    if (!answer.ok) {
      throw new CliError(
        EXIT.FAILURE,
        `the running Hub refused the removal: ${refusal(answer, target)}`,
      );
    }
    if (named === null) {
      say(io.stdout, "Removed the unfiled key: the running Hub stops polling it at once.");
    } else {
      say(
        io.stdout,
        `Removed the key of ${namedAs(named)}: the running Hub stops polling it at once.`,
      );
      say(io.stdout, `Its removal time is recorded: ${AUTO_HEAL}`);
    }
    return EXIT.OK;
  }
  try {
    const stored = readHubSecrets(path);
    const store = createFileKeyStore(path, { log: () => {}, warn: () => {} });
    if (account === null) {
      if (stored.legacy === null) throw new CliError(EXIT.USAGE, "the Hub holds no unfiled key");
      await store.removeLegacy();
      say(io.stdout, `Removed the unfiled key from ${shown}.`);
      return EXIT.OK;
    }
    const named = resolveName("Account", account, offlineAccounts(dataDir, readLabels(dataDir)));
    if (!stored.accounts.some((entry) => entry.accountUuid === named.id)) {
      throw new CliError(EXIT.USAGE, `${namedAs(named)} holds no key on this Hub`);
    }
    await store.remove(named.id, new Date((deps.now ?? Date.now)()).toISOString());
    say(io.stdout, `Removed the key of ${namedAs(named)} from ${shown}.`);
    say(io.stdout, `Its removal time is kept: ${AUTO_HEAL}`);
    return EXIT.OK;
  } finally {
    reached.lock.release();
  }
}
