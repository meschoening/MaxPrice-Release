import {
  ACCOUNT_NOT_KNOWN,
  accountLabel,
  buildReportUrl,
  formatMembershipToken,
  normalize,
  type ReportQueryInput,
  spansAccounts,
} from "@maxprice/shared";
import type { ZodType, ZodTypeDef } from "zod";
import type { Daemon } from "./daemon-client";
import type { ReportRequest } from "./report-request";

// The Account(s) column of `projects` and `sessions` (ADR-0140 §3). Rows
// carry no Account on the wire, so the column is filled here: while it shows
// (the Scope's Memberships span two or more Accounts, `spansAccounts`), the
// report is asked once more for each Account in the Scope, narrowed by the
// `membership` param to that Account's in-Scope Memberships, the selection
// the Desktop's Account filter sends for them. A row present in that answer
// had usage of that Account in the range, and lists its label. While the
// Scope holds the usage whose Account is not known, one more request asks for
// the in-Scope Organizations' `<org>~unknown` Memberships, and a row present
// there lists `Account not known`. While the column is hidden, and under
// `--json`, nothing more is asked, so a one-Account install makes the
// requests it always made.

// One extra request: whose label a present row lists, and the Memberships
// that narrow it.
export type AccountProbe = { label: string; memberships: string[] };

// The extra requests, in the order the cell lists their labels: each Account
// in the Scope's Membership order (Home's first), then `Account not known`.
// Null while the column is hidden.
export function accountProbes(
  request: Pick<ReportRequest, "memberships" | "scope" | "scopeState" | "accountLabels">,
): AccountProbe[] | null {
  const { memberships, scope, scopeState, accountLabels } = request;
  if (!spansAccounts(memberships)) return null;
  const keys = [...new Set(memberships.map((m) => m.accountKey))];
  const probes = keys.map((key) => ({
    label: accountLabels.get(key) ?? accountLabel(key, null),
    memberships: memberships.filter((m) => m.accountKey === key).map((m) => m.token),
  }));
  if (scope.unknownAccount) {
    // The Organization axis as resolved; left any, every tracked one.
    const organizations =
      scope.organizations.length > 0
        ? scope.organizations
        : [
            ...(scopeState.trackedOrganizations ??
              new Set(memberships.map((m) => m.organizationUuid))),
          ].sort();
    probes.push({
      label: ACCOUNT_NOT_KNOWN,
      memberships: organizations.map((uuid) => formatMembershipToken(uuid, null)),
    });
  }
  return probes;
}

// The column's cells: the probes' labels, and each row key's probes, by
// index into them, in order.
export type AccountCells = {
  labels: readonly string[];
  byKey: ReadonlyMap<string, readonly number[]>;
};

// The report at `path` asked once per probe, with the report's own input but
// its Scope: each row key `keysOf` reads from an answer maps to the probes
// whose answer holds it.
export async function rowAccounts<T>(
  daemon: Daemon,
  path: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
  input: ReportQueryInput,
  probes: readonly AccountProbe[],
  keysOf: (answer: T) => Iterable<string>,
): Promise<AccountCells> {
  const byKey = new Map<string, number[]>();
  for (const [i, probe] of probes.entries()) {
    // A `membership` param names the Scope alone; the axes are left out, as
    // the Desktop's Account filter sends a Membership list.
    const url = buildReportUrl(
      path,
      normalize({
        ...input,
        account: undefined,
        organization: undefined,
        memberships: probe.memberships,
      }),
    );
    const { data } = await daemon.request(url, schema);
    for (const key of new Set(keysOf(data))) byKey.set(key, [...(byKey.get(key) ?? []), i]);
  }
  return { labels: probes.map((p) => p.label), byKey };
}

// The cell of a row held by the probes `held` (indices, any order): their
// labels in the probes' order, joined, or an em dash for none.
export function accountsText(cells: AccountCells, held: Iterable<number>): string {
  const on = new Set(held);
  const labels = cells.labels.filter((_, i) => on.has(i));
  return labels.length === 0 ? "—" : labels.join(", ");
}
