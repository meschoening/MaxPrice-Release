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

// The quota surfaces' view (ADR-0106 §10): whether the Organization whose
// limits Live reads has a weekly limit (the This week tile's fallback line),
// and the topbar's Organization scope chip. Pure, so their markup is testable
// without the query hooks. The Scope's head Organization
// (`useScope().quotaOrganization`) is the one they read under every Scope.

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

// Whether the Quota organization has no weekly limit to read, so the This
// week tile has no weekly reset to wait for (ADR-0106 §10, #384):
//   - `forbidden` reads nothing about its limits;
//   - otherwise an `absent` weekly Window state is no such limit (an
//     Enterprise organization's). The state is the last successful poll's, so
//     a transient `error` keeps it;
//   - an `active` or `idle` window is a limit (#384), and so is a window with
//     no state yet, a Connect-seeded `none` included, so the tile never drops
//     its warning before a poll.
// No Quota organization (no Home) has none to lack.
export function noWeeklyLimit(input: {
  quotaOrganization: string | undefined;
  answer: OrganizationLimits["answer"] | undefined;
  weekly: WindowState | undefined;
}): boolean {
  if (input.quotaOrganization === undefined) return false;
  return input.answer === "forbidden" || input.weekly === "absent";
}
