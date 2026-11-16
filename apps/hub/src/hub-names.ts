import { join } from "node:path";
import {
  HUB_ORGANIZATIONS_PATH,
  hubAccountLabel,
  hubLabelDirectorySchema,
  hubOrganizationsResponseSchema,
  hubStatusSchema,
  LABEL_DIRECTORY_PATH,
  type HubAccount,
  type HubLabelDirectory,
  type HubStatus,
  type HubStatusReportKey,
} from "@maxprice/shared";
import { LEGACY_KEY } from "@maxprice/usage-core";
import { CliError, EXIT } from "./cli";
import {
  createLabelDirectory,
  LABEL_DIRECTORY_FILE,
  LEGACY_ORGANIZATION_DIRECTORY_FILE,
  type LabelDirectory,
  readLabelDirectoryFile,
} from "./label-directory";
import { refusal, type RunningHub, unreadable } from "./operator-client";
import { createOrganizationRoster, ORGANIZATION_ROSTER_FILE } from "./organization-roster";
import { hubOrganizationRows } from "./organization-rows";
import { readHubSecrets, secretsPath } from "./secrets";

// How `maxprice-hub`'s commands name an Account or an Organization
// (ADR-0140 §2): `key remove <account>`, `label account <account>` and
// `label org <org>`, and what `key list` and `status` read to label their
// rows. The names a command matches are those of everything this Hub knows:
// through a running Hub, what its own routes answer, as its console reads
// them; with none, the data dir's files, read under serve.lock.

// The unmoved legacy key's name on every terminal surface (ADR-0140 §6), the
// Hub's own word for a key no Account has claimed yet. `key remove --unfiled`
// is the only way to name it, so it never collides with a label.
export const UNFILED_KEY_LABEL = "Unfiled key";

// One thing a name may match: its id (an account uuid or an Organization's
// id) and its label as this Hub resolves it.
export type Named = { id: string; label: string };

// The first 8 characters of an id, as `Account <first 8>` shows them.
export function shortId(id: string): string {
  return id.slice(0, 8);
}

// `<label> (<first 8>)`, the way a line names one thing it acted on.
export function namedAs({ id, label }: Named): string {
  return `${label} (${shortId(id)})`;
}

// The one thing `name` names, among `candidates` (ADR-0140 §2): its label
// exactly, case and all, as an `<org>` is matched; its full id; or the
// first 8 characters of its id, and only 8. A name that matches nothing, or
// several things, exits 2; the latter names each, so the user can pick one
// by its id.
export function resolveName(
  what: "Account" | "Organization",
  name: string,
  candidates: readonly Named[],
): Named {
  const matched = new Map<string, Named>();
  for (const candidate of candidates) {
    if (
      candidate.label === name ||
      candidate.id === name ||
      (name.length === 8 && candidate.id.startsWith(name))
    ) {
      matched.set(candidate.id, candidate);
    }
  }
  const found = [...matched.values()];
  if (found.length === 0) throw new CliError(EXIT.USAGE, `no ${what} on this Hub matches ${name}`);
  if (found.length > 1) {
    throw new CliError(
      EXIT.USAGE,
      `${name} matches ${found.length} ${what}s on this Hub: ${found.map(namedAs).join(", ")}`,
    );
  }
  return found[0]!;
}

// ── Through a running Hub ───────────────────────────────────────────────────

// The running Hub's status, as its reach's probe answered it.
export function liveStatus(hub: RunningHub): HubStatus {
  const status = hubStatusSchema.safeParse(hub.status);
  if (!status.success) throw unreadable("/api/status");
  return status.data;
}

// The running Hub's Label directory, `GET /api/label-directory`. A refusal
// is exit 1, as `status` reads it.
export async function liveLabelDirectory(hub: RunningHub): Promise<HubLabelDirectory> {
  const answer = await hub.request("GET", LABEL_DIRECTORY_PATH);
  if (!answer.ok) {
    throw new CliError(
      EXIT.FAILURE,
      `the running Hub refused its label directory: ${refusal(answer, LABEL_DIRECTORY_PATH)}`,
    );
  }
  const directory = hubLabelDirectorySchema.safeParse(answer.body);
  if (!directory.success) throw unreadable(LABEL_DIRECTORY_PATH);
  return directory.data;
}

// The running Hub's Account labels for `accounts`, its status's: its Label
// directory's account entries, read only when one of them has an id. The
// unfiled key's label is the Hub's own word, so it alone asks nothing.
export async function liveAccountLabels(
  hub: RunningHub,
  accounts: readonly HubAccount[],
): Promise<HubLabelDirectory["accounts"]> {
  return accounts.some((account) => account.accountUuid !== null)
    ? (await liveLabelDirectory(hub)).accounts
    : {};
}

// Each Account a status lists, as `key list` and `status` show it, labelled
// through the Label directory's account entries (`hubAccountLabel`), the
// unfiled legacy key as `Unfiled key`, every terminal surface's word for it
// (ADR-0140 §6).
export function labelledAccounts(
  accounts: readonly HubAccount[],
  labels: HubLabelDirectory["accounts"] = {},
): HubStatusReportKey[] {
  return accounts.map((account) => ({
    provider: account.provider,
    accountUuid: account.accountUuid,
    label:
      account.accountUuid === null
        ? UNFILED_KEY_LABEL
        : hubAccountLabel(account.accountUuid, labels),
    connection: account.connection,
    setAt: account.setAt,
    source: account.source,
    removedAt: account.removedAt,
  }));
}

// Every Account the running Hub knows, the set its own Account rename checks
// against: every one its status lists with an id (a key held or removed, or
// named only by an event tag or a published Home), and every one its Label
// directory holds an entry for.
export async function liveAccounts(hub: RunningHub): Promise<Named[]> {
  const status = liveStatus(hub);
  const labels = (await liveLabelDirectory(hub)).accounts;
  return accountsNamed(
    [
      ...status.accounts.flatMap((account) =>
        account.accountUuid === null ? [] : [account.accountUuid],
      ),
      ...Object.keys(labels),
    ],
    labels,
  );
}

// Every Organization the running Hub knows, as its console reads them:
// `GET /api/organizations`, each with its resolved label.
export async function liveOrganizations(hub: RunningHub): Promise<Named[]> {
  const answer = await hub.request("GET", HUB_ORGANIZATIONS_PATH);
  if (!answer.ok) {
    throw new CliError(
      EXIT.FAILURE,
      `the running Hub refused its Organizations: ${refusal(answer, HUB_ORGANIZATIONS_PATH)}`,
    );
  }
  const parsed = hubOrganizationsResponseSchema.safeParse(answer.body);
  if (!parsed.success) throw unreadable(HUB_ORGANIZATIONS_PATH);
  return parsed.data.organizations.map((row) => ({ id: row.uuid, label: row.label }));
}

// ── From the data dir's files ───────────────────────────────────────────────

// The data dir's Label directory, for an edit, as `serve` opens it: a v6
// Organization directory beside it converted first, as `serve`'s boot does,
// since a label-directory.json the edit wrote would keep the boot from ever
// converting that file, and a file it cannot read kept as .bak and replaced.
export function openLabelDirectory(dataDir: string): LabelDirectory {
  return createLabelDirectory({
    path: join(dataDir, LABEL_DIRECTORY_FILE),
    legacyPath: join(dataDir, LEGACY_ORGANIZATION_DIRECTORY_FILE),
  });
}

// The data dir's Label directory for a read that changes nothing (`key
// list`, setup's listing, a name resolved for no label write): the file as
// it stands, one it cannot read as empty, and both files left as they are,
// with no .bak and no line (readLabelDirectoryFile).
export function readLabels(dataDir: string): HubLabelDirectory {
  return readLabelDirectoryFile(join(dataDir, LABEL_DIRECTORY_FILE));
}

// The Accounts the data dir's secrets.json holds a key or a removal time for.
// It is no running Hub's whole set: an Account named only by an event tag or
// a published Home lives in the running Hub's memory alone (ADR-0140's note).
export function storedAccounts(dataDir: string): string[] {
  const stored = readHubSecrets(secretsPath(dataDir));
  return [...stored.accounts.map((account) => account.accountUuid), ...Object.keys(stored.removed)];
}

// Every Account the data dir's files name: secrets.json's and the Label
// directory's, whose union `labels` is.
export function offlineAccounts(dataDir: string, labels: HubLabelDirectory): Named[] {
  return accountsNamed(
    [...storedAccounts(dataDir), ...Object.keys(labels.accounts)],
    labels.accounts,
  );
}

// The data dir's Organization roster, as `serve` opens it.
export function openRoster(dataDir: string) {
  return createOrganizationRoster({
    path: join(dataDir, ORGANIZATION_ROSTER_FILE),
    legacyAccount: LEGACY_KEY,
  });
}

// Every Organization the data dir's files name, as the running Hub's
// GET /api/organizations would answer them from the same files.
export function offlineOrganizations(dataDir: string, labels: HubLabelDirectory): Named[] {
  return hubOrganizationRows(
    openRoster(dataDir).organizations(),
    labels.organizations,
    LEGACY_KEY,
  ).map((row) => ({ id: row.uuid, label: row.label }));
}

// Each Account once, sorted, with the label the Hub gives it.
function accountsNamed(uuids: readonly string[], labels: HubLabelDirectory["accounts"]): Named[] {
  return [...new Set(uuids)].sort().map((id) => ({ id, label: hubAccountLabel(id, labels) }));
}
