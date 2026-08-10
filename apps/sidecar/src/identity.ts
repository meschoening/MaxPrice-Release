import { basename, isAbsolute, relative, sep } from "node:path";

// Map a JSONL file path to the `(projectSlug, sessionId)` pair the event store
// tags every event with. Claude Code lays sessions out two ways:
//   - flat:     `<root>/<project-slug>/<session-id>.jsonl`
//   - subagent: `<root>/<project-slug>/<session-id>/subagents/agent-*.jsonl`
// A subagent transcript belongs to its parent `<session-id>` — reports key
// subagent usage onto the parent session UUID, and the engine matches that.
//
// This is the single source of that derivation: the watcher's `flush` (tagging
// incrementally appended events) and the engine store's `scan` (tagging the
// initial full-scan events) both call it. They MUST agree — the store dedups
// by `(messageId, requestId)`, so if the two paths derived a different
// `projectSlug`/`sessionId` for the same logical event, the projects/sessions
// aggregators would split it across two buckets depending on arrival path.
export function identityFromPath(
  path: string,
  roots: string[],
): { projectSlug: string; sessionId: string } {
  for (const root of roots) {
    const rel = relative(root, path);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      const segments = rel.split(sep);
      // `<slug>/<session>.jsonl` and the deeper subagent layout share one
      // rule: the session identity is the path segment directly under the
      // slug. In the flat form that segment is the `.jsonl` file itself; in
      // the subagent form it is the `<session-id>` directory. Stripping a
      // trailing `.jsonl` (a no-op on the directory form) covers both.
      if (segments.length >= 2) {
        return {
          projectSlug: segments[0] ?? "",
          sessionId: stripJsonl(segments[1] ?? ""),
        };
      }
      // A loose file directly under a root — no project slug.
      return { projectSlug: "", sessionId: stripJsonl(segments[0] ?? "") };
    }
  }
  // Outside every known root — best-effort session id from the filename.
  return { projectSlug: "", sessionId: stripJsonl(basename(path)) };
}

function stripJsonl(name: string): string {
  return name.replace(/\.jsonl$/, "");
}
