import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  listedOrgSchema,
  orgLimitsAnswerSchema,
  type ListedOrg,
  type OrganizationRosterHints,
  type UsageOrganizations,
} from "@maxprice/shared";

// The Hub's discovered roster (#284, #267 item 7): what its key last listed,
// each Organization's roster hints and its last Limits answer. Boot polls it
// at once, before any network round trip; only a SUCCESSFUL listing replaces
// it, so a failed discovery changes no row. A key clear keeps the file. The
// upstream `name` never enters it (ADR-0098 §6). Its wire shape is the
// console's GET /api/organizations (organization-rows.ts, #294).
const rosterEntrySchema = listedOrgSchema.extend({ limits: orgLimitsAnswerSchema.nullable() });
const rosterFileSchema = z.object({ organizations: z.array(rosterEntrySchema) });
export type RosterEntry = z.infer<typeof rosterEntrySchema>;

export const NO_HINTS: OrganizationRosterHints = {
  capabilities: [],
  rateLimitTier: null,
  billingType: null,
  ravenType: null,
  analyticsSubscriptionPlan: null,
};

export type OrganizationRoster = {
  ids: () => string[];
  list: () => RosterEntry[];
  // A successful listing: the roster becomes exactly the listing, in its
  // order; a surviving entry keeps its last Limits answer.
  replace: (listed: readonly ListedOrg[]) => boolean;
  // The poller's answers, for entries already in the roster.
  recordLimits: (organizations: UsageOrganizations) => boolean;
  // A pre-#283 credential's orgId, recorded before the credstore forgets it.
  remember: (id: string) => boolean;
};

// Each mutator updates memory first, persists, and reports a change. A failed
// write throws AFTER memory holds the change: the listing path warns and keeps
// polling; the boot holds back the credstore rewrite that depends on it.
export function createOrganizationRoster(opts: {
  path: string;
  readFileImpl?: (path: string, encoding: "utf8") => string;
  writeFileImpl?: typeof writeFileSync;
}): OrganizationRoster {
  const path = opts.path;
  let entries: RosterEntry[] = [];
  let dirty = false;

  // Missing file = first boot (silent). Corrupt file: warn, keep a .bak,
  // start empty (the machine directory's warn-and-preserve posture).
  let rawBytes: string | null = null;
  try {
    rawBytes = (opts.readFileImpl ?? readFileSync)(path, "utf8");
  } catch (err) {
    // Only a missing file means first boot. Abort initialization on other
    // read failures so no mutator can overwrite a roster we could not read.
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
  }
  if (rawBytes !== null) {
    let loaded = false;
    try {
      const parsed = rosterFileSchema.safeParse(JSON.parse(rawBytes));
      if (parsed.success) {
        entries = parsed.data.organizations;
        loaded = true;
      }
    } catch {
      // fall through to the recovery path
    }
    if (!loaded) {
      try {
        writeFileSync(`${path}.bak`, rawBytes);
      } catch {
        // best-effort — never block boot on the backup copy
      }
      console.warn(
        `[hub] organization-roster.json was unreadable — starting an empty roster (original preserved at ${path}.bak)`,
      );
    }
  }

  // Atomic whole-file rewrite: tmp + fsync + rename.
  function persist(): void {
    const serialized = `${JSON.stringify({ organizations: entries }, null, 2)}\n`;
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
  function commit(next: RosterEntry[]): boolean {
    const changed = JSON.stringify(next) !== JSON.stringify(entries);
    if (!changed && !dirty) return false;
    entries = next;
    dirty = true;
    persist();
    dirty = false;
    return changed;
  }

  return {
    ids: () => entries.map((e) => e.id),
    list: () => entries.map((e) => ({ ...e, hints: { ...e.hints } })),
    replace: (listed) => {
      const limits = new Map(entries.map((e) => [e.id, e.limits]));
      return commit(
        listed.map((o) => ({ id: o.id, hints: o.hints, limits: limits.get(o.id) ?? null })),
      );
    },
    recordLimits: (organizations) =>
      commit(
        entries.map((e) =>
          Object.hasOwn(organizations, e.id) ? { ...e, limits: organizations[e.id]!.limits } : e,
        ),
      ),
    remember: (id) =>
      entries.some((e) => e.id === id)
        ? commit(entries)
        : commit([...entries, { id, hints: NO_HINTS, limits: null }]),
  };
}
