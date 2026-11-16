import {
  ACCOUNT_NOT_KNOWN,
  type AccountEntry,
  type AccountsResponse,
  type OrganizationsResponse,
  usageConnectionLabel,
} from "@maxprice/shared";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { accountShortId, shortId } from "../names";
import type { Style } from "./style";
import { type Column, NAME_MIN, type Output, renderTable } from "./table";

// `maxprice account list` (ADR-0140 §5), and how every `account` and `home`
// line names an Account and a Membership. Pure: the commands read the
// daemon.
//
//   Accounts
//   ┌──────────────────┬──────────┬───────────────────┬──────────┬─────────────────┬───────────────┬───────────────┐
//   │ Account          │ Id       │ Email             │ Tracking │ Connection      │ Current login │ Organizations │
//   ├──────────────────┼──────────┼───────────────────┼──────────┼─────────────────┼───────────────┼───────────────┤
//   │ Alex             │ 11111111 │ —                 │ Home     │ Connected       │ yes           │ 2, 2 tracked  │
//   │ Blair            │ 22222222 │ —                 │ Tracked  │ Session expired │ yes           │ 3, 2 tracked  │
//   │ Account fe9733fc │ pending  │ —                 │ Excluded │ Not connected   │               │ 1, 1 tracked  │
//   └──────────────────┴──────────┴───────────────────┴──────────┴─────────────────┴───────────────┴───────────────┘
//
// The rows are /api/accounts' in its order, the Home membership's Account
// first, as `org list` puts Home first.

// ADR-0140 §5: where Accounts come from, for a roster with none.
export const EMPTY_ACCOUNTS =
  "No Accounts yet. They appear once Claude Code has signed in on this machine " +
  "or 'maxprice key set' connects one.";

// An Account as every `account` line names it: its label and its Id, the
// exclude confirmation's title shape. Inert, since a label is the user's.
export function accountText(entry: Pick<AccountEntry, "label" | "accountUuid">): string {
  return `${terminalText(entry.label)} (${accountShortId(entry)})`;
}

// A Membership as `home` names it, `<Organization> · <Account>`, each by its
// label; an Organization the roster lacks by its short id, and an Account
// not known as every surface says it.
export function membershipText(
  organizationUuid: string,
  account: Pick<AccountEntry, "label"> | null,
  roster: OrganizationsResponse,
): string {
  const row = roster.organizations.find((entry) => entry.uuid === organizationUuid);
  const organization = row === undefined ? shortId(organizationUuid) : terminalText(row.label);
  return `${organization} · ${account === null ? ACCOUNT_NOT_KNOWN : terminalText(account.label)}`;
}

// The Organizations the roster tracks: Home and every row it calls tracked.
export function trackedOrganizations(roster: OrganizationsResponse): Set<string> {
  const tracked = new Set(roster.organizations.filter((e) => e.tracked).map((e) => e.uuid));
  if (roster.home !== null) tracked.add(roster.home);
  return tracked;
}

type Tracking = "Home" | "Tracked" | "Excluded";

type Row = {
  label: string;
  id: string;
  email: string;
  tracking: Tracking;
  connection: string;
  currentLogin: boolean;
  organizations: string;
};

function paintTracking(text: string, s: Style): string {
  if (text === "Home") return s.bold(text);
  if (text === "Excluded") return s.dim(text);
  return text;
}

// On a terminal too narrow for them all, Email drops first, then Current
// login, then Organizations; the label, the Id, the tracking and the
// connection always show.
const COLUMNS: readonly Column<Row>[] = [
  { header: "Account", text: (row) => row.label, min: NAME_MIN.account },
  { header: "Id", text: (row) => row.id },
  { header: "Email", text: (row) => row.email, drop: 1 },
  { header: "Tracking", text: (row) => row.tracking, paint: paintTracking },
  { header: "Connection", text: (row) => row.connection },
  { header: "Current login", text: (row) => (row.currentLogin ? "yes" : ""), drop: 2 },
  { header: "Organizations", text: (row) => row.organizations, drop: 3 },
];

// `3, 2 tracked`: the Organizations the Account is known in, and how many of
// them this machine tracks.
function organizationsText(entry: AccountEntry, tracked: ReadonlySet<string>): string {
  const all = new Set(entry.memberships.map((m) => m.organizationUuid));
  const count = [...all].filter((uuid) => tracked.has(uuid)).length;
  return `${all.size}, ${count} tracked`;
}

export function renderAccounts(
  accounts: AccountsResponse,
  roster: OrganizationsResponse,
  out: Output,
): string {
  if (accounts.accounts.length === 0) return `${EMPTY_ACCOUNTS}\n`;
  const tracked = trackedOrganizations(roster);
  const ordered = [
    ...accounts.accounts.filter((entry) => entry.home),
    ...accounts.accounts.filter((entry) => !entry.home),
  ];
  const rows = ordered.map(
    (entry): Row => ({
      label: entry.label,
      id: accountShortId(entry),
      email: entry.email ?? "—",
      tracking: entry.home ? "Home" : entry.tracked ? "Tracked" : "Excluded",
      connection: usageConnectionLabel(entry.connection),
      // GET /api/accounts reads each email live from a root's current login
      // file, and from nothing else (ADR-0136 §7), so an email read here is
      // a current login naming the Account.
      currentLogin: entry.email !== null,
      organizations: organizationsText(entry, tracked),
    }),
  );
  return renderTable({ title: "Accounts", columns: COLUMNS, rows }, out);
}
