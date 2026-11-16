import {
  deriveProjectName,
  sessionProjectName,
  type ProjectGroup,
  type ProjectRow,
  type SessionRow,
} from "@maxprice/shared";
import { matchAccount, type MenuAccount } from "./account-menu";
import { isUnattributed } from "./session-assignment";
import { SETTINGS_SECTIONS, settingsSectionId, type SettingsSectionKey } from "./settings-sections";

// The ⌘K finder (#620 item 3, #640), as pure data: what a query matches, how
// the results group and order, and which one Enter takes. `finder.tsx` renders
// it and carries out each result's action.
//
// The haystack is the sessions and projects of the rail's Date range (#665:
// "Follow the rail") under every tracked Membership, never narrowed by
// the rail's Project, Model or Machine filters or the Account filter
// (`finder.tsx`'s query): a finder that could only find what those filters
// already show would miss the one thing it is for. Following the range keeps
// a picked project on the Projects page it opens.

export const SESSION_CAP = 8;
export const PROJECT_CAP = 5;
// The query that lists the sessions whose Account can't be determined, and
// the tag they carry: "Unknown" (#665), as all such usage is labelled.
export const UNKNOWN_QUERY = "unknown";
export const UNKNOWN_TAG = "Unknown";

// --- The hotkey --------------------------------------------------------------

// ⌘K on macOS, Ctrl+K elsewhere: the palette convention, so it fires from
// inside a text field too (unlike ⇧R, `manual-refresh-hotkey.ts`). Any other
// modifier, or the other platform's, is left alone: Ctrl+K on macOS is the
// text fields' kill-line.
export function isFinderHotkey(e: KeyboardEvent, mac: boolean): boolean {
  if (e.key.toLowerCase() !== "k") return false;
  if (e.altKey || e.shiftKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

// The chord as the trigger shows it, and as its accessible name spells it.
export function finderShortcut(mac: boolean): { kbd: string; aria: string } {
  return mac ? { kbd: "⌘K", aria: "⌘K" } : { kbd: "Ctrl K", aria: "Ctrl+K" };
}

// --- Unknown -----------------------------------------------------------------

// A session with no Attribution evidence and no Membership assertion: it
// counts under its Presumed membership, and its Account can't be determined.
// The rule Settings › Unattributed usage lists by (`isUnattributed`): an
// `assigned` session has been attributed by hand.
export function isUnknown(row: Pick<SessionRow, "organizationResolution">): boolean {
  return isUnattributed(row);
}

// --- Settings ----------------------------------------------------------------

export interface FinderSetting {
  label: string;
  // The route it opens, and the section anchor to scroll to there.
  to: string;
  section: string;
  // Further words it answers to, beyond its label.
  keywords: readonly string[];
}

// Where Settings' sections render: the five that hide on some platforms or
// states (`Settings.tsx`).
export interface SettingsAvailability {
  background: boolean;
  autostart: boolean;
  mac: boolean;
  // Unattributed usage: past one Membership to assign to
  // (`useUnattributedShown`, #639).
  unattributed: boolean;
  // Home membership: past one Account (`accountsView`'s `home`, #621).
  homeMembership: boolean;
}

// The ⌘K words a section answers to beyond its title.
const SECTION_KEYWORDS: Partial<Record<SettingsSectionKey, readonly string[]>> = {
  diskUsage: ["storage"],
  cleanUp: ["storage"],
  // Settings › Accounts (#639) took Claude account's words: the key and the
  // Organizations live on the Claude section's cards, Home on its select.
  homeMembership: ["home", "account", "organization"],
  claude: ["account", "organization", "session key", "connect", "reconnect", "label"],
  gateways: ["cliproxyapi", "management key"],
  // The Owner-less review's words before #639, and the Unknown tag's query.
  unattributedUsage: [UNKNOWN_QUERY, "owner-less", "assign"],
  appInfo: ["version", "user guide"],
};

// Whether a section renders here: the five `Settings.tsx` hides on some
// platforms or states. Every other section always renders.
function sectionShown(key: SettingsSectionKey, at: SettingsAvailability): boolean {
  if (key === "background") return at.background;
  if (key === "autostart") return at.autostart;
  if (key === "transparency") return at.mac;
  if (key === "unattributedUsage") return at.unattributed;
  if (key === "homeMembership") return at.homeMembership;
  return true;
}

// Today's Settings sections in page order (`SETTINGS_SECTIONS`), under the
// titles they render with, less the ones that do not render here.
export function finderSettings(at: SettingsAvailability): FinderSetting[] {
  return (Object.keys(SETTINGS_SECTIONS) as SettingsSectionKey[])
    .filter((key) => sectionShown(key, at))
    .map((key): FinderSetting => {
      const title = SETTINGS_SECTIONS[key];
      return {
        label: `Settings › ${title}`,
        to: "/settings",
        section: settingsSectionId(title),
        keywords: SECTION_KEYWORDS[key] ?? [],
      };
    });
}

// --- Matching ----------------------------------------------------------------

export type FinderHit =
  | { kind: "session"; key: string; row: SessionRow; project: string; unknown: boolean }
  | { kind: "project"; key: string; row: ProjectRow; name: string }
  | { kind: "account"; key: string; account: MenuAccount }
  | { kind: "setting"; key: string; setting: FinderSetting };

export type FinderKind = FinderHit["kind"];

export interface FinderGroup {
  kind: FinderKind;
  title: string;
  hits: FinderHit[];
}

const GROUP_TITLES: Record<FinderKind, string> = {
  session: "Sessions",
  project: "Projects",
  account: "Accounts",
  setting: "Settings",
};

export interface FinderInput {
  query: string;
  sessions: readonly SessionRow[];
  // The folded project groups (`foldProjectRows` through the project axis's
  // index), which also name each session's project.
  projects: readonly ProjectGroup[];
  // The Account menu's tracked Accounts; null while the Account filter is
  // hidden, where there is no Account filter to set.
  accounts: readonly MenuAccount[] | null;
  settings: readonly FinderSetting[];
  // Past one tracked Organization (`useScope().multi`). Below it every
  // session counts under the one Organization there is, so the Unknown
  // tag and query would only say "no Owner record", which nothing there acts
  // on; the session pages' `presumed` pills follow the same gate.
  multi: boolean;
}

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

// Each folded group's name under every member slug, worktrees included: the
// project a session's own slug belongs to.
export function projectNamesBySlug(groups: readonly ProjectGroup[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of groups) {
    const name = deriveProjectName(g.row.path);
    out.set(g.row.slug, name);
    for (const m of g.members) out.set(m.slug, name);
  }
  return out;
}

const byCostDesc =
  <T>(cost: (x: T) => number, tie: (x: T) => string) =>
  (a: T, b: T) =>
    cost(b) - cost(a) || (tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0);

// The results for a query, grouped Sessions, Projects, Accounts, Settings,
// empty groups dropped. An empty query matches nothing (the finder shows its
// hint instead).
export function finderResults(input: FinderInput): FinderGroup[] {
  const q = normalizeQuery(input.query);
  if (q === "") return [];
  const names = projectNamesBySlug(input.projects);

  const listUnknown = input.multi && q === UNKNOWN_QUERY;
  const sessions: FinderHit[] = input.sessions
    .map((row) => {
      const own = sessionProjectName(row);
      const project = names.get(row.projectPath) ?? own;
      const unknown = input.multi && isUnknown(row);
      const matches = listUnknown
        ? unknown
        : row.sessionId.toLowerCase().startsWith(q) ||
          project.toLowerCase().includes(q) ||
          own.toLowerCase().includes(q) ||
          row.modelsUsed.some((m) => m.toLowerCase().includes(q));
      return matches ? { row, project, unknown } : null;
    })
    .filter((x) => x !== null)
    .sort(
      byCostDesc(
        (x) => x.row.totalCost,
        (x) => x.row.sessionId,
      ),
    )
    .slice(0, SESSION_CAP)
    .map((x) => ({ kind: "session", key: `session:${x.row.sessionId}`, ...x }));

  const projects: FinderHit[] = input.projects
    .map((g) => ({ row: g.row, name: deriveProjectName(g.row.path) }))
    .filter((p) => p.name.toLowerCase().includes(q) || p.row.path.toLowerCase().includes(q))
    .sort(
      byCostDesc(
        (p) => p.row.costRange,
        (p) => p.row.slug,
      ),
    )
    .slice(0, PROJECT_CAP)
    .map((p) => ({ kind: "project", key: `project:${p.row.slug}`, ...p }));

  // An Account with no Membership listed has nothing to filter to.
  const accounts: FinderHit[] = (input.accounts ?? [])
    .filter((a) => a.memberships.length > 0 && matchAccount(a, q).matches)
    .map((account) => ({ kind: "account", key: `account:${account.key}`, account }));

  const settings: FinderHit[] = input.settings
    .filter((s) => s.label.toLowerCase().includes(q) || s.keywords.some((k) => k.includes(q)))
    .map((setting) => ({ kind: "setting", key: `setting:${setting.label}`, setting }));

  const groups: Array<[FinderKind, FinderHit[]]> = [
    ["session", sessions],
    ["project", projects],
    ["account", accounts],
    ["setting", settings],
  ];
  return groups
    .filter(([, hits]) => hits.length > 0)
    .map(([kind, hits]) => ({ kind, title: GROUP_TITLES[kind], hits }));
}

// The results in the order shown: what the arrows step through.
export function flatHits(groups: readonly FinderGroup[]): FinderHit[] {
  return groups.flatMap((g) => g.hits);
}

// What Enter takes: the active result, else the first shown.
export function enterTarget(hits: readonly FinderHit[], active: number): FinderHit | null {
  return hits[active] ?? hits[0] ?? null;
}

// A session the finder opens may sit outside the rail's Scope, Model and
// Machine filters, since the finder ignores them; filtered, its page would
// read "no recorded usage events" (#640 Sol S1). So the finder opens it with
// this param, and the session page then reads every tracked Membership with
// no Model or Machine filter. In the URL, so a reload keeps it.
export const UNFILTERED_PARAM = "unfiltered";

export function finderSessionPath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}?${UNFILTERED_PARAM}=1`;
}

export function isUnfilteredSession(params: URLSearchParams): boolean {
  return params.get(UNFILTERED_PARAM) === "1";
}
