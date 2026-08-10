// Display helpers for a project's real working-directory path.
//
// Claude Code names each project *directory* after the absolute cwd with every
// "/" and "." replaced by "-" (`/Users/dev/.config/foo-bar` → `-Users-dev--config-foo-bar`).
// That slug is lossy — a literal "-" in a folder name is indistinguishable from
// a path separator — so it is NOT a path source. The faithful path comes from
// the JSONL `cwd` field, resolved sidecar-side and carried on the wire as the
// `path` field of ProjectRow / SessionRow (ADR-0009). These helpers operate on
// that real path, not the slug.

// Slug → slash-joined path by replacing every "-" with "/". Lossy and
// best-effort — used only as the sidecar's cold-cache / no-`cwd` fallback so a
// `path` is always present. Not for general display.
export function slugToPath(slug: string): string {
  return slug.replace(/-/g, "/");
}

// Path → Claude Code project slug: every non-alphanumeric character becomes a
// "-". This is the FORWARD direction of the lossy encoding `slugToPath` can
// only guess at, and unlike that guess it is exact — which makes it a reliable
// test for "is this cwd the directory the slug names?".
//
// The rule is deliberately broader than the separators. Verified against a
// 55-slug corpus spanning macOS, Windows and an external volume, where it
// reproduced every slug: separators (`/`, `\`), the Windows drive colon, the
// dots in `.claude`, and also underscores (`MS_RESEARCH` → `MS-RESEARCH`) and
// spaces (`MM Paper Exp Protocols` → `MM-Paper-Exp-Protocols`).
export function slugFromPath(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

// Either platform's path separator. Windows `cwd` values arrive
// backslash-separated (`D:\git\MaxPrice`), and a fleet client renders rows from
// every machine at once, so both forms have to be handled on every host —
// `process.platform` is the WRONG discriminator here.
const SEPARATOR = /[/\\]/;

// ---------------------------------------------------------------------------
// Worktree membership
// ---------------------------------------------------------------------------

// Claude Code's `EnterWorktree` (and the superpowers worktree skill) plant every
// worktree under `<repo>/.claude/worktrees/<name>`, so a worktree gets its own
// cwd, its own slug, and — before this — its own project row. One repo could
// occupy a dozen rows that were individually correct yet collectively unreadable.
//
// WHY A PATH RULE AND NOT GIT. A worktree's directory is routinely deleted the
// moment its branch merges — of the five MaxPrice worktrees in the live corpus,
// four are gone and the survivor is an empty husk `git worktree list` no longer
// knows about — while its usage history lives forever. Anything that has to ask
// the filesystem (or `git`) therefore answers "not a worktree" for exactly the
// rows that need folding most, and can never answer at all for a fleet row whose
// path lives on another machine. The path is the only evidence that survives.
//
// The marker below is in SLUG space, which is not a shortcut: `slugFromPath`
// maps every non-alphanumeric to "-", so `/.claude/worktrees/` encodes to
// `--claude-worktrees-` and cutting at the marker in slug space gives exactly
// the parent's slug. `parentProjectPath` is the path-space twin, needed only to
// name a group whose parent has no row of its own; the two commute, which is
// pinned as a test.
const WORKTREE_SLUG_MARKER = "--claude-worktrees-";
const WORKTREE_PATH_MARKER = /[/\\]\.claude[/\\]worktrees[/\\]/;

// The slug of the project a worktree belongs to — itself, for anything that is
// not a worktree. Cuts at the FIRST marker, so a worktree nested inside another
// worktree folds all the way out to the repository that owns both.
//
// The near-miss this must not make: `D--git-MaxPrice-Hub` is a DIFFERENT
// project that shares a prefix with `D--git-MaxPrice`. Matching the full marker
// rather than the parent slug alone is what keeps them apart — the live corpus
// has real instances of this, pinned in the tests.
//
// `at <= 0` returns the slug untouched: a slug that BEGINS with the marker
// (a repository at a filesystem root) has no parent to name, and slicing would
// yield the empty string as an identity.
export function parentProjectSlug(slug: string): string {
  const at = slug.indexOf(WORKTREE_SLUG_MARKER);
  return at <= 0 ? slug : slug.slice(0, at);
}

// Whether a slug names a worktree rather than a project's own directory.
export function isWorktreeSlug(slug: string): boolean {
  return parentProjectSlug(slug) !== slug;
}

// The string every worktree slug of `parentSlug` begins with. Exists so the
// sidecar's filter predicate can precompute one prefix per selected project and
// then decide membership with a bare `startsWith` — no slicing, no allocation
// per event, over a corpus in the millions.
export function worktreeSlugPrefix(parentSlug: string): string {
  return parentSlug + WORKTREE_SLUG_MARKER;
}

// The directory of the project a worktree belongs to — itself, for anything
// that is not a worktree. The path-space twin of `parentProjectSlug`, used to
// derive a display name for a group whose parent directory has no project row
// (a repository worked in only through worktrees, or whose own activity falls
// outside the current date range).
export function parentProjectPath(path: string): string {
  const m = WORKTREE_PATH_MARKER.exec(path);
  return m && m.index > 0 ? path.slice(0, m.index) : path;
}

// A friendly display path: the real absolute path with a home directory
// collapsed to "~" (macOS `/Users/<name>`, Linux `/home/<name>`, Windows
// `<drive>:\Users\<name>`).
//
// The separators are deliberately left NATIVE rather than normalised. Two
// checkouts of one repo — `C:\Users\dev\Documents\git\proj` and
// `/Users/dev/Documents/git/proj` — both collapse to a "~"-prefixed remainder,
// and it is only the surviving `\` vs `/` that keeps them telling apart on a
// fleet client. Normalising separators here would silently reintroduce
// duplicate-looking rows.
export function deriveProjectPath(path: string): string {
  const home = path.match(/^\/(?:Users|home)\/[^/]+|^[A-Za-z]:\\Users\\[^\\]+/);
  if (home) {
    const rest = path.slice(home[0].length);
    return rest ? `~${rest}` : "~";
  }
  return path;
}

// A short human name for a project: the leaf segment of the real path. Dashes
// and dots in the folder name are preserved, since this splits on separators
// only — a Windows path yields its folder, not the whole `D:\git\...` string.
export function deriveProjectName(path: string): string {
  const segments = path.split(SEPARATOR).filter((s) => s.length > 0);
  return segments.length > 0 ? (segments[segments.length - 1] as string) : path;
}
