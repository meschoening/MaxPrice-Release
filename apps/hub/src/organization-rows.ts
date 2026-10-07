import {
  resolveOrganizationLabel,
  type HubOrganization,
  type OrganizationLabelEntry,
  type OrganizationRosterHints,
  type OrgLimitsAnswer,
  type UsageOrganizations,
} from "@maxprice/shared";

// One roster entry as the rows read it; organization-roster.ts's entries
// satisfy it. Null hints: the listing said nothing a label may use.
export type HubRosterEntry = {
  id: string;
  hints: OrganizationRosterHints | null;
  limits: OrgLimitsAnswer | null;
};

// The Organizations the Hub knows, as GET /api/organizations answers them
// (#294): every roster entry in roster order, then every Organization the
// directory holds a live label for that the roster lacks, in uuid order. Each
// label resolves as the sidecar's roster resolves it: the directory's rename,
// else the hints' plan word, else the short id. A row's Limits answer is the
// live status map's, else the roster's last answer without its times, else
// null. A listed row also carries its roster hints when it has any (#366), so a
// client that learns the roster resolves the same default label; a
// directory-only row carries none. The operator rename checks uniqueness
// against these same labels.
export function hubOrganizationRows(
  roster: ReadonlyArray<HubRosterEntry>,
  labels: Readonly<Record<string, OrganizationLabelEntry>>,
  live: UsageOrganizations,
): HubOrganization[] {
  // Own keys only: an id named like an Object prototype member reads nothing.
  const row = (
    uuid: string,
    hints: OrganizationRosterHints | null,
    listed: boolean,
    answer: OrgLimitsAnswer | null,
  ): HubOrganization => {
    const { label, renamed } = resolveOrganizationLabel({
      uuid,
      rename: Object.hasOwn(labels, uuid) ? labels[uuid]!.label : null,
      organizationType: null,
      hints,
    });
    const limits = Object.hasOwn(live, uuid)
      ? live[uuid]!
      : answer === null
        ? null
        : { limits: answer, lastReadAt: null, lastSampleAt: null };
    return { uuid, label, renamed, listed, limits, ...(listed && hints !== null ? { hints } : {}) };
  };
  const rostered = new Set(roster.map((entry) => entry.id));
  const directoryOnly = Object.keys(labels)
    .filter((uuid) => !rostered.has(uuid) && labels[uuid]!.label !== null)
    .sort();
  return [
    ...roster.map((entry) => row(entry.id, entry.hints, true, entry.limits)),
    ...directoryOnly.map((uuid) => row(uuid, null, false, null)),
  ];
}
