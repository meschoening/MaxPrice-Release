// The Repo identity probe (ADR-0062 §2) — a pure file read, never a spawned
// git (ADR-0010). Walk up from the project path to the first `.git`; follow
// the gitdir:/commondir indirection when it is a file (worktrees, submodules);
// read [remote "origin"] url out of the plain-INI config.
//
// Two outcomes, deliberately distinct: "probed" is a DEFINITE answer (repoId
// or a definite no-origin null) that may overwrite a persisted row;
// "unreachable" (missing dir, EACCES, torn read, metadata that isn't a modest
// regular file — see `readGitMetadata`) never touches one — that is
// the entire point of persistence, because a probe answers "now" and
// directories die.
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { repoIdFromRemote } from "@maxprice/shared";

export type ProbeResult = { kind: "probed"; repoId: string | null } | { kind: "unreachable" };

// A `.git` file, a `commondir`, and a `config` are all kilobyte-scale TEXT.
// Anything else at those paths is not ours to read: after the first
// indirection the path chain is derived from BYTES INSIDE the project
// directory (a tarball can ship a `.git` file AND a FIFO — GNU tar extracts
// FIFO entries by default), and readFileSync on a FIFO blocks this process's
// one loop forever, on `open(2)`, waiting for a writer that never comes — at
// boot, on every rescan, and on every first-seen slug, with no timeout and no
// recovery. The existing catch cannot help: this blocks, it does not throw.
// Regular file, modest size, or we treat the whole probe as unreachable.
//
// Note the only other type check in this module is `isDirectory()`, which
// discriminates directory vs EVERYTHING else — so a FIFO, socket, or device
// named `.git` takes the indirection branch, where the first read below
// rejects it. Stat-then-read is TOCTOU in principle; it converts an indefinite
// hang into a bounded read in every non-racing case, which is the whole of the
// exposure.
const MAX_GIT_METADATA_BYTES = 1024 * 1024;

function readGitMetadata(path: string): string {
  const st = statSync(path, { throwIfNoEntry: false });
  if (st === undefined || !st.isFile() || st.size > MAX_GIT_METADATA_BYTES) {
    throw new Error(`not readable git metadata: ${path}`);
  }
  return readFileSync(path, "utf8");
}

// git-config VALUE grammar, and it lives here rather than in @maxprice/shared's
// `repo-id.ts` on purpose: that module owns URL grammar, this one owns the file
// the URLs are read out of. A later tidy that merged the two would put git's
// comment and quoting rules in front of every remote string in the app.
//
// git strips an unquoted trailing `#`/`;` comment and unwraps quotes — and it
// WRITES the quoted form itself whenever a value contains a `#`, so both
// spellings are ordinary config that git reads identically. Carrying the
// trivia into the key would stop two checkouts of one repo folding over
// punctuation: `…/bar.git # primary` no longer matches the `.git` strip, and a
// leading `"` rides the scp user-part group straight into the key.
function cleanConfigValue(raw: string): string {
  let out = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string;
    if (c === "\\") {
      // Only `\"` and `\\` can plausibly appear in a remote URL; any other
      // backslash keeps itself, since a Windows-flavored path is likelier here
      // than git's `\n`/`\t` escapes.
      const next = raw[i + 1];
      if (next === '"' || next === "\\") {
        out += next;
        i++;
      } else {
        out += c;
      }
      continue;
    }
    // Quoting is per-RUN, not whole-value: git accepts `a" "b`, so the flag
    // toggles and the quote characters themselves are simply dropped.
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (c === "#" || c === ";")) break;
    out += c;
  }
  return out.trim();
}

export function originUrlFromConfig(config: string): string | null {
  let inOrigin = false;
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const m = /^url\s*=\s*(.+)$/i.exec(line);
    if (m === null) continue;
    // A value that is nothing but a comment is "no origin url", the same
    // definite answer as no `url` key at all — and the same one `repoIdFromRemote`
    // would reach from an empty string, just typed honestly.
    const url = cleanConfigValue(m[1] as string);
    return url === "" ? null : url;
  }
  return null;
}

// The config path for a `.git` that is a FILE: `gitdir: <p>` (relative to the
// worktree) names the per-worktree git dir; its `commondir` file (relative to
// THAT dir) names the shared .git holding the real config. A submodule's git
// dir has no commondir and carries its own config — also correct.
function configPathViaIndirection(dotGitFile: string, worktreeRoot: string): string {
  const gitdirLine = readGitMetadata(dotGitFile).trim();
  const m = /^gitdir:\s*(.+)$/.exec(gitdirLine);
  if (m === null) throw new Error(`unrecognized .git file at ${dotGitFile}`);
  const gitDir = resolve(worktreeRoot, (m[1] as string).trim());
  const commondirFile = join(gitDir, "commondir");
  // ABSENCE is the normal no-indirection case (a submodule's git dir carries
  // its own config), so it stays a plain existence question; anything that IS
  // there goes through the same guard as every other read.
  if (statSync(commondirFile, { throwIfNoEntry: false }) === undefined) {
    return join(gitDir, "config");
  }
  const common = resolve(gitDir, readGitMetadata(commondirFile).trim());
  return join(common, "config");
}

export function probeRepoId(projectPath: string): ProbeResult {
  try {
    if (!statSync(projectPath, { throwIfNoEntry: false })?.isDirectory()) {
      return { kind: "unreachable" };
    }
    const start = resolve(projectPath);
    let dir = start;
    for (;;) {
      const dotGit = join(dir, ".git");
      const st = statSync(dotGit, { throwIfNoEntry: false });
      if (st !== undefined) {
        const configPath = st.isDirectory()
          ? join(dotGit, "config")
          : configPathViaIndirection(dotGit, dir);
        const url = originUrlFromConfig(readGitMetadata(configPath));
        if (url === null) return { kind: "probed", repoId: null };
        // The subpath is the remainder below the RESOLVED toplevel `dir`, never
        // derived from the project path alone: `normalizeSubpath` strips leading
        // separators, so an absolute "subpath" would mint a plausible-looking
        // key that folds nothing.
        const sub = relative(dir, start);
        return {
          kind: "probed",
          repoId: repoIdFromRemote(url, sub.startsWith("..") ? "" : sub),
        };
      }
      const parent = dirname(dir);
      if (parent === dir) return { kind: "probed", repoId: null };
      dir = parent;
    }
  } catch {
    // A `.git` that exists but whose config read throws (EACCES, missing
    // config) lands here, as does every `readGitMetadata` rejection above —
    // conservative, so any persisted row survives.
    return { kind: "unreachable" };
  }
}
