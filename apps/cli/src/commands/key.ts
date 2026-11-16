import {
  ACCOUNT_CREDENTIAL_KIND,
  type AccountEntry,
  accountLabel,
  ACCOUNTS_PATH,
  accountsResponseSchema,
  CLAUDE_CODE_TOKEN_REFUSAL,
  credentialAckSchema,
  discoverOrgsResponseSchema,
  isAccountUuid,
  isClaudeCodeToken,
  legacyReplacedBy,
  type OrganizationEntry,
  ORGANIZATIONS_PATH,
  organizationsResponseSchema,
  sessionKeyListingFailure,
  USAGE_HUB_KEYS_PATH,
  USAGE_KEYS_PATH,
  usageHubKeysResponseSchema,
  type UsageHubKeysResponse,
  usageKeysResponseSchema,
  type UsageKeyset,
} from "@maxprice/shared";
import { EXIT_INTERRUPTED } from "@maxprice/usage-core/secret-input";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { connect, type Daemon, probeFirst, pushIfUp, pushSaved } from "../daemon-client";
import { CliError, EXIT, usageError } from "../exit";
import type { Io, Parsed } from "../main";
import { organizationArgument, resolveAccount, shortId } from "../names";
import { dataDir, displayPath, type Env, secretsPath } from "../paths";
import { accountText, trackedOrganizations } from "../render/accounts";
import { atHubOf, type KeyListJson, keyRows, renderConnected, renderKeys } from "../render/keys";
import { terminalOutput } from "../render/table";
import { type SecretsDeps, secretReader, setAtNow } from "../secret-input";
import {
  editSecrets,
  keysetOf,
  readSecretsForEdit,
  type Secrets,
  withAccountKey,
  withoutOrgIds,
} from "../secrets";
import { hubNamed, trackKeyAccount } from "../settings";
import { type EditDeps, read, readInterruptibleLine, readyDaemon } from "../tracking-edit";
import { trackOrganizations } from "./org";

// `maxprice key set|list|remove` (ADR-0121 §6–7, ADR-0138 §2–§6, ADR-0140
// §6–§7): the claude.ai session keys, one per Account, which the Desktop
// client keeps in the keychain and this client in secrets.json.
//
// `set` is the Desktop client's Connect, with the file standing in for the
// keychain: check the key and learn its Account, write that Account's entry,
// push the whole keyset, track the Account, then list the key's Memberships
// and offer to track each Organization new to this machine. A failed push
// keeps the key for the daemon's next boot. `list` shows each stored key with
// its connection, and while a Hub is joined what the Hub holds for its
// Account. `remove` drops one Account's key, or the unfiled legacy key, and
// needs no daemon, since a removal needs no check; it never touches the
// Hub's key (ADR-0138 §7).
//
// No message from here carries any part of the key: not a usage error about
// one given as an argument, not a verb or an Account name that might be one
// pasted in its place.

const DISCOVER_PATH = "/api/usage/discover-orgs";
const CREDENTIAL_PATH = "/api/usage/credential";

const HELP = "maxprice key --help";

function usage(message: string): CliError {
  return usageError(message, HELP);
}

// What `key` takes from a test: the secret reader and the clock, and for
// `set`'s Track prompts whether stdin is a terminal, the line reader and the
// settings lock's options.
export type KeyDeps = SecretsDeps & EditDeps;

// Whether the pasted key, for `account`, also replaces the legacy key the file
// holds (`legacyReplacedBy`, the Desktop client's rule): the daemon resolved
// it to that same Account, or it is expired with its Account never learned.
// Asked only while the file holds one.
async function replacesLegacy(daemon: Daemon, env: Env, account: string): Promise<boolean> {
  if (readSecretsForEdit(env).sessionKey === undefined) return false;
  const { data } = await daemon.request(USAGE_KEYS_PATH, usageKeysResponseSchema);
  return legacyReplacedBy(data, account);
}

// The whole keyset, as the file now holds it.
function sendKeyset(daemon: Daemon, keyset: UsageKeyset | null): Promise<unknown> {
  return daemon.request(CREDENTIAL_PATH, credentialAckSchema, { method: "POST", body: keyset });
}

type Named = Pick<OrganizationEntry, "uuid" | "label">;

function isYes(answer: string): boolean {
  const word = answer.trim().toLowerCase();
  return word === "y" || word === "yes";
}

// ADR-0121 §6, in its order, then ADR-0140 §7's Connect report.
async function set(rest: readonly string[], io: Io, env: Env, deps: KeyDeps): Promise<number> {
  // argv lands in shell history and `ps`; the value is never echoed.
  if (rest.length > 0) {
    throw usage(
      "the key is never an argument: argv lands in shell history and ps; " +
        "paste it at the prompt or pipe it on stdin",
    );
  }
  // The probe before the prompt, so a down or skewed daemon never costs a
  // paste; then the file, so a paste is never spent on one the write would
  // refuse (§6 as amended by #469). The daemon's initial scan is waited out
  // first, since the roster is partial during it, and the roster read before
  // the key's discovery records its Organizations: what this machine knew
  // before the key, which decides what is new.
  const daemon = await readyDaemon(io, env);
  readSecretsForEdit(env);
  const before = await read(daemon, ORGANIZATIONS_PATH, organizationsResponseSchema);
  const sessionKey = await secretReader(io, deps)("Session key: ");
  if (sessionKey === null) return EXIT_INTERRUPTED;
  if (sessionKey === "") throw usage("no session key was given");
  // ADR-0121 §10: Claude Code's credential is named, never sent to claude.ai.
  if (isClaudeCodeToken(sessionKey)) {
    throw new CliError(EXIT.FAILURE, CLAUDE_CODE_TOKEN_REFUSAL, [
      "'maxprice key --help' says where to copy a session key from.",
    ]);
  }
  const { data } = await daemon.request(DISCOVER_PATH, discoverOrgsResponseSchema, {
    method: "POST",
    body: { sessionKey },
  });
  // The Desktop client's words, shared.
  if (data.orgs.length === 0) {
    throw new CliError(EXIT.FAILURE, sessionKeyListingFailure(data.failureKind));
  }
  // The key's Account names its entry (ADR-0138 §2): a key whose
  // `/api/account` read failed has none to go in, so it is refused in the
  // words of a claude.ai that did not answer, as the Desktop client does.
  const account = data.account?.accountUuid ?? null;
  if (account === null || !isAccountUuid(account)) {
    throw new CliError(EXIT.FAILURE, sessionKeyListingFailure("error"));
  }
  const replaceLegacy = await replacesLegacy(daemon, env, account);
  const setAt = setAtNow(deps);
  let next: Secrets = {};
  editSecrets(env, (secrets) => {
    // A reconnect keeps an unacknowledged `orgId` the replaced entry carried.
    const orgId = secrets.sessionKeys?.[account]?.orgId;
    const keyed = withAccountKey(secrets, account, {
      value: sessionKey,
      kind: ACCOUNT_CREDENTIAL_KIND,
      setAt,
      ...(orgId === undefined ? {} : { orgId }),
    });
    next = replaceLegacy ? { ...keyed, sessionKey: undefined } : keyed;
    return next;
  });
  await pushSaved(env, () => sendKeyset(daemon, keysetOf(next)));
  // Acknowledged: the history any `orgId` names is stamped, so it goes.
  editSecrets(env, withoutOrgIds);
  // Connecting tracks the Account (ADR-0136 §4). After the push, so the key
  // is in use whatever this write does.
  try {
    await trackKeyAccount(env, account);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    throw new CliError(
      EXIT.FAILURE,
      `the key is stored and in use, but its Account is not tracked: ${error.message}`,
      ["Run 'maxprice key set' again to track it."],
    );
  }

  // ADR-0140 §7: the Account by its label as `account list` shows it, and
  // each of the key's Memberships with its Organization's tracking, from
  // the roster discovery has just recorded them in.
  const roster = await read(daemon, ORGANIZATIONS_PATH, organizationsResponseSchema);
  const accounts = await read(daemon, ACCOUNTS_PATH, accountsResponseSchema);
  const label =
    accounts.accounts.find((entry) => entry.accountUuid === account)?.label ??
    accountLabel(account, null);
  const known = new Set(before.organizations.map((entry) => entry.uuid));
  if (before.home !== null) known.add(before.home);
  const organizations = data.orgs.map((org) => org.id);
  io.stdout.write(
    renderConnected({
      account: { label, accountUuid: account },
      organizations,
      roster,
      known,
    }),
  );
  io.stderr.write(`Stored in ${displayPath(secretsPath(dataDir(env)), env)} (0600).\n`);

  // Each Organization new to this machine that is not tracked: a new one
  // starts Excluded (ADR-0138 §4).
  const tracked = trackedOrganizations(roster);
  const fresh: Named[] = organizations
    .filter((uuid) => !known.has(uuid) && !tracked.has(uuid))
    .map(
      (uuid) =>
        roster.organizations.find((entry) => entry.uuid === uuid) ??
          // Not in the roster after all: named by its short id.
          { uuid, label: shortId(uuid) },
    );
  if (fresh.length === 0) return EXIT.OK;
  if (!(deps.stdinIsTTY ?? process.stdin.isTTY === true)) {
    io.stdout.write("To track a new Organization:\n");
    for (const entry of fresh) {
      const argument = organizationArgument(entry, roster.organizations);
      io.stdout.write(`  maxprice org track ${terminalText(argument)}\n`);
    }
    return EXIT.OK;
  }
  const readLine = deps.readLine ?? readInterruptibleLine;
  const chosen: Named[] = [];
  for (const entry of fresh) {
    const answer = await readLine(`Track ${terminalText(entry.label)}? [y/N] `);
    // The key and the Account's tracking are already written: they stay,
    // and nothing answered here is tracked.
    if (answer === null) return EXIT_INTERRUPTED;
    if (isYes(answer)) chosen.push(entry);
  }
  if (chosen.length > 0) await trackOrganizations(chosen, daemon, io, env, deps);
  return EXIT.OK;
}

// An Account the file holds a key for that the daemon's listing lacks (the
// file changed since the daemon read it, or there is no listing), as
// `remove` names it: by its uuid, a prefix of it, or its fallback label.
function heldOnly(uuid: string): AccountEntry {
  return {
    key: uuid,
    accountUuid: uuid,
    pending: false,
    tracked: false,
    home: false,
    email: null,
    label: accountLabel(uuid, null),
    connection: "disconnected",
    memberships: [],
  };
}

// The joined Hub's keys, or null while no Hub is configured (the daemon's
// Hub connection is off).
async function hubKeys(daemon: Daemon): Promise<UsageHubKeysResponse | null> {
  if (daemon.status.hubConnection === "off") return null;
  return (await daemon.request(USAGE_HUB_KEYS_PATH, usageHubKeysResponseSchema)).data;
}

// ADR-0140 §6: needs the daemon, as every read of its state does, so a down
// one exits 3 and a skewed one 4.
async function list(json: boolean, io: Io, env: Env, deps: KeyDeps): Promise<number> {
  const daemon = await connect({ env });
  const secrets = readSecretsForEdit(env);
  const keys = (await daemon.request(USAGE_KEYS_PATH, usageKeysResponseSchema)).data;
  const accounts = await read(daemon, ACCOUNTS_PATH, accountsResponseSchema);
  const hub = await hubKeys(daemon);
  const answer: KeyListJson = {
    hubJoined: hub !== null,
    keys: keyRows({ secrets, keys, accounts: accounts.accounts, hub }),
  };
  if (json) {
    io.stdout.write(JSON.stringify(answer, null, 2) + "\n");
    return EXIT.OK;
  }
  const now = (deps.now ?? Date.now)();
  io.stdout.write(renderKeys(answer, now, terminalOutput(io.stdout, env)));
  return EXIT.OK;
}

// A read `remove` can do without: a daemon that is down, or that refuses or
// fails it, answers null, and the removal goes on without what it says.
async function readIfUp<T>(
  daemon: Daemon | null,
  request: (d: Daemon) => Promise<T>,
): Promise<T | null> {
  if (daemon === null) return null;
  try {
    return await request(daemon);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return null;
  }
}

// Why the file alone names an Account: no daemon runs, or it did not list
// its Accounts.
type Unlisted = "down" | "unlisted";

const UNLISTED_HINTS: Record<Unlisted, string> = {
  down: "With the daemon not running, an Account is named by its uuid or an 8-character prefix.",
  unlisted:
    "The daemon did not list its Accounts, so an Account is named by its uuid or an " +
    "8-character prefix.",
};

// An Account named for `remove`, the name never echoed: it may be a key
// pasted in its place. With no listing of Accounts, only a stored key's uuid
// or a prefix of it names one.
function resolveForRemove(
  name: string,
  candidates: readonly AccountEntry[],
  unlisted: Unlisted | null,
): AccountEntry {
  try {
    return resolveAccount(name, candidates);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const several = error.hints.length > 0;
    const hints = [...error.hints, ...(unlisted === null ? [] : [UNLISTED_HINTS[unlisted]])];
    throw new CliError(
      EXIT.USAGE,
      several
        ? "that name matches several Accounts; give its id or a longer prefix"
        : "no Account has that name",
      hints,
    );
  }
}

// The line after a removal about the Hub's key for the Account (ADR-0140
// §6), from what the daemon says of the Hub (`hubKeys`, read after the
// write): definite while it says the joined Hub holds one; none while it has
// no Hub configured, or says the Hub holds none or has not answered yet;
// conditional while there is no daemon or no answer from it, and
// settings.json names a Hub.
async function hubLine(daemon: Daemon | null, uuid: string, env: Env): Promise<string | null> {
  const id = shortId(uuid);
  const hub = await readIfUp(daemon, hubKeys);
  if (hub === null && daemon?.status.hubConnection === "off") return null;
  if (hub === null) {
    return hubNamed(env)
      ? "If the Hub holds a key for this Account, remove it there with " +
          `maxprice-hub key remove ${id}.`
      : null;
  }
  const state = atHubOf(hub, uuid);
  if (state === "none" || state === "unknown") return null;
  return (
    "The Hub still holds a key for this Account; remove it on the Hub with " +
    `maxprice-hub key remove ${id}.`
  );
}

// ADR-0140 §6: one Account's key, or with `--unfiled` the legacy key, out of
// the file; then the keyset pushed to a daemon that runs. It needs no
// daemon, so neither one that is down nor one that fails a read stops it:
// the file names the Account then. The Hub's key is the Hub's: a line says
// when the Hub holds, or may hold, one for the Account.
async function remove(
  names: readonly string[],
  unfiled: boolean,
  io: Io,
  env: Env,
): Promise<number> {
  if (unfiled && names.length > 0) throw usage("key remove --unfiled takes no Account");
  if (!unfiled && names.length === 0) throw usage("key remove needs an Account, or --unfiled");
  if (names.length > 1) throw usage("key remove takes one Account");
  const probed = await probeFirst(env);
  const daemon = probed instanceof CliError ? null : probed;
  const secrets = readSecretsForEdit(env);

  let removed: string;
  let account: string | null = null;
  let edit: (secrets: Secrets) => Secrets;
  // A name that names nothing to remove is a usage error, as at the Hub.
  if (unfiled) {
    if (secrets.sessionKey === undefined) {
      throw new CliError(EXIT.USAGE, "no unfiled key is stored");
    }
    removed = "the unfiled key";
    edit = (s) => ({ ...s, sessionKey: undefined });
  } else {
    const stored = Object.keys(secrets.sessionKeys ?? {});
    const listed = await readIfUp(
      daemon,
      async (d) => (await read(d, ACCOUNTS_PATH, accountsResponseSchema)).accounts,
    );
    const known = listed ?? [];
    const candidates = [
      ...known,
      ...stored.filter((uuid) => !known.some((e) => e.accountUuid === uuid)).map(heldOnly),
    ];
    const unlisted = listed !== null ? null : daemon === null ? "down" : "unlisted";
    const entry = resolveForRemove(names[0]!, candidates, unlisted);
    const uuid = entry.accountUuid;
    if (uuid === null || secrets.sessionKeys?.[uuid] === undefined) {
      throw new CliError(EXIT.USAGE, `no key is stored for ${accountText(entry)}`, [
        { label: "The stored keys:", command: "maxprice key list" },
      ]);
    }
    account = uuid;
    removed = `the key for ${accountText(entry)}`;
    edit = (s) => {
      const kept = { ...s.sessionKeys };
      delete kept[uuid];
      return { ...s, sessionKeys: kept };
    };
  }

  let next: Secrets = {};
  editSecrets(env, (s) => {
    next = edit(s);
    return next;
  });
  const shown = displayPath(secretsPath(dataDir(env)), env);
  const code = await pushIfUp(probed, io.stderr, shown, (d) => sendKeyset(d, keysetOf(next)));
  io.stdout.write(`Removed ${removed}\n`);
  const line = account === null ? null : await hubLine(daemon, account, env);
  if (line !== null) io.stdout.write(`${line}\n`);
  return code;
}

const VERBS = ["set", "list", "remove"] as const;

export async function key(
  parsed: Parsed,
  io: Io,
  env: Env = process.env,
  deps: KeyDeps = {},
): Promise<number> {
  const [verb, ...rest] = parsed.positionals;
  const json = parsed.values.json === true;
  const unfiled = parsed.values.unfiled === true;
  if (verb === undefined) throw usage("key needs a command: set, list or remove");
  // Not echoed: a key pasted where the verb goes would be.
  if (!(VERBS as readonly string[]).includes(verb)) {
    throw usage("unknown key command; the commands are set, list and remove");
  }
  if (json && verb !== "list") throw usage("--json is for key list only");
  if (unfiled && verb !== "remove") throw usage("--unfiled is for key remove only");
  switch (verb) {
    case "set":
      return await set(rest, io, env, deps);
    case "list":
      if (rest.length > 0) throw usage("key list takes no arguments");
      return await list(json, io, env, deps);
    default:
      return await remove(rest, unfiled, io, env);
  }
}
