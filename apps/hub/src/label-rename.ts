import {
  checkLabel,
  hubAccountLabel,
  LABEL_MAX,
  labelTaken,
  organizationUuidKeySchema,
} from "@maxprice/shared";
import { LEGACY_KEY } from "@maxprice/usage-core";
import type { LabelDirectory } from "./label-directory";
import { hubOrganizationRows, type HubRosterEntry } from "./organization-rows";

// The operator's rename of one Label directory entry (ADR-0105 §4, §8,
// ADR-0136 §7, ADR-0139 §7), its rules in one place for both of its editors:
// the running Hub's PUT /api/label-directory/{organizations,accounts}/:uuid
// (server.ts), which the console and `maxprice-hub label` call, and
// `maxprice-hub label`'s and `key set --label`'s offline edit of
// label-directory.json under serve.lock (label-commands.ts, ADR-0140 §8, §9).
// A refusal carries the route's status and words, which the offline edit
// gives as its own (exit 2).

export type LabelRefusal = { status: 400 | 404 | 409; error: string };

// The 409 an edit gets when it would take the union past its cap: no fault
// of the label, which another directory could hold.
export const LABEL_DIRECTORY_FULL = "label directory is full";

// Whether a refusal is of the label itself, invalid (400) or in use by
// another row (409), so another label could pass: a prompt asks again for
// these alone. An unknown name (404), a full directory and any failed write
// are not the label's.
export function refusesTheLabel({ status, error }: { status: number; error: string }): boolean {
  return status === 400 || (status === 409 && error !== LABEL_DIRECTORY_FULL);
}

// A label as typed, trimmed and checked by the shared rules (checkLabel), or
// the 400 that refuses it.
export function checkedLabel(raw: string): { label: string } | LabelRefusal {
  const check = checkLabel(raw);
  if (check.ok) return { label: check.label };
  return {
    status: 400,
    error:
      check.reason === "empty" ? "label is empty" : `label is longer than ${LABEL_MAX} characters`,
  };
}

// What an entry is checked against. An Organization's: the roster, whose
// rows (with the directory's) GET /api/organizations answers. An Account's:
// the Accounts its editor knows beside the directory's own account keys, the
// running Hub's status's, or, offline, those secrets.json holds a key or a
// removal time for.
export type LabelTarget =
  | { kind: "organizations"; uuid: string; roster: ReadonlyArray<HubRosterEntry> }
  | { kind: "accounts"; uuid: string; accounts: Iterable<string> };

// One rename, `label` already checked (checkedLabel) or null to clear it.
// An Organization is known when the roster lists it or the directory holds
// its entry, and its id is one a directory key could hold: stored, any other
// would fail every client's parse of the union. An Account is known when its
// editor knows it or the directory holds its entry. A label is unique among
// the OTHER rows of its kind as the Hub resolves them, case-insensitively
// (`labelTaken`): an Organization's against hubOrganizationRows' labels, an
// Account's against `hubAccountLabel`'s. A clear is never refused on that
// ground. A union the edit would take past its cap is refused whole. A write
// that fails throws, the directory keeping its previous union.
export function applyLabelRename(
  directory: LabelDirectory,
  target: LabelTarget,
  label: string | null,
): "ok" | "unchanged" | LabelRefusal {
  const labels = directory.labels();
  const { uuid } = target;
  if (target.kind === "organizations") {
    if (
      (!target.roster.some((entry) => entry.id === uuid) &&
        !Object.hasOwn(labels.organizations, uuid)) ||
      !organizationUuidKeySchema.safeParse(uuid).success
    ) {
      return { status: 404, error: "unknown organization" };
    }
    if (label !== null) {
      const rows = hubOrganizationRows(target.roster, labels.organizations, LEGACY_KEY).map(
        (row) => [row.uuid, row.label] as const,
      );
      if (labelTaken(rows, uuid, label)) {
        return { status: 409, error: "another organization already uses that label" };
      }
    }
  } else {
    const known = new Set<string>([...Object.keys(labels.accounts), ...target.accounts]);
    if (!known.has(uuid)) return { status: 404, error: "unknown account" };
    if (label !== null) {
      const rows = [...known].map(
        (other) => [other, hubAccountLabel(other, labels.accounts)] as const,
      );
      if (labelTaken(rows, uuid, label)) {
        return { status: 409, error: "another account already uses that label" };
      }
    }
  }
  const result = directory.rename(target.kind, uuid, label);
  return result === "full" ? { status: 409, error: LABEL_DIRECTORY_FULL } : result;
}
