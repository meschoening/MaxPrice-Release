import { labelDirectoryEntryPath, type LabelDirectoryKind } from "@maxprice/shared";
import { CliError, EXIT } from "./cli";
import {
  liveAccounts,
  liveOrganizations,
  offlineAccounts,
  offlineOrganizations,
  openLabelDirectory,
  openRoster,
  resolveName,
  shortId,
  storedAccounts,
} from "./hub-names";
import type { OperatorVerb } from "./index";
import { applyLabelRename, checkedLabel, type LabelTarget, refusesTheLabel } from "./label-rename";
import { refusal, type RunningHub } from "./operator-client";

// `maxprice-hub label account|org` (ADR-0140 §9) and `key set`'s label
// (§8): the operator's rename of one Label directory entry, as the console's
// Rename writes it. The Headless Hub has no console, so its terminal is the
// only place on the Hub to rename. Both paths keep one rule set
// (label-rename.ts): through a running Hub, its own PUT applies it; with
// none, this process applies it to label-directory.json under serve.lock.
// Each refusal is exit 2 in the route's words, as the store verbs' are.

// A rename refused, exit 2 in the route's words (or the offline edit's, the
// same). `ofTheLabel` when the label itself was refused, invalid or in use
// (refusesTheLabel), so another label could pass: `key set`'s prompt asks
// again for these alone, and says any other refusal left the label unwritten.
export class LabelRefused extends CliError {
  constructor(
    readonly ofTheLabel: boolean,
    message: string,
  ) {
    super(EXIT.USAGE, message);
    this.name = "LabelRefused";
  }
}

// The route's PUT: `label` already checked, or null to clear it.
export async function liveLabel(
  hub: RunningHub,
  kind: LabelDirectoryKind,
  uuid: string,
  label: string | null,
): Promise<void> {
  const path = labelDirectoryEntryPath(kind, uuid);
  const answer = await hub.request("PUT", path, { label });
  if (!answer.ok) {
    const error = refusal(answer, path);
    throw new LabelRefused(refusesTheLabel({ status: answer.status, error }), error);
  }
}

// The same rename on the data dir's files, its caller holding serve.lock. The
// Label directory is opened as `serve` opens it, converting a v6
// Organization directory first, and checked against what the files know: an
// Organization against the roster, an Account against secrets.json. A write
// that fails throws the store's own Error.
export function offlineLabel(
  dataDir: string,
  kind: LabelDirectoryKind,
  uuid: string,
  label: string | null,
): void {
  const directory = openLabelDirectory(dataDir);
  const target: LabelTarget =
    kind === "organizations"
      ? { kind, uuid, roster: openRoster(dataDir).organizations() }
      : { kind, uuid, accounts: storedAccounts(dataDir) };
  const result = applyLabelRename(directory, target, label);
  if (typeof result !== "string") throw new LabelRefused(refusesTheLabel(result), result.error);
}

const WHAT = { accounts: "Account", organizations: "Organization" } as const;

function labelledLine(kind: LabelDirectoryKind, id: string, label: string | null): string {
  return label === null
    ? `Unlabelled ${WHAT[kind]} ${shortId(id)}`
    : `Labelled ${WHAT[kind]} ${shortId(id)}: ${label}`;
}

// The command, both ways, for runOperatorVerb: `name` is matched as
// ADR-0140 §2 matches one (`resolveName`), among what the running Hub or the
// files know; `label` is the new label, or null for `--unset`. The label is
// checked here, before the Hub is reached, so an empty one sends nothing.
export function labelVerb(
  kind: LabelDirectoryKind,
  name: string,
  label: string | null,
): OperatorVerb {
  let next: string | null = null;
  if (label !== null) {
    const checked = checkedLabel(label);
    if ("error" in checked) throw new CliError(EXIT.USAGE, checked.error);
    next = checked.label;
  }
  const what = WHAT[kind];
  return {
    live: async (hub) => {
      const candidates =
        kind === "accounts" ? await liveAccounts(hub) : await liveOrganizations(hub);
      const { id } = resolveName(what, name, candidates);
      await liveLabel(hub, kind, id, next);
      return labelledLine(kind, id, next);
    },
    offline: async (dataDir) => {
      const labels = openLabelDirectory(dataDir).labels();
      const candidates =
        kind === "accounts"
          ? offlineAccounts(dataDir, labels)
          : offlineOrganizations(dataDir, labels);
      const { id } = resolveName(what, name, candidates);
      offlineLabel(dataDir, kind, id, next);
      return labelledLine(kind, id, next);
    },
  };
}
