// Exported via a package.json subpath solely for the sidecar fleet test rig (apps/sidecar/src/test-hub.ts) — keep signatures stable, a cross-app test contract.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  ORGANIZATION_ASSERTION_DIRECTORY_MAX,
  mergeNewestWins,
  organizationAssertionEntrySchema,
  sessionIdKeySchema,
  type OrganizationAssertionEntry,
} from "@maxprice/shared";

// The Hub's Organization assertion directory (#310, ADR-0107 §11): the fleet's
// union of Organization assertions, sessionId → { organizationUuid, editedAt },
// in its own file beside the Organization directory (#288), whose mechanics it
// copies rather than shares: atomic whole-file rewrite, per-entry salvage, at
// most ORGANIZATION_ASSERTION_DIRECTORY_MAX entries, newest `editedAt` wins,
// and a cleared claim stays as a tombstone so an older copy cannot resurrect
// it. Opaque: the Hub never checks that a session or an Organization exists,
// and nothing here edits a claim — every entry arrives in some client's push.
// Every client holds the entries it has adopted, so a directory that starts
// empty is rebuilt by the fleet's next pushes.

// Entries stay `unknown` so ONE bad entry can't fail the whole file — each is
// parsed (and skipped) individually below. An oversized envelope takes the
// corrupt file's backup-and-rebuild path, so loading can never produce a union
// the wire schema refuses.
const directoryFileSchema = z.object({
  version: z.literal(1),
  assertions: z
    .record(z.unknown())
    .refine((entries) => Object.keys(entries).length <= ORGANIZATION_ASSERTION_DIRECTORY_MAX),
});

export type OrganizationAssertionDirectory = {
  // The whole union, tombstones included, keys sorted (stable bytes and
  // bodies), as copies.
  assertions: () => Record<string, OrganizationAssertionEntry>;
  // Merges a client's push newest-wins. "ok" when an entry changed, after the
  // union is persisted; "unchanged" writes nothing; "full" when the merged
  // union would pass the cap — refused whole, nothing written. Updating a held
  // session never grows the union. A write that fails leaves the previous
  // union in place and throws.
  merge: (incoming: Record<string, OrganizationAssertionEntry>) => "ok" | "unchanged" | "full";
};

export function createOrganizationAssertionDirectory(opts: {
  path: string;
  writeFileImpl?: (path: string, data: string) => void;
}): OrganizationAssertionDirectory {
  const path = opts.path;
  let assertions = new Map<string, OrganizationAssertionEntry>();

  // Synchronous load at construction, one read: at the cap the file is ~2.7 MB
  // with UUID session ids, ~5.1 MB with every key at its schema limit.
  // Missing file = first boot (silent). Corrupt file: warn, keep a .bak, start
  // empty.
  let rawBytes: string | null = null;
  try {
    rawBytes = readFileSync(path, "utf8");
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
      console.warn(
        `[hub] organization assertion directory could not be read; starting empty: ${err}`,
      );
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
      console.warn(
        `[hub] organization assertion directory unreadable; starting empty (kept ${path}.bak)`,
      );
    } else {
      // A bad entry is a bounded loss of one claim, and its author re-pushes
      // it; it leaves the disk at the next write.
      let skipped = 0;
      for (const [sessionId, candidate] of Object.entries(file.assertions)) {
        const parsed = organizationAssertionEntrySchema.safeParse(candidate);
        if (parsed.success && sessionIdKeySchema.safeParse(sessionId).success) {
          assertions.set(sessionId, parsed.data);
        } else {
          skipped += 1;
        }
      }
      if (skipped > 0) {
        console.warn(
          `[hub] organization assertion directory: skipped ${skipped} unreadable ${skipped === 1 ? "entry" : "entries"} in ${path}`,
        );
      }
    }
  }

  function sorted(source: ReadonlyMap<string, OrganizationAssertionEntry>) {
    return Object.fromEntries(
      [...source.keys()].sort().map((sessionId) => [sessionId, { ...source.get(sessionId)! }]),
    );
  }

  // Atomic whole-file rewrite (tmp + fsync + rename), written compact: the
  // union can hold 20,000 entries. The caller adopts the next union only after
  // this returns, so a failed write leaves the previous one in memory.
  function persist(next: ReadonlyMap<string, OrganizationAssertionEntry>): void {
    const serialized = `${JSON.stringify({ version: 1, assertions: sorted(next) })}\n`;
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
    assertions: () => sorted(assertions),
    merge: (incoming) => {
      const { merged, changed } = mergeNewestWins(assertions, Object.entries(incoming));
      if (changed.length === 0) return "unchanged";
      if (merged.size > ORGANIZATION_ASSERTION_DIRECTORY_MAX) return "full";
      persist(merged);
      assertions = merged;
      return "ok";
    },
  };
}
