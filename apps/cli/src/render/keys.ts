import {
  type AccountEntry,
  accountLabel,
  formatRelativeTime,
  type HubKeyState,
  type OrganizationsResponse,
  type UsageConnection,
  usageConnectionLabel,
  type UsageHubKeysResponse,
  type UsageKeysResponse,
} from "@maxprice/shared";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import type { Secrets } from "../secrets";
import { shortId } from "../names";
import { membershipText, trackedOrganizations } from "./accounts";
import { type Column, NAME_MIN, type Output, renderTable } from "./table";

// `maxprice key list` and `key set`'s Connect lines (ADR-0140 §6, §7). Pure:
// the command reads secrets.json and the daemon. Nothing here ever holds a
// key: a row is built from an entry's Account and `setAt` alone.
//
//   Session keys
//   ┌──────────────────┬──────────┬─────────────────┬───────────────────────┬──────────────┐
//   │ Account          │ Id       │ Connection      │ Set at                │ At Hub       │
//   ├──────────────────┼──────────┼─────────────────┼───────────────────────┼──────────────┤
//   │ Alex             │ 11111111 │ Connected       │ 2026-10-20 (just now) │ no key       │
//   │ Blair            │ 22222222 │ Session expired │ 2026-10-01 (19d ago)  │ not read yet │
//   │ Unfiled key      │ —        │ Connected       │ 2026-10-01 (19d ago)  │ —            │
//   └──────────────────┴──────────┴─────────────────┴───────────────────────┴──────────────┘
//
// At Hub shows only while the client is joined to a Hub.

export const NO_KEYS = "No session keys stored. 'maxprice key set' connects an Account.";

// The unfiled legacy key's row (ADR-0138 §12, ADR-0140 §6).
export const UNFILED_LABEL = "Unfiled key";

// What the joined Hub holds for a row's Account: the Hub's own state, or
// `unknown` while the client holds no status from it yet.
export type AtHub = HubKeyState | "unknown";

const AT_HUB_WORDS: Record<AtHub, string> = {
  connected: "connected",
  expired: "expired",
  error: "error",
  pending: "not read yet",
  none: "no key",
  unknown: "unknown",
};

export type KeyRow = {
  // The Account's uuid, or null for the unfiled key.
  account: string | null;
  label: string;
  // The key's connection as the daemon holds it; null when it holds no such
  // key (the file changed since the daemon last read it).
  connection: UsageConnection | null;
  setAt: string;
  // null while no Hub is joined, and for the unfiled key, whose Account is
  // not known.
  atHub: AtHub | null;
};

// `key list --json`'s object (ADR-0140 §6): whether a Hub is joined, then
// each row as the table shows it, in its order, the raw states in place of
// their words.
export type KeyListJson = { hubJoined: boolean; keys: KeyRow[] };

// What the joined Hub holds for `account`: its state, `none` for an Account
// its status does not list, `unknown` while the client holds no status.
export function atHubOf(hub: UsageHubKeysResponse, account: string): AtHub {
  if (hub.accounts === null) return "unknown";
  return hub.accounts.find((entry) => entry.accountUuid === account)?.state ?? "none";
}

// `key list`'s rows, and `status`'s line per key: each Account's key, in the daemon's Account order (the
// Home membership's Account first), those it does not list after by uuid,
// then the unfiled key.
export function keyRows(input: {
  secrets: Secrets;
  keys: UsageKeysResponse;
  accounts: readonly AccountEntry[];
  hub: UsageHubKeysResponse | null;
}): KeyRow[] {
  const { secrets, keys, accounts, hub } = input;
  const stored = secrets.sessionKeys ?? {};
  const listed = [
    ...accounts.filter((entry) => entry.home),
    ...accounts.filter((entry) => !entry.home),
  ];
  const order = [
    ...listed.flatMap((entry) =>
      entry.accountUuid !== null && stored[entry.accountUuid] !== undefined
        ? [{ uuid: entry.accountUuid, label: entry.label }]
        : [],
    ),
    ...Object.keys(stored)
      .filter((uuid) => !listed.some((entry) => entry.accountUuid === uuid))
      .sort()
      .map((uuid) => ({ uuid, label: accountLabel(uuid, null) })),
  ];
  const rows: KeyRow[] = order.map(({ uuid, label }) => ({
    account: uuid,
    label,
    connection: keys.keys.find((key) => key.accountUuid === uuid)?.connection ?? null,
    setAt: stored[uuid]!.setAt,
    atHub: hub === null ? null : atHubOf(hub, uuid),
  }));
  if (secrets.sessionKey !== undefined) {
    rows.push({
      account: null,
      label: UNFILED_LABEL,
      connection: keys.legacy?.connection ?? null,
      setAt: secrets.sessionKey.setAt,
      atHub: null,
    });
  }
  return rows;
}

// `setAt`'s calendar date in this process's zone, then its age, as `status`
// says when a key was set.
export function setAtText(iso: string, now: number): string {
  const date = new Date(Date.parse(iso));
  const day = date.toLocaleDateString("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return `${day} (${formatRelativeTime(iso, now)})`;
}

type Cells = KeyRow & { now: number };

function columns(joined: boolean): Column<Cells>[] {
  const all: Column<Cells>[] = [
    { header: "Account", text: (row) => row.label, min: NAME_MIN.account },
    { header: "Id", text: (row) => (row.account === null ? "—" : row.account.slice(0, 8)) },
    {
      header: "Connection",
      text: (row) => (row.connection === null ? "—" : usageConnectionLabel(row.connection)),
    },
    { header: "Set at", text: (row) => setAtText(row.setAt, row.now), drop: 1 },
  ];
  if (joined) {
    all.push({
      header: "At Hub",
      text: (row) => (row.atHub === null ? "—" : AT_HUB_WORDS[row.atHub]),
    });
  }
  return all;
}

export function renderKeys(list: KeyListJson, now: number, out: Output): string {
  if (list.keys.length === 0) return `${NO_KEYS}\n`;
  const rows = list.keys.map((row) => ({ ...row, now }));
  return renderTable({ title: "Session keys", columns: columns(list.hubJoined), rows }, out);
}

// A Membership's Organization tracking as `key set` lists it (ADR-0138 §4):
// Home, Tracked or Excluded, as the roster now has it, and `(new)` when the
// roster did not know the Organization before this key.
function trackingText(
  organization: string,
  roster: OrganizationsResponse,
  known: ReadonlySet<string>,
): string {
  const word =
    roster.home === organization
      ? "Home"
      : trackedOrganizations(roster).has(organization)
        ? "Tracked"
        : "Excluded";
  return known.has(organization) ? word : `${word} (new)`;
}

// `key set`'s report (ADR-0140 §7): the Account connected and tracked, then
// each of the key's Memberships with its Organization's tracking, aligned.
export function renderConnected(input: {
  account: Pick<AccountEntry, "label"> & { accountUuid: string };
  organizations: readonly string[];
  roster: OrganizationsResponse;
  known: ReadonlySet<string>;
}): string {
  const { account, roster, known } = input;
  const lines = [
    `Connected ${terminalText(account.label)} (${shortId(account.accountUuid)}), now tracked`,
  ];
  const rows = input.organizations.map((organization) => ({
    name: membershipText(organization, account, roster),
    tracking: trackingText(organization, roster, known),
  }));
  const width = Math.max(0, ...rows.map((row) => row.name.length));
  for (const row of rows) lines.push(`  ${row.name.padEnd(width)}  ${row.tracking}`);
  return lines.join("\n") + "\n";
}
