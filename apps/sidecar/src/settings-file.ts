import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { settingsSchema, type Settings } from "@maxprice/shared";

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

// Full parsed Settings from settings.json, or null on a missing/unparseable
// file (transient mid-write states included — callers retry on the next
// watch event, ADR-0014). parseSettings never throws; the null here is only
// for unreadable/invalid-JSON files.
export function readSettingsFile(path: string): Settings | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const result = settingsSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

// Read `claudePaths` from settings.json, tilde-expanded. Returns null on a
// missing or unparseable file — the caller (index.ts) then falls back to
// resolveWatchRoots($CLAUDE_CONFIG_DIR). Malformed JSON is expected
// transiently (a write in flight); the caller retries (ADR-0014).
export function readClaudePathsFromSettings(path: string): string[] | null {
  const s = readSettingsFile(path);
  return s === null ? null : s.claudePaths.map(expandTilde);
}

// The tracked set (the #260 lifecycle decision, items 1 and 2): the
// Organizations whose usage this machine counts, as the persisted
// `trackedOrganizations` list UNION the Home organization. This generalises
// ADR-0098's single Home organization (#275); #299 is the slice that records
// it in the ADR. Computed fresh on every settings read — boot and the settings
// watch — so the union is enforced against a hand-edited file rather than
// trusted from it.
//
// Returns `null` exactly when `home` is null, and `null` means NOTHING is
// excluded. That is today's no-Home behaviour, the mode the golden corpus runs
// in, and the mode the first-launch selection walk needs. A non-empty list with
// no Home is null too: Home anchors the set, Home is null only before the
// first-launch seed, and that walk has to see the whole corpus to choose one
// (`prepareOrganizationStore`).
export function resolveTrackedOrganizations(
  home: string | null,
  tracked: readonly string[],
): ReadonlySet<string> | null {
  if (home === null) return null;
  const set = new Set<string>([home]);
  for (const uuid of tracked) if (uuid !== "") set.add(uuid);
  return set;
}
