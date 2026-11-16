import { foldTrackedAccounts, type AccountsSeed, type PendingFold } from "./accounts";
import {
  homeMembershipOf,
  homeOrganizationOf,
  type Settings,
  withHomeOrganization,
} from "./settings";

// Tracking an Organization (ADR-0098) or an Account (ADR-0136 §3): the
// settings writes that track one, exclude one or make an Organization Home,
// and the words of the exclude confirmation.
// Shared by the Desktop client's Settings › Accounts (#639) and the Headless
// client's `maxprice org` and `maxprice account` (ADR-0122 §6, ADR-0140 §5),
// so both write the same patch behind the same guards and ask the same
// question (ADR-0118 §7). Each patch is a pure function of the settings it is built
// from, and returns null when there is nothing to write.

// The settings write that makes `target` Home without changing the resolved
// tracked set (Home ∪ the list, as the sidecar resolves it): the target leaves
// the list and the old Home joins it, so the sidecar sees a Home change inside
// an unchanged set and nothing is re-walked. null when there is no Home yet,
// the target already is Home, or it is untracked (its becoming Home would
// widen the set). Tracked means both the roster row says so and the settings
// list names it: settings are the authority, and the roster's `tracked` can
// lag a settings write. The Home membership keeps its Account (ADR-0136 §5):
// only its Organization moves, and any other Provider's entry is kept.
export function makeHomePatch(
  settings: Pick<Settings, "homeMemberships" | "trackedOrganizations">,
  target: string,
  tracked: boolean,
): Pick<Settings, "homeMemberships" | "trackedOrganizations"> | null {
  const membership = homeMembershipOf(settings);
  if (membership === null || target === membership.organizationUuid || !tracked) return null;
  const list = new Set(settings.trackedOrganizations);
  if (!list.has(target)) return null;
  list.delete(target);
  list.add(membership.organizationUuid);
  return {
    homeMemberships: withHomeOrganization(settings, target),
    trackedOrganizations: [...list],
  };
}

// The settings write that tracks `uuid`: the list with it appended, which
// widens the resolved tracked set. null when there is no Home yet (the sidecar
// then resolves no set and excludes nothing, so a list edit changes nothing),
// `uuid` is Home (always tracked), or the list already names it. Built inside
// the write, from the settings as the write before it left them: in the
// Desktop client's settings write chain (`update((current) =>
// trackPatch(current, uuid))`), and in the Headless client's `editSettings`,
// from the file as read under the settings lock (ADR-0122 §2). Two edits in a
// row therefore both land; a patch built from an earlier read would drop the
// first.
export function trackPatch(
  settings: Pick<Settings, "homeMemberships" | "trackedOrganizations">,
  uuid: string,
): Pick<Settings, "trackedOrganizations"> | null {
  const home = homeOrganizationOf(settings);
  if (home === null || uuid === home) return null;
  if (settings.trackedOrganizations.includes(uuid)) return null;
  return { trackedOrganizations: [...settings.trackedOrganizations, uuid] };
}

// The settings write that excludes `uuid`: the list without it, which narrows
// the resolved tracked set. null when there is no Home yet, `uuid` is Home
// (always tracked, whatever the list says), or the list does not name it. In
// the Desktop client a scope on `uuid` resets in the same write, since its
// writer resolves the scope against the new list (`parseSettings`); the
// Headless client writes no scope (ADR-0122 §4). Built inside the write, like
// `trackPatch`.
export function excludePatch(
  settings: Pick<Settings, "homeMemberships" | "trackedOrganizations">,
  uuid: string,
): Pick<Settings, "trackedOrganizations"> | null {
  const home = homeOrganizationOf(settings);
  if (home === null || uuid === home) return null;
  if (!settings.trackedOrganizations.includes(uuid)) return null;
  return {
    trackedOrganizations: settings.trackedOrganizations.filter((member) => member !== uuid),
  };
}

// The Account patches' guards: the list they edit, or null when no edit can
// change the resolved Account set. That set is the list UNION the Home
// membership's Account (`resolveTrackedAccounts`), and it is null, excluding
// nothing, while there is no Home membership or no list. An absent list
// (`null`) is a file that predates Accounts: the sidecar derives its upgrade
// set (ADR-0136 §8) and the host persists that seed before any edit, so an
// edit built on an absent list would replace the upgrade set with one Account
// and is refused instead. `key` is an account uuid or `pending:<hash>`.
function accountList(
  settings: Pick<Settings, "homeMemberships" | "trackedAccounts">,
  key: string,
): string[] | null {
  const membership = homeMembershipOf(settings);
  if (membership === null || settings.trackedAccounts === null) return null;
  // The Home membership's Account is always tracked, whatever the list says.
  if (key === membership.accountUuid) return null;
  return settings.trackedAccounts;
}

// The settings write that tracks the Account `key`: the list with it
// appended. null when the guards above refuse or the list already names it.
// Built inside the write, like `trackPatch`.
export function trackAccountPatch(
  settings: Pick<Settings, "homeMemberships" | "trackedAccounts">,
  key: string,
): { trackedAccounts: string[] } | null {
  const list = accountList(settings, key);
  if (list === null || list.includes(key)) return null;
  return { trackedAccounts: [...list, key] };
}

// The settings write that excludes the Account `key`: the list without it.
// null when the guards above refuse (the Home membership's Account among
// them) or the list does not name it. Built inside the write, like
// `excludePatch`.
export function excludeAccountPatch(
  settings: Pick<Settings, "homeMemberships" | "trackedAccounts">,
  key: string,
): { trackedAccounts: string[] } | null {
  const list = accountList(settings, key);
  if (list === null || !list.includes(key)) return null;
  return { trackedAccounts: list.filter((member) => member !== key) };
}

// The settings write that persists the sidecar's Account seed (ADR-0136 §4,
// §8; #631 decision 2): the tracked Account list it derived, and the Home
// membership's Account. Written only while the file names no list, so a list
// any writer has already persisted, the user's or an earlier seed's, is never
// replaced. The Home membership is completed only where it is still the
// seed's: absent (a first launch whose Home seed has not landed yet, so this
// write lands it with its Account), or the seed's Organization with no Account
// known. A Home the user moved meanwhile keeps its own Account. Built inside
// the write, like `trackPatch`: the Desktop renderer's settings write chain
// and the Headless client's `editSettings`. null when there is nothing to
// write.
export function seedAccountsPatch(
  settings: Pick<Settings, "homeMemberships" | "trackedAccounts">,
  seed: AccountsSeed,
): Pick<Settings, "homeMemberships" | "trackedAccounts"> | null {
  if (settings.trackedAccounts !== null) return null;
  const membership = homeMembershipOf(settings);
  const completes =
    membership === null ||
    (membership.organizationUuid === seed.homeOrganizationUuid && membership.accountUuid === null);
  return {
    homeMemberships: completes
      ? {
          ...settings.homeMemberships,
          anthropic: {
            organizationUuid: seed.homeOrganizationUuid,
            accountUuid: seed.homeAccountUuid,
          },
        }
      : settings.homeMemberships,
    trackedAccounts: [...seed.trackedAccounts],
  };
}

// The settings write that freezes the sidecar's Pending account folds
// (ADR-0137 §1): the list with each folded Pending key replaced by its Account
// or dropped (`foldTrackedAccounts`). null when the file names no list (the
// seed persists the folded set instead) or no fold changes it, so a fold the
// host already wrote, or one whose Pending key the user has since excluded,
// writes nothing. Built inside the write, like `trackPatch`.
export function foldAccountsPatch(
  settings: Pick<Settings, "trackedAccounts">,
  folds: readonly PendingFold[],
): { trackedAccounts: string[] } | null {
  const list = settings.trackedAccounts;
  if (list === null) return null;
  const next = foldTrackedAccounts(list, folds);
  if (next.length === list.length && next.every((key, i) => key === list[i])) return null;
  return { trackedAccounts: next };
}

// The exclude confirmation's paragraphs: the Desktop client's dialog, and what
// `maxprice org exclude` and `maxprice account exclude` print before they ask. Excluding repairs this
// machine's history alone (ADR-0098 §5): its sessions leave the Hub and the
// Local archive, and only the session files can bring them back. `hub`: a Hub
// is configured, connected or not.
export function excludeCopy(facts: { hub: boolean }): string[] {
  return [
    facts.hub
      ? "Its usage leaves every report on this machine, and this machine's sessions for it are removed from your hub. What other machines recorded for it stays on your hub."
      : "Its usage leaves every report on this machine.",
    "Claude Code session files aren't touched: tracking it again brings back whatever they still hold, and nothing else.",
  ];
}

// The exclude confirmation's title, with the uuid's first 8 as `shortId`. The
// bare label, since the id follows: a collision suffix would print it twice.
export function excludeTitle(bareLabel: string, shortId: string): string {
  return `Exclude ${bareLabel} (${shortId})?`;
}

// The exclude confirmation's typed token is the bare label: the collision
// suffix's middle dot is not typeable, and the title names the id. Trimmed,
// case-sensitive (the Desktop client's `isForgetArmed` rule). The Headless
// client checks a typed line and `--confirm` alike (ADR-0122 §6).
export function isExcludeArmed(typed: string, bareLabel: string): boolean {
  return typed.trim() === bareLabel;
}
