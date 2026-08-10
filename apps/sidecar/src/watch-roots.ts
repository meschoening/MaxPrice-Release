import { join } from "node:path";
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
  // this to a real existsSync + isDirectory check.
  dirExists: (path: string) => boolean;
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
export function resolveWatchRoots(params: ResolveWatchRootsParams): string[] {
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
    if (dirExists(path)) roots.push(path);
  }
  return roots;
}
