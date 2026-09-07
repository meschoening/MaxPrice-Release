import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  activePricingSnapshot,
  setActivePricingSnapshot,
  pricingSnapshot,
  type PricingSnapshot,
  parsePricingSnapshot,
} from "@maxprice/shared";

const MAX_BYTES = 32 * 1024 * 1024;

export async function loadPricingCache(path: string): Promise<void> {
  try {
    const file = await open(path, "r");
    let text: string;
    try {
      if ((await file.stat()).size > MAX_BYTES) throw new Error("pricing cache is too large");
      text = await file.readFile("utf8");
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("pricing cache is too large");
    } finally {
      await file.close();
    }
    const snapshot = parsePricingSnapshot(JSON.parse(text));
    const captured = Date.parse(snapshot.capturedAt);
    if (captured > Date.now()) throw new Error("pricing cache is dated in the future");
    if (Object.keys(snapshot.models).length < Object.keys(pricingSnapshot.models).length * 0.5) {
      throw new Error("pricing cache is below the bundled completeness floor");
    }
    if (captured > Date.parse(activePricingSnapshot().capturedAt))
      setActivePricingSnapshot(snapshot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        "[sidecar] pricing cache ignored:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

export async function savePricingCache(path: string, snapshot: PricingSnapshot): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, JSON.stringify(snapshot), { flag: "wx" });
    await rename(temporary, path);
  } catch (err) {
    // A disk failure must not undo working in-memory prices or report the fetch as failed.
    console.warn(
      "[sidecar] pricing cache could not be saved:",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
