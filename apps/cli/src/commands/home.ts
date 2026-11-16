import {
  type AccountEntry,
  accountLabel,
  ACCOUNTS_PATH,
  type AccountsResponse,
  accountsResponseSchema,
  type HomeMembership,
  homeMembershipOf,
  homeMembershipPatch,
  ORGANIZATIONS_PATH,
  type OrganizationsResponse,
  organizationsResponseSchema,
  SCOPE_ALL,
  SCOPE_HOME,
  type Settings,
  trackedAccountSet,
  trackedOrganizationSet,
} from "@maxprice/shared";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import type { Daemon } from "../daemon-client";
import { CliError, EXIT, usageError } from "../exit";
import type { Io, Parsed } from "../main";
import {
  accountArgument,
  accountShortId,
  resolveAccount,
  resolveOrganization,
  shortId,
} from "../names";
import type { Env } from "../paths";
import { accountText, membershipText } from "../render/accounts";
import { organizationText } from "../render/organizations";
import { scopeFlagsText } from "../report-request";
import { readSettingsObject } from "../settings";
import {
  type Decision as EditDecision,
  editAndWait,
  type EditDeps,
  read,
  readyDaemon,
  trackingSettings,
  type Watch,
} from "../tracking-edit";

// `maxprice home` and `maxprice home set --account <a> --org <o>` (ADR-0140
// §5): Settings › Accounts' Home select on the command line. `home` prints the
// Home membership, one line per Provider; `set` chooses one by §1's flags and
// writes the Desktop's patch (`homeMembershipPatch`) under the settings lock,
// then waits as `org track` does. The old Home's Account and Organization
// join the tracked lists, so moving Home excludes nothing; choosing a
// Membership whose Organization is Excluded tracks it in the same write.

const HELP = "maxprice home --help";

function usage(message: string): CliError {
  return usageError(message, HELP);
}

// The Providers `home` names, one line each. Claude alone until a second
// Provider exists (ADR-0140 §1's two-Provider design).
const CLAUDE = "Claude";

type Tracking = Pick<Settings, "homeMemberships" | "trackedOrganizations" | "trackedAccounts">;

type Target = { account: AccountEntry; organizationUuid: string };

type Decision = EditDecision<Partial<Tracking>>;

type Daemons = { roster: OrganizationsResponse; accounts: AccountsResponse };

async function readBoth(daemon: Daemon): Promise<Daemons> {
  const [roster, accounts] = await Promise.all([
    read(daemon, ORGANIZATIONS_PATH, organizationsResponseSchema),
    read(daemon, ACCOUNTS_PATH, accountsResponseSchema),
  ]);
  return { roster, accounts };
}

// Whether the Account is tracked: the file's set, or the daemon's while the
// file names none yet, as a report's Scope reads it.
function accountTracked(entry: AccountEntry, settings: Tracking): boolean {
  const set = trackedAccountSet(settings);
  return set === null ? entry.tracked : set.has(entry.key);
}

// As in Settings, a Home membership's Account is tracked and is no Pending
// account: a Pending key never leaves this machine, and a Home membership is
// published (ADR-0136 §5).
function accountRefusal(
  entry: AccountEntry,
  settings: Tracking,
  accounts: readonly AccountEntry[],
): CliError | null {
  if (entry.accountUuid === null) {
    return new CliError(
      EXIT.FAILURE,
      `${accountText(entry)} is a Pending account, which cannot be Home until a key or a ` +
        "login names its Account",
      [{ label: "Connect its key:", command: "maxprice key set" }],
    );
  }
  if (!accountTracked(entry, settings)) {
    return new CliError(EXIT.FAILURE, `${accountText(entry)} is excluded; track it first`, [
      {
        label: "Track it:",
        command: `maxprice account track ${accountArgument(entry, accounts)}`,
      },
    ]);
  }
  return null;
}

// §1's flags, one value each: a name, `home` (that side of the Home
// membership) or `all` (any, as a flag left out). Both named choose one
// Membership the Account holds, its Organization Excluded or not; one left
// out must leave exactly one tracked Membership. A name matching nothing or
// several, and any other match, exits 2; an Account that is excluded or
// Pending exits 1.
function resolveTarget(
  flags: { account: string | undefined; org: string | undefined },
  settings: Tracking,
  { roster, accounts }: Daemons,
): Target {
  const home = homeMembershipOf(settings);
  const all = accounts.accounts;
  let account: AccountEntry | null = null;
  if (flags.account === SCOPE_HOME) {
    account = all.find((entry) => entry.key === home?.accountUuid) ?? null;
    if (account === null) {
      throw new CliError(
        EXIT.USAGE,
        "the Home membership's Account is not known; name the Account",
      );
    }
  } else if (flags.account !== undefined && flags.account !== SCOPE_ALL) {
    account = resolveAccount(flags.account, all);
  }
  let organization: string | null = null;
  if (flags.org === SCOPE_HOME) organization = home?.organizationUuid ?? null;
  else if (flags.org !== undefined && flags.org !== SCOPE_ALL) {
    organization = resolveOrganization(flags.org, roster.organizations).uuid;
  }
  if (account !== null) {
    const refusal = accountRefusal(account, settings, all);
    if (refusal !== null) throw refusal;
  }
  if (account !== null && organization !== null) {
    if (!account.memberships.some((m) => m.organizationUuid === organization)) {
      const row = roster.organizations.find((entry) => entry.uuid === organization);
      const org = row === undefined ? shortId(organization) : organizationText(row);
      throw new CliError(EXIT.USAGE, `${accountText(account)} has no Membership in ${org}`);
    }
    return { account, organizationUuid: organization };
  }

  const trackedOrganizations = trackedOrganizationSet(settings);
  const candidates: Target[] = [];
  for (const entry of account === null ? all : [account]) {
    if (!accountTracked(entry, settings)) continue;
    for (const { organizationUuid } of entry.memberships) {
      if (organization !== null && organizationUuid !== organization) continue;
      if (trackedOrganizations !== null && !trackedOrganizations.has(organizationUuid)) continue;
      candidates.push({ account: entry, organizationUuid });
    }
  }
  const named = scopeFlagsText({
    accounts: flags.account === undefined ? [] : [flags.account],
    orgs: flags.org === undefined ? [] : [flags.org],
  });
  if (candidates.length === 0) {
    throw new CliError(EXIT.USAGE, `no tracked Membership matches ${named}`, [
      "Name both --account and --org to choose a Membership in an Excluded organization.",
    ]);
  }
  if (candidates.length > 1) {
    throw new CliError(
      EXIT.USAGE,
      `${named} names ${candidates.length} tracked Memberships; name one with --account and --org`,
      candidates.map(
        (c) =>
          `${membershipText(c.organizationUuid, c.account, roster)}  ` +
          `${shortId(c.organizationUuid)} · ${accountShortId(c.account)}`,
      ),
    );
  }
  const only = candidates[0]!;
  const refusal = accountRefusal(only.account, settings, all);
  if (refusal !== null) throw refusal;
  return only;
}

function sameMembership(home: HomeMembership | null, target: Target): boolean {
  return (
    home !== null &&
    home.organizationUuid === target.organizationUuid &&
    home.accountUuid === target.account.accountUuid
  );
}

// With no Home the daemon resolves no tracked set and excludes nothing; the
// daemon saves the Home it chooses at its first scan (ADR-0122 §3).
function noHome(): CliError {
  return new CliError(
    EXIT.FAILURE,
    "there is no Home membership yet, so every Account and Organization is counted; " +
      "an edit needs a Home",
  );
}

// The guards against the file as read, the first time and under the lock:
// no Home yet, the Account excluded meanwhile, and the target already Home.
function decide(settings: Tracking, target: Target, daemons: Daemons): Decision {
  if (homeMembershipOf(settings) === null) return { kind: "refuse", error: noHome() };
  const refusal = accountRefusal(target.account, settings, daemons.accounts.accounts);
  if (refusal !== null) return { kind: "refuse", error: refusal };
  const patch = homeMembershipPatch(settings, target.organizationUuid, target.account.accountUuid!);
  if (patch !== null) return { kind: "write", patch };
  return {
    kind: "answer",
    line: `${membershipText(target.organizationUuid, target.account, daemons.roster)} is already Home`,
  };
}

// The wait, as `org track`'s: until the daemon shows the change (its
// roster's Home is the Organization, and its Account listing's Home Account
// the Account) and nothing is re-walking. Once the file's Home membership is
// another, a later edit replaced it.
function homeWatch(target: Target, daemon: Daemon): Watch<Daemons> {
  return {
    read: () => readBoth(daemon),
    rewalking: ({ roster }) => roster.organizations.some((entry) => entry.reingesting),
    shows: ({ roster, accounts }) => {
      const account = accounts.accounts.find((entry) => entry.key === target.account.key);
      return roster.home === target.organizationUuid && account?.home === true;
    },
    holds: (settings) => sameMembership(homeMembershipOf(settings), target),
  };
}

// The old Home as the outcome names it: its Membership, or its Organization
// alone while its Account is not known.
function oldHomeText(old: HomeMembership, daemons: Daemons): string {
  if (old.accountUuid === null) {
    const row = daemons.roster.organizations.find((e) => e.uuid === old.organizationUuid);
    return row === undefined ? shortId(old.organizationUuid) : terminalText(row.label);
  }
  const entry = daemons.accounts.accounts.find((e) => e.key === old.accountUuid);
  return membershipText(
    old.organizationUuid,
    entry ?? { label: accountLabel(old.accountUuid, null) },
    daemons.roster,
  );
}

async function set(
  flags: { account: string | undefined; org: string | undefined },
  io: Io,
  env: Env,
  deps: EditDeps,
): Promise<number> {
  const daemon = await readyDaemon(io, env);
  const daemons = await readBoth(daemon);
  const first = trackingSettings(readSettingsObject(env), env);
  if (homeMembershipOf(first) === null) throw noHome();
  const target = resolveTarget(flags, first, daemons);
  const before = await editAndWait(
    {
      first,
      decide: (settings) => decide(settings, target, daemons),
      apply: (raw, patch) => {
        const { trackedAccounts, ...rest } = patch;
        Object.assign(raw, rest);
        // A file that names no tracked Accounts yet keeps naming none: the
        // daemon's seed fills it (ADR-0136 §8), and an absent list is not
        // written as a null one.
        if (trackedAccounts !== null) raw.trackedAccounts = trackedAccounts;
      },
      watch: homeWatch(target, daemon),
    },
    io,
    env,
    deps,
  );
  if (before === null) return EXIT.OK;
  const tracked = trackedOrganizationSet(before);
  const row = daemons.roster.organizations.find((e) => e.uuid === target.organizationUuid);
  if (tracked !== null && !tracked.has(target.organizationUuid)) {
    io.stdout.write(
      `Tracked ${row === undefined ? shortId(target.organizationUuid) : organizationText(row)}\n`,
    );
  }
  const old = homeMembershipOf(before)!;
  io.stdout.write(
    `${membershipText(target.organizationUuid, target.account, daemons.roster)} is Home; ` +
      `${oldHomeText(old, daemons)} stays tracked\n`,
  );
  return EXIT.OK;
}

// `home`: the Home membership, one line per Provider, as the daemon reads
// it: the Organization its roster names Home (the persisted one, else its
// seed), and the Account its listing marks Home.
async function show(json: boolean, io: Io, env: Env): Promise<number> {
  const daemon = await readyDaemon(io, env);
  const [roster, accounts] = await Promise.all([
    daemon.request(ORGANIZATIONS_PATH, organizationsResponseSchema),
    daemon.request(ACCOUNTS_PATH, accountsResponseSchema),
  ]);
  if (json) {
    // No one route holds the Home membership: the roster names its
    // Organization, and the Account listing its Account while it is known.
    io.stdout.write(`{"organizations":${roster.text},"accounts":${accounts.text}}`);
    return EXIT.OK;
  }
  const home = roster.data.home;
  const account = accounts.data.accounts.find((entry) => entry.home) ?? null;
  const text =
    home === null ? "no Home membership yet" : membershipText(home, account, roster.data);
  io.stdout.write(`${CLAUDE}  ${text}\n`);
  return EXIT.OK;
}

// One value for a flag `home set` takes once.
function single(values: unknown, flag: string): string | undefined {
  const list = (values as string[] | undefined) ?? [];
  if (list.length > 1) throw usage(`home set takes one ${flag}`);
  return list[0];
}

export async function home(
  parsed: Parsed,
  io: Io,
  env: Env = process.env,
  deps: EditDeps = {},
): Promise<number> {
  const [verb, ...rest] = parsed.positionals;
  const json = parsed.values.json === true;
  const given = (parsed.values.account ?? parsed.values.org) !== undefined;
  if (verb === undefined) {
    if (given) throw usage("--account and --org are for home set only");
    return await show(json, io, env);
  }
  if (verb !== "set") throw usage(`unknown home command '${verb}'`);
  if (json) throw usage("--json is for home only, not home set");
  if (rest.length > 0) {
    throw usage("home set takes no argument; name the Membership with --account and --org");
  }
  const account = single(parsed.values.account, "--account");
  const org = single(parsed.values.org, "--org");
  if (account === undefined && org === undefined) {
    throw usage("home set needs --account, --org or both");
  }
  return await set({ account, org }, io, env, deps);
}
