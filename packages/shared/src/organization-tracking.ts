import type { Settings } from "./settings";

// Tracking an Organization (ADR-0098): the settings writes that track one,
// exclude one or make one Home, and the words of the exclude confirmation.
// Shared by the Desktop client's Organizations list (Settings → Claude
// account) and the Headless client's `maxprice org` (ADR-0122 §6), so both
// write the same patch behind the same guards and ask the same question
// (ADR-0118 §7). Each patch is a pure function of the settings it is built
// from, and returns null when there is nothing to write.

// The settings write that makes `target` Home without changing the resolved
// tracked set (Home ∪ the list, as the sidecar resolves it): the target leaves
// the list and the old Home joins it, so the sidecar sees a Home change inside
// an unchanged set and nothing is re-walked. null when there is no Home yet,
// the target already is Home, or it is untracked (its becoming Home would
// widen the set). Tracked means both the roster row says so and the settings
// list names it: settings are the authority, and the roster's `tracked` can
// lag a settings write.
export function makeHomePatch(
  settings: Pick<Settings, "homeOrganization" | "trackedOrganizations">,
  target: string,
  tracked: boolean,
): Pick<Settings, "homeOrganization" | "trackedOrganizations"> | null {
  const home = settings.homeOrganization;
  if (home === null || target === home || !tracked) return null;
  const list = new Set(settings.trackedOrganizations);
  if (!list.has(target)) return null;
  list.delete(target);
  list.add(home);
  return { homeOrganization: target, trackedOrganizations: [...list] };
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
  settings: Pick<Settings, "homeOrganization" | "trackedOrganizations">,
  uuid: string,
): Pick<Settings, "trackedOrganizations"> | null {
  const home = settings.homeOrganization;
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
  settings: Pick<Settings, "homeOrganization" | "trackedOrganizations">,
  uuid: string,
): Pick<Settings, "trackedOrganizations"> | null {
  const home = settings.homeOrganization;
  if (home === null || uuid === home) return null;
  if (!settings.trackedOrganizations.includes(uuid)) return null;
  return {
    trackedOrganizations: settings.trackedOrganizations.filter((member) => member !== uuid),
  };
}

// The exclude confirmation's paragraphs: the Desktop client's dialog, and what
// `maxprice org exclude` prints before it asks. Excluding repairs this
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
