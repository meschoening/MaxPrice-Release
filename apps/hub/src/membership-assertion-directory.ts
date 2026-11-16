// Exported via a package.json subpath solely for the sidecar fleet test rig (apps/sidecar/src/test-hub.ts) — keep signatures stable, a cross-app test contract.
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { loadOrConvertDirectory } from "./directory-conversion";
import {
  MEMBERSHIP_ASSERTION_DIRECTORY_MAX,
  mergeNewestWins,
  membershipAssertionEntrySchema,
  sessionIdKeySchema,
  type MembershipAssertionEntry,
} from "@maxprice/shared";

// The Hub's Membership assertion directory (#310, ADR-0107 §11, ADR-0139 §7):
// the fleet's union of Membership assertions, sessionId → { organizationUuid,
// accountUuid?, editedAt }, in membership-assertion-directory.json beside the
// Label directory, whose mechanics it copies rather than shares (all but the
// v6 conversion's load-or-convert IO, which both take from
// ./directory-conversion.ts): atomic whole-file rewrite, per-entry salvage, at most
// MEMBERSHIP_ASSERTION_DIRECTORY_MAX entries, newest `editedAt` wins (the
// entry whole, Account and all), and a cleared claim stays as a tombstone so
// an older copy cannot resurrect it. Opaque: the Hub never checks that a
// session, an Organization or an Account exists, and nothing here edits a
// claim — every entry arrives in some client's push. Every client holds the
// entries it has adopted, so a directory that starts empty is rebuilt by the
// fleet's next pushes.

export const MEMBERSHIP_ASSERTION_DIRECTORY_FILE = "membership-assertion-directory.json";
// The v6 Hub's file, Organization assertions alone (`{ version: 1,
// assertions }`): converted once at boot (below) and by `restore` of a v6
// backup.
export const LEGACY_ORGANIZATION_ASSERTION_DIRECTORY_FILE = "organization-assertion-directory.json";

// Entries stay `unknown` so ONE bad entry can't fail the whole file — each is
// parsed (and skipped) individually below. An oversized envelope takes the
// corrupt file's backup-and-rebuild path, so loading can never produce a union
// the wire schema refuses.
const envelope = <V extends 1 | 2>(version: V) =>
  z.object({
    version: z.literal(version),
    assertions: z
      .record(z.unknown())
      .refine((entries) => Object.keys(entries).length <= MEMBERSHIP_ASSERTION_DIRECTORY_MAX),
  });
const directoryFileSchema = envelope(2);
const legacyFileSchema = envelope(1);

type Assertions = Map<string, MembershipAssertionEntry>;

// The readable entries, and how many were not: a bad entry is a bounded loss
// of one claim, and its author re-pushes it.
function salvage(entries: Record<string, unknown>): { assertions: Assertions; skipped: number } {
  const assertions: Assertions = new Map();
  let skipped = 0;
  for (const [sessionId, candidate] of Object.entries(entries)) {
    const parsed = membershipAssertionEntrySchema.safeParse(candidate);
    if (parsed.success && sessionIdKeySchema.safeParse(sessionId).success) {
      assertions.set(sessionId, parsed.data);
    } else {
      skipped += 1;
    }
  }
  return { assertions, skipped };
}

function sorted(source: ReadonlyMap<string, MembershipAssertionEntry>) {
  return Object.fromEntries(
    [...source.keys()].sort().map((sessionId) => [sessionId, { ...source.get(sessionId)! }]),
  );
}

// The file's bytes, written compact: the union can hold 20,000 entries.
function directoryText(assertions: Assertions): string {
  return `${JSON.stringify({ version: 2, assertions: sorted(assertions) })}\n`;
}

// A v6 Organization assertion directory as parsed, converted to the
// Membership assertion directory's bytes (ADR-0139 §7): every claim carries
// over unchanged, with no Account, and takes its Account by ADR-0137 §3 at
// query time. Null when `raw` is no v1 file. Pure, so the boot (below) and
// `restore` of a v6 backup (restore.ts) convert one way; `skipped` counts the
// entries the conversion could not read and dropped.
export function migrateOrganizationAssertionDirectoryFile(
  raw: unknown,
): { text: string; skipped: number } | null {
  const legacy = legacyFileSchema.safeParse(raw);
  if (!legacy.success) return null;
  const { assertions, skipped } = salvage(legacy.data.assertions);
  return { text: directoryText(assertions), skipped };
}

export type MembershipAssertionDirectory = {
  // The whole union, tombstones included, keys sorted (stable bytes and
  // bodies), as copies.
  assertions: () => Record<string, MembershipAssertionEntry>;
  // Merges a client's push newest-wins. "ok" when an entry changed, after the
  // union is persisted; "unchanged" writes nothing; "full" when the merged
  // union would pass the cap — refused whole, nothing written. Updating a held
  // session never grows the union. A write that fails leaves the previous
  // union in place and throws.
  merge: (incoming: Record<string, MembershipAssertionEntry>) => "ok" | "unchanged" | "full";
};

export function createMembershipAssertionDirectory(opts: {
  path: string;
  // The v6 file beside it, converted at the first boot that finds no
  // membership-assertion-directory.json (serve passes it; a store without one
  // converts nothing).
  legacyPath?: string;
  writeFileImpl?: (path: string, data: string) => void;
}): MembershipAssertionDirectory {
  const path = opts.path;
  let assertions: Assertions = new Map();

  // Atomic whole-file rewrite (tmp + fsync + rename). The caller adopts the
  // next union only after this returns, so a failed write leaves the
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

  // Synchronous load at construction, one read: at the cap the file is ~2.7 MB
  // with UUID session ids, ~5.1 MB with every key at its schema limit.
  // Missing file = first boot (silent), unless the v6 file is there. A
  // membership-assertion-directory.json this boot cannot read is never
  // converted over.
  const rawBytes = loadOrConvertDirectory({
    path,
    ...(opts.legacyPath === undefined ? {} : { legacyPath: opts.legacyPath }),
    name: "membership assertion directory",
    legacyName: "v6 organization-assertion-directory.json",
    max: MEMBERSHIP_ASSERTION_DIRECTORY_MAX,
    loads: (text) => {
      try {
        return directoryFileSchema.safeParse(JSON.parse(text)).success;
      } catch {
        return false;
      }
    },
    convert: migrateOrganizationAssertionDirectoryFile,
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
      // Corrupt file: warn, keep a .bak, start empty.
      try {
        writeFileSync(`${path}.bak`, rawBytes);
      } catch {
        // best-effort — never block boot on the backup copy
      }
      console.warn(
        `[hub] membership assertion directory unreadable; starting empty (kept ${path}.bak)`,
      );
    } else {
      // A bad entry leaves the disk at the next write.
      const loaded = salvage(file.assertions);
      assertions = loaded.assertions;
      if (loaded.skipped > 0) {
        console.warn(
          `[hub] membership assertion directory: skipped ${loaded.skipped} unreadable ${loaded.skipped === 1 ? "entry" : "entries"} in ${path}`,
        );
      }
    }
  }

  return {
    assertions: () => sorted(assertions),
    merge: (incoming) => {
      const { merged, changed } = mergeNewestWins(assertions, Object.entries(incoming));
      if (changed.length === 0) return "unchanged";
      if (merged.size > MEMBERSHIP_ASSERTION_DIRECTORY_MAX) return "full";
      write(directoryText(merged));
      assertions = merged;
      return "ok";
    },
  };
}
