// Exported via a package.json subpath solely for the sidecar fleet test rig (apps/sidecar/src/test-hub.ts) — keep signatures stable, a cross-app test contract.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { loadOrConvertDirectory } from "./directory-conversion";
import {
  LABEL_DIRECTORY_MAX,
  accountUuidSchema,
  labelEntrySchema,
  mergeNewestWins,
  organizationUuidKeySchema,
  type HubLabelDirectory,
  type LabelDirectoryKind,
  type LabelEntry,
} from "@maxprice/shared";

// The Hub's Label directory (#288, ADR-0105 §8, ADR-0139 §7): the fleet's
// union of user-set labels, Organization labels by Organization uuid and
// Account labels by account uuid, each { label, editedAt }, in
// label-directory.json beside the machine directory, atomic whole-file
// rewrite, at most LABEL_DIRECTORY_MAX entries across both maps. Newest
// `editedAt` wins (@maxprice/shared's newest-wins), and a cleared label stays
// as a tombstone so an older copy cannot resurrect it. Labels only: the Hub
// never interprets an Organization or an Account, an Organization's upstream
// `name` never enters it, and an account key is an account uuid, so no
// Pending account or email does either. Every client holds the entries it has
// adopted, so a directory that starts empty is rebuilt by the fleet's next
// pushes.

export const LABEL_DIRECTORY_FILE = "label-directory.json";
// The v6 Hub's file, Organization labels alone (`{ version: 1, labels }`):
// converted once at boot (below) and by `restore` of a v6 backup.
export const LEGACY_ORGANIZATION_DIRECTORY_FILE = "organization-directory.json";

// Entries stay `unknown` here so ONE bad entry can't fail the whole file —
// each is parsed (and skipped) individually below (the Identity directory's
// per-row salvage). An oversized envelope takes the same backup-and-rebuild
// path as a corrupt file, so loading can never produce a union that the wire
// schema refuses.
const directoryFileSchema = z
  .object({
    version: z.literal(2),
    organizations: z.record(z.unknown()),
    accounts: z.record(z.unknown()),
  })
  .refine(
    (file) =>
      Object.keys(file.organizations).length + Object.keys(file.accounts).length <=
      LABEL_DIRECTORY_MAX,
  );
const legacyFileSchema = z.object({
  version: z.literal(1),
  labels: z
    .record(z.unknown())
    .refine((labels) => Object.keys(labels).length <= LABEL_DIRECTORY_MAX),
});

type Labels = Map<string, LabelEntry>;

// Each map's readable entries, and how many were not: a bad entry is a
// bounded loss of one label, and its author re-pushes it.
function salvage(file: z.infer<typeof directoryFileSchema>) {
  let skipped = 0;
  const read = (entries: Record<string, unknown>, key: z.ZodTypeAny): Labels => {
    const out: Labels = new Map();
    for (const [uuid, candidate] of Object.entries(entries)) {
      const parsed = labelEntrySchema.safeParse(candidate);
      if (parsed.success && key.safeParse(uuid).success) out.set(uuid, parsed.data);
      else skipped += 1;
    }
    return out;
  };
  return {
    organizations: read(file.organizations, organizationUuidKeySchema),
    accounts: read(file.accounts, accountUuidSchema),
    skipped,
  };
}

function sorted(source: ReadonlyMap<string, LabelEntry>): Record<string, LabelEntry> {
  return Object.fromEntries(
    [...source.keys()].sort().map((uuid) => [uuid, { ...source.get(uuid)! }]),
  );
}

// The file's bytes, keys sorted, as every write lays them out.
function directoryText(organizations: Labels, accounts: Labels): string {
  const file = { version: 2, organizations: sorted(organizations), accounts: sorted(accounts) };
  return `${JSON.stringify(file, null, 2)}\n`;
}

// A v6 Organization directory as parsed, converted to the Label directory's
// bytes (ADR-0139 §7): its labels become the Organization map, unchanged, and
// the Account map starts empty. Null when `raw` is no v1 file. Pure, so the
// boot (below) and `restore` of a v6 backup (restore.ts) convert one way;
// `skipped` counts the entries the conversion could not read and dropped.
export function migrateOrganizationDirectoryFile(
  raw: unknown,
): { text: string; skipped: number } | null {
  const legacy = legacyFileSchema.safeParse(raw);
  if (!legacy.success) return null;
  const { organizations, accounts, skipped } = salvage({
    version: 2,
    organizations: legacy.data.labels,
    accounts: {},
  });
  return { text: directoryText(organizations, accounts), skipped };
}

// The union label-directory.json holds as it stands, for a reader that
// changes nothing (`maxprice-hub key list`, setup's listing, a name resolved
// for no write, hub-names.ts's readLabels): a bad entry skipped, as a load
// skips it, and a file that is missing, unreadable, invalid or past the cap
// read as empty. Nothing is written, kept as .bak or warned, and a v6
// Organization directory beside it is not read: only the load below, which
// an edit opens, repairs or converts.
export function readLabelDirectoryFile(path: string): HubLabelDirectory {
  let file: z.infer<typeof directoryFileSchema> | null = null;
  try {
    const parsed = directoryFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.success) file = parsed.data;
  } catch {
    // Missing, unreadable or not JSON: read as empty.
  }
  if (file === null) return { organizations: {}, accounts: {} };
  const { organizations, accounts } = salvage(file);
  return { organizations: sorted(organizations), accounts: sorted(accounts) };
}

// "full": the edit would take the union of both maps past
// LABEL_DIRECTORY_MAX entries, tombstones included. The whole edit is refused
// and nothing is written. Editing a key the union already holds never grows
// it, so it is never refused on this ground.
export type LabelDirectory = {
  // The whole union, tombstones included, keys sorted (stable bytes and bodies).
  labels: () => HubLabelDirectory;
  // Merges a client's push newest-wins, each map by its own keys; persists
  // and answers "ok" only when an entry changed. A write that fails restores
  // the previous union and throws.
  merge: (incoming: HubLabelDirectory) => "ok" | "unchanged" | "full";
  // The operator's rename of one Organization or one Account: `label` is
  // already validated and trimmed, or null to clear. "unchanged" when the
  // entry already holds that label, or a clear finds no label (absent or a
  // tombstone); nothing is written and `editedAt` stays. Otherwise stamps
  // editedAt = max(now, previous editedAt + 1 ms) and persists (a failed
  // write restores and throws).
  rename: (
    kind: LabelDirectoryKind,
    uuid: string,
    label: string | null,
  ) => "ok" | "unchanged" | "full";
};

export function createLabelDirectory(opts: {
  path: string;
  // The v6 file beside it, converted at the first boot that finds no
  // label-directory.json (serve passes it; a store without one converts
  // nothing).
  legacyPath?: string;
  nowImpl?: () => number;
  writeFileImpl?: (path: string, data: string) => void;
}): LabelDirectory {
  const path = opts.path;
  const now = opts.nowImpl ?? Date.now;
  let organizations: Labels = new Map();
  let accounts: Labels = new Map();

  // Atomic whole-file rewrite (the machine directory's persist): tmp + fsync +
  // rename so a crash mid-write never truncates the directory. Callers write
  // the next union first and adopt it only after, so a failed write leaves the
  // previous one in memory.
  function write(text: string): void {
    const tmp = `${path}.tmp`;
    (opts.writeFileImpl ?? writeFileSync)(tmp, text);
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }

  // Synchronous load at construction — the file is small (one entry per
  // label). Missing file = first boot (silent), unless the v6 file is there.
  // A label-directory.json this boot cannot read is never converted over.
  const rawBytes = loadOrConvertDirectory({
    path,
    ...(opts.legacyPath === undefined ? {} : { legacyPath: opts.legacyPath }),
    name: "label directory",
    legacyName: "v6 organization-directory.json",
    max: LABEL_DIRECTORY_MAX,
    loads: (text) => {
      try {
        return directoryFileSchema.safeParse(JSON.parse(text)).success;
      } catch {
        return false;
      }
    },
    convert: migrateOrganizationDirectoryFile,
    write,
  });
  if (rawBytes !== null) {
    let file: z.infer<typeof directoryFileSchema> | null = null;
    try {
      const parsed = directoryFileSchema.safeParse(JSON.parse(rawBytes));
      if (parsed.success) file = parsed.data;
    } catch {
      // fall through to the recovery path
    }
    if (file === null) {
      // Corrupt file: warn, keep a .bak, start empty (the machine directory's
      // warn-and-preserve posture).
      try {
        writeFileSync(`${path}.bak`, rawBytes);
      } catch {
        // best-effort — never block boot on the backup copy
      }
      console.warn(`[hub] label directory unreadable; starting empty (kept ${path}.bak)`);
    } else {
      // A bad entry leaves the disk at the next write.
      const loaded = salvage(file);
      organizations = loaded.organizations;
      accounts = loaded.accounts;
      if (loaded.skipped > 0) {
        console.warn(
          `[hub] label directory: skipped ${loaded.skipped} unreadable ${loaded.skipped === 1 ? "entry" : "entries"} in ${path}`,
        );
      }
    }
  }

  const size = (a: Labels, b: Labels): number => a.size + b.size;

  return {
    labels: () => ({ organizations: sorted(organizations), accounts: sorted(accounts) }),
    merge: (incoming) => {
      const orgs = mergeNewestWins(organizations, Object.entries(incoming.organizations));
      const accs = mergeNewestWins(accounts, Object.entries(incoming.accounts));
      if (orgs.changed.length === 0 && accs.changed.length === 0) return "unchanged";
      // The cap bounds the union of both maps, not just one push or one map:
      // every GET and POST answers the whole union under the wire's own cap,
      // so it must never outgrow it.
      if (size(orgs.merged, accs.merged) > LABEL_DIRECTORY_MAX) return "full";
      write(directoryText(orgs.merged, accs.merged));
      organizations = orgs.merged;
      accounts = accs.merged;
      return "ok";
    },
    rename: (kind, uuid, label) => {
      const held = kind === "organizations" ? organizations : accounts;
      const previous = held.get(uuid);
      if ((previous?.label ?? null) === label) return "unchanged";
      if (previous === undefined && size(organizations, accounts) >= LABEL_DIRECTORY_MAX) {
        return "full";
      }
      // An edit is newer than everything its editor has seen: an entry adopted
      // from a clock that runs ahead still loses to this rename.
      const floor = previous === undefined ? -Infinity : Date.parse(previous.editedAt) + 1;
      const next = new Map(held);
      next.set(uuid, { label, editedAt: new Date(Math.max(now(), floor)).toISOString() });
      const [nextOrganizations, nextAccounts] =
        kind === "organizations" ? [next, accounts] : [organizations, next];
      write(directoryText(nextOrganizations, nextAccounts));
      organizations = nextOrganizations;
      accounts = nextAccounts;
      return "ok";
    },
  };
}
