import { deriveProjectName, type OrganizationEntry, type SessionRow } from "@maxprice/shared";
import {
  organizationLabel,
  organizationLabelMap,
  sessionOrganizationLabel,
} from "@/lib/organization-scope-view";

// The Sessions page's Organization assignment (#312), as pure view logic: how
// an owner-less session reads, how the review list groups it, what a selection
// sums to, how a write is undone, and what the chooser offers. No React, so
// every rule is testable on plain rows.
//
// Everything reads the ROWS (#312 ruling 2): `organizationResolution` says how
// a session's owner-less usage is attributed, and `organizationSplit` names a
// partly owned session's two halves (ruling 1). Nothing compares Organizations
// to infer a split: a peer's session presumed under its own published Home
// names another Organization than this Home, and is wholly owner-less all the
// same. Only a session's owner-less rows ever move (ADR-0107).

export type OwnerlessKind = "presumed" | "assigned";

// A session with owner-less usage — presumed or assigned. Only these are
// selectable: an assertion on a wholly owned session would apply to nothing.
export function isOwnerless(row: SessionRow): boolean {
  return row.organizationResolution === "presumed" || row.organizationResolution === "assigned";
}

// Where a session's owner-less usage counts now: the split's owner-less half,
// else the row's (latest event's) Organization. Meaningful for an owner-less
// row; absent when the row resolves to no Organization.
export function ownerlessTarget(row: SessionRow): string | undefined {
  return row.organizationSplit?.ownerless ?? row.organizationUuid;
}

// Partly owned: some of its usage carries an Owner record, so only the rest
// moves. Read off the split, never inferred.
export function isPartlyOwned(row: SessionRow): boolean {
  return row.organizationSplit !== undefined;
}

// The claim a session held before a write, for its Undo (#312 ruling 6): an
// assigned session's owner-less target, else none — a presumed session held no
// claim, so undoing a write to it clears.
export function previousAssertion(row: SessionRow): string | null {
  return row.organizationResolution === "assigned" ? (ownerlessTarget(row) ?? null) : null;
}

// The label of an owner-less target, collision-suffixed through the roster's
// map; the em dash of the Organization cells for a row that names none.
function targetLabel(labels: ReadonlyMap<string, string>, uuid: string | undefined): string {
  return sessionOrganizationLabel(uuid, labels) ?? "—";
}

// --- the tag -----------------------------------------------------------------

export interface SessionTag {
  kind: OwnerlessKind;
  // The owner-less target's label.
  label: string;
  // The tooltip.
  title: string;
  // Partly owned: the tag reads `… · part`.
  part: boolean;
  // The owned half's label, present exactly when `part`.
  ownedLabel?: string;
}

// The `presumed` / `assigned` pill of an owner-less session; none for a session
// whose usage all carries Owner records, or that resolves to no Organization.
export function sessionTag(
  row: SessionRow,
  labels: ReadonlyMap<string, string>,
): SessionTag | null {
  const kind = row.organizationResolution;
  if (kind !== "presumed" && kind !== "assigned") return null;
  const label = targetLabel(labels, ownerlessTarget(row));
  const title =
    kind === "presumed"
      ? `No Owner record: counted under ${label} by presumption`
      : `Assigned to ${label}`;
  const split = row.organizationSplit;
  if (split === undefined) return { kind, label, title, part: false };
  const ownedLabel = organizationLabel(labels, split.owned);
  return {
    kind,
    label,
    title: `${title}. Only its owner-less part — the rest has an Owner record for ${ownedLabel}.`,
    part: true,
    ownedLabel,
  };
}

// --- the All-scope Organization cell -----------------------------------------

export interface OrganizationCellLabels {
  // The line the cell leads with, which is also what the column sorts and
  // searches by: a partly owned session's owned half, else the row's
  // Organization; null for none (the em dash).
  label: string | null;
  // A partly owned session's owner-less half, read beneath.
  ownerlessLabel?: string;
}

// The Sessions table's Organization cell under All organizations. A partly
// owned session leads with the Organization its Owner records name, never the
// row's own (its latest event's, which may be the owner-less half).
export function organizationCellLabels(
  row: SessionRow,
  labels: ReadonlyMap<string, string>,
): OrganizationCellLabels {
  const split = row.organizationSplit;
  if (split === undefined) return { label: sessionOrganizationLabel(row.organizationUuid, labels) };
  return {
    label: organizationLabel(labels, split.owned),
    ownerlessLabel: organizationLabel(labels, split.ownerless),
  };
}

// --- the review list ---------------------------------------------------------

export interface GroupSummary {
  kind: OwnerlessKind | "mixed";
  // The shared target's label; absent when `mixed`.
  label?: string;
}

export interface OwnerlessGroup {
  key: string;
  // The folded project name (ADR-0061).
  name: string;
  // The shown sessions, last activity descending.
  sessions: SessionRow[];
  // Their total cost.
  cost: number;
  summary: GroupSummary;
}

export interface GroupOwnerlessOptions {
  search: string;
  // The page's folded project name for a session (Sessions.tsx), so a group
  // is exactly what the table's Project column reads.
  projectName: (row: SessionRow) => string;
  labels: ReadonlyMap<string, string>;
  // The strings a session's search matches against. The page may pass its
  // table's own `searchKeys` so the list finds what the table finds; the
  // default is the table's static keys — id, path, project and directory
  // names, models.
  searchKeys?: (row: SessionRow) => readonly string[];
}

// The owner-less review list: owner-less sessions grouped by folded project
// name, groups by cost descending (then name), sessions by last activity
// descending. A search is the table's (DataTable): trimmed, case-insensitive,
// a substring of any key. A group whose name matches keeps all its sessions;
// otherwise only its matching sessions show, and a group with none is dropped.
// Cost and summary describe the shown sessions only — what "Select all N
// shown" and the group checkbox act on (Review Focus 5).
export function groupOwnerless(
  rows: readonly SessionRow[],
  { search, projectName, labels, searchKeys }: GroupOwnerlessOptions,
): OwnerlessGroup[] {
  const needle = search.trim().toLowerCase();
  const keysOf =
    searchKeys ??
    ((row: SessionRow) => [
      row.sessionId,
      row.path,
      projectName(row),
      deriveProjectName(row.path),
      ...row.modelsUsed,
    ]);
  const matches = (text: string): boolean => text.toLowerCase().includes(needle);

  const byName = new Map<string, SessionRow[]>();
  for (const row of rows) {
    if (!isOwnerless(row)) continue;
    const name = projectName(row);
    const members = byName.get(name);
    if (members === undefined) byName.set(name, [row]);
    else members.push(row);
  }

  const groups: OwnerlessGroup[] = [];
  for (const [name, members] of byName) {
    const shown =
      needle === "" || matches(name) ? members : members.filter((row) => keysOf(row).some(matches));
    if (shown.length === 0) continue;
    const sessions = [...shown].sort(
      (a, b) => (Date.parse(b.lastActivity) || 0) - (Date.parse(a.lastActivity) || 0),
    );
    groups.push({
      key: name,
      name,
      sessions,
      cost: sessions.reduce((total, row) => total + row.totalCost, 0),
      summary: groupSummary(sessions, labels),
    });
  }
  return groups.sort((a, b) => b.cost - a.cost || compareStrings(a.name, b.name));
}

// One kind and one target across the group, else `mixed` — presumed beside
// assigned (even to the same Organization), two targets, or presumed under this
// Home beside a peer's.
function groupSummary(
  sessions: readonly SessionRow[],
  labels: ReadonlyMap<string, string>,
): GroupSummary {
  const [first] = sessions;
  const kind = first?.organizationResolution;
  if (first === undefined || (kind !== "presumed" && kind !== "assigned")) return { kind: "mixed" };
  const target = ownerlessTarget(first);
  const shared = sessions.every(
    (row) => row.organizationResolution === kind && ownerlessTarget(row) === target,
  );
  return shared ? { kind, label: targetLabel(labels, target) } : { kind: "mixed" };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- the selection bar -------------------------------------------------------

export interface SelectionSummary {
  count: number;
  cost: number;
  presumed: number;
  assigned: number;
  partlyOwned: number;
  // Distinct folded project names, first-seen order.
  projects: string[];
  // The chooser's checked Organization: the assertion every selected session
  // holds, only when all of them are assigned to that one uuid. Null for any
  // presumed session in the selection, differing targets, or no selection —
  // picking Home for a presumed session is a real write that pins it there,
  // so a checked Home would misread as a no-op (the prototype's rule).
  sharedTarget: string | null;
  anyAssigned: boolean;
}

export function selectionSummary(
  selected: readonly SessionRow[],
  projectName: (row: SessionRow) => string,
): SelectionSummary {
  let cost = 0;
  let presumed = 0;
  let assigned = 0;
  let partlyOwned = 0;
  const projects = new Set<string>();
  const targets = new Set<string | undefined>();
  for (const row of selected) {
    cost += row.totalCost;
    if (row.organizationResolution === "presumed") presumed += 1;
    if (row.organizationResolution === "assigned") assigned += 1;
    if (isPartlyOwned(row)) partlyOwned += 1;
    projects.add(projectName(row));
    targets.add(ownerlessTarget(row));
  }
  const [only] = targets;
  return {
    count: selected.length,
    cost,
    presumed,
    assigned,
    partlyOwned,
    projects: [...projects],
    sharedTarget: assigned === selected.length && targets.size === 1 ? (only ?? null) : null,
    anyAssigned: assigned > 0,
  };
}

// --- Undo --------------------------------------------------------------------

export interface UndoGroup {
  organizationUuid: string | null;
  sessionIds: string[];
}

// The writes that restore `rows` — read before the write — to their previous
// claims (#312 ruling 6): one PUT per previous assertion, cleared (null) first,
// then by uuid ascending. A mixed selection restores each session to its own
// claim (Review Focus 4).
export function undoPlan(rows: readonly SessionRow[]): UndoGroup[] {
  const byTarget = new Map<string | null, string[]>();
  for (const row of rows) {
    const previous = previousAssertion(row);
    const ids = byTarget.get(previous);
    if (ids === undefined) byTarget.set(previous, [row.sessionId]);
    else ids.push(row.sessionId);
  }
  return [...byTarget]
    .map(([organizationUuid, sessionIds]) => ({ organizationUuid, sessionIds }))
    .sort((a, b) =>
      a.organizationUuid === null
        ? -1
        : b.organizationUuid === null
          ? 1
          : compareStrings(a.organizationUuid, b.organizationUuid),
    );
}

// --- the chooser -------------------------------------------------------------

export interface ChooserOption {
  uuid: string;
  label: string;
  tracked: boolean;
  isHome: boolean;
}

// What `Assign to…` offers: Home first, then the other tracked Organizations,
// then the Excluded ones, each in roster order. Labels are collision-suffixed
// across the whole roster, as every surface naming an Organization reads them.
export function chooserOptions(
  roster: ReadonlyArray<Pick<OrganizationEntry, "uuid" | "label" | "tracked">>,
  home: string | null,
): ChooserOption[] {
  const labels = organizationLabelMap(roster);
  const options = roster.map(({ uuid, tracked }) => ({
    uuid,
    label: organizationLabel(labels, uuid),
    tracked,
    isHome: uuid === home,
  }));
  return [
    ...options.filter((o) => o.isHome),
    ...options.filter((o) => !o.isHome && o.tracked),
    ...options.filter((o) => !o.isHome && !o.tracked),
  ];
}

// --- Settings' counts ----------------------------------------------------------

// The presumed sessions among `rows`. Settings hands it the Home-scoped,
// all-time sessions query (#312 ruling 4), where a peer's sessions presumed
// under its own published Home never appear; it counts what it is handed.
export function presumptionCount(rows: readonly SessionRow[]): number {
  return rows.reduce((n, row) => (row.organizationResolution === "presumed" ? n + 1 : n), 0);
}

// The sessions an assertion map (GET /api/organization-assertions) claims for
// one Organization — Settings' `N sessions assigned here`, and the ids Return
// them clears.
export function assignedHereIds(
  assertions: Readonly<Record<string, string>>,
  uuid: string,
): string[] {
  return Object.keys(assertions).filter((sessionId) => assertions[sessionId] === uuid);
}

// --- the review list's checkboxes ------------------------------------------------

// The selection is a set of sessionIds (the PUT's key). Every helper below
// hands back a new set, never mutating the one it is given, so a state setter
// sees the change.

export type CheckState = "off" | "some" | "on";

// How a checkbox over `ids` reads: none, some or all of them selected. A
// group's ids are its SHOWN sessions, which are all selectable (the list holds
// owner-less sessions only), so a search narrows what the tri-state reflects
// (Review Focus 5). No ids reads off, never vacuously on.
export function checkState(ids: readonly string[], selected: ReadonlySet<string>): CheckState {
  let on = 0;
  for (const id of ids) if (selected.has(id)) on += 1;
  return on === 0 ? "off" : on === ids.length ? "on" : "some";
}

// A checkbox click over `ids` — one session's, or a group's shown sessions:
// all of them selected deselects them, else selects them all. The rest of the
// selection is untouched.
export function toggleSessions(
  selected: ReadonlySet<string>,
  ids: readonly string[],
): ReadonlySet<string> {
  const next = new Set(selected);
  if (checkState(ids, selected) === "on") for (const id of ids) next.delete(id);
  else for (const id of ids) next.add(id);
  return next;
}

// The sessions the review list shows, in list order: what "Select all N shown"
// counts and makes the selection (Review Focus 5).
export function shownSessionIds(groups: readonly OwnerlessGroup[]): string[] {
  return groups.flatMap((group) => group.sessions.map((row) => row.sessionId));
}

// --- the selection after a write -----------------------------------------------

// The selection, keyed by sessionId, narrowed to sessions still in `rows` and
// still owner-less — a write can move a session out of the current scope, or a
// refresh can find nothing owner-less left in it (Review Focus 2). Hands back
// the same set when nothing is dropped, so a state setter can bail out.
export function pruneSelection(
  selectedIds: ReadonlySet<string>,
  rows: readonly SessionRow[],
): ReadonlySet<string> {
  const selectable = new Set<string>();
  for (const row of rows) if (isOwnerless(row)) selectable.add(row.sessionId);
  const kept = new Set<string>();
  for (const id of selectedIds) if (selectable.has(id)) kept.add(id);
  return kept.size === selectedIds.size ? selectedIds : kept;
}
