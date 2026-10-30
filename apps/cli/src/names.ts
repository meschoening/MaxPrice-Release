import { displayOrganizationLabels, type OrganizationEntry } from "@maxprice/shared";
import { CliError, EXIT, type Hint } from "./exit";

// Naming a thing on the command line: an Organization (ADR-0122 §6), and by
// the same rule a machine. A name is matched as a full id, then as a unique
// id prefix of at least 8 characters (the short id the CLI prints), then as
// the exact label, case-sensitive. An ambiguous name exits 2 and lists the
// candidates; a name that matches nothing exits 2.

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
  const labelled = entries.filter((entry) => how.label(entry) === name);
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
