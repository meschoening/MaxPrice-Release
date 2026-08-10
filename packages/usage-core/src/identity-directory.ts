// The Identity directory store — ONE implementation for both sides (ADR-0062
// §3), like fleet-event-store: the client sidecar holds own + mirrored fleet
// rows, the hub holds the fleet union. AUTHORITATIVE, not a disposable cache:
// a dead directory's row is irreplaceable, so this file is never casually
// wiped. Corrupt-file posture follows the hub machine-directory (.bak + warn +
// start empty) — live rows re-probe and re-pull; the other side's copy is the
// second chance for the rest.
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  adoptHubProjectMergeAssertions,
  adoptHubIdentityRows,
  identityRowKey,
  mergeIdentityRows,
  mergeProjectMergeAssertions,
  projectMergeAssertionKey,
  projectMergeAssertionSchema,
  projectIdentityRowSchema,
  type ProjectMergeAssertion,
  type ProjectIdentityRow,
} from "@maxprice/shared";

// Rows stay `unknown` here so ONE bad row can't fail the whole file — each is
// parsed (and skipped) individually below.
const fileSchema = z
  .object({
    rows: z.array(z.unknown()),
    assertions: z.array(z.unknown()).optional().default([]),
  })
  .passthrough();

export type IdentityDirectory = {
  load: () => void;
  // Is this store's RAM a faithful view of its file? False on EITHER of the two
  // ways a load can fail to reconstruct the union:
  //   • the file could not be READ at all (any non-ENOENT fault, twice) — RAM
  //     then holds only what has been probed since boot, and persists are
  //     withheld so the (possibly intact) file on disk survives untouched;
  //   • the file was read but could not be RECONSTRUCTED — corrupt JSON or a
  //     schema-rejected envelope. Writes stay ENABLED there (the .bak kept the
  //     bytes and the recreate is the documented recovery), but RAM is still a
  //     fragment rather than a view of the union.
  // A fresh (ENOENT) store IS usable — empty is the truth there. No production
  // caller re-attempts the load (the sidecar's fleet.ts loads once, the hub's
  // serve() once, the hub CLI once per one-shot process), so either latch is
  // permanent for the process and a restart is the cure.
  //
  // CALLER OBLIGATION: never serve an unusable store's rows to the fleet as a
  // union. list() cannot express the difference — an empty list from a latched
  // store is byte-identical to a genuinely empty one, and the pull semantics
  // (adoptHubIdentityRows) read an empty union as a purge instruction. The hub
  // withholds the whole route surface instead, so clients 404-degrade to
  // local-only rather than mirroring a phantom emptiness.
  usable: () => boolean;
  list: () => ProjectIdentityRow[];
  ownRows: (selfMachineId: string) => ProjectIdentityRow[];
  listAssertions: () => ProjectMergeAssertion[];
  ownAssertions: (selfMachineId: string) => ProjectMergeAssertion[];
  upsert: (rows: readonly ProjectIdentityRow[]) => boolean;
  upsertAssertions: (assertions: readonly ProjectMergeAssertion[]) => boolean;
  // User-action durability boundary (ADR-0064). Unlike probe/sync upserts,
  // this is transactional: the assertion becomes visible only after the
  // atomic file replacement succeeds, and throws on failure.
  commitAssertion: (assertion: ProjectMergeAssertion) => boolean;
  // CALLER OBLIGATION: `hubRows` must be a COMPLETED, SUCCESSFUL full-union
  // fetch. Pull semantics mirror foreign machines wholesale, so an empty array
  // is a purge instruction that deletes every foreign row — never call this
  // from an error, timeout, or partial-page path.
  adoptUnion: (
    hubRows: readonly ProjectIdentityRow[],
    hubAssertions: readonly ProjectMergeAssertion[],
    selfMachineId: string,
  ) => boolean;
  removeMachine: (machineId: string) => boolean;
};

export function createIdentityDirectory(opts: {
  path: string;
  // Test seam, mirroring fleet-event-store's: the read-fault classification
  // below is the whole point of #85's fix, so it has to be exercisable without
  // manufacturing a real EACCES.
  readFileImpl?: (path: string) => string;
  writeFileImpl?: typeof writeFileSync;
}): IdentityDirectory {
  const rows = new Map<string, ProjectIdentityRow>();
  const assertions = new Map<string, ProjectMergeAssertion>();
  const readFile = opts.readFileImpl ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFile = opts.writeFileImpl ?? writeFileSync;
  // Fail-closed latch: set when load() could not READ the file at all (any
  // fault that is not ENOENT). See persist() for what it buys.
  let loadFailed = false;
  // Content latch: the file was READ but could not be reconstructed (corrupt
  // JSON / schema-rejected envelope). RAM is a fragment, not a view of the
  // file — safe to WRITE over (backupCorrupt kept the bytes in .bak, and the
  // client's self-heal depends on that write) but NEVER safe to SERVE as a
  // union, since an absent row is a purge instruction. Deliberately a SECOND,
  // independent latch rather than reusing loadFailed: folding the two would
  // gate persist() as well and thereby kill identity persistence forever on
  // every client with a corrupt file — and unlike a lock, a corrupt file never
  // self-heals, so nothing would ever recreate it.
  let contentLost = false;

  // Atomic whole-file rewrite + fsync (the fleet-event-store writeDurable
  // pattern): these rows are authoritative and irreplaceable, so a crash
  // mid-write must never truncate the file. mkdir first — the data dir may not
  // exist yet on a first write.
  function serialize(
    nextRows: Map<string, ProjectIdentityRow> = rows,
    nextAssertions: Map<string, ProjectMergeAssertion> = assertions,
  ): string {
    return `${JSON.stringify(
      {
        rows: sortedRows(nextRows),
        assertions: sortedAssertions(nextAssertions),
      },
      null,
      2,
    )}\n`;
  }

  function writeSnapshot(
    nextRows: Map<string, ProjectIdentityRow> = rows,
    nextAssertions: Map<string, ProjectMergeAssertion> = assertions,
  ): void {
    const serialized = serialize(nextRows, nextAssertions);
    const tmp = `${opts.path}.tmp`;
    mkdirSync(dirname(opts.path), { recursive: true });
    writeFile(tmp, serialized);
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, opts.path);
  }

  function persist(): void {
    // Fail closed (#85's lesson, ADR-0062 §3 "never casually wiped"). After an
    // unreadable load, RAM holds only what has been probed since boot — and
    // this write is a whole-file REPLACE, so persisting would truncate the
    // authoritative file down to that fragment, silently destroying exactly the
    // rows nothing can re-probe (directories that no longer exist), with no
    // .bak. An AV scanner holding the file on Windows is the everyday trigger.
    // Mutators still update RAM and report their change bit; only the disk write
    // is withheld. No production caller re-attempts the load, so the latch is
    // permanent for this process — a restart is the cure. load() would not be a
    // safe retry primitive anyway: it opens with rows.clear(), so re-running it
    // would discard everything probed while the latch held.
    //
    // Gated on loadFailed ONLY, never on contentLost: a file that was READ but
    // was corrupt has its bytes in .bak already, and recreating it from the
    // rows probed since boot is the documented recovery (see usable()).
    if (loadFailed) return;
    try {
      writeSnapshot();
    } catch (err) {
      console.warn(`[usage-core] identity directory persist failed: ${String(err)}`);
    }
  }

  // ONE retry, immediately — no sleep. load() is synchronous and sits on the
  // boot path, so blocking the loop to wait out a lock is a worse failure than
  // missing the retry (the sidecar's LISTENING handshake is on a 5s budget);
  // and it is the fail-closed latch, not the retry, that makes an unreadable
  // file non-destructive. ENOENT rethrows from the first attempt — a fresh
  // store is not a fault and must not be read twice.
  function readWithOneRetry(): string {
    try {
      return readFile(opts.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err;
      console.warn(`[usage-core] identity directory read failed, retrying once: ${String(err)}`);
      return readFile(opts.path);
    }
  }

  function load(): void {
    rows.clear();
    assertions.clear();
    // Both latches describe THIS load's outcome, so both are re-derived from
    // scratch — never carried across one.
    loadFailed = false;
    contentLost = false;
    let raw: string;
    try {
      raw = readWithOneRetry();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // First launch: an empty store that may write freely.
        return;
      }
      // Unreadable twice. Come up empty in RAM but hold every write, so the
      // file on disk — which may be perfectly intact — survives untouched.
      loadFailed = true;
      console.warn(
        `[usage-core] identity directory read failed twice, starting empty and holding writes: ${String(err)}`,
      );
      return;
    }
    // The file was READ, so writes stay enabled whatever comes next: a corrupt
    // parse keeps a .bak and the next write legitimately recreates the file.
    // That is exactly why the two questions are split — "may I write this file"
    // (yes) and "is my RAM a faithful view of the union" (no, once backupCorrupt
    // fires, which is what sets contentLost).
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      backupCorrupt();
      return;
    }
    const file = fileSchema.safeParse(parsed);
    if (!file.success) {
      backupCorrupt();
      return;
    }
    // Per-row leniency is DELIBERATE, and stops deliberately short of
    // contentLost: a whole-file corruption is an UNBOUNDED loss of the union
    // (serving that emptiness purges the fleet), while one schema-rejected row
    // is a BOUNDED loss of exactly one row — letting it disable fleet identity
    // sync would be the bigger regression. Warn, though: this store is
    // authoritative and irreplaceable, so a dropped row must never be silent.
    for (const candidate of file.data.rows) {
      const r = projectIdentityRowSchema.safeParse(candidate);
      if (r.success) {
        rows.set(identityRowKey(r.data), r.data);
      } else {
        const why = r.error.issues.map((i) => `${i.path.join(".") || "(row)"}: ${i.message}`);
        console.warn(
          `[usage-core] identity directory: skipping unparseable row in ${opts.path} — ${why.join("; ")}`,
        );
      }
    }
    for (const candidate of file.data.assertions) {
      const parsedAssertion = projectMergeAssertionSchema.safeParse(candidate);
      if (parsedAssertion.success) {
        assertions.set(projectMergeAssertionKey(parsedAssertion.data), parsedAssertion.data);
      } else {
        const why = parsedAssertion.error.issues.map(
          (i) => `${i.path.join(".") || "(assertion)"}: ${i.message}`,
        );
        console.warn(
          `[usage-core] identity directory: skipping unparseable assertion in ${opts.path} — ${why.join("; ")}`,
        );
      }
    }
  }

  function backupCorrupt(): void {
    try {
      copyFileSync(opts.path, `${opts.path}.bak`);
    } catch {
      // best effort — never block startup on the backup copy
    }
    // The file was readable but its CONTENT is gone: writes stay enabled (the
    // .bak holds the bytes, and the recreate below is the recovery), but this
    // RAM must never be served to the fleet as a union. Setting the latch here
    // rather than at the two call sites covers the JSON.parse and the envelope
    // branch by construction.
    contentLost = true;
    console.warn(
      `[usage-core] identity directory corrupt ${opts.path} — backed up to .bak, starting empty`,
    );
  }

  // Stable (machineId, projectSlug) order, on disk as well as in memory, so an
  // unchanged directory serializes to identical bytes.
  function sortedRows(source = rows): ProjectIdentityRow[] {
    return [...source.values()].sort((a, b) =>
      a.machineId === b.machineId
        ? a.projectSlug.localeCompare(b.projectSlug)
        : a.machineId.localeCompare(b.machineId),
    );
  }

  function sortedAssertions(source = assertions): ProjectMergeAssertion[] {
    return [...source.values()].sort((a, b) =>
      a.authorMachineId === b.authorMachineId
        ? a.source.anchor.localeCompare(b.source.anchor)
        : a.authorMachineId.localeCompare(b.authorMachineId),
    );
  }

  // Copies — a caller must not be able to mutate the store's live rows
  // (machine-directory's list() posture).
  function list(): ProjectIdentityRow[] {
    return sortedRows().map((r) => ({ ...r }));
  }

  function listAssertions(): ProjectMergeAssertion[] {
    return sortedAssertions().map((a) => ({
      ...a,
      source: { ...a.source },
      target: a.target === null ? null : { ...a.target },
    }));
  }

  return {
    load,
    usable: () => !loadFailed && !contentLost,
    list,
    ownRows: (self) => list().filter((r) => r.machineId === self),
    listAssertions,
    ownAssertions: (self) =>
      listAssertions().filter((assertion) => assertion.authorMachineId === self),
    upsert: (incoming) => {
      const changed = mergeIdentityRows(rows, incoming);
      if (changed) persist();
      return changed;
    },
    upsertAssertions: (incoming) => {
      const changed = mergeProjectMergeAssertions(assertions, incoming);
      if (changed) persist();
      return changed;
    },
    commitAssertion: (assertion) => {
      if (loadFailed || contentLost)
        throw new Error("identity directory is degraded; restart before changing project merges");
      const next = new Map(assertions);
      const changed = mergeProjectMergeAssertions(next, [assertion]);
      if (!changed) return false;
      // Write FIRST. A throw leaves the live map byte-for-byte unchanged.
      writeSnapshot(rows, next);
      assertions.clear();
      for (const [key, value] of next) assertions.set(key, value);
      return true;
    },
    adoptUnion: (hubRows, hubAssertions, self) => {
      const rowResult = adoptHubIdentityRows(rows, hubRows, self);
      const assertionResult = adoptHubProjectMergeAssertions(assertions, hubAssertions, self);
      if (rowResult.changed || assertionResult.changed) {
        rows.clear();
        for (const [k, r] of rowResult.rows) rows.set(k, r);
        assertions.clear();
        for (const [k, assertion] of assertionResult.assertions) assertions.set(k, assertion);
        persist();
      }
      return rowResult.changed || assertionResult.changed;
    },
    removeMachine: (machineId) => {
      let changed = false;
      for (const [k, r] of rows)
        if (r.machineId === machineId) {
          rows.delete(k);
          changed = true;
        }
      if (changed) persist();
      return changed;
    },
  };
}
