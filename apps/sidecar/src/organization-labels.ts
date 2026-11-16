import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { ZodType } from "zod";
import {
  LABEL_DIRECTORY_MAX,
  accountUuidSchema,
  checkLabel,
  labelEntrySchema,
  mergeNewestWins,
  organizationUuidKeySchema,
  type LabelEntry,
} from "@maxprice/shared";
import type { FleetLabels } from "./fleet";

// organization-labels.json — the user's renames (GLOSSARY.md, Organization
// label; #287): `{ version: 1, labels: { [uuid]: { label, editedAt } } }`.
// account-labels.json beside it (#635, ADR-0136 §7) is the same store for the
// Account labels, keyed by account uuid (`accountUuidSchema`, so a
// Pending key or an address is dropped at load and never pushed); everything
// said here of the one is said of the other.
// Durable and user-authored, unlike the disposable `organizations.json` beside
// it (./organizations.ts): deleting that one costs plan words and Connect's
// seed until a later login or Connect relearns them, and first-seen times,
// which are lost — each Organization is re-stamped at the later moment it is
// next seen; deleting this one loses what the user typed. So it holds nothing
// that can be re-derived.
// Each entry carries its own `editedAt` (ISO), and a cleared label stays as a
// tombstone (`label: null`) rather than being deleted, so the Hub's
// Label directory (#288, ADR-0105 §8, ADR-0139 §7) can merge copies
// newest-`editedAt`-wins and an older copy of a rename can never resurrect a
// label the user cleared. The fleet pushes this file's entries to that
// directory and adopts its union back through `merge`, so the file also holds
// renames made on other machines.
// A label is presentation, never identity: nothing is keyed by it, it never
// stands in for a uuid, and a rename moves no number. The upstream
// Organization `name` is never written here (ADR-0098 §6) — every label in
// this file is one a user typed.

// Entries stay `unknown` here so ONE bad entry can't empty the whole file —
// each is parsed (and dropped) individually at load, under the one entry
// schema the wire and the Hub's file share (ADR-0105 §8).
const labelsFileSchema = z.object({
  version: z.literal(1),
  labels: z.record(z.unknown()),
});

export type LabelStore = {
  load: () => Promise<void>;
  // The user's label, or null when never set, cleared, or not one the rename
  // rules would accept — so the resolved default applies.
  get: (uuid: string) => string | null;
  // Every entry, tombstones included, by uuid, each as stored. The live map:
  // callers only read it.
  entries: () => ReadonlyMap<string, Readonly<LabelEntry>>;
  // label: an already-validated, trimmed label, or null to clear. Resolves true
  // when it wrote. A request that changes nothing — the label the entry already
  // holds, or a clear of a uuid with no label (no entry, or already a
  // tombstone) — is a no-op: no write, no tombstone minted, and `editedAt` does
  // not move, so a no-op can never win the Hub directory's newest-`editedAt`
  // merge (#288). A write that fails rejects and leaves the previous entry in
  // place, so a retry of the same label writes it. Calls run one at a time, in
  // call order.
  set: (uuid: string, label: string | null) => Promise<boolean>;
  // Adopts the Hub directory's union (#288): each incoming entry replaces the
  // held one only when it is the newer edit (@maxprice/shared's newest-wins).
  // The entries must already be parsed with the entry schema; they are not
  // re-validated. `wrote` when any entry changed, which costs one write;
  // `labelChanged` when some Organization's label did, which is the only
  // change a reader can see — an `editedAt` that moved alone is not. A write
  // that fails rejects and restores every changed entry. Queued with `set`.
  merge: (
    incoming: Record<string, LabelEntry>,
  ) => Promise<{ wrote: boolean; labelChanged: boolean }>;
};

// Whether one more label entry, of either kind, would grow this machine's two
// label maps past the Label directory's cap on their union (ADR-0139 §7,
// §10): `adds` when the rename keys an entry its store does not hold yet. The
// push sends both maps whole while they fit, so a rename the Hub's union
// could never take is refused here, before it is written, rather than having the Hub refuse every
// later push. The check and the write it guards run inside one
// `LabelUnionLock` turn, or two renames of different kinds could both pass at
// one entry below the cap. Adopting the Hub's union is not capped: the Hub
// holds its own union to the cap, and adoption cannot refuse another
// machine's labels. It takes the lock so that a rename's check never reads
// the union in the middle of an adoption. What this machine adds and has not
// pushed yet is outside the Hub's union, so a rename here and one on another
// machine landing at the cap together can still leave this machine over it
// after adoption; the cap is local, and only the Hub sees the fleet. Such a
// machine keeps every label, refuses each new one here, and pushes only what
// the Hub can take (fleet.ts's `labelPushBody`): the rest stay unsynced.
export function labelUnionFull(
  organizations: Pick<LabelStore, "entries">,
  accounts: Pick<LabelStore, "entries">,
  adds: boolean,
): boolean {
  return adds && organizations.entries().size + accounts.entries().size >= LABEL_DIRECTORY_MAX;
}

// One turn at a time across both label stores, for every step that reads the
// union of the two maps and then grows it (#635, ADR-0139 §7): the
// Organization rename's and the Account rename's cap check and write, and
// the fleet's adoption of the Hub's union into both maps. Each store keeps
// its own queue for its own writes; this lock is outside them and never taken
// inside a store's queue, so the two cannot wait on each other. bootSidecar()
// makes one and hands it to both renames and to `createFleetLabels`. A task
// that rejects rejects its own caller and never stalls the next.
export type LabelUnionLock = <T>(task: () => Promise<T>) => Promise<T>;

export function createLabelUnionLock(): LabelUnionLock {
  let chain: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  };
}

// The two stores as the fleet's Label directory sync sees them (#288, #635):
// both maps pushed whole, and the Hub's union adopted into each store, the
// Organization map first, then the Account map, with which kind's labels a
// reader can now see changed. bootSidecar() and the test rigs wire this one
// adapter.
export function createFleetLabels(opts: {
  ready: Promise<void>;
  organizations: Pick<LabelStore, "entries" | "merge">;
  accounts: Pick<LabelStore, "entries" | "merge">;
  unionLock: LabelUnionLock;
}): FleetLabels {
  return {
    ready: opts.ready,
    entries: () => ({
      organizations: opts.organizations.entries(),
      accounts: opts.accounts.entries(),
    }),
    merge: (incoming) =>
      opts.unionLock(async () => {
        const organizations = await opts.organizations.merge(incoming.organizations);
        const accounts = await opts.accounts.merge(incoming.accounts);
        return {
          organizationsChanged: organizations.labelChanged,
          accountsChanged: accounts.labelChanged,
        };
      }),
  };
}

export function createOrganizationLabels(opts: { path: string; now?: () => number }): LabelStore {
  return createLabelStore({
    ...opts,
    name: "organization-labels.json",
    key: organizationUuidKeySchema,
  });
}

export function createAccountLabels(opts: { path: string; now?: () => number }): LabelStore {
  return createLabelStore({ ...opts, name: "account-labels.json", key: accountUuidSchema });
}

function createLabelStore(opts: {
  path: string;
  // The file's name, for its warnings.
  name: string;
  // What may key an entry: the Label directory's key for this kind.
  key: ZodType<string>;
  now?: () => number;
}): LabelStore {
  const now = opts.now ?? Date.now;
  const known = new Map<string, LabelEntry>();

  // Absent: start empty, silently. Unreadable JSON or an envelope that is not
  // `{ version: 1, labels: {…} }`: keep the bytes as `.bak` and start empty.
  // Otherwise every entry the entry schema accepts loads and every other is
  // dropped (ADR-0105 §8 amends §5, which kept one as stored). The file itself
  // is never written here, so a dropped entry stays on disk until the first
  // write replaces it.
  async function load(): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = await readFile(opts.path);
    } catch (err) {
      // ENOENT — first launch. Any other fault starts empty too, but says so.
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
        console.warn(`[sidecar] ${opts.name} could not be read; starting empty: ${err}`);
      }
      return;
    }
    let file: z.infer<typeof labelsFileSchema> | null = null;
    try {
      const parsed = labelsFileSchema.safeParse(JSON.parse(bytes.toString("utf8")));
      if (parsed.success) file = parsed.data;
    } catch {
      // fall through to the recovery path
    }
    if (file === null) {
      try {
        await writeFile(`${opts.path}.bak`, bytes);
      } catch {
        // best-effort — never fail the load on the backup copy
      }
      console.warn(`[sidecar] ${opts.name} unreadable; starting empty (kept .bak)`);
      return;
    }
    // A bad entry is a bounded loss of one label; it leaves the disk at the
    // next write.
    let skipped = 0;
    for (const [uuid, candidate] of Object.entries(file.labels)) {
      const parsed = labelEntrySchema.safeParse(candidate);
      if (parsed.success && opts.key.safeParse(uuid).success) {
        known.set(uuid, parsed.data);
      } else {
        skipped += 1;
      }
    }
    if (skipped > 0) {
      console.warn(
        `[sidecar] ${opts.name}: skipped ${skipped} unreadable ${skipped === 1 ? "entry" : "entries"}`,
      );
    }
  }

  async function write(): Promise<void> {
    const tmp = `${opts.path}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, labels: Object.fromEntries(known) }));
    await rename(tmp, opts.path);
  }

  // One `set` or `merge` at a time — the whole of it: the comparison, the
  // change, the write and, on failure, the undo. The registry queues only its
  // writes; this store queues more, because it undoes a failed write, and an
  // undo is only sound when no other call can land between the change and the
  // write's outcome. Overlapping, a second `set` of the same uuid could restore
  // the first's never-written label as its "previous" one, or a write carrying
  // the second's change could land before the second's own write failed and
  // was undone in memory only. The queue also keeps every write off the one
  // fixed `${path}.tmp` while another is using it. A failed call rejects its
  // own caller and never stalls the queue. The rename route serializes its
  // calls too, but not against the fleet's adoption of the Hub union (#288),
  // which can land in the middle of a rename and relies on this queue alone.
  let chain: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  async function applySet(uuid: string, label: string | null): Promise<boolean> {
    const prev = known.get(uuid);
    // Case-sensitive: "lab" → "Lab" is a rename the user asked for.
    if ((prev?.label ?? null) === label) return false;
    // An edit is newer than everything its editor has seen (ADR-0105 §8): an
    // entry adopted from a machine whose clock runs ahead still loses to this
    // rename.
    const editedAt = new Date(
      Math.max(now(), prev ? Date.parse(prev.editedAt) + 1 : -Infinity),
    ).toISOString();
    known.set(uuid, { label, editedAt });
    try {
      await write();
    } catch (err) {
      // A write that failed must not leave its label behind in memory: the
      // caller was told it failed, a read would show a label the file never
      // got, and a retry of the same label would match it and no-op.
      if (prev === undefined) known.delete(uuid);
      else known.set(uuid, prev);
      throw err;
    }
    return true;
  }

  async function applyMerge(
    incoming: Record<string, LabelEntry>,
  ): Promise<{ wrote: boolean; labelChanged: boolean }> {
    const { merged, changed } = mergeNewestWins(known, Object.entries(incoming));
    if (changed.length === 0) return { wrote: false, labelChanged: false };
    const previous = new Map(changed.map((uuid) => [uuid, known.get(uuid)]));
    let labelChanged = false;
    // `known` is changed in place: `entries()` hands out the live map.
    for (const uuid of changed) {
      const next = merged.get(uuid)!;
      if ((previous.get(uuid)?.label ?? null) !== next.label) labelChanged = true;
      known.set(uuid, next);
    }
    try {
      await write();
    } catch (err) {
      // As `applySet`'s undo, for every key the merge changed.
      for (const [uuid, prev] of previous) {
        if (prev === undefined) known.delete(uuid);
        else known.set(uuid, prev);
      }
      throw err;
    }
    return { wrote: true, labelChanged };
  }

  // The entry schema refuses a label no rename could have written — empty,
  // over 40 code points, or untrimmed — so load drops such an entry
  // (ADR-0105 §8). This read-time check is the defence in depth, for an entry
  // that reached memory any other way: such a label reads as absent, never as
  // itself — the renderer's roster schema rejects an empty label, and one bad
  // row would blank the whole roster (the Home select, the first-launch seed).
  function get(uuid: string): string | null {
    const label = known.get(uuid)?.label ?? null;
    if (label === null) return null;
    const check = checkLabel(label);
    return check.ok && check.label === label ? label : null;
  }

  return {
    load,
    get,
    entries: () => known,
    set: (uuid, label) => enqueue(() => applySet(uuid, label)),
    merge: (incoming) => enqueue(() => applyMerge(incoming)),
  };
}
