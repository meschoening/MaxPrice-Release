import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Stable per-machine identity (ADR-0035): sent as x-maxprice-machine on every
// hub request — today informational, tomorrow the key the usage-event sync
// attributes data by. A plain UUID file beside usage-history.jsonl; NOT in
// settings.json (it is app infrastructure, not user config).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function loadOrCreateMachineId(path: string): string {
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (UUID_RE.test(existing)) return existing;
  } catch {
    // missing — fall through to create
  }
  const id = crypto.randomUUID();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${id}\n`);
  } catch (err) {
    console.warn("[sidecar] machine-id persist failed (using ephemeral id):", err);
  }
  return id;
}
