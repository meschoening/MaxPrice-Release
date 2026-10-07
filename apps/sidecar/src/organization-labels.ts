import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  checkOrganizationLabel,
  mergeNewestWins,
  organizationLabelEntrySchema,
  organizationUuidKeySchema,
  type OrganizationLabelEntry,
} from "@maxprice/shared";

// organization-labels.json — the user's renames (GLOSSARY.md, Organization
// label; #287): `{ version: 1, labels: { [uuid]: { label, editedAt } } }`.
// Durable and user-authored, unlike the disposable `organizations.json` beside
// it (./organizations.ts): deleting that one costs plan words and Connect's
// seed until a later login or Connect relearns them, and first-seen times,
// which are lost — each Organization is re-stamped at the later moment it is
// next seen; deleting this one loses what the user typed. So it holds nothing
// that can be re-derived.
// Each entry carries its own `editedAt` (ISO), and a cleared label stays as a
// tombstone (`label: null`) rather than being deleted, so the Hub's
// Organization directory (#288, ADR-0105 §8) can merge copies
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

export type OrganizationLabels = {
  load: () => Promise<void>;
  // The user's label, or null when never set, cleared, or not one the rename
  // rules would accept — so the resolved default applies.
  get: (uuid: string) => string | null;
  // Every entry, tombstones included, by uuid, each as stored. The live map:
  // callers only read it.
  entries: () => ReadonlyMap<string, Readonly<OrganizationLabelEntry>>;
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
    incoming: Record<string, OrganizationLabelEntry>,
  ) => Promise<{ wrote: boolean; labelChanged: boolean }>;
};

export function createOrganizationLabels(opts: {
  path: string;
  now?: () => number;
}): OrganizationLabels {
  const now = opts.now ?? Date.now;
  const known = new Map<string, OrganizationLabelEntry>();

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
        console.warn(
          `[sidecar] organization-labels.json could not be read; starting empty: ${err}`,
        );
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
      console.warn("[sidecar] organization-labels.json unreadable; starting empty (kept .bak)");
      return;
    }
    // A bad entry is a bounded loss of one label; it leaves the disk at the
    // next write.
    let skipped = 0;
    for (const [uuid, candidate] of Object.entries(file.labels)) {
      const parsed = organizationLabelEntrySchema.safeParse(candidate);
      if (parsed.success && organizationUuidKeySchema.safeParse(uuid).success) {
        known.set(uuid, parsed.data);
      } else {
        skipped += 1;
      }
    }
    if (skipped > 0) {
      console.warn(
        `[sidecar] organization-labels.json: skipped ${skipped} unreadable ${skipped === 1 ? "entry" : "entries"}`,
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
    incoming: Record<string, OrganizationLabelEntry>,
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
    const check = checkOrganizationLabel(label);
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
