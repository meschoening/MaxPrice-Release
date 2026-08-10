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
