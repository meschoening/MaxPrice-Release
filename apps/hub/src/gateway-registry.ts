// Exported via a package.json subpath for the fleet test rigs (the sidecar's test Hub, ADR-0141's fleet acceptance) — keep signatures stable, a cross-app test contract.
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { z } from "zod";
import { byCodeUnit, gatewayId, gatewayIdSchema, gatewayUrlSchema } from "@maxprice/shared";

// The Gateways the Hub holds (ADR-0141 §7, D9): `gateways.json` beside
// hub.json, `{ version: 1, gateways: [{ id, url }] }`, sorted by id. Not
// secret: each Gateway's management key is in the key store under its id
// (key-store.ts's HubGatewayKeyStore). The Membership assertion directory's
// mechanics, copied: loaded once at construction, rewritten whole and
// atomically (tmp + fsync + rename), a corrupt file kept as `.bak` and the
// list started empty, an unreadable entry skipped.
//
// Written only once a Gateway is connected, and removed when the last one
// goes, so a Hub that never held a Gateway has no such file.

export const GATEWAY_REGISTRY_FILE = "gateways.json";

export type RegisteredGateway = { id: string; url: string };

const entrySchema = z
  .object({ id: gatewayIdSchema, url: gatewayUrlSchema })
  .strict()
  // An entry whose id is not its URL's is not a Gateway this Hub connected.
  .refine((entry) => gatewayId(entry.url) === entry.id);
const fileSchema = z.object({ version: z.literal(1), gateways: z.array(z.unknown()) });

export type GatewayRegistry = {
  // Every registered Gateway, sorted by id, as copies.
  list: () => RegisteredGateway[];
  get: (id: string) => RegisteredGateway | null;
  // Adds the Gateway, or replaces its URL's spelling. Throws when the write
  // fails, keeping the previous list.
  set: (entry: RegisteredGateway) => void;
  // Removes it; false when it was not registered. Throws when the write
  // fails, keeping the previous list.
  remove: (id: string) => boolean;
};

export function createGatewayRegistry(opts: {
  path: string;
  writeFileImpl?: (path: string, data: string) => void;
  warn?: (line: string) => void;
}): GatewayRegistry {
  const { path } = opts;
  const warn = opts.warn ?? ((line: string) => console.warn(line));
  let gateways = new Map<string, RegisteredGateway>();

  function write(next: Map<string, RegisteredGateway>): void {
    if (next.size === 0) {
      rmSync(path, { force: true });
      return;
    }
    const sorted = [...next.values()].sort((a, b) => byCodeUnit(a.id, b.id));
    const tmp = `${path}.tmp`;
    (opts.writeFileImpl ?? writeFileSync)(
      tmp,
      `${JSON.stringify({ version: 1, gateways: sorted }, null, 2)}\n`,
    );
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }

  let raw: string | null = null;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Missing: no Gateway was ever connected (or the last one was removed).
  }
  if (raw !== null) {
    let file: z.infer<typeof fileSchema> | null = null;
    try {
      const parsed = fileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) file = parsed.data;
    } catch {
      // fall through to the recovery path
    }
    if (file === null) {
      try {
        writeFileSync(`${path}.bak`, raw);
      } catch {
        // best-effort — never block boot on the backup copy
      }
      warn(
        `[hub] ${GATEWAY_REGISTRY_FILE} unreadable; starting with no Gateway (kept ${path}.bak)`,
      );
    } else {
      let skipped = 0;
      for (const candidate of file.gateways) {
        const parsed = entrySchema.safeParse(candidate);
        if (parsed.success) gateways.set(parsed.data.id, parsed.data);
        else skipped += 1;
      }
      if (skipped > 0) {
        warn(
          `[hub] ${GATEWAY_REGISTRY_FILE}: skipped ${skipped} unreadable ${skipped === 1 ? "entry" : "entries"}`,
        );
      }
    }
  }

  return {
    list: () =>
      [...gateways.values()].sort((a, b) => byCodeUnit(a.id, b.id)).map((g) => ({ ...g })),
    get: (id) => {
      const entry = gateways.get(id);
      return entry === undefined ? null : { ...entry };
    },
    set: (entry) => {
      const next = new Map(gateways);
      next.set(entry.id, { ...entry });
      write(next);
      gateways = next;
    },
    remove: (id) => {
      if (!gateways.has(id)) return false;
      const next = new Map(gateways);
      next.delete(id);
      write(next);
      gateways = next;
      return true;
    },
  };
}
