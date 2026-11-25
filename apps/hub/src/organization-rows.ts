import {
  resolveOrganizationLabel,
  type HubOrganization,
  type LabelEntry,
  type OrganizationRosterHints,
} from "@maxprice/shared";

// One roster Organization as the rows read it; organization-roster.ts's
// `organizations()` satisfies it. `listedBy` holds Account keys, the legacy
// key's included; null hints: the listing said nothing a label may use.
export type HubRosterEntry = {
  id: string;
  hints: OrganizationRosterHints | null;
  listedBy: readonly string[];
};

// The Organizations the Hub knows, as GET /api/organizations answers them
// (#294, ADR-0139 §9): every roster Organization in roster order, then every
// Organization the directory holds a live label for that the roster lacks, in
// uuid order. Each label resolves as the sidecar's roster resolves it: the
// directory's rename, else the hints' plan word, else the short id. A row's
// `listedBy` is the Accounts whose key's listing names it, sorted; the
// unmoved legacy key (`legacyAccount`) has no Account to name, so it adds
// nothing. A roster row also carries the newest listing's hints when it has
// any (#366), so a client that learns the roster resolves the same default
// label; a directory-only row carries none. The operator rename checks
// uniqueness against these same labels.
export function hubOrganizationRows(
  roster: ReadonlyArray<HubRosterEntry>,
  labels: Readonly<Record<string, LabelEntry>>,
  legacyAccount: string,
): HubOrganization[] {
  // Own keys only: an id named like an Object prototype member reads nothing.
  const row = (
    uuid: string,
    hints: OrganizationRosterHints | null,
    listedBy: readonly string[],
  ): HubOrganization => {
    const { label, renamed } = resolveOrganizationLabel({
      uuid,
      rename: Object.hasOwn(labels, uuid) ? labels[uuid]!.label : null,
      login: null,
      hints,
    });
    return {
      uuid,
      label,
      renamed,
      listedBy: listedBy.filter((account) => account !== legacyAccount).sort(),
      ...(hints !== null ? { hints } : {}),
    };
  };
  const rostered = new Set(roster.map((entry) => entry.id));
  const directoryOnly = Object.keys(labels)
    .filter((uuid) => !rostered.has(uuid) && labels[uuid]!.label !== null)
    .sort();
  return [
    ...roster.map((entry) => row(entry.id, entry.hints, entry.listedBy)),
    ...directoryOnly.map((uuid) => row(uuid, null, [])),
  ];
}
