import {
  accountLabelPath,
  type AccountEntry,
  ACCOUNTS_PATH,
  type AccountsResponse,
  accountsResponseSchema,
  excludeAccountPatch,
  excludeTitle,
  homeMembershipOf,
  ORGANIZATIONS_PATH,
  type OrganizationsResponse,
  organizationsResponseSchema,
  type Settings,
  trackAccountPatch,
} from "@maxprice/shared";
import type { Daemon } from "../daemon-client";
import { CliError, EXIT, usageError } from "../exit";
import type { Io, Parsed } from "../main";
import { accountShortId, resolveAccount } from "../names";
import type { Env } from "../paths";
import { accountText, renderAccounts } from "../render/accounts";
import { terminalOutput } from "../render/table";
import {
  confirmExclude,
  type Decision as EditDecision,
  editAndWait,
  type EditDeps,
  labelArguments,
  labelOutcome,
  putLabel,
  read,
  readyDaemon,
  type Watch,
} from "../tracking-edit";

// `maxprice account list|track|exclude|label` (ADR-0140 §5): Settings ›
// Accounts' Account level on the command line, beside `org`'s Organization
// level, since tracking is two independent levels (ADR-0136 §3). It works as
// `org` does: every verb connects and waits out the initial scan, an edit
// names its Account against the daemon's `/api/accounts`, writes the
// Desktop client's patch (`trackAccountPatch`, `excludeAccountPatch`)
// behind its guards under the settings lock, and waits until the daemon
// shows it and no Organization is re-walking. A label goes through the
// daemon's rename route.

const HELP = "maxprice account --help";

function usage(message: string): CliError {
  return usageError(message, HELP);
}

type Verb = "track" | "exclude";

type Tracking = Pick<Settings, "homeMemberships" | "trackedAccounts">;

type Decision = EditDecision<{ trackedAccounts: string[] }>;

// The patch helpers' null, told apart by the tests they make: no Home, no
// tracked Account list yet, the target is the Home membership's Account,
// and the list's membership.
function decide(verb: Verb, settings: Tracking, entry: AccountEntry): Decision {
  const name = accountText(entry);
  const home = homeMembershipOf(settings);
  if (home === null) {
    return {
      kind: "refuse",
      error: new CliError(
        EXIT.FAILURE,
        "there is no Home membership yet, so every Account is counted; an edit needs a Home",
      ),
    };
  }
  // A file that predates Accounts: the daemon derives the tracked set and
  // saves it at its next boot (ADR-0136 §8); an edit now would replace that
  // set with one Account.
  if (settings.trackedAccounts === null) {
    return {
      kind: "refuse",
      error: new CliError(
        EXIT.FAILURE,
        "settings.json names no tracked Accounts yet, so every Account is counted; " +
          "the daemon saves them after its first scan",
      ),
    };
  }
  const isHome = entry.key === home.accountUuid;
  if (verb === "track") {
    const patch = trackAccountPatch(settings, entry.key);
    if (patch !== null) return { kind: "write", patch };
    return {
      kind: "answer",
      line: isHome
        ? `${name} is the Home membership's Account, which is always tracked`
        : `${name} is already tracked`,
    };
  }
  const patch = excludeAccountPatch(settings, entry.key);
  if (patch !== null) return { kind: "write", patch };
  if (!isHome) return { kind: "answer", line: `${name} is already excluded` };
  return {
    kind: "refuse",
    error: new CliError(
      EXIT.FAILURE,
      `${name} is the Home membership's Account, which is always tracked`,
      [
        {
          label: "Make a Membership of another Account Home first:",
          command: "maxprice home set --account <account>",
        },
      ],
    ),
  };
}

function readAccounts(daemon: Daemon): Promise<AccountsResponse> {
  return read(daemon, ACCOUNTS_PATH, accountsResponseSchema);
}

type Shown = { accounts: AccountsResponse; roster: OrganizationsResponse };

// As `org`'s wait (ADR-0122 §6): until /api/accounts shows the change, the
// Account tracked or excluded, and no Organization is re-walking (the
// roster's `reingesting`, the only re-walk the daemon reports). One the
// listing lacks has not shown it yet. Once the file no longer holds the
// change, a later edit replaced it (or the daemon folded a Pending key into
// its Account, ADR-0137 §1).
function accountWatch(verb: Verb, key: string, daemon: Daemon): Watch<Shown> {
  return {
    read: async () => {
      const accounts = await readAccounts(daemon);
      const roster = await read(daemon, ORGANIZATIONS_PATH, organizationsResponseSchema);
      return { accounts, roster };
    },
    rewalking: ({ roster }) => roster.organizations.some((entry) => entry.reingesting),
    shows: ({ accounts }) => {
      const row = accounts.accounts.find((entry) => entry.key === key);
      return row !== undefined && row.tracked === (verb === "track");
    },
    holds: (settings) => {
      const named =
        homeMembershipOf(settings)?.accountUuid === key ||
        (settings.trackedAccounts ?? []).includes(key);
      return verb === "track" ? named : !named;
    },
  };
}

async function list(json: boolean, io: Io, env: Env): Promise<number> {
  const daemon = await readyDaemon(io, env);
  const { data, text } = await daemon.request(ACCOUNTS_PATH, accountsResponseSchema);
  if (json) {
    io.stdout.write(text);
    return EXIT.OK;
  }
  const roster = await read(daemon, ORGANIZATIONS_PATH, organizationsResponseSchema);
  io.stdout.write(renderAccounts(data, roster, terminalOutput(io.stdout, env)));
  return EXIT.OK;
}

async function edit(
  verb: Verb,
  name: string,
  confirm: string | undefined,
  io: Io,
  env: Env,
  deps: EditDeps,
): Promise<number> {
  const daemon = await readyDaemon(io, env);
  const entry = resolveAccount(name, (await readAccounts(daemon)).accounts);
  // Decided again under the lock, as `org` does.
  const written = await editAndWait(
    {
      decide: (settings) => decide(verb, settings, entry),
      ...(verb === "exclude"
        ? {
            confirm: () =>
              confirmExclude({
                title: excludeTitle(entry.label, accountShortId(entry)),
                bareLabel: entry.label,
                confirm,
                help: HELP,
                daemon,
                io,
                deps,
              }),
          }
        : {}),
      apply: (raw, patch) => {
        raw.trackedAccounts = patch.trackedAccounts;
      },
      watch: accountWatch(verb, entry.key, daemon),
    },
    io,
    env,
    deps,
  );
  if (written === null) return EXIT.OK;
  io.stdout.write(`${verb === "track" ? "Tracked" : "Excluded"} ${accountText(entry)}\n`);
  return EXIT.OK;
}

// ADR-0140 §5: the Account label, through the daemon's rename route, which
// rides the fleet's Label directory. The directory keys Accounts by uuid
// alone, so a Pending account takes none: its email is its label until a
// pairing resolves it (ADR-0136 §7).
async function label(name: string, value: string | null, io: Io, env: Env): Promise<number> {
  const daemon = await readyDaemon(io, env);
  const accounts = (await readAccounts(daemon)).accounts;
  const entry = resolveAccount(name, accounts);
  if (entry.accountUuid === null) {
    throw new CliError(
      EXIT.FAILURE,
      `${accountText(entry)} is a Pending account, which takes no label: its email is its ` +
        "label until a key or a login names its Account",
      [{ label: "Connect its key:", command: "maxprice key set" }],
    );
  }
  const answer = await putLabel(
    daemon,
    accountLabelPath(entry.accountUuid),
    value,
    accountsResponseSchema,
    accountText(entry),
  );
  const now = answer.accounts.find((row) => row.key === entry.key) ?? entry;
  io.stdout.write(`${labelOutcome(accountText(entry), now.label, entry.label)}\n`);
  return EXIT.OK;
}

const VERBS = ["list", "track", "exclude", "label"] as const;

export async function account(
  parsed: Parsed,
  io: Io,
  env: Env = process.env,
  deps: EditDeps = {},
): Promise<number> {
  const [verb, ...names] = parsed.positionals;
  const confirm = parsed.values.confirm as string | undefined;
  const json = parsed.values.json === true;
  const unset = parsed.values.unset === true;
  if (verb === undefined) throw usage("account needs a command: list, track, exclude or label");
  if (!(VERBS as readonly string[]).includes(verb)) {
    throw usage(`unknown account command '${verb}'`);
  }
  if (confirm !== undefined && verb !== "exclude") {
    throw usage("--confirm is for account exclude only");
  }
  if (json && verb !== "list") throw usage("--json is for account list only");
  if (unset && verb !== "label") throw usage("--unset is for account label only");
  if (verb === "list") {
    if (names.length > 0) throw usage("account list takes no Account");
    return await list(json, io, env);
  }
  if (verb === "label") {
    const args = labelArguments(names, unset, "account", "Account", HELP);
    return await label(args.name, args.label, io, env);
  }
  if (names.length === 0) throw usage(`account ${verb} needs an Account`);
  if (names.length > 1) throw usage(`account ${verb} takes one Account`);
  return await edit(verb as Verb, names[0]!, confirm, io, env, deps);
}
