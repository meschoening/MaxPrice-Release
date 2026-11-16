import {
  type AccountEntry,
  displayOrganizationLabels,
  emailHash,
  type OrganizationEntry,
  pendingAccountKey,
} from "@maxprice/shared";
import { CliError, EXIT, type Hint } from "./exit";

// Naming a thing on the command line: an Organization (ADR-0122 §6), and by
// the same rule a machine and an Account (ADR-0140 §2). A name is matched as
// a full id, then as a unique id prefix of at least 8 characters (the short
// id the CLI prints), then as the exact label, case-sensitive, or another
// exact name the thing answers to (an Account's email). An ambiguous name
// exits 2 and lists the candidates; a name that matches nothing exits 2.

const MIN_ID_PREFIX = 8;

// The short id the CLI prints for an Organization: the shortest prefix a
// name may give.
export function shortId(uuid: string): string {
  return uuid.slice(0, MIN_ID_PREFIX);
}

export type Nameable<T> = {
  // What the thing is called in a message: "Organization", "machine".
  noun: string;
  id: (entry: T) => string;
  label: (entry: T) => string;
  // Another exact name the entry answers to beside its label, or null: an
  // Account's email as read here.
  alias?: (entry: T) => string | null;
  // How a candidate is listed under an ambiguous name.
  describe: (entry: T) => string;
};

function ambiguous<T>(name: string, matches: readonly T[], how: Nameable<T>): CliError {
  const hints: Hint[] = matches.map((entry) => how.describe(entry));
  return new CliError(
    EXIT.USAGE,
    `'${name}' names ${matches.length} ${how.noun}s; give its id or a longer prefix`,
    hints,
  );
}

export function resolveName<T>(name: string, entries: readonly T[], how: Nameable<T>): T {
  const exact = entries.find((entry) => how.id(entry) === name);
  if (exact !== undefined) return exact;
  if (name.length >= MIN_ID_PREFIX) {
    const prefixed = entries.filter((entry) => how.id(entry).startsWith(name));
    if (prefixed.length === 1) return prefixed[0]!;
    if (prefixed.length > 1) throw ambiguous(name, prefixed, how);
  }
  const labelled = entries.filter(
    (entry) => how.label(entry) === name || (how.alias?.(entry) ?? null) === name,
  );
  if (labelled.length === 1) return labelled[0]!;
  if (labelled.length > 1) throw ambiguous(name, labelled, how);
  throw new CliError(EXIT.USAGE, `no ${how.noun} is named '${name}'`);
}

// An Organization in the daemon's roster (`/api/organizations`), named by
// its uuid, a uuid prefix or its bare label. Candidates are listed as every
// surface shows them: the collision-suffixed label, then the short id.
export function resolveOrganization(
  name: string,
  roster: readonly OrganizationEntry[],
): OrganizationEntry {
  const shown = displayOrganizationLabels(roster);
  return resolveName(name, roster, {
    noun: "Organization",
    id: (entry) => entry.uuid,
    label: (entry) => entry.label,
    describe: (entry) => `${shown.get(entry.uuid) ?? entry.label}  ${shortId(entry.uuid)}`,
  });
}

// An Account's Id as the CLI prints it: its uuid's short id, or `pending` for
// a Pending account, which has none (ADR-0140 §5).
export function accountShortId(entry: Pick<AccountEntry, "accountUuid">): string {
  return entry.accountUuid === null ? "pending" : shortId(entry.accountUuid);
}

// An Account in the daemon's roster (`/api/accounts`), named by its uuid, an
// 8-character uuid prefix, its label, or its email as this machine reads it,
// the only name a Pending account has (ADR-0140 §2). A Pending account's
// `pending:<hash>` key never leaves this machine's daemon, so it is no name.
// The daemon holds no address for a Pending account (`email: null`, ADR-0137
// §1's note), so its email names it through its key: the hash of the name
// typed (`emailHash`, trimmed and lower-cased as the parser hashes it).
export function resolveAccount(name: string, accounts: readonly AccountEntry[]): AccountEntry {
  const pendingKey = name.includes("@") ? pendingAccountKey(emailHash(name)) : null;
  return resolveName(name, accounts, {
    noun: "Account",
    // A Pending account has no uuid, so no id or prefix names it.
    id: (entry) => entry.accountUuid ?? "",
    label: (entry) => entry.label,
    alias: (entry) => (entry.pending && entry.key === pendingKey ? name : entry.email),
    describe: (entry) => `${entry.label}  ${accountShortId(entry)}`,
  });
}

// A name as a shell word in a command the CLI prints: as it is when it holds
// nothing a shell reads, else single-quoted.
export function shellWord(name: string): string {
  return /^[\w.@:+=/-]+$/.test(name) ? name : `'${name.replaceAll("'", "'\\''")}'`;
}

// The first of `names` that names the thing alone, as a shell word: a name
// another thing also answers to, or one that resolves to another thing
// (a label that is another's uuid prefix), is passed over.
function argumentOf(names: readonly (string | null)[], namesIt: (name: string) => boolean): string {
  const usable = names.filter((name): name is string => name !== null);
  const found = usable.find((name) => {
    try {
      return namesIt(name);
    } catch (error) {
      if (error instanceof CliError) return false;
      throw error;
    }
  });
  // The last is the full id, which names the thing whenever it has one.
  return shellWord(found ?? usable[usable.length - 1]!);
}

// How a command the CLI prints names an Organization (`maxprice org track
// …`): its bare label while that names it alone, else its short id, or its
// uuid while another shares the short id. Raw, as `shellWord` leaves it: a
// line on a terminal passes through `terminalText` (an error's hints do in
// `renderError`).
export function organizationArgument(
  entry: Pick<OrganizationEntry, "uuid" | "label">,
  roster: readonly OrganizationEntry[],
): string {
  return argumentOf(
    [entry.label, shortId(entry.uuid), entry.uuid],
    (name) => resolveOrganization(name, roster).uuid === entry.uuid,
  );
}

// How a command the CLI prints names an Account (`maxprice account track
// …`), by the same rule: its label while that names it alone, else its short
// id, or its uuid. A Pending account has no id, and the daemon holds no
// address for it, so it is printed by its label (`Account <first 8>` of its
// email's hash); a user names it by typing that email (`resolveAccount`).
export function accountArgument(entry: AccountEntry, accounts: readonly AccountEntry[]): string {
  const ids = entry.accountUuid === null ? [] : [shortId(entry.accountUuid), entry.accountUuid];
  return argumentOf(
    [entry.label, ...ids, ...(ids.length === 0 ? [entry.email] : [])],
    (name) => resolveAccount(name, accounts).key === entry.key,
  );
}
