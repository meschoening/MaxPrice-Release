import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { hubMachinesResponseSchema, type HubMachine } from "@maxprice/shared";

// ADR-0041 — the client-side [[Machine directory]] cache. A tiny RAM copy of the
// hub's authoritative directory (machineId → display name), persisted to one
// small JSON file so machine names still render when the app opens OFFLINE —
// before, or without, a hub connection. fleet.ts (Task 9) refreshes it on
// connect and on every hub:machines poke; the loopback GET /api/machines
// (Task 10) serves list().
//
// Unlike the hub's own directory (apps/hub/src/machine-directory.ts) this copy
// is DISPOSABLE: the hub is the source of truth, so a missing or corrupt file
// just starts empty and the next refresh repairs it — no .bak, no merge. The
// disk write is a pure offline nicety, so a persist failure only warns while
// RAM keeps serving.

export type MachineDirectoryCache = {
  load: () => void;
  update: (machines: HubMachine[]) => void;
  list: () => HubMachine[];
};

export function createMachineDirectoryCache(opts: { path: string }): MachineDirectoryCache {
  const path = opts.path;
  let machines: HubMachine[] = [];

  return {
    // Synchronous read at the caller's chosen moment. A MISSING file is the
    // benign first-run case (silent); a present-but-unreadable file is a genuine
    // anomaly worth a single warn. Either way we fall back to an empty list and
    // never throw — names are a nicety, and the hub will resend the directory.
    load: () => {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (err) {
        // A MISSING file is the benign first-run case (silent); a present-but-
        // unreadable one (EACCES, EIO, …) is a genuine anomaly worth a single
        // warn — matching the doc comment above. Either way, start empty.
        machines = [];
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(
            `[sidecar] machine directory cache at ${path} was unreadable — starting empty:`,
            err,
          );
        }
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        machines = [];
        console.warn(`[sidecar] machine directory cache at ${path} was corrupt — starting empty`);
        return;
      }
      const result = hubMachinesResponseSchema.safeParse(parsed);
      if (!result.success) {
        machines = [];
        console.warn(
          `[sidecar] machine directory cache at ${path} failed validation — starting empty`,
        );
        return;
      }
      machines = result.data.machines;
    },

    // The hub's list is AUTHORITATIVE — replace wholesale, never merge. RAM is
    // updated first so list() serves the fresh names even if the disk write
    // fails; the atomic tmp+rename persist (the settings-file pattern) is a pure
    // offline convenience, so a write failure only warns.
    update: (next) => {
      machines = next;
      try {
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, `${JSON.stringify({ machines }, null, 2)}\n`);
        renameSync(tmp, path);
      } catch (err) {
        console.warn(
          `[sidecar] failed to persist machine directory cache to ${path} (serving from memory):`,
          err,
        );
      }
    },

    list: () => machines,
  };
}
