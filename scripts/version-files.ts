// Single source of truth for every file in this repo that carries the product
// version, plus the surgical read/write helpers both release scripts share.
//
// `set-version.ts` writes these; `preflight.ts` re-reads them and asserts each
// equals the tag being released. What the two share is exactly this LIST and
// nothing else: the checker does NOT reuse the surgical parser below. It
// `JSON.parse`s the JSON files and takes their top-level `version` key, and for
// Cargo.toml it locates the `[package]` section and reads the first `version`
// inside that section only (see `readIndependently` in preflight.ts). So a
// writer that anchored on the wrong key — a nested two-space-indented
// `"version"`, a Cargo.toml whose `[package]` is not the first table — is
// caught by the checker rather than read straight back and confirmed by it.
//
// Why surgical string edits rather than parse-and-reserialize: every one of
// these files is under `prettier --check` (JSON) or `cargo fmt --check` (TOML),
// and reserializing risks reordering keys or normalizing whitespace in ways
// that pass here and fail the format gate. Rewriting just the version literal
// guarantees a one-line diff.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dirname, "..");

// What breaks if this file's version disagrees with the shipped tag.
export type VersionRole =
  // Sets the version the built app reports at runtime. A lagging value yields a
  // PERPETUAL update loop: the updater manifest advertises the tag version, the
  // installed bundle self-reports the older conf version, and it re-downloads
  // forever.
  | "runtime"
  // Baked into a build and reported by it: the renderer's compile-time constant
  // __APP_VERSION__ (the sidebar's version chip, the boot splash), the
  // sidecar's `engineVersion`, which `bun build --compile` inlines from its
  // package.json and which the Headless client's commands compare exactly with
  // their own (ADR-0119 §5), that own version, which the Headless client's
  // `--version` and `update` read from apps/cli/package.json (ADR-0118 §6,
  // ADR-0123), and the Hub's, from apps/hub/package.json, which its
  // `GET /page/view` reports and the Hub page compares with the version it was
  // built with, reloading once when they differ (ADR-0124 §4, §6; ADR-0129 §2).
  // And the User guide's, from apps/guide/package.json, which its build stamps
  // into every page (ADR-0132 §6).
  // Wrong here means the app visibly lies about which version it is, a
  // Headless command reports version skew against itself, the Hub reports a
  // version it is not and the Hub page reloads once over it, or the guide's
  // pages name a release they did not come from.
  | "baked"
  // Cargo records each workspace member's own version in its Cargo.lock beside
  // the crate name. Cargo REFUSES to rewrite a lockfile when `--locked` is
  // passed — which the release gate and every CI leg do — so a stale entry is
  // not cosmetic: it fails the build outright, and the error names the lockfile
  // rather than the version bump that invalidated it. v0.2.0 and v0.3.0 both
  // hit this as a mid-release surprise before these three joined the list.
  | "build"
  // Never read at runtime. Kept in lockstep so `grep -r '"version"'` tells the
  // truth and nobody has to remember which manifests "really" count.
  | "hygiene";

/**
 * Where in a file's text the version literal lives.
 *
 * `lock` carries the crate name because a Cargo.lock declares a `version` for
 * every package in the dependency graph — hundreds of them, all at column 0.
 * Position cannot identify the right one; only the `name` line above it can.
 */
export type VersionTarget = { kind: "json" } | { kind: "toml" } | { kind: "lock"; pkg: string };

/** Repo-relative, forward-slashed `path`, plus what breaks when it is stale. */
export type VersionFile = VersionTarget & { path: string; role: VersionRole };

export const VERSION_FILES: VersionFile[] = [
  { path: "apps/desktop/src-tauri/tauri.conf.json", kind: "json", role: "runtime" },
  { path: "apps/hub-desktop/src-tauri/tauri.conf.json", kind: "json", role: "runtime" },

  { path: "apps/desktop/package.json", kind: "json", role: "baked" },
  { path: "apps/hub-desktop/package.json", kind: "json", role: "baked" },
  { path: "apps/sidecar/package.json", kind: "json", role: "baked" },
  { path: "apps/cli/package.json", kind: "json", role: "baked" },
  { path: "apps/hub/package.json", kind: "json", role: "baked" },
  { path: "apps/guide/package.json", kind: "json", role: "baked" },

  { path: "package.json", kind: "json", role: "hygiene" },
  { path: "packages/glass/package.json", kind: "json", role: "hygiene" },
  { path: "packages/shared/package.json", kind: "json", role: "hygiene" },
  { path: "packages/usage-core/package.json", kind: "json", role: "hygiene" },
  { path: "apps/desktop/src-tauri/Cargo.toml", kind: "toml", role: "hygiene" },
  { path: "apps/hub-desktop/src-tauri/Cargo.toml", kind: "toml", role: "hygiene" },
  { path: "apps/hub/credstore/Cargo.toml", kind: "toml", role: "hygiene" },

  // One per Cargo.toml above — the same version, echoed by Cargo into the
  // lockfile. `pkg` is the crate's `[package] name`, which is NOT derivable
  // from the path (`apps/desktop` holds `maxprice-desktop`).
  {
    path: "apps/desktop/src-tauri/Cargo.lock",
    kind: "lock",
    pkg: "maxprice-desktop",
    role: "build",
  },
  {
    path: "apps/hub-desktop/src-tauri/Cargo.lock",
    kind: "lock",
    pkg: "maxprice-hub-desktop",
    role: "build",
  },
  {
    path: "apps/hub/credstore/Cargo.lock",
    kind: "lock",
    pkg: "maxprice-credstore",
    role: "build",
  },
];

// Every pattern below captures three groups — prefix, the version literal,
// closing quote — so `writeVersion` can rebuild the line around group 2 instead
// of substring-replacing the old version inside the match. That distinction is
// only cosmetic for JSON and TOML, where the match holds nothing but the
// version; it is load-bearing for `lock`, whose match also spans a crate name a
// substring swap could hit first.

// A top-level `"version": "..."` in a 2-space-indented JSON file. The indent
// anchor is load-bearing: it excludes any nested `"version"` key (a dependency
// literally named `version`, a nested config block) that a looser pattern would
// hit first.
const JSON_VERSION = /^( {2}"version": ")([^"]*)(")/m;

// `version = "..."` at column 0. In all three Cargo.toml files this is the
// `[package]` version on line 3; a dependency's version is always indented or
// inline-table form, so column-0 anchoring is unambiguous.
const TOML_VERSION = /^(version = ")([^"]*)(")/m;

// Cargo writes each `[[package]]` block as `name` then `version`, adjacent and
// at column 0, so the crate name is what disambiguates one entry from the
// hundreds of dependency entries around it. `\r?\n` because a lockfile is
// checked out with the platform's line endings even though Cargo writes LF.
function lockVersion(pkg: string): RegExp {
  // Cargo crate names are `[A-Za-z0-9_-]+`. Refusing anything else means no
  // name can ever be interpolated as a regex metacharacter — and a name that
  // fails this is a typo in VERSION_FILES, which should be loud, not escaped.
  if (!/^[A-Za-z0-9_-]+$/.test(pkg)) {
    throw new Error(`Not a crate name that can anchor a lockfile lookup: ${JSON.stringify(pkg)}`);
  }
  return new RegExp(`^(name = "${pkg}"\\r?\\nversion = ")([^"]*)(")`, "m");
}

function pattern(target: VersionTarget): RegExp {
  if (target.kind === "json") return JSON_VERSION;
  if (target.kind === "toml") return TOML_VERSION;
  return lockVersion(target.pkg);
}

/**
 * The one place the version literal is located in a file's text. Pure, so the
 * anchoring above can be asserted against synthetic strings — `writeVersion`
 * resolves its path against REPO_ROOT and can therefore only ever be pointed at
 * real repo files. Returns null when the file declares no version.
 */
export function parseVersion(text: string, target: VersionTarget): string | null {
  const match = pattern(target).exec(text);
  return match ? match[2]! : null;
}

export function readVersion(file: VersionFile): string {
  const abs = join(REPO_ROOT, file.path);
  const version = parseVersion(readFileSync(abs, "utf8"), file);
  if (version === null) throw new Error(`No version declaration found in ${file.path}`);
  return version;
}

/**
 * The pure half of `writeVersion`: rebuild the matched line around a new
 * version, leaving every other byte alone. Returns null when the text declares
 * no version.
 *
 * Pure so the WRITE anchoring can be asserted against synthetic text, the same
 * way `parseVersion` can. Reading the right value and writing over the right
 * bytes are separate claims — a `lock` match spans a crate name as well as a
 * version, so a writer could read correctly and still edit the wrong span.
 */
export function replaceVersion(
  text: string,
  target: VersionTarget,
  version: string,
): string | null {
  if (parseVersion(text, target) === null) return null;
  return text.replace(
    pattern(target),
    (_whole: string, prefix: string, _old: string, suffix: string) => prefix + version + suffix,
  );
}

/** Returns true when the file changed, false when it already said `version`. */
export function writeVersion(file: VersionFile, version: string): boolean {
  const abs = join(REPO_ROOT, file.path);
  const before = readFileSync(abs, "utf8");
  const current = parseVersion(before, file);
  if (current === null) throw new Error(`No version declaration found in ${file.path}`);
  if (current === version) return false;
  const after = replaceVersion(before, file, version);
  writeFileSync(abs, after!);
  return true;
}

// Reject anything that isn't a plain three-part semver. Tauri's updater compares
// versions semantically and a malformed one fails in confusing ways at install
// time rather than here.
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Strips a leading `v` so callers can pass either `v1.2.3` or `1.2.3`. */
export function normalizeVersion(input: string): string {
  const version = input.startsWith("v") ? input.slice(1) : input;
  if (!SEMVER.test(version)) {
    throw new Error(`"${input}" is not a valid version (expected X.Y.Z, optionally v-prefixed)`);
  }
  return version;
}
