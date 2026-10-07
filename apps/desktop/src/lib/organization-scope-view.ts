import {
  ALL_ORGANIZATIONS,
  displayOrganizationLabels,
  resolveOrganizationLabel,
  resolveOrganizationScope,
  type OrganizationEntry,
  type OrganizationLimits,
  type Settings,
  type UsageCurrent,
} from "@maxprice/shared";

// The Organization scope chip's view (ADR-0106), built from settings and the
// roster. Pure, so the chip's markup is testable without the query hooks.
//
// Presence follows the TRACKED set in settings — Home plus
// `trackedOrganizations` — never the roster of seen Organizations: a machine
// that tracks only Home has nothing to scope between, and All over a
// one-member set is Home (#262 item 11), so it shows no chip at all. The test
// is the shared resolution rule itself: the chip exists exactly when All
// resolves to All. The roster only names what settings already lists; one
// that lags settings still yields an option, under the `Organization <first 8>`
// fallback.
//
// "No limits" marks a Limits answer of `none` or `forbidden`: the last read
// found no window, or could not read any. A transient `error`, or an
// Organization that has never been read, still has limits to read, so it
// carries no marker. The chip reads the answer alone, so an idle subscription
// Organization, which also answers `none` (ADR-0108 §4), wears the marker too;
// the quota surfaces refine `none` by its weekly cadence (`quotaSurface`).

// The answers with no window read, shared by the chip's marker and the quota
// surfaces' rule.
export function isNoLimitsAnswer(
  answer: OrganizationLimits["answer"] | undefined,
): answer is "none" | "forbidden" {
  return answer === "none" || answer === "forbidden";
}

// uuid → the label to render, collision-suffixed across the WHOLE roster, so
// the chip and every other surface that names an Organization agree.
export function organizationLabelMap(
  roster: ReadonlyArray<Pick<OrganizationEntry, "uuid" | "label">>,
): Map<string, string> {
  return displayOrganizationLabels(roster);
}

// A uuid the roster has not listed renders the shared label resolution's
// answer for an Organization with no rename and no plan word, so the fallback
// is spelled in one place; the upstream name never appears.
export function organizationLabel(labels: ReadonlyMap<string, string>, uuid: string): string {
  return (
    labels.get(uuid) ??
    resolveOrganizationLabel({ uuid, rename: null, organizationType: null, hints: null }).label
  );
}

// The Organization cells of the Sessions and Projects tables, shown only under
// All organizations. A session with no attributed Organization reads null —
// the cell renders an em dash rather than a label it cannot claim.
export function sessionOrganizationLabel(
  uuid: string | undefined,
  labels: ReadonlyMap<string, string>,
): string | null {
  return uuid === undefined ? null : organizationLabel(labels, uuid);
}

// A project's Organizations in first-seen order: none is null, one reads as its
// label, several as a count whose title lists every label in that order. One
// label is its own title, since a long one truncates in the cell.
export function projectOrganizationsCell(
  uuids: readonly string[],
  labels: ReadonlyMap<string, string>,
): { text: string; title: string } | null {
  const [only] = uuids;
  if (only === undefined) return null;
  if (uuids.length === 1) {
    const label = organizationLabel(labels, only);
    return { text: label, title: label };
  }
  return {
    text: `${uuids.length} organizations`,
    title: uuids.map((uuid) => organizationLabel(labels, uuid)).join(", "),
  };
}

export interface ScopeOption {
  uuid: string;
  label: string;
  isHome: boolean;
  noLimits: boolean;
}

export interface ScopeView {
  // Home first, then the tracked rest in roster order, then any the roster
  // lacks in settings order.
  options: ScopeOption[];
  // The resolved scope: null (Home), a uuid, or "all".
  selected: string | null;
  isAll: boolean;
  // The scoped Organization's label; Home's under Home; "All organizations"
  // under All.
  chipLabel: string;
  // Home's label: the Quota organization under All, the one scope whose chip
  // names it.
  quotaLabel: string;
}

// `settings.organizationScope` is already resolved (`parseSettings`), so it is
// taken as given. null: no Home, or fewer than two tracked Organizations.
export function buildScopeView(
  settings: Pick<Settings, "homeOrganization" | "trackedOrganizations" | "organizationScope">,
  roster: ReadonlyArray<Pick<OrganizationEntry, "uuid" | "label" | "limits">>,
): ScopeView | null {
  const home = settings.homeOrganization;
  const tracked = settings.trackedOrganizations;
  if (home === null) return null;
  if (resolveOrganizationScope(ALL_ORGANIZATIONS, home, tracked) !== ALL_ORGANIZATIONS) return null;

  // The members again, for ordering only: Home, then the tracked list with
  // empty entries and repeats dropped, in settings order.
  const members = new Set<string>([home]);
  for (const uuid of tracked) if (uuid !== "") members.add(uuid);
  const labels = organizationLabelMap(roster);
  const byUuid = new Map(roster.map((entry) => [entry.uuid, entry]));
  const listed = roster.filter((entry) => entry.uuid !== home && members.has(entry.uuid));
  const unlisted = [...members].filter((uuid) => uuid !== home && !byUuid.has(uuid));
  const order = [home, ...listed.map((entry) => entry.uuid), ...unlisted];

  const options = order.map(
    (uuid): ScopeOption => ({
      uuid,
      label: organizationLabel(labels, uuid),
      isHome: uuid === home,
      noLimits: isNoLimitsAnswer(byUuid.get(uuid)?.limits?.answer),
    }),
  );
  const selected = settings.organizationScope;
  const isAll = selected === ALL_ORGANIZATIONS;
  const homeLabel = organizationLabel(labels, home);
  return {
    options,
    selected,
    isAll,
    chipLabel: isAll
      ? "All organizations"
      : selected === null
        ? homeLabel
        : organizationLabel(labels, selected),
    quotaLabel: homeLabel,
  };
}

// What the quota surfaces say about the Quota organization, whose reading they
// show under every scope.
export type NoLimits = { answer: "none" | "forbidden"; label: string };
export interface QuotaSurface {
  // The Quota organization's label under All organizations, else null:
  // scoped to one Organization the chip already names it.
  tag: string | null;
  // Set only when the Quota organization's limits can't be read (`forbidden`),
  // or it answers `none` with no weekly cadence (`quotaSurface`).
  noLimits: NoLimits | null;
}

// An Organization's Limits answer as the roster reports it: undefined for an
// unread entry, a uuid the roster lacks, or a roster not yet loaded. A string,
// so it keeps its value across the roster's per-read status churn and a memo
// keyed on it holds.
export function rosterLimitsAnswer(
  roster: ReadonlyArray<Pick<OrganizationEntry, "uuid" | "limits">> | undefined,
  uuid: string | undefined,
): OrganizationLimits["answer"] | undefined {
  if (uuid === undefined) return undefined;
  return roster?.find((entry) => entry.uuid === uuid)?.limits?.answer;
}

// Whether an Organization's usage-current entry is loaded and carries no weekly
// reset: no weekly window seen on this machine or the Hub, since the last-known
// reset (the poller's, else the stored history's) outlives an idle stretch
// (ADR-0083). An entry not loaded yet is not, so the note never flashes before
// the data. A boolean, so a memo keyed on it holds across usage reads.
export function lacksWeeklyCadence(
  usage: Pick<UsageCurrent, "weeklyResetAt"> | undefined,
): boolean {
  return usage !== undefined && usage.weeklyResetAt === null;
}

// The tag follows the scope; the note follows the Quota organization's roster
// Limits answer (`rosterLimitsAnswer`) and, for `none`, its cadence:
//   - `forbidden` is no limits: nothing about its limits can be read.
//   - `none` is no limits only with no weekly cadence (`noWeeklyCadence`). The
//     poller also answers `none` for a subscription Organization with no window
//     in flight (ADR-0108 §4), and that one keeps its last weekly reset.
//   - `windows`, `error` and no answer say nothing, leaving today's rendering.
// The rule holds under every scope, so a single tracked Organization gains the
// note too. No Quota organization (no Home) names nothing.
export function quotaSurface(input: {
  isAll: boolean;
  quotaOrganization: string | undefined;
  labels: ReadonlyMap<string, string>;
  answer: OrganizationLimits["answer"] | undefined;
  noWeeklyCadence: boolean;
}): QuotaSurface {
  const { isAll, quotaOrganization, labels, answer, noWeeklyCadence } = input;
  if (quotaOrganization === undefined) return { tag: null, noLimits: null };
  const label = organizationLabel(labels, quotaOrganization);
  const noLimits = isNoLimitsAnswer(answer) && (answer === "forbidden" || noWeeklyCadence);
  return {
    tag: isAll ? label : null,
    noLimits: noLimits ? { answer, label } : null,
  };
}

// The Live chart's note beside its controls on the block span: the 5-hour
// block it frames is the Quota organization's, so under All it says whose.
export function blockSpanNote(span: string, tag: string | null): string | null {
  return span === "block" && tag !== null ? `${tag}'s block` : null;
}

// The Blocks page's topbar subtitle suffix: every block there is the Quota
// organization's, so under All the subtitle says whose.
export function blocksSubtitleSuffix(pathname: string, tag: string | null): string {
  return pathname === "/blocks" && tag !== null ? ` · ${tag}'s blocks` : "";
}

// The scope a menu option writes, which is also the resolved scope it reads as
// selected under: Home as `null`, the only form Home takes; any other
// Organization as its uuid; the All option as ALL_ORGANIZATIONS.
export function optionScope(
  option: Pick<ScopeOption, "uuid" | "isHome"> | typeof ALL_ORGANIZATIONS,
): string | null {
  if (option === ALL_ORGANIZATIONS) return ALL_ORGANIZATIONS;
  return option.isHome ? null : option.uuid;
}
