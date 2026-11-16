// Exported via a package.json subpath solely for the sidecar fleet test rig (apps/sidecar/src/test-hub.ts) — keep signatures stable, a cross-app test contract.
import { readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { hubMachineSchema, type HubHomeMemberships, type HubMachine } from "@maxprice/shared";

// The hub-persisted machine directory (ADR-0041): machineId → {name,
// registeredAt, mergedInto, homeMemberships}, its own small file beside
// events.jsonl, atomic whole-file rewrite. Events never carry names — ids
// resolve at render time (the project-slug pattern). Registration is implicit
// on any authenticated contact; the default name is the self-reported hostname
// FROZEN at registration (lightly cleaned; machine-<prefix> fallback), never
// silently re-adopted (a replacement machine must not swallow another's
// history). Names are unique, enforced case-insensitively at write time:
// registration collisions get a numeric suffix, renames get a 409 upstream.
// `mergedInto` stays null until M7's merge route; it persists now so M7 is
// additive. `homeMemberships` is the machine's own published Home membership
// per Provider (#281, ADR-0139 §6), written only by its self PUT and stored
// verbatim; absent = never published.

const directoryFileSchema = z.object({ machines: z.array(hubMachineSchema) }).passthrough();

// The v6 directory published a Home organization alone (`homeOrganization:
// X`). ADR-0139 §6: such an entry becomes `homeMemberships: { anthropic: {
// organizationUuid: X, accountUuid: null } }`, the machine republishing its
// Account on its first v7 contact; a null one is a null map, and an entry
// that already has `homeMemberships` keeps it. The old key goes either way:
// the entry schema passes unknown keys through, so a kept one would be served
// on every GET. Pure, on the file as parsed, so the boot (below) and `restore`
// of a v6 backup (restore.ts) convert one way. `migrated` counts the entries
// it changed; at zero `file` is the input itself and nothing need be written.
export function migrateMachineDirectoryFile(raw: unknown): { file: unknown; migrated: number } {
  if (typeof raw !== "object" || raw === null || !("machines" in raw)) {
    return { file: raw, migrated: 0 };
  }
  const machines = (raw as { machines: unknown }).machines;
  if (!Array.isArray(machines)) return { file: raw, migrated: 0 };
  let migrated = 0;
  const next = machines.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !Object.hasOwn(entry, "homeOrganization")) {
      return entry;
    }
    migrated += 1;
    const { homeOrganization, ...rest } = entry as Record<string, unknown>;
    if (Object.hasOwn(rest, "homeMemberships")) return rest;
    return {
      ...rest,
      homeMemberships:
        homeOrganization === null || homeOrganization === undefined
          ? null
          : { anthropic: { organizationUuid: homeOrganization, accountUuid: null } },
    };
  });
  return migrated === 0 ? { file: raw, migrated } : { file: { ...raw, machines: next }, migrated };
}

// The file's bytes, as every write lays them out.
function machineDirectoryText(machines: readonly HubMachine[]): string {
  return `${JSON.stringify({ machines }, null, 2)}\n`;
}

// A file's text with its v6 Homes converted, laid out as the boot's own
// rewrite lays it out, for `restore` of a v6 backup (restore.ts): null when
// nothing in it migrates, or when the Hub's loader would not read it (its
// boot then keeps it as `.bak`, as before).
export function convertMachineDirectoryText(
  text: string,
): { text: string; migrated: number } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const migration = migrateMachineDirectoryFile(raw);
  if (migration.migrated === 0) return null;
  const parsed = directoryFileSchema.safeParse(migration.file);
  if (!parsed.success) return null;
  return { text: machineDirectoryText(parsed.data.machines), migrated: migration.migrated };
}

// Deterministic, frozen-at-registration cleaning: trim, strip a trailing
// .local (mDNS noise on macOS), collapse whitespace runs to "-", cap at 63
// chars. Empty result ⇒ null (caller falls back to machine-<short-id>).
function cleanHostname(raw: string | null): string | null {
  if (raw === null) return null;
  const cleaned = raw
    .trim()
    .replace(/\.local$/i, "")
    .replace(/\s+/g, "-")
    .slice(0, 63);
  return cleaned === "" ? null : cleaned;
}

export type MachineDirectory = {
  ensureRegistered: (machineId: string, hostname: string | null) => boolean;
  rename: (machineId: string, name: string) => "ok" | "collision" | "unknown";
  merge: (
    machineId: string,
    into: string,
  ) => "ok" | "self" | "cycle" | "unknown-source" | "unknown-target";
  // The machine's whole published map. Absent and null are the same "nothing
  // published": re-setting either, or a map deep-equal to the one stored, is
  // "unchanged" and rewrites nothing, since every client republishes on every
  // connect. "invalid" is a value this directory's own loader would reject
  // (an empty uuid, over the schema's cap, a Pending key): refused untouched,
  // because one entry that fails `hubMachineSchema` sends the whole file to
  // `.bak` at the next boot.
  setHome: (
    machineId: string,
    home: HubHomeMemberships | null,
  ) => "ok" | "unchanged" | "unknown" | "invalid";
  remove: (machineId: string) => boolean;
  has: (machineId: string) => boolean;
  list: () => HubMachine[];
};

export function createMachineDirectory(opts: {
  path: string;
  nowImpl?: () => string;
  writeFileImpl?: typeof writeFileSync;
}): MachineDirectory {
  const path = opts.path;
  const now = opts.nowImpl ?? (() => new Date().toISOString());
  // registeredAt insertion order preserved by the Map (list() returns copies).
  const machines = new Map<string, HubMachine>();

  // Synchronous load at construction — the file is small (one entry per
  // machine). Missing file = first boot (silent). Corrupt file: warn, keep a
  // .bak so a hand-rename isn't silently lost, start empty (config.ts's
  // warn-and-preserve posture).
  let rawBytes: string | null = null;
  try {
    rawBytes = readFileSync(path, "utf8");
  } catch {
    // ENOENT — first boot
  }
  let migrated = 0;
  if (rawBytes !== null) {
    let loaded = false;
    try {
      const migration = migrateMachineDirectoryFile(JSON.parse(rawBytes));
      const parsed = directoryFileSchema.safeParse(migration.file);
      if (parsed.success) {
        for (const m of parsed.data.machines) machines.set(m.machineId, m);
        loaded = true;
        migrated = migration.migrated;
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
        `[hub] machine-directory.json was unreadable — starting a fresh directory (original preserved at ${path}.bak)`,
      );
    }
  }

  // Atomic whole-file rewrite (the config.ts writeConfig pattern): tmp +
  // rename so a crash mid-write never truncates the directory.
  function persist(next = machines): void {
    const serialized = machineDirectoryText([...next.values()]);
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

  // A v6 file's Homes, converted once: the file is rewritten only when an
  // entry migrated, so the next boot reads a v7 file and writes nothing. A
  // failed write keeps the converted entries in memory, and the next write,
  // or the next boot's conversion, lands them; it never stops the boot.
  if (migrated > 0) {
    const homes = `the Homes of ${migrated} machine${migrated === 1 ? "" : "s"}`;
    try {
      persist();
      console.log(`[hub] machine directory: converted ${homes} to Home memberships`);
    } catch (err) {
      console.warn(
        `[hub] machine directory: could not write ${homes} converted to Home memberships: ${err}`,
      );
    }
  }

  function nameTaken(candidate: string, excludeMachineId?: string): boolean {
    const lower = candidate.toLowerCase();
    for (const m of machines.values()) {
      if (m.machineId === excludeMachineId) continue;
      if (m.name.toLowerCase() === lower) return true;
    }
    return false;
  }

  return {
    ensureRegistered: (machineId, hostname) => {
      if (machines.has(machineId)) return false;
      const base = cleanHostname(hostname) ?? `machine-${machineId.slice(0, 8)}`;
      let name = base;
      for (let suffix = 2; nameTaken(name); suffix += 1) name = `${base}-${suffix}`;
      machines.set(machineId, { machineId, name, registeredAt: now(), mergedInto: null });
      persist();
      return true;
    },
    rename: (machineId, name) => {
      const entry = machines.get(machineId);
      if (entry === undefined) return "unknown";
      if (nameTaken(name, machineId)) return "collision";
      machines.set(machineId, { ...entry, name });
      persist();
      return "ok";
    },
    merge: (machineId, into) => {
      if (!machines.has(machineId)) return "unknown-source";
      if (!machines.has(into)) return "unknown-target";
      if (machineId === into) return "self";
      // Walk the target's alias chain: landing back on the source closes a
      // loop (resolution is transitive, so a→b→c with c→a would spin forever).
      const seen = new Set<string>();
      for (
        let cur: string | null = into;
        cur !== null;
        cur = machines.get(cur)?.mergedInto ?? null
      ) {
        if (cur === machineId) return "cycle";
        if (seen.has(cur)) break; // a pre-existing loop — stop walking, allow
        seen.add(cur);
      }
      const entry = machines.get(machineId)!;
      machines.set(machineId, { ...entry, mergedInto: into });
      persist();
      return "ok";
    },
    setHome: (machineId, home) => {
      // The loader's own field, so the two can never disagree.
      const parsed = hubMachineSchema.shape.homeMemberships.safeParse(home);
      if (!parsed.success) return "invalid";
      const entry = machines.get(machineId);
      if (entry === undefined) return "unknown";
      if (isDeepStrictEqual(entry.homeMemberships ?? null, parsed.data ?? null)) return "unchanged";
      machines.set(machineId, { ...entry, homeMemberships: parsed.data ?? null });
      persist();
      return "ok";
    },
    remove: (machineId) => {
      if (!machines.has(machineId)) return false;
      const next = new Map(machines);
      next.delete(machineId);
      // Null dangling aliases: an entry merged into the purged id becomes
      // standalone again — its rows survive (purge is never name-transitive)
      // and must not fold into a name that no longer exists.
      for (const [id, m] of next) {
        if (m.mergedInto === machineId) next.set(id, { ...m, mergedInto: null });
      }
      persist(next);
      machines.clear();
      for (const [id, m] of next) machines.set(id, m);
      return true;
    },
    has: (machineId) => machines.has(machineId),
    list: () => [...machines.values()].map((m) => ({ ...m })),
  };
}
