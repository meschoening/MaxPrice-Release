import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  byCodeUnit,
  listedOrgSchema,
  type ListedOrg,
  type OrganizationRosterHints,
} from "@maxprice/shared";

// The Hub's discovered roster (#284, #267 item 7; ADR-0139 §9): what each key
// last listed, by the key's Account key (its account uuid, or the poller's
// LEGACY_KEY for the unmoved legacy key), with when it listed and each
// Organization's roster hints. Boot polls the union of every held key's
// listing at once, before any network round trip; only a SUCCESSFUL listing
// replaces a key's, so a failed discovery changes no row. A removed key's
// listing goes with it. The upstream `name` never enters it (ADR-0098 §6).
// Its wire shape is the console's GET /api/organizations
// (organization-rows.ts, #294).
//
// `organization-roster.json` is `{ version: 2, listings }`. A v6 file,
// `{ organizations: [{ id, hints, limits }] }`, is its one key's listing: it
// is read as the legacy key's, with no listing time, and written back in the
// new shape at once (a declared upgrade rewrite). Its Limits answers are
// dropped: they live on the Hub status's Memberships now.
export const ORGANIZATION_ROSTER_FILE = "organization-roster.json";

const listingSchema = z.object({
  // When the listing landed; null for one carried over from a v6 file.
  listedAt: z.string().nullable(),
  organizations: z.array(listedOrgSchema),
});
const rosterFileSchema = z.object({
  version: z.literal(2),
  listings: z.record(listingSchema),
});
const v6RosterFileSchema = z.object({
  organizations: z.array(listedOrgSchema.passthrough()),
});
export type RosterListing = z.infer<typeof listingSchema>;

export const NO_HINTS: OrganizationRosterHints = {
  capabilities: [],
  rateLimitTier: null,
  billingType: null,
  ravenType: null,
  analyticsSubscriptionPlan: null,
};

// One Organization as the rows read it: its id, the newest listing's hints,
// and the Account keys whose listing names it.
export type RosterOrganization = { id: string; hints: OrganizationRosterHints; listedBy: string[] };

export type OrganizationRoster = {
  // The union of every listing's Organizations, sorted.
  ids: () => string[];
  // One key's listed Organization ids (null: no listing).
  listing: (account: string) => string[] | null;
  // Every listing, by Account key.
  listings: () => Record<string, RosterListing>;
  // Every Organization any listing names: by Account key, then in listing
  // order, each once; hints from the newest listing that names it.
  organizations: () => RosterOrganization[];
  // A successful listing: that key's becomes exactly it, in its order.
  replace: (account: string, listed: readonly ListedOrg[], listedAt: string) => boolean;
  // A removed key's listing goes with it.
  forget: (account: string) => boolean;
  // ADR-0138 §12's move: the legacy key's listing becomes its Account's.
  // An Account that already has a listing keeps its own.
  move: (from: string, to: string) => boolean;
  // A pre-#283 credential's orgId, recorded in that key's listing before
  // the credstore forgets it.
  remember: (account: string, id: string) => boolean;
};

// Each mutator updates memory first, persists, and reports a change. A failed
// write throws AFTER memory holds the change: the listing path warns and keeps
// polling; the boot holds back the credstore rewrite that depends on it.
export function createOrganizationRoster(opts: {
  path: string;
  // The v6 file's one key: the poller's LEGACY_KEY.
  legacyAccount: string;
  readFileImpl?: (path: string, encoding: "utf8") => string;
  writeFileImpl?: typeof writeFileSync;
}): OrganizationRoster {
  const path = opts.path;
  let listings: Record<string, RosterListing> = {};
  let dirty = false;
  let upgrade = false;

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
      const json: unknown = JSON.parse(rawBytes);
      const parsed = rosterFileSchema.safeParse(json);
      if (parsed.success) {
        listings = parsed.data.listings;
        loaded = true;
      } else {
        const v6 = v6RosterFileSchema.safeParse(json);
        if (v6.success) {
          listings = {
            [opts.legacyAccount]: {
              listedAt: null,
              organizations: v6.data.organizations.map((o) => ({ id: o.id, hints: o.hints })),
            },
          };
          loaded = true;
          upgrade = true;
        }
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
    const sorted = Object.fromEntries(
      Object.entries(listings).sort(([a], [b]) => byCodeUnit(a, b)),
    );
    const serialized = `${JSON.stringify({ version: 2, listings: sorted }, null, 2)}\n`;
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
  function commit(next: Record<string, RosterListing>): boolean {
    const changed = JSON.stringify(next) !== JSON.stringify(listings);
    if (!changed && !dirty) return false;
    listings = next;
    dirty = true;
    persist();
    dirty = false;
    return changed;
  }
  function without(account: string): Record<string, RosterListing> {
    return Object.fromEntries(Object.entries(listings).filter(([k]) => k !== account));
  }

  // The v6 file is rewritten in the new shape at once. A failed write keeps
  // the v6 file, which the next boot reads the same way.
  if (upgrade) {
    try {
      dirty = true;
      persist();
      dirty = false;
    } catch (err) {
      console.warn("[hub] organization roster write failed:", err);
    }
  }

  function organizations(): RosterOrganization[] {
    const out = new Map<string, RosterOrganization & { at: string | null }>();
    for (const [account, listing] of Object.entries(listings).sort(([a], [b]) =>
      byCodeUnit(a, b),
    )) {
      for (const org of listing.organizations) {
        const held = out.get(org.id);
        if (held === undefined) {
          out.set(org.id, {
            id: org.id,
            hints: { ...org.hints },
            listedBy: [account],
            at: listing.listedAt,
          });
          continue;
        }
        held.listedBy.push(account);
        // The newest listing's hints; a v6 listing (no time) is the oldest.
        if (listing.listedAt !== null && (held.at === null || listing.listedAt > held.at)) {
          held.hints = { ...org.hints };
          held.at = listing.listedAt;
        }
      }
    }
    return [...out.values()].map(({ id, hints, listedBy }) => ({ id, hints, listedBy }));
  }

  return {
    ids: () =>
      [...new Set(Object.values(listings).flatMap((l) => l.organizations.map((o) => o.id)))].sort(
        byCodeUnit,
      ),
    listing: (account) =>
      Object.hasOwn(listings, account) ? listings[account]!.organizations.map((o) => o.id) : null,
    listings: () =>
      Object.fromEntries(
        Object.entries(listings).map(([k, l]) => [
          k,
          { listedAt: l.listedAt, organizations: l.organizations.map((o) => ({ ...o })) },
        ]),
      ),
    organizations,
    replace: (account, listed, listedAt) =>
      commit({
        ...listings,
        [account]: { listedAt, organizations: listed.map((o) => ({ id: o.id, hints: o.hints })) },
      }),
    forget: (account) => (Object.hasOwn(listings, account) ? commit(without(account)) : false),
    move: (from, to) => {
      if (!Object.hasOwn(listings, from)) return false;
      const moved = without(from);
      if (!Object.hasOwn(moved, to)) moved[to] = listings[from]!;
      return commit(moved);
    },
    remember: (account, id) => {
      const listing = listings[account];
      if (listing?.organizations.some((o) => o.id === id)) return commit(listings);
      return commit({
        ...listings,
        [account]: {
          listedAt: listing?.listedAt ?? null,
          organizations: [...(listing?.organizations ?? []), { id, hints: NO_HINTS }],
        },
      });
    },
  };
}
