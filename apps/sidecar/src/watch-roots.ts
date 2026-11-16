import { join, resolve } from "node:path";
import { DEFAULT_CLAUDE_PATHS } from "@maxprice/shared";

// Expand a leading `~` in a tilde path to an absolute path under `homedir`,
// splitting the remainder on "/" so the segments are re-joined with the
// per-OS separator (matching the previous join()-based construction). Paths
// without a leading `~` are returned unchanged.
function expandTilde(path: string, homedir: string): string {
  if (path === "~") return homedir;
  if (path.startsWith("~/")) return join(homedir, ...path.slice(2).split("/"));
  return path;
}

export type ResolveWatchRootsParams = {
  // Raw $CLAUDE_CONFIG_DIR — may be undefined, empty, or comma-separated.
  configDir: string | undefined;
  homedir: string;
  // Injected so the resolver stays pure and unit-testable. Production wires
  // this to a real `stat` + isDirectory check — ASYNCHRONOUS, because these
  // are the user's own claudePaths and may live on a network mount, where a
  // synchronous stat that does not return would stop the event loop (issue
  // #183, the audit).
  dirExists: (path: string) => Promise<boolean>;
};

// Resolve the JSONL project roots chokidar should watch. $CLAUDE_CONFIG_DIR
// (comma-separated allowed) names config dirs whose `projects/` subdir holds
// the per-project session files; with it unset we fall back to Claude Code's
// two standard locations (modern XDG + legacy), derived by tilde-expanding the
// shared DEFAULT_CLAUDE_PATHS (the single source of truth — already including
// the `projects` suffix, so the fallback skips the per-dir append the env-var
// branch still does). Mirrors how Claude Code itself lays out the data. Non-existent
// candidates are dropped, so the watcher only ever sees real directories and
// the status bar reflects what's actually live.
export async function resolveWatchRoots(params: ResolveWatchRootsParams): Promise<string[]> {
  const { configDir, homedir, dirExists } = params;

  const candidates =
    configDir && configDir.trim() !== ""
      ? configDir
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
          .map((dir) => join(dir, "projects"))
      : DEFAULT_CLAUDE_PATHS.map((path) => expandTilde(path, homedir));

  const seen = new Set<string>();
  const roots: string[] = [];
  for (const path of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (await dirExists(path)) roots.push(path);
  }
  return roots;
}

// The `projects` directories `$CLAUDE_CONFIG_DIR` names that a listed
// `claudePaths` leaves out (#679). `listed` is the settings file's list,
// tilde-expanded, or null when the file names no `claudePaths` (or there is no
// file): the variable then decides the roots itself (ADR-0122 §5), so nothing
// is left out. `configDirRoots` is `resolveWatchRoots` with the variable set,
// the existing directories only; an unset variable is no roots. Compared as
// resolved paths, so a trailing separator or a `..` does not hide a match.
export function unlistedConfigDirRoots(
  configDirRoots: readonly string[],
  listed: readonly string[] | null,
): string[] {
  if (listed === null) return [];
  const named = new Set(listed.map((path) => resolve(path)));
  return configDirRoots.filter((root) => !named.has(resolve(root)));
}
