import { slugFromPath, slugToPath } from "@maxprice/shared";

// Part 4.5 — slug → real working-directory path, derived from stored events.
//
// `/api/daily-by-project` (E5) and `/api/projects` (E7) each ship a project's
// real `path` alongside its slug-keyed data (ADR-0009 — the Claude Code
// project slug is a lossy `/`-and-`.`-collapsed encoding that can't be
// reversed to a path). The faithful path is the JSONL `cwd`, and every
// `StoredEvent` already carries it — so unlike the old file-reading
// `project-paths.ts` resolver, the engine derivation is a *pure* function over
// data the aggregator already holds.
//
// `cwd` is immutable per project in practice, so any one event's `cwd`
// suffices; an event whose `cwd` is absent (older history records omit it) is
// skipped. A slug with no `cwd` anywhere falls back to the lossy `slugToPath`,
// so a `path` is always a non-empty string.

// Resolve one project's real path from an already-captured first non-empty
// `cwd`. Every aggregator that emits a project path folds its events in
// `byTimestamp` order and captures that scalar as it goes (`foldSlugEvent`,
// `foldSessionEvent`, `foldProjectEvent`), so none of them retains the member
// events just to read one field at flush. Falls back to the lossy
// `slugToPath(slug)` when no event carried a `cwd`, so a `path` is always a
// non-empty string.
export function resolveProjectPath(slug: string, cwd?: string): string {
  return cwd !== undefined && cwd !== "" ? cwd : slugToPath(slug);
}

// A bucket's running answer to "which directory does this slug name?".
//
// WHY THIS IS NOT JUST THE FIRST `cwd`. The original derivation took the first
// non-empty `cwd` in timestamp order, resting on the assumption that `cwd` is
// immutable per project. It is not: a worktree session starts in the parent
// repo and switches cwd mid-session (`EnterWorktree`), and ordinary work
// wanders into subdirectories. So the first `cwd` routinely names the parent
// repo, a sibling worktree, or a subfolder — and because every worktree of one
// repo then resolved to that same parent path, N distinct slugs collapsed onto
// ONE displayed identity and rendered as N identical-looking rows.
//
// The slug itself is the disambiguator. It is a pure function of the directory
// (`slugFromPath`), so the true `cwd` is the observed one that encodes back to
// the slug — exact, not heuristic.
//
// `exact` records that such a match has landed, which both pins the answer
// against later wandering and lets the hot fold skip all further work for the
// bucket.
export type PathCapture = { path: string | undefined; exact: boolean };

export function emptyPathCapture(): PathCapture {
  return { path: undefined, exact: false };
}

// Fold one event's `cwd` into a bucket's capture. Callers present events in
// timestamp order, so the retained fallback is still the first `cwd` seen —
// preserving the old behaviour for any slug whose directory is never observed
// (a renamed or since-deleted folder), while an exact match upgrades it.
export function capturePath(c: PathCapture, slug: string, cwd: string | undefined): void {
  if (c.exact || !cwd) return;
  if (c.path === undefined) c.path = cwd;
  // `slugFromPath` replaces each non-alphanumeric CODE UNIT with exactly one
  // "-", so it is length-preserving: a cwd of a different length provably
  // cannot encode to this slug. The O(1) guard makes the regex a cost only
  // plausible candidates pay — a bucket whose directory was renamed or deleted
  // never latches `exact`, and would otherwise re-run it for every event it
  // ever folds, in each of the four hot folds. Equivalent, not an
  // approximation; pinned by the length property test in packages/shared.
  if (cwd.length === slug.length && slugFromPath(cwd) === slug) {
    c.path = cwd;
    c.exact = true;
  }
}
