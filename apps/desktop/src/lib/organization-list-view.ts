import {
  ALL_ORGANIZATIONS,
  checkOrganizationLabel,
  displayOrganizationLabels,
  formatWallClock,
  ORGANIZATION_LABEL_MAX,
  resolveOrganizationLabel,
  usageConnectionLabel,
  type HubConnection,
  type OrganizationEntry,
  type OrganizationLimits,
  type OrganizationsResponse,
  type Settings,
  type TimeDisplay,
  type UsageConnection,
} from "@maxprice/shared";
import { countSessions, type AssertionWrite } from "@/lib/assignment-writes";
import { assignedHereIds } from "@/lib/session-assignment";
import { OWNERLESS_PARAM } from "@/lib/session-selection";

// The Organizations list's view (Settings → Claude account), built from the
// roster and the key's connection. Pure, so the list's markup is testable
// without the query hooks.
//
// Past one Organization the list replaces the Home select. Every Organization
// the roster knows gets a row, tracked or not; no row carries a usage count of
// any kind (ADR-0098). What the list counts is sessions (#312): an Excluded
// row's facts name how many are claimed for it, since they show in no
// sessions list, and the line beneath the list counts those presumed under
// Home. Labels are the roster's, collision-suffixed across the whole roster so
// the list agrees with every other surface that names one; the upstream name
// never appears.

export const HOME_HINT =
  "Home is the default scope, and where usage with no recorded organization is counted.";
export const HOME_SWITCH_REASON = "Home is always tracked. Make another organization Home first.";
export const NO_HOME_SWITCH_REASON = "Every organization is counted until MaxPrice has a Home.";
// A choice ("Which"), since the list shows the Excluded organizations too.
export const ORGANIZATION_LIST_DESCRIPTION =
  "Which organizations MaxPrice counts on this machine, and the claude.ai session key for their real 5-hour and weekly limits.";

// Glass `.dot` variants.
export type LimitsTone = "good" | "warn" | "soft";
export interface LimitsPhrase {
  tone: LimitsTone;
  text: string;
}

export interface OrganizationRowView {
  uuid: string;
  // Rendered, collision-suffixed.
  label: string;
  // The roster's label, unsuffixed: what a rename edits.
  bareLabel: string;
  renamed: boolean;
  // What the label falls back to without a rename: the rename's placeholder.
  defaultLabel: string;
  tracked: boolean;
  isHome: boolean;
  tags: { home: boolean; currentLogin: boolean; isNew: boolean };
  reingesting: boolean;
  // The plan word a rename hides from the label, else null.
  planWord: string | null;
  limits: LimitsPhrase;
  canMakeHome: boolean;
  // Why the switch cannot act, as its title: Home's on the Home row, and the
  // no-Home reason on every row while the settings name no Home; else null.
  switchDisabledReason: string | null;
  // The switch acts: no disabled reason, and the settings have loaded.
  canToggleTracked: boolean;
  facts: {
    plan: string;
    limits: LimitsPhrase;
    // The last complete sample's clock: tracked Organizations answering
    // `windows` only.
    lastSample: string | null;
    seenOn: string;
    id: string;
  };
}

export interface OrganizationListInput {
  roster: OrganizationsResponse;
  // settings.homeOrganization ?? roster.home: the Home tag and the row order.
  home: string | null;
  // The persisted Home and list, which alone decide where `Make Home` has a
  // patch to write; null while the settings load.
  settings: Pick<Settings, "homeOrganization" | "trackedOrganizations"> | null;
  // The session key's connection (useLiveStatus).
  key: UsageConnection;
  // The roster's poll answers are the Hub's map, read with the Hub's key.
  hubSourced: boolean;
  // The previous Settings visit (ISO); null when none is recorded.
  lastOpenedAt: string | null;
  display: TimeDisplay;
}

export function showOrganizationList(roster: OrganizationsResponse | undefined): boolean {
  return roster !== undefined && roster.organizations.length >= 2;
}

// Home first, then the rest in roster order.
export function organizationListRows(input: OrganizationListInput): OrganizationRowView[] {
  const { roster, home, settings, key, hubSourced, lastOpenedAt, display } = input;
  const labels = displayOrganizationLabels(roster.organizations);
  const ordered = [
    ...roster.organizations.filter((entry) => entry.uuid === home),
    ...roster.organizations.filter((entry) => entry.uuid !== home),
  ];
  return ordered.map((entry): OrganizationRowView => {
    const isHome = entry.uuid === home;
    const limits = limitsPhrase(entry, key, hubSourced, display);
    // With no Home the sidecar resolves no tracked set and excludes nothing,
    // so no row's switch has a write to make (`trackPatch`/`excludePatch`).
    const switchDisabledReason =
      settings?.homeOrganization === null
        ? NO_HOME_SWITCH_REASON
        : isHome
          ? HOME_SWITCH_REASON
          : null;
    return {
      uuid: entry.uuid,
      label: labels.get(entry.uuid) ?? entry.label,
      bareLabel: entry.label,
      renamed: entry.renamed,
      defaultLabel:
        entry.plan ??
        resolveOrganizationLabel({
          uuid: entry.uuid,
          rename: null,
          organizationType: null,
          hints: null,
        }).label,
      tracked: entry.tracked,
      isHome,
      tags: {
        home: isHome,
        currentLogin: entry.currentLogin,
        isNew: isNewOrganization(entry, lastOpenedAt),
      },
      reingesting: entry.reingesting,
      planWord: entry.renamed ? entry.plan : null,
      limits,
      // Offered exactly where the button has a write to make.
      canMakeHome: settings !== null && makeHomePatch(settings, entry.uuid, entry.tracked) !== null,
      switchDisabledReason,
      canToggleTracked: settings !== null && switchDisabledReason === null,
      facts: {
        plan: entry.plan ?? "Unknown",
        limits,
        lastSample: lastSampleText(entry, display),
        seenOn: seenOnText(entry.seenOn),
        id: entry.uuid.slice(0, 8),
      },
    };
  });
}

// The key's state outranks the row's answer: with no key and no Hub nothing
// can be read, and an expired key needs re-pasting before anything is. A Hub
// polls with its own key, so its answers stand while this machine has none. An
// answer seeded by Connect is marked, since no poll has confirmed it — and it
// was read with this machine's pasted key, never the Hub's.
export function limitsPhrase(
  entry: OrganizationEntry,
  key: UsageConnection,
  hubSourced: boolean,
  display: TimeDisplay,
): LimitsPhrase {
  if (key === "disconnected" && !hubSourced) {
    return { tone: "soft", text: "Connect to read limits" };
  }
  if (key === "expired") return { tone: "warn", text: "Session key expired" };
  const { limits } = entry;
  if (limits === null) {
    return entry.seenOn.account
      ? { tone: "soft", text: "Connect to read limits" }
      : { tone: "soft", text: "Not on this account's list" };
  }
  const phrase = answerPhrase(limits, hubSourced, display);
  return limits.source === "connect" ? { ...phrase, text: `${phrase.text} (at connect)` } : phrase;
}

function answerPhrase(
  limits: OrganizationLimits,
  hubSourced: boolean,
  display: TimeDisplay,
): LimitsPhrase {
  switch (limits.answer) {
    case "windows":
      return limits.lastReadAt === null || Number.isNaN(Date.parse(limits.lastReadAt))
        ? { tone: "good", text: "Limits readable" }
        : { tone: "good", text: `Limits read ${formatWallClock(limits.lastReadAt, display)}` };
    case "none":
      return { tone: "good", text: "Answers · no limit window" };
    case "forbidden":
      return hubSourced && limits.source === "poll"
        ? { tone: "soft", text: "The Hub's key can't read its limits" }
        : { tone: "soft", text: "Limits not readable with this key" };
    case "error":
      return { tone: "warn", text: "Couldn't read limits · retrying" };
  }
}

// A sample time that does not parse is a fact nobody can read: no fact at all.
function lastSampleText(entry: OrganizationEntry, display: TimeDisplay): string | null {
  if (!entry.tracked || entry.limits?.answer !== "windows") return null;
  const at = entry.limits.lastSampleAt;
  if (at === null || Number.isNaN(Date.parse(at))) return null;
  return formatWallClock(at, display);
}

function seenOnText(seenOn: OrganizationEntry["seenOn"]): string {
  const places = [
    seenOn.machine ? "this machine" : null,
    seenOn.fleet ? "the fleet" : null,
    seenOn.account ? "your account" : null,
  ].filter((place) => place !== null);
  return places.length === 0 ? "—" : places.join(" · ");
}

// An untracked Organization first recorded after the previous Settings visit.
// No recorded visit, or no first-seen time, marks nothing new.
export function isNewOrganization(entry: OrganizationEntry, lastOpenedAt: string | null): boolean {
  return (
    !entry.tracked &&
    lastOpenedAt !== null &&
    entry.firstSeenAt !== null &&
    Date.parse(entry.firstSeenAt) > Date.parse(lastOpenedAt)
  );
}

// Connect's status line past one Organization: it describes the key, since
// each row carries its own answer and read time. Tracked Organizations
// answering `windows` or `none` are the ones read. A key `error` reads as
// connected while any of them is read: it includes one Organization's 403
// (#270), which is not the key failing, and the count carries the shortfall.
// With none read it is a connection error. The sidebar foot and the tray keep
// `usageConnectionLabel` for every state.
export interface KeyStatusLine {
  // The state the dot and the text colour follow (usage-status.ts).
  connection: UsageConnection;
  text: string;
  // The `when` suffix; null with an expired key or none.
  detail: string | null;
}

export function keyStatusLine(key: UsageConnection, roster: OrganizationsResponse): KeyStatusLine {
  switch (key) {
    case "expired":
      return { connection: "expired", text: "Session key expired", detail: null };
    case "disconnected":
      return { connection: "disconnected", text: "Not connected", detail: null };
    case "connected":
    case "error": {
      const tracked = roster.organizations.filter((entry) => entry.tracked);
      const read = tracked.filter(
        (entry) => entry.limits?.answer === "windows" || entry.limits?.answer === "none",
      );
      const detail = `— reading limits for ${read.length} of ${tracked.length} tracked`;
      return key === "error" && read.length === 0
        ? { connection: "error", text: usageConnectionLabel("error"), detail }
        : { connection: "connected", text: "Connected", detail };
    }
  }
}

// The settings write that makes `target` Home without changing the resolved
// tracked set (Home ∪ the list, as the sidecar resolves it): the target leaves
// the list and the old Home joins it, so the sidecar sees a Home change inside
// an unchanged set and nothing is re-walked. null when there is no Home yet,
// the target already is Home, or it is untracked (its becoming Home would
// widen the set). Tracked means both the row says so and the settings list
// names it: settings are the authority, and the roster's `tracked` can lag a
// settings write.
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
// the settings write chain (`update((current) => trackPatch(current, uuid))`),
// so it reads the list as the write before it left it.
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
// (always tracked, whatever the list says), or the list does not name it. A
// scope on `uuid` resets in the same write, since the writer resolves the
// scope against the new list (`parseSettings`). Built inside the write chain,
// like `trackPatch`.
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

// What the track and exclude confirmations say, from what tracking an
// Organization changes on this machine.
export interface TrackingFacts {
  // It has usage on this machine (`seenOn.machine`).
  local: boolean;
  // A hub is configured, connected or not.
  hub: boolean;
  // What its limits will be once tracked, when limits can be read now: with
  // this machine's key (a reading error is not the key failing), or by the
  // Hub. null when nothing can be read, or its answer says nothing either way.
  limits: "polled" | "unreadable" | "unlisted" | null;
}

export function trackingFacts(
  entry: OrganizationEntry,
  key: UsageConnection,
  hubConnection: HubConnection,
  hubSourced: boolean,
): TrackingFacts {
  const readable = hubSourced || key === "connected" || key === "error";
  return {
    local: entry.seenOn.machine,
    hub: hubConnection !== "off",
    limits: readable ? trackedLimits(entry) : null,
  };
}

function trackedLimits(entry: OrganizationEntry): TrackingFacts["limits"] {
  if (entry.limits === null) return entry.seenOn.account ? null : "unlisted";
  switch (entry.limits.answer) {
    case "windows":
    case "none":
      return "polled";
    case "forbidden":
      return "unreadable";
    case "error":
      return null;
  }
}

// The track confirmation's paragraphs. Neither limits sentence names a key:
// the Hub's may be the one reading.
export function trackCopy(facts: TrackingFacts): string[] {
  const copy = [
    facts.local
      ? "MaxPrice reads its history from the Claude Code session files still on this machine and counts it in every report. History whose session files are gone can't be counted."
      : "This machine has no usage for it yet. Any that appears is counted in every report.",
  ];
  if (facts.hub && facts.local) {
    copy.push(
      "Its usage here is also shared with your hub, where other machines that track it can see it.",
    );
  }
  switch (facts.limits) {
    case "polled":
      copy.push("Its limits are read once a minute.");
      break;
    case "unreadable":
      copy.push("Its limits can't be read, so its blocks are estimated.");
      break;
    case "unlisted":
      copy.push("It isn't on this account's list, so its blocks are estimated.");
      break;
    case null:
      break;
  }
  return copy;
}

// The exclude confirmation's paragraphs. Excluding repairs this machine's
// history alone (ADR-0098 §5): its sessions leave the hub and the Local
// archive, and only the session files can bring them back.
export function excludeCopy(facts: TrackingFacts): string[] {
  return [
    facts.hub
      ? "Its usage leaves every report on this machine, and this machine's sessions for it are removed from your hub. What other machines recorded for it stays on your hub."
      : "Its usage leaves every report on this machine.",
    "Claude Code session files aren't touched: tracking it again brings back whatever they still hold, and nothing else.",
  ];
}

export function trackTitle(row: Pick<OrganizationRowView, "label">): string {
  return `Track ${row.label}?`;
}

// The bare label, since the id follows: a collision suffix would print it twice.
export function excludeTitle(row: Pick<OrganizationRowView, "bareLabel" | "facts">): string {
  return `Exclude ${row.bareLabel} (${row.facts.id})?`;
}

// The exclude confirmation's typed token is the bare label: the collision
// suffix's middle dot is not typeable, and the title names the id. Trimmed,
// case-sensitive (`isForgetArmed`'s rule).
export function isExcludeArmed(typed: string, bareLabel: string): boolean {
  return typed.trim() === bareLabel;
}

export type RenameSubmission =
  | { kind: "noop" }
  // null clears the rename.
  | { kind: "put"; label: string | null }
  | { kind: "invalid"; error: string };

// What saving the rename draft does. The sidecar also refuses a label another
// Organization already uses (case-insensitively); that refusal arrives from
// the PUT.
export function renameSubmission(
  draft: string,
  row: Pick<OrganizationRowView, "bareLabel" | "renamed">,
): RenameSubmission {
  const trimmed = draft.trim();
  if (trimmed === "") return row.renamed ? { kind: "put", label: null } : { kind: "noop" };
  if (row.renamed && trimmed === row.bareLabel) return { kind: "noop" };
  const check = checkOrganizationLabel(trimmed);
  if (!check.ok) {
    return { kind: "invalid", error: `Use ${ORGANIZATION_LABEL_MAX} characters or fewer.` };
  }
  return { kind: "put", label: check.label };
}

// A rename refusal as the inline error shows it: the sidecar's refusals are
// lowercase fragments ("another organization already uses that label"), so
// the first letter is capitalized and a closing period added.
export function refusalSentence(message: string): string {
  const text = message.trim();
  if (text === "") return text;
  const capitalized = text[0]!.toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

// --- #312: the presumption line, Review and Return them ------------------------

// Settings' line above the Home hint: how many sessions' owner-less usage
// counts under Home by presumption, before its Review link. `presumed` is the
// presumed sessions of the Home-scoped, all-time sessions query (#312 ruling
// 4), null while it is not asked (one tracked Organization) or has not
// answered. Null hides the line: no count, a count of 0, or no Home row to
// name — `homeLabel` is that row's collision-suffixed label.
export function presumptionLine(
  presumed: number | null,
  homeLabel: string | undefined,
): string | null {
  if (presumed === null || presumed <= 0 || homeLabel === undefined) return null;
  return `${countSessions(presumed)} counted under ${homeLabel} by presumption`;
}

// Where Review lands: the Sessions page's owner-less view (#312 ruling 8).
export const PRESUMPTION_REVIEW_PATH = `/sessions?${OWNERLESS_PARAM}=1`;

// The settings write Review makes before it goes: the count is Home's, so a
// scope on one other Organization — which would hide every session it counts —
// goes back to Home. Home already shows them and All shows them beside the
// rest, so either stays. Built inside the settings write chain
// (`update((current) => reviewScopePatch(current.organizationScope,
// current.homeOrganization))`), like `trackPatch`.
export function reviewScopePatch(
  scope: string | null,
  home: string | null,
): { organizationScope: null } | null {
  if (scope === null || scope === ALL_ORGANIZATIONS || scope === home) return null;
  return { organizationScope: null };
}

// The sessions an Excluded Organization's facts count as assigned here: the
// assertion map's claims for it (#312 ruling 2). A session claimed for an
// Excluded Organization is dormant and shows in no sessions list, so the map
// is the only place it can be seen and returned (ruling 7). A tracked row has
// none: its assigned sessions show in every sessions list.
export function excludedClaims(
  row: Pick<OrganizationRowView, "uuid" | "tracked">,
  assertions: Readonly<Record<string, string>>,
): string[] {
  return row.tracked ? [] : assignedHereIds(assertions, row.uuid);
}

export function assignedHereText(n: number): string {
  return `${countSessions(n)} assigned here`;
}

// Return them: clear an Excluded Organization's claims, so the sessions count
// wherever their owner-less usage is presumed again; Undo claims them for it
// once more. Run through `runAssertionWrite`, so its toasts are the Sessions
// page's (`Restored N sessions` from Undo, `‹failure›: ‹error›` on a failure).
// The message names no Organization: a returned session is presumed under its
// producer's published Home, which for a peer's session is not this one.
export function returnWrite(sessionIds: string[], uuid: string): AssertionWrite {
  return {
    sessionIds,
    organizationUuid: null,
    undo: [{ organizationUuid: uuid, sessionIds }],
    message: `Returned ${countSessions(sessionIds.length)}`,
    failure: "Couldn't return sessions",
  };
}

export function navigateToPresumptionReview(
  scopeWrite: Promise<void>,
  navigate: (path: string) => void,
): Promise<void> {
  // The settings writer reports failures; only its success may open Review.
  return scopeWrite.then(() => navigate(PRESUMPTION_REVIEW_PATH)).catch(() => {});
}
