import {
  displayOrganizationLabels,
  homeFirst,
  type OrganizationEntry,
  type OrganizationsResponse,
  seenOnText,
} from "@maxprice/shared";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { shortId } from "../names";
import type { Style } from "./style";
import { type Column, NAME_MIN, type Output, renderTable } from "./table";

// `maxprice org list` as #445's Variant A table (ADR-0122 §6), and how every
// `org` line names an Organization. Pure: the command reads the roster.
//
//   Organizations
//   ┌──────────────┬──────────┬──────────┬───────────────┬──────────────┬────────────┐
//   │ Organization │ Id       │ Tracking │ Current login │ Seen on      │ Re-walking │
//   ├──────────────┼──────────┼──────────┼───────────────┼──────────────┼────────────┤
//   │ Personal     │ 3f2a91c0 │ Home     │ yes           │ this machine │            │
//   │ Team         │ bbbbbbbb │ Tracked  │               │ the fleet    │ yes        │
//   └──────────────┴──────────┴──────────┴───────────────┴──────────────┴────────────┘
//
// The rows are the Desktop client's Organizations list's: Home first, then
// the roster's order, each under its collision-suffixed label. Home is the
// roster's, the daemon's own: the persisted setting, else its seed.

// ADR-0122 §6: where Organizations come from, for a roster with none.
export const EMPTY_ROSTER =
  "No Organizations yet. They appear once Claude Code has run on this machine, " +
  "'maxprice key set' lists the ones its key can read, or a Hub is joined.";

// An Organization as every `org` line names it: the bare label and the short
// id, the exclude confirmation's title shape (`excludeTitle`). The bare
// label, since the id follows: a collision suffix would name the id twice.
// Inert, since a label is the user's.
export function organizationName(entry: Pick<OrganizationEntry, "uuid" | "label">): string {
  return `${terminalText(entry.label)} (${shortId(entry.uuid)})`;
}

type Tracking = "Home" | "Tracked" | "Excluded";

type Row = {
  label: string;
  id: string;
  tracking: Tracking;
  currentLogin: boolean;
  seenOn: string;
  reingesting: boolean;
};

function paintTracking(text: string, s: Style): string {
  if (text === "Home") return s.bold(text);
  if (text === "Excluded") return s.dim(text);
  return text;
}

// On a terminal too narrow for them all, Seen on drops first, then Current
// login; the label, the id, the tracking and a re-walk always show.
const COLUMNS: readonly Column<Row>[] = [
  { header: "Organization", text: (row) => row.label, min: NAME_MIN.organization },
  { header: "Id", text: (row) => row.id },
  { header: "Tracking", text: (row) => row.tracking, paint: paintTracking },
  { header: "Current login", text: (row) => (row.currentLogin ? "yes" : ""), drop: 2 },
  { header: "Seen on", text: (row) => row.seenOn, drop: 1 },
  {
    header: "Re-walking",
    text: (row) => (row.reingesting ? "yes" : ""),
    paint: (text, s) => (text === "" ? text : s.yellow(text)),
  },
];

export function renderOrganizations(roster: OrganizationsResponse, out: Output): string {
  if (roster.organizations.length === 0) return `${EMPTY_ROSTER}\n`;
  const labels = displayOrganizationLabels(roster.organizations);
  const rows = homeFirst(roster.organizations, roster.home).map(
    (entry): Row => ({
      label: labels.get(entry.uuid) ?? entry.label,
      id: shortId(entry.uuid),
      tracking: entry.uuid === roster.home ? "Home" : entry.tracked ? "Tracked" : "Excluded",
      currentLogin: entry.currentLogin,
      seenOn: seenOnText(entry.seenOn),
      reingesting: entry.reingesting,
    }),
  );
  return renderTable({ title: "Organizations", columns: COLUMNS, rows }, out);
}
