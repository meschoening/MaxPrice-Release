import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  ORGANIZATION_ASSERTION_DIRECTORY_MAX,
  mergeNewestWins,
  organizationAssertionEntrySchema,
  sessionIdKeySchema,
  type OrganizationAssertionEntry,
  type OrganizationsResponse,
} from "@maxprice/shared";
import { sameAssertions, withAssertions, type Presumption } from "./engine/presumption";

// organization-assertions.json — the user's Organization assertions (#310,
// ADR-0107 §11): `{ version: 1, assertions: { [sessionId]: { organizationUuid,
// editedAt } } }`. Durable and user-authored, like organization-labels.json
// beside it, whose mechanics it copies: each entry carries its own `editedAt`,
// a cleared claim stays as a tombstone (`organizationUuid: null`) so an older
// copy can never resurrect it, and the file is salvaged entry by entry. The
// fleet pushes these entries to the Hub's Organization assertion directory and
// adopts its union back through `merge`, so the file also holds claims made on
// other machines; a machine with no Hub works from this file alone. The engine
// never sees an edit time or a tombstone: main() installs `resolved()` into
// the presumption cell (engine/presumption.ts, `withAssertions`).

// Entries stay `unknown` so ONE bad entry can't empty the whole file — each is
// parsed (and dropped) individually at load, under the one entry schema the
// wire and the Hub's file share.
const assertionsFileSchema = z.object({
  version: z.literal(1),
  assertions: z.record(z.unknown()),
});

// What a bulk `set` did: how many sessions' entries it wrote, or "full" when
// it would have grown the file past ORGANIZATION_ASSERTION_DIRECTORY_MAX — the
// whole batch refused, nothing written.
export type OrganizationAssertionSetResult = { kind: "ok"; changed: number } | { kind: "full" };

export type OrganizationAssertions = {
  // Reads the file. Queued like `set` and `merge`, so an edit or an adoption
  // issued while it runs waits for it. Never rejects.
  load: () => Promise<void>;
  // Every entry, tombstones included, by session id, each as stored. The live
  // map: callers only read it.
  entries: () => ReadonlyMap<string, Readonly<OrganizationAssertionEntry>>;
  // sessionId → organizationUuid for every live claim — no tombstone, no edit
  // time. A FRESH map per call, never mutated afterwards: main() installs it
  // into the presumption, whose identity every report cache compares, so its
  // contents must never change under it.
  resolved: () => Map<string, string>;
  // Claims every listed session for `organizationUuid`, or clears each claim
  // (`null`), with ONE write for the batch. Duplicates collapse. A session that
  // already holds that value — or, clearing, holds no claim (absent or a
  // tombstone) — is left alone: no write, no tombstone minted, `editedAt`
  // unmoved. Each written entry is stamped max(now, its previous editedAt +
  // 1 ms), so an edit is newer than everything its editor has seen. A write
  // that fails undoes every session of the batch and rejects.
  set: (
    sessionIds: readonly string[],
    organizationUuid: string | null,
  ) => Promise<OrganizationAssertionSetResult>;
  // Adopts the Hub directory's union: each incoming entry replaces the held
  // one only when it is the newer edit (@maxprice/shared's newest-wins). The
  // entries must already be parsed with the entry schema. `wrote` when any
  // entry changed (one write); `assertionChanged` when some session's resolved
  // Organization did — an `editedAt` that moved alone, or a tombstone for a
  // session with no claim, is not. A write that fails rejects and restores
  // every changed entry.
  merge: (
    incoming: Record<string, OrganizationAssertionEntry>,
  ) => Promise<{ wrote: boolean; assertionChanged: boolean }>;
};

export function createOrganizationAssertions(opts: {
  path: string;
  now?: () => number;
}): OrganizationAssertions {
  const now = opts.now ?? Date.now;
  const known = new Map<string, OrganizationAssertionEntry>();

  // One load, set or merge at a time — the whole of it: the comparison, the
  // change, the write and, on failure, the undo. An undo is only sound when no
  // other call can land between the change and the write's outcome, and the
  // queue keeps every write off the one fixed `${path}.tmp`. The load rides it
  // too, so nothing can write a file that lacks what the load was about to
  // read. A failed call rejects its own caller and never stalls the queue.
  let chain: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  // Absent: start empty, silently. Unreadable JSON or an envelope that is not
  // `{ version: 1, assertions: {…} }`: keep the bytes as `.bak`, start empty.
  // Otherwise every entry the schema accepts loads and every other is dropped;
  // the file itself is not written here, so a dropped entry leaves the disk at
  // the first write.
  async function applyLoad(): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = await readFile(opts.path);
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
        console.warn(
          `[sidecar] organization-assertions.json could not be read; starting empty: ${err}`,
        );
      }
      return;
    }
    let file: z.infer<typeof assertionsFileSchema> | null = null;
    try {
      const parsed = assertionsFileSchema.safeParse(JSON.parse(bytes.toString("utf8")));
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
      console.warn("[sidecar] organization-assertions.json unreadable; starting empty (kept .bak)");
      return;
    }
    let skipped = 0;
    for (const [sessionId, candidate] of Object.entries(file.assertions)) {
      const parsed = organizationAssertionEntrySchema.safeParse(candidate);
      if (parsed.success && sessionIdKeySchema.safeParse(sessionId).success) {
        known.set(sessionId, parsed.data);
      } else {
        skipped += 1;
      }
    }
    if (skipped > 0) {
      console.warn(
        `[sidecar] organization-assertions.json: skipped ${skipped} unreadable ${skipped === 1 ? "entry" : "entries"}`,
      );
    }
  }

  async function write(): Promise<void> {
    const tmp = `${opts.path}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, assertions: Object.fromEntries(known) }));
    await rename(tmp, opts.path);
  }

  // Puts back every entry a failed write had changed.
  function restore(previous: ReadonlyMap<string, OrganizationAssertionEntry | undefined>): void {
    for (const [sessionId, prev] of previous) {
      if (prev === undefined) known.delete(sessionId);
      else known.set(sessionId, prev);
    }
  }

  async function applySet(
    sessionIds: readonly string[],
    organizationUuid: string | null,
  ): Promise<OrganizationAssertionSetResult> {
    const nowMs = now();
    const previous = new Map<string, OrganizationAssertionEntry | undefined>();
    let added = 0;
    for (const sessionId of new Set(sessionIds)) {
      const prev = known.get(sessionId);
      if ((prev?.organizationUuid ?? null) === organizationUuid) continue;
      previous.set(sessionId, prev);
      if (prev === undefined) added += 1;
    }
    if (previous.size === 0) return { kind: "ok", changed: 0 };
    // Only a batch that adds sessions can be full. `merge` has no cap, so the
    // file may already be past it; clears and updates of held sessions add
    // nothing and still land there.
    if (added > 0 && known.size + added > ORGANIZATION_ASSERTION_DIRECTORY_MAX) {
      return { kind: "full" };
    }
    for (const [sessionId, prev] of previous) {
      // An edit is newer than everything its editor has seen: an entry adopted
      // from a machine whose clock runs ahead still loses to this one.
      const floor = prev === undefined ? -Infinity : Date.parse(prev.editedAt) + 1;
      known.set(sessionId, {
        organizationUuid,
        editedAt: new Date(Math.max(nowMs, floor)).toISOString(),
      });
    }
    try {
      await write();
    } catch (err) {
      restore(previous);
      throw err;
    }
    return { kind: "ok", changed: previous.size };
  }

  async function applyMerge(
    incoming: Record<string, OrganizationAssertionEntry>,
  ): Promise<{ wrote: boolean; assertionChanged: boolean }> {
    const { merged, changed } = mergeNewestWins(known, Object.entries(incoming));
    if (changed.length === 0) return { wrote: false, assertionChanged: false };
    const previous = new Map(changed.map((sessionId) => [sessionId, known.get(sessionId)]));
    let assertionChanged = false;
    // `known` changes in place: `entries()` hands out the live map.
    for (const sessionId of changed) {
      const next = merged.get(sessionId)!;
      if ((previous.get(sessionId)?.organizationUuid ?? null) !== next.organizationUuid) {
        assertionChanged = true;
      }
      known.set(sessionId, next);
    }
    try {
      await write();
    } catch (err) {
      restore(previous);
      throw err;
    }
    return { wrote: true, assertionChanged };
  }

  return {
    load: () => enqueue(applyLoad),
    entries: () => known,
    resolved: () => {
      const live = new Map<string, string>();
      for (const [sessionId, e] of known) {
        if (e.organizationUuid !== null) live.set(sessionId, e.organizationUuid);
      }
      return live;
    },
    set: (sessionIds, organizationUuid) => enqueue(() => applySet(sessionIds, organizationUuid)),
    merge: (incoming) => enqueue(() => applyMerge(incoming)),
  };
}

// ── main()'s writer, and the PUT's rules (#310) ──

// The assertion writer's swap, asked before it is made (#309's handoff): the
// presumption `current` with `resolved` installed through `withAssertions`, or
// null when `current` already asserts exactly that — so an unchanged pull, a
// no-op boot or an echo mints no identity and clears no report cache.
// `resolved` must be a snapshot no one mutates afterwards (`resolved()` above
// hands out a fresh map): every cache compares the presumption's identity, so
// its contents may never change under it.
export function presumptionWithAssertions(
  current: Presumption,
  resolved: ReadonlyMap<string, string>,
): Presumption | null {
  return sameAssertions(current.assertedBySession, resolved)
    ? null
    : withAssertions(current, resolved);
}

// What PUT /api/organization-assertions answers, before HTTP: how many
// sessions' entries it wrote, or which refusal (404 / 409 in the pinned error
// envelope). A failed write rejects instead (500).
export type OrganizationAssertResult =
  | { kind: "ok"; changed: number }
  | { kind: "unknown" }
  | { kind: "full" };

// The bulk set / clear behind PUT /api/organization-assertions (#310). A
// non-null target must be an Organization this machine's roster lists — any
// Organization it has seen, Tracked or Excluded (#306 item 7); a clear names
// none, so it reads no roster. Sessions are opaque: an id need not exist here,
// since archive-only history and other machines' sessions are legitimate
// targets. When the set wrote, main()'s writer installs the resolved claims
// (`install`, true when the presumption swapped), a swap is followed by the
// wholesale report invalidation, and `assertionsWritten` pushes the map to the
// Hub. `assertions.set` must wait for the store's boot load (main()'s
// `assertionsReady`).
export function createOrganizationAssert(deps: {
  roster: () => Promise<OrganizationsResponse>;
  assertions: Pick<OrganizationAssertions, "set">;
  install: () => boolean;
  invalidateReports: () => void;
  assertionsWritten: () => void;
}): (
  sessionIds: readonly string[],
  organizationUuid: string | null,
) => Promise<OrganizationAssertResult> {
  return async (sessionIds, organizationUuid) => {
    if (organizationUuid !== null) {
      const roster = await deps.roster();
      if (!roster.organizations.some((o) => o.uuid === organizationUuid)) {
        return { kind: "unknown" };
      }
    }
    const result = await deps.assertions.set(sessionIds, organizationUuid);
    if (result.kind === "full") return { kind: "full" };
    if (result.changed > 0) {
      if (deps.install()) deps.invalidateReports();
      deps.assertionsWritten();
    }
    return { kind: "ok", changed: result.changed };
  };
}
