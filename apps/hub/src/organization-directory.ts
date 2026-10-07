// Exported via a package.json subpath solely for the sidecar fleet test rig (apps/sidecar/src/test-hub.ts) — keep signatures stable, a cross-app test contract.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  ORGANIZATION_DIRECTORY_MAX,
  mergeNewestWins,
  organizationLabelEntrySchema,
  organizationUuidKeySchema,
  type OrganizationLabelEntry,
} from "@maxprice/shared";

// The Hub's Organization directory (#288, ADR-0105 §8): the fleet's union of
// Organization label entries, organizationUuid → { label, editedAt }, its own
// small file beside the machine directory, atomic whole-file rewrite, at most
// ORGANIZATION_DIRECTORY_MAX entries. Newest `editedAt` wins (@maxprice/shared's
// newest-wins), and a cleared label stays as a tombstone so an older copy
// cannot resurrect it. Labels only: the Hub never interprets an Organization,
// and the upstream `name` never enters it. Every client holds the entries it
// has adopted, so a directory that starts empty is rebuilt by the fleet's next
// pushes.

// Entries stay `unknown` here so ONE bad entry can't fail the whole file —
// each is parsed (and skipped) individually below (the Identity directory's
// per-row salvage).
// An oversized envelope takes the same backup-and-rebuild path as a corrupt
// file, so loading can never produce a union that the wire schema refuses.
const directoryFileSchema = z.object({
  version: z.literal(1),
  labels: z
    .record(z.unknown())
    .refine((entries) => Object.keys(entries).length <= ORGANIZATION_DIRECTORY_MAX),
});

// "full": the edit would take the union past ORGANIZATION_DIRECTORY_MAX
// entries, tombstones included. The whole edit is refused and nothing is
// written. Editing a uuid the union already holds never grows it, so it is
// never refused on this ground.
export type OrganizationDirectory = {
  // The whole union, tombstones included, keys sorted (stable bytes and bodies).
  labels: () => Record<string, OrganizationLabelEntry>;
  // Merges a client's push newest-wins; persists and answers "ok" only when an
  // entry changed. A write that fails restores the previous union and throws.
  merge: (incoming: Record<string, OrganizationLabelEntry>) => "ok" | "unchanged" | "full";
  // The operator's rename: `label` is already validated and trimmed, or null to
  // clear. "unchanged" when the entry already holds that label, or a clear finds
  // no label (absent or a tombstone); nothing is written and `editedAt` stays.
  // Otherwise stamps editedAt = max(now, previous editedAt + 1 ms) and persists
  // (a failed write restores and throws).
  rename: (uuid: string, label: string | null) => "ok" | "unchanged" | "full";
};

export function createOrganizationDirectory(opts: {
  path: string;
  nowImpl?: () => number;
  writeFileImpl?: (path: string, data: string) => void;
}): OrganizationDirectory {
  const path = opts.path;
  const now = opts.nowImpl ?? Date.now;
  let labels = new Map<string, OrganizationLabelEntry>();

  // Synchronous load at construction — the file is small (one entry per
  // Organization). Missing file = first boot (silent). Corrupt file: warn, keep
  // a .bak, start empty (the machine directory's warn-and-preserve posture).
  let rawBytes: string | null = null;
  try {
    rawBytes = readFileSync(path, "utf8");
  } catch (err) {
    // ENOENT — first boot. Any other fault starts empty too, but says so.
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
      console.warn(`[hub] organization directory could not be read; starting empty: ${err}`);
    }
  }
  if (rawBytes !== null) {
    let file: z.infer<typeof directoryFileSchema> | null = null;
    try {
      const parsed = directoryFileSchema.safeParse(JSON.parse(rawBytes));
      if (parsed.success) file = parsed.data;
    } catch {
      // fall through to the recovery path
    }
    if (file === null) {
      try {
        writeFileSync(`${path}.bak`, rawBytes);
      } catch {
        // best-effort — never block boot on the backup copy
      }
      console.warn(`[hub] organization directory unreadable; starting empty (kept ${path}.bak)`);
    } else {
      // A bad entry is a bounded loss of one label, and its author re-pushes
      // it; it leaves the disk at the next write.
      let skipped = 0;
      for (const [uuid, candidate] of Object.entries(file.labels)) {
        const parsed = organizationLabelEntrySchema.safeParse(candidate);
        if (parsed.success && organizationUuidKeySchema.safeParse(uuid).success) {
          labels.set(uuid, parsed.data);
        } else {
          skipped += 1;
        }
      }
      if (skipped > 0) {
        console.warn(
          `[hub] organization directory: skipped ${skipped} unreadable ${skipped === 1 ? "entry" : "entries"} in ${path}`,
        );
      }
    }
  }

  function sorted(source: ReadonlyMap<string, OrganizationLabelEntry>) {
    return Object.fromEntries(
      [...source.keys()].sort().map((uuid) => [uuid, { ...source.get(uuid)! }]),
    );
  }

  // Atomic whole-file rewrite (the machine directory's persist): tmp + fsync +
  // rename so a crash mid-write never truncates the directory. Callers write
  // the next union first and adopt it only after, so a failed write leaves the
  // previous one in memory.
  function persist(next: ReadonlyMap<string, OrganizationLabelEntry>): void {
    const serialized = `${JSON.stringify({ version: 1, labels: sorted(next) }, null, 2)}\n`;
    const tmp = `${path}.tmp`;
    (opts.writeFileImpl ?? writeFileSync)(tmp, serialized);
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }

  return {
    labels: () => sorted(labels),
    merge: (incoming) => {
      const { merged, changed } = mergeNewestWins(labels, Object.entries(incoming));
      if (changed.length === 0) return "unchanged";
      // The cap bounds the union, not just one push: every GET and POST answers
      // the whole union under the wire's own cap, so it must never outgrow it.
      if (merged.size > ORGANIZATION_DIRECTORY_MAX) return "full";
      persist(merged);
      labels = merged;
      return "ok";
    },
    rename: (uuid, label) => {
      const previous = labels.get(uuid);
      if ((previous?.label ?? null) === label) return "unchanged";
      if (previous === undefined && labels.size >= ORGANIZATION_DIRECTORY_MAX) return "full";
      // An edit is newer than everything its editor has seen: an entry adopted
      // from a clock that runs ahead still loses to this rename.
      const floor = previous === undefined ? -Infinity : Date.parse(previous.editedAt) + 1;
      const next = new Map(labels);
      next.set(uuid, { label, editedAt: new Date(Math.max(now(), floor)).toISOString() });
      persist(next);
      labels = next;
      return "ok";
    },
  };
}
