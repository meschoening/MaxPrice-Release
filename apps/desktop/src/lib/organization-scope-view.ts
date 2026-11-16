import {
  ALL_ORGANIZATIONS,
  homeOrganizationOf,
  isMultiOrganization,
  organizationLabel,
  organizationLabelMap,
  type OrganizationEntry,
  type OrganizationLimits,
  type ScopeSetting,
  type Settings,
  type WindowState,
} from "@maxprice/shared";

// The quota surfaces' view (ADR-0106 §10): what the Active block and This week
// tiles, the Live chart's block span and the Blocks page's subtitle say about
// the Organization whose limits they read, and the topbar's Organization scope
// chip. Pure, so their markup is testable without the query hooks.
//
// The Scope's head Organization (`useScope().quotaOrganization`) is what the
// quota surfaces read under every Scope; while the Scope spans more than one
// Organization (`spansOrganizations`) they name it (`tag`).

// --- The Organization scope chip (ADR-0106, kept by #637) --------------------
//
// The chip shows only on an install whose Account filter is hidden (fewer than
// two tracked Accounts, `accountFilterVisible`) and that tracks two or more
// Organizations: there it is the one Scope control, as it was in v0.9.x. With
// the Account filter showing, the filter holds the Scope and the chip never
// renders (#613 §3).
//
// Presence follows the TRACKED set in settings — Home plus
// `trackedOrganizations` — never the roster of seen Organizations: a machine
// that tracks only Home has nothing to scope between, and All over a
// one-member set is Home (#262 item 11), so it shows no chip at all. The roster
// only names what settings already lists; one that lags settings still yields
// an option, under the `Organization <first 8>` fallback.
//
// It reads and writes the persisted `scope` on the Organization axis alone
// (`chipScope`): Home as `null`, All as `{ organization: ["all"] }`, another
// Organization as `{ organization: [uuid] }`, exactly what a released file's
// `organizationScope` reads as, so a v0.9.x choice is shown and kept.
//
// "No limits" marks a Limits answer of `none` or `forbidden`: the last read
// found no supported limit at all (including idle model-scoped caps), or could
// not read any. A transient `error`, or an Organization never read, still has
// limits to read, so it carries no marker. An idle Organization answers
// `windows` (#384), so it wears none.

// The answers with no limit to read, the chip's marker.
export function isNoLimitsAnswer(
  answer: OrganizationLimits["answer"] | undefined,
): answer is "none" | "forbidden" {
  return answer === "none" || answer === "forbidden";
}

export interface ScopeOption {
  uuid: string;
  label: string;
  isHome: boolean;
  noLimits: boolean;
}

export interface ScopeChipView {
  // Home first, then the tracked rest in roster order, then any the roster
  // lacks in settings order.
  options: ScopeOption[];
  // The selected option: null (Home), a uuid, or "all".
  selected: string | null;
  isAll: boolean;
  // The scoped Organization's label; Home's under Home; "All organizations"
  // under All.
  chipLabel: string;
  // Home's label: the head Organization under All, the one scope whose chip
  // names it.
  quotaLabel: string;
  // A persisted Scope the chip cannot show is being read as Home
  // (`ScopeView.hiddenSelection`): the chip shows Home and says so.
  hiddenSelection: boolean;
}

// The option an Organization-axis Scope selects: Home for none, a stale
// uuid, `home` or a list the chip cannot show (which the sidecar resolves
// the same way, or which `scopeView` does not read); All for `all`; else the
// tracked uuid it names.
export function chipSelection(
  scope: ScopeSetting | null,
  members: ReadonlySet<string>,
  home: string,
): string | null {
  const tokens = scope?.organization;
  if (tokens === undefined || tokens.length !== 1) return null;
  const [token] = tokens;
  if (token === ALL_ORGANIZATIONS) return ALL_ORGANIZATIONS;
  return token !== undefined && token !== home && members.has(token) ? token : null;
}

// `selection` is the Scope the window reads (`ScopeView.selection`), and
// `hiddenSelection` its flag. null: no Home, or fewer than two tracked
// Organizations.
export function buildScopeChipView(
  settings: Pick<Settings, "homeMemberships" | "trackedOrganizations">,
  roster: ReadonlyArray<Pick<OrganizationEntry, "uuid" | "label" | "limits">>,
  selection: ScopeSetting | null,
  hiddenSelection = false,
): ScopeChipView | null {
  const home = homeOrganizationOf(settings);
  const tracked = settings.trackedOrganizations;
  if (home === null || !isMultiOrganization(home, tracked)) return null;

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
  const selected = chipSelection(selection, members, home);
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
    hiddenSelection,
  };
}

// The option's own selected value, which is also the value it reads as
// selected under: Home as `null`, the only form Home takes; any other
// Organization as its uuid; the All option as ALL_ORGANIZATIONS.
export function optionScope(
  option: Pick<ScopeOption, "uuid" | "isHome"> | typeof ALL_ORGANIZATIONS,
): string | null {
  if (option === ALL_ORGANIZATIONS) return ALL_ORGANIZATIONS;
  return option.isHome ? null : option.uuid;
}

// The persisted `scope` an option writes: the Organization axis alone, what a
// released file's `organizationScope` parses to (`parseSettings`).
export function chipScope(selected: string | null): ScopeSetting | null {
  return selected === null ? null : { organization: [selected] };
}

// The note a hidden selection shows (`ScopeView.hiddenSelection`): the saved
// Scope names Accounts or Memberships, which no control on a one-Account
// install can show, so the window reads the default Scope until a second
// Account is tracked. The file keeps it.
export const HIDDEN_SELECTION_NOTE =
  "A saved Account selection is not applied while only one Account is tracked. Showing the Home membership.";
export const HIDDEN_SELECTION_SHORT = "Saved selection not applied";

// What the quota surfaces say about the Quota organization, whose reading they
// show under every scope. A tile shows no meter for its window, and says why,
// when the Quota organization has no such limit (`absent`, its Window state)
// or its limits can't be read (`forbidden`).
export type NoLimit = { reason: "absent" | "forbidden"; label: string };
export interface QuotaSurface {
  // The Quota organization's label while the Scope spans more than one
  // Organization, else null: scoped to one Organization, there is no other
  // it could be.
  tag: string | null;
  // The Active block tile's note and the This Week tile's, each set only
  // when that tile's window has no limit to show (`quotaSurface`).
  fiveHourNote: NoLimit | null;
  weeklyNote: NoLimit | null;
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

// One window's Window state as the roster reports it (#384): what the
// Organization's last successful poll said, kept across a failed read.
// undefined with no such poll (an unread entry, a Connect seed), a uuid the
// roster lacks or a roster not yet loaded. A string, so a memo keyed on it
// holds across the roster's per-read churn.
export function rosterWindowState(
  roster: ReadonlyArray<Pick<OrganizationEntry, "uuid" | "limits">> | undefined,
  uuid: string | undefined,
  window: "fiveHour" | "weekly",
): WindowState | undefined {
  if (uuid === undefined) return undefined;
  return roster?.find((entry) => entry.uuid === uuid)?.limits?.windowStates?.[window];
}

// The tag follows the Scope; each tile's note follows the Quota organization's
// roster facts for its own window:
//   - `forbidden` is unreadable on both: nothing about its limits can be read.
//   - otherwise a window whose Window state is `absent` has no such limit: an
//     Enterprise organization's weekly window, or a `five_hour` of null. The
//     state is the last successful poll's, so a transient `error` keeps it.
//   - an `active` or `idle` window says nothing: an idle limit renders idle on
//     every Organization (#384). So does a window with no state yet, a
//     Connect-seeded `none` included, so no note flashes before a poll.
// The rule holds under every scope, so a single tracked Organization gains the
// note too. No Quota organization (no Home) names nothing.
export function quotaSurface(input: {
  // The Scope spans more than one Organization (`ScopeView.spansOrganizations`).
  isAll: boolean;
  quotaOrganization: string | undefined;
  labels: ReadonlyMap<string, string>;
  answer: OrganizationLimits["answer"] | undefined;
  fiveHour: WindowState | undefined;
  weekly: WindowState | undefined;
}): QuotaSurface {
  const { isAll, quotaOrganization, labels, answer } = input;
  if (quotaOrganization === undefined) return { tag: null, fiveHourNote: null, weeklyNote: null };
  const label = organizationLabel(labels, quotaOrganization);
  const noLimit = (state: WindowState | undefined): NoLimit | null =>
    answer === "forbidden"
      ? { reason: "forbidden", label }
      : state === "absent"
        ? { reason: "absent", label }
        : null;
  return {
    tag: isAll ? label : null,
    fiveHourNote: noLimit(input.fiveHour),
    weeklyNote: noLimit(input.weekly),
  };
}

// The Live chart's note beside its controls on the block span: the 5-hour
// block it frames is the Quota organization's, so while the Scope spans
// Organizations it says whose.
export function blockSpanNote(span: string, tag: string | null): string | null {
  return span === "block" && tag !== null ? `${tag}'s block` : null;
}

// The Blocks page's topbar subtitle suffix: every block there is the Quota
// organization's, so while the Scope spans Organizations the subtitle says
// whose. None while the page names its Membership in a tab or its strip
// instead (#619 A, #638): whenever the Scope's Memberships
// (`useScopeMemberships`, non-empty only with two or more tracked Accounts)
// hold any, exactly when `blocksTabsView` is not `single`. A one-Account
// install, whose list is always empty, keeps the suffix.
export function blocksSubtitleSuffix(
  pathname: string,
  tag: string | null,
  scopeMemberships: readonly unknown[] = [],
): string {
  if (pathname !== "/blocks" || tag === null || scopeMemberships.length > 0) return "";
  return ` · ${tag}'s blocks`;
}
