// Exported via a package.json subpath solely for the sidecar fleet test rig (apps/sidecar/src/test-hub.ts) — keep signatures stable, a cross-app test contract.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { hubMachineSchema, type HubMachine } from "@maxprice/shared";

// The hub-persisted machine directory (ADR-0041): machineId → {name,
// registeredAt, mergedInto}, its own small file beside events.jsonl, atomic
// whole-file rewrite. Events never carry names — ids resolve at render time
// (the project-slug pattern). Registration is implicit on any authenticated
// contact; the default name is the self-reported hostname FROZEN at
// registration (lightly cleaned; machine-<prefix> fallback), never silently
// re-adopted (a replacement machine must not swallow another's history).
// Names are unique, enforced case-insensitively at write time: registration
// collisions get a numeric suffix, renames get a 409 upstream. `mergedInto`
// stays null until M7's merge route; it persists now so M7 is additive.

const directoryFileSchema = z.object({ machines: z.array(hubMachineSchema) }).passthrough();

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
  remove: (machineId: string) => boolean;
  has: (machineId: string) => boolean;
  list: () => HubMachine[];
};

export function createMachineDirectory(opts: {
  path: string;
  nowImpl?: () => string;
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
  if (rawBytes !== null) {
    let loaded = false;
    try {
      const parsed = directoryFileSchema.safeParse(JSON.parse(rawBytes));
      if (parsed.success) {
        for (const m of parsed.data.machines) machines.set(m.machineId, m);
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
        `[hub] machine-directory.json was unreadable — starting a fresh directory (original preserved at ${path}.bak)`,
      );
    }
  }

  // Atomic whole-file rewrite (the config.ts writeConfig pattern): tmp +
  // rename so a crash mid-write never truncates the directory.
  function persist(): void {
    const serialized = `${JSON.stringify({ machines: [...machines.values()] }, null, 2)}\n`;
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, serialized);
    renameSync(tmp, path);
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
    remove: (machineId) => {
      if (!machines.has(machineId)) return false;
      machines.delete(machineId);
      // Null dangling aliases: an entry merged into the purged id becomes
      // standalone again — its rows survive (purge is never name-transitive)
      // and must not fold into a name that no longer exists.
      for (const [id, m] of machines) {
        if (m.mergedInto === machineId) machines.set(id, { ...m, mergedInto: null });
      }
      persist();
      return true;
    },
    has: (machineId) => machines.has(machineId),
    list: () => [...machines.values()].map((m) => ({ ...m })),
  };
}
