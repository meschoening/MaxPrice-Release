// Compose and verify the Tauri updater manifests that drive MaxPrice's update
// channel, which is served from a THIRD repo (ADR-0071).
//
//   bun scripts/compose-updater-manifest.ts compose --channel desktop ...
//   bun scripts/compose-updater-manifest.ts verify latest.json hub-latest.json
//
// PUBLIC-ONLY FILE. It lives in the private repo under release/overlay/ and
// reaches the public build repo through the overlay pass, never the allowlist
// (ADR-0070 §5). Nothing in the private repo's own release path calls it: the
// local hand-built pipeline (ADR-0052) produces no updater artifacts at all,
// because `createUpdaterArtifacts` is false in both committed tauri.conf.json
// files and only the CI build merges the overlay that flips it on. So this runs
// exactly once per release, inside GitHub Actions, and its only dependencies
// are node builtins plus the `gh` CLI the runners already carry.
//
// WHERE THE PIECES LIVE, and why it is split across two repos at all:
//
//   MaxPrice-Release   the five installers. This is what a human downloads,
//                      and keeping its asset list to five is the entire point
//                      of the split — updater freight used to double it.
//   MP-Updates         the manifests, plus the one artifact that has nowhere
//                      else to go: macOS updates in-place from a .app.tar.gz,
//                      which is not an installer anybody would download.
//
// A manifest is just URLs, so Windows entries point straight back at the .exe
// already sitting in MaxPrice-Release and nothing is copied. Detached .sig
// files are never published anywhere — the signature travels INSIDE the
// manifest as a string, which is the only place Tauri's updater reads it from.
//
// PLATFORM COVERAGE is asserted, not discovered. A missing .sig would otherwise
// drop its platform from the manifest silently and every client on it would sit
// on "no update available" forever, which is indistinguishable from a healthy
// channel until someone notices a version gap in the wild.
//
//   desktop   darwin-aarch64, darwin-x86_64, windows-x86_64
//   hub       windows-x86_64
//
// Linux is deliberately absent from both. Tauri v2 can only update an AppImage,
// and this release ships a .deb (release-assets.ts records why no AppImage is
// built: linuxdeploy runs ldd over the Bun-compiled sidecar and the dynamic
// loader segfaults). A .deb updates through the distro, or by re-downloading.
//
// BOTH darwin keys point at ONE universal bundle, which is correct here and was
// a bug in the Actions-era predecessor this replaces: CI builds macOS with
// `--target universal-apple-darwin`, so a single .app.tar.gz genuinely serves
// both architectures. The rule is wrong for a two-leg arch-specific build like
// the local fallback pipeline's, where each arch would overwrite the other —
// so `classifyArtifact` keys off the fact that ONE darwin artifact is staged,
// and refuses outright if it is ever handed two.
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export type Channel = "desktop" | "hub";

/** Tauri's platform keys — `<os>-<arch>`, as the updater looks them up. */
export type UpdaterPlatform = "darwin-aarch64" | "darwin-x86_64" | "windows-x86_64";

/** Which repo hosts the artifact a platform entry points at. */
export type Host = "installers" | "updates";

export type PlatformEntry = { signature: string; url: string };

export type Manifest = {
  version: string;
  pub_date: string;
  platforms: Record<string, PlatformEntry>;
};

/** A staged updater artifact: the bundle's published name and its signature. */
export type StagedArtifact = { name: string; signature: string };

export const EXPECTED_PLATFORMS: Record<Channel, readonly UpdaterPlatform[]> = {
  desktop: ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"],
  hub: ["windows-x86_64"],
};

/** The Tauri project whose tauri.conf.json carries a channel's updater pubkey. */
export function projectOf(channel: Channel): string {
  return channel === "hub" ? "apps/hub-desktop" : "apps/desktop";
}

export function manifestNameOf(channel: Channel): string {
  return channel === "hub" ? "hub-latest.json" : "latest.json";
}

/**
 * Which platforms an artifact serves, and which repo hosts it.
 *
 * Extension-driven because that is genuinely what decides it: under Tauri v2's
 * `createUpdaterArtifacts`, the NSIS installer IS the Windows updater bundle
 * (there is no separate .nsis.zip — mapping one was the second bug in the
 * Actions-era predecessor), while macOS gets a purpose-built .app.tar.gz.
 * Returns null for anything else so an unrecognised artifact is REPORTED rather
 * than quietly left out of the manifest.
 */
export function classifyArtifact(
  name: string,
): { platforms: UpdaterPlatform[]; host: Host } | null {
  if (name.endsWith(".app.tar.gz")) {
    return { platforms: ["darwin-aarch64", "darwin-x86_64"], host: "updates" };
  }
  if (name.endsWith(".exe")) {
    return { platforms: ["windows-x86_64"], host: "installers" };
  }
  return null;
}

/** A GitHub release asset's public download URL. */
export function assetUrl(repo: string, tag: string, name: string): string {
  return `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
}

type KeyIdResult = { keyId: Buffer; error: null } | { keyId: null; error: string };

/**
 * The 8-byte minisign key id out of a base64-wrapped minisign file — the shape
 * of BOTH halves compared here. A `.sig` file and a tauri.conf.json `pubkey`
 * are each base64 of a 2+ line minisign file whose SECOND line decodes to
 * `alg(2) | keyId(8) | payload`. Never throws: a corrupt input has to be
 * reportable alongside every other defect, not abort the run holding them.
 */
export function minisignKeyId(encoded: string, what: string): KeyIdResult {
  const lines = Buffer.from(encoded.trim(), "base64")
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  const payload = lines[1];
  if (payload === undefined) {
    return {
      keyId: null,
      error: `${what} does not decode to a minisign file (expected 2+ lines, got ${lines.length})`,
    };
  }
  const raw = Buffer.from(payload.trim(), "base64");
  if (raw.length < 10) {
    return {
      keyId: null,
      error: `${what} has a truncated minisign payload (${raw.length} bytes, expected at least 10)`,
    };
  }
  return { keyId: raw.subarray(2, 10), error: null };
}

/** A key id the way minisign itself prints it — the raw bytes are reversed. */
export function formatKeyId(keyId: Buffer): string {
  return Buffer.from(keyId).reverse().toString("hex").toUpperCase();
}

export type ComposeInput = {
  channel: Channel;
  version: string;
  tag: string;
  artifacts: StagedArtifact[];
  /** The channel's committed updater pubkey, base64 as tauri.conf.json holds it. */
  pubkey: string;
  installersRepo: string;
  updatesRepo: string;
  /** Published name for the macOS bundle in the updates repo. */
  darwinAsset: string | null;
  /** ISO-8601, injected so the pure core has no clock. */
  now: string;
};

export type ComposeResult =
  | { manifest: Manifest; errors: null }
  | { manifest: null; errors: string[] };

/**
 * Build one channel's manifest, or report EVERY defect that stopped it.
 *
 * Pure — no filesystem, no network, no clock — because the interesting
 * failures here are all classification and key-identity ones, and they are
 * worth pinning in tests that never touch a release.
 */
export function composeManifest(input: ComposeInput): ComposeResult {
  const errors: string[] = [];
  const platforms: Record<string, PlatformEntry> = {};

  // Which key SIGNED a bundle is invisible to every other gate: a mismatched
  // keypair signs cleanly, uploads cleanly, verifies as well-formed, and only
  // fails inside the installed app — where it presents as every client
  // silently refusing an update that looks perfectly healthy from here.
  const decodedPub = minisignKeyId(input.pubkey, `the updater pubkey for ${input.channel}`);
  if (decodedPub.error !== null) errors.push(decodedPub.error);
  const shippedKeyId = decodedPub.keyId;

  let darwinSeen: string | null = null;

  for (const artifact of input.artifacts) {
    const kind = classifyArtifact(artifact.name);
    if (kind === null) {
      errors.push(
        `${artifact.name} is not a recognised updater bundle ` +
          `(expected *.app.tar.gz or *.exe) — refusing to guess its platform`,
      );
      continue;
    }

    if (kind.host === "updates") {
      if (darwinSeen !== null) {
        // See the header: one universal bundle serving both darwin keys is
        // only correct while there is exactly one.
        errors.push(
          `two macOS bundles were staged (${darwinSeen} and ${artifact.name}) — ` +
            `this composer maps ONE universal bundle onto both darwin keys, so a ` +
            `per-arch build needs the arch carried explicitly, not inferred`,
        );
        continue;
      }
      darwinSeen = artifact.name;
    }

    if (artifact.signature.trim() === "") {
      errors.push(`${artifact.name}.sig is empty — that bundle shipped unsigned`);
      continue;
    }

    if (shippedKeyId !== null) {
      const signed = minisignKeyId(artifact.signature, `${artifact.name}.sig`);
      if (signed.error !== null) {
        errors.push(signed.error);
        continue;
      }
      if (!signed.keyId.equals(shippedKeyId)) {
        errors.push(
          `${artifact.name}.sig was signed by key ${formatKeyId(signed.keyId)}, but ` +
            `${projectOf(input.channel)}/src-tauri/tauri.conf.json ships pubkey ` +
            `${formatKeyId(shippedKeyId)} — every installed app would reject this update`,
        );
        continue;
      }
    }

    let url: string;
    if (kind.host === "updates") {
      if (input.darwinAsset === null) {
        errors.push(
          `${artifact.name} is a macOS bundle but no --darwin-asset name was given, ` +
            `so its URL in ${input.updatesRepo} cannot be constructed`,
        );
        continue;
      }
      url = assetUrl(input.updatesRepo, input.tag, input.darwinAsset);
    } else {
      url = assetUrl(input.installersRepo, input.tag, artifact.name);
    }

    for (const platform of kind.platforms) {
      platforms[platform] = { signature: artifact.signature.trim(), url };
    }
  }

  for (const expected of EXPECTED_PLATFORMS[input.channel]) {
    if (platforms[expected] === undefined) {
      errors.push(
        `no updater bundle covers ${expected} — every ${input.channel} client on that ` +
          `platform would see "no update available" indefinitely`,
      );
    }
  }

  if (errors.length > 0) return { manifest: null, errors };

  return {
    manifest: {
      version: input.version,
      // Composition time, deliberately: the legs finish at different moments
      // on different runners and there is no single build clock.
      pub_date: input.now.replace(/\.\d{3}Z$/, "Z"),
      platforms,
    },
    errors: null,
  };
}

// ---------------------------------------------------------------------------
// Verification — the last gate before a manifest goes live.
// ---------------------------------------------------------------------------

export type UrlCheck = { url: string; ok: boolean; detail: string };

/**
 * Prove a manifest URL actually serves bytes.
 *
 * This is the one failure the two-repo split introduces that a single-repo
 * release could not have: the manifest and the artifact it names are published
 * by different steps, to different repos, and a manifest advertising a 404 is
 * worse than no manifest at all — clients would retry the same dead download
 * on every launch. So every URL is fetched before the channel is switched over.
 *
 * HEAD first; a ranged GET is the fallback, because the redirect target GitHub
 * hands out for release assets is object storage that has historically been
 * less consistent about HEAD than about GET. One byte is enough to prove the
 * object resolves.
 */
export async function checkUrl(url: string, fetchImpl = fetch): Promise<UrlCheck> {
  const attempt = async (init: RequestInit): Promise<Response | string> => {
    try {
      return await fetchImpl(url, { redirect: "follow", ...init });
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  const head = await attempt({ method: "HEAD" });
  if (typeof head !== "string" && head.ok) {
    return { url, ok: true, detail: `HEAD ${head.status}` };
  }

  const ranged = await attempt({ method: "GET", headers: { Range: "bytes=0-0" } });
  if (typeof ranged === "string") {
    return { url, ok: false, detail: `GET failed: ${ranged}` };
  }
  if (ranged.ok) {
    return { url, ok: true, detail: `GET ${ranged.status}` };
  }
  return {
    url,
    ok: false,
    detail: `HEAD ${typeof head === "string" ? head : head.status}, ` + `GET ${ranged.status}`,
  };
}

/** Every URL a manifest advertises, deduplicated — darwin keys share one. */
export function manifestUrls(manifest: Manifest): string[] {
  return [...new Set(Object.values(manifest.platforms).map((p) => p.url))];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** The updater pubkey a channel's app was actually built to verify against. */
function readPubkey(root: string, channel: Channel): string | null {
  const path = join(root, projectOf(channel), "src-tauri", "tauri.conf.json");
  try {
    const conf = JSON.parse(readFileSync(path, "utf8")) as {
      plugins?: { updater?: { pubkey?: string } };
    };
    return conf.plugins?.updater?.pubkey ?? null;
  } catch {
    return null;
  }
}

/**
 * Staged artifacts, read from a directory of `<bundle>.sig` files.
 *
 * The directory is populated by `gh release download` off the draft release, so
 * the names here are already the PUBLISHED ones — which matters, because GitHub
 * rewrites the space in the hub's "MaxPrice Hub_…" bundle to a dot on upload.
 * Reading them back from the release rather than from the build's bundle
 * directory is what keeps the manifest's URLs and the release's asset names the
 * same strings.
 */
function readStaged(dir: string): StagedArtifact[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sig"))
    .sort()
    .map((sig) => ({
      name: basename(sig, ".sig"),
      signature: readFileSync(join(dir, sig), "utf8").trim(),
    }));
}

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return null;
  return argv[i + 1] ?? null;
}

function requireFlag(argv: string[], name: string): string {
  const value = flag(argv, name);
  if (value === null || value.startsWith("--")) {
    throw new Error(`missing required --${name}`);
  }
  return value;
}

async function cmdCompose(argv: string[]): Promise<number> {
  const rawChannel = requireFlag(argv, "channel");
  if (rawChannel !== "desktop" && rawChannel !== "hub") {
    console.error(`Unknown channel "${rawChannel}" (expected desktop or hub)`);
    return 2;
  }
  const channel: Channel = rawChannel;
  const version = requireFlag(argv, "version");
  const tag = requireFlag(argv, "tag");
  const dir = requireFlag(argv, "dir");
  const installersRepo = requireFlag(argv, "installers-repo");
  const updatesRepo = requireFlag(argv, "updates-repo");
  const darwinAsset = flag(argv, "darwin-asset");
  const root = flag(argv, "root") ?? process.cwd();
  const out = flag(argv, "out") ?? manifestNameOf(channel);

  const pubkey = readPubkey(root, channel);
  if (pubkey === null) {
    console.error(
      `No updater pubkey in ${projectOf(channel)}/src-tauri/tauri.conf.json — ` +
        `cannot tell what should have signed these bundles.`,
    );
    return 1;
  }

  const artifacts = readStaged(dir);
  if (artifacts.length === 0) {
    console.error(
      `No .sig files under ${dir}. The build legs produce updater bundles only when ` +
        `the CI config overlay (src-tauri/tauri.updater.conf.json) was merged — check ` +
        `that the build job still passes --config.`,
    );
    return 1;
  }

  const result = composeManifest({
    channel,
    version,
    tag,
    artifacts,
    pubkey,
    installersRepo,
    updatesRepo,
    darwinAsset,
    now: new Date().toISOString(),
  });

  if (result.errors !== null) {
    console.error(`\nRefusing to compose ${out} — the release is incomplete:\n`);
    for (const e of result.errors) console.error(`  - ${e}`);
    console.error("");
    return 1;
  }

  await Bun.write(out, `${JSON.stringify(result.manifest, null, 2)}\n`);
  console.log(`Assembled ${out}:`);
  console.log(JSON.stringify(result.manifest, null, 2));
  return 0;
}

async function cmdVerify(argv: string[]): Promise<number> {
  const files = argv.filter((a) => !a.startsWith("--"));
  if (files.length === 0) {
    console.error("usage: compose-updater-manifest.ts verify <manifest.json>...");
    return 2;
  }

  let failed = 0;
  for (const file of files) {
    let manifest: Manifest;
    try {
      manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
    } catch (err) {
      console.error(`✗ ${file} — unreadable: ${err instanceof Error ? err.message : err}`);
      failed++;
      continue;
    }

    const urls = manifestUrls(manifest);
    console.log(`\n${file} — ${urls.length} URL(s), version ${manifest.version}`);
    const checks = await Promise.all(urls.map((u) => checkUrl(u)));
    for (const check of checks) {
      console.log(`  ${check.ok ? "✓" : "✗"} ${check.detail}  ${check.url}`);
      if (!check.ok) failed++;
    }
  }

  if (failed > 0) {
    console.error(
      `\n${failed} manifest URL(s) do not resolve. NOT publishing the update channel — ` +
        `a manifest advertising a dead download is worse than no manifest, because every ` +
        `client would retry it on every launch.\n`,
    );
    return 1;
  }
  console.log("\nEvery manifest URL resolves.");
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "compose":
      return cmdCompose(rest);
    case "verify":
      return cmdVerify(rest);
    default:
      console.error(
        "usage:\n" +
          "  compose-updater-manifest.ts compose --channel <desktop|hub> --version <v> \\\n" +
          "      --tag <vX.Y.Z> --dir <staged> --installers-repo <o/r> --updates-repo <o/r> \\\n" +
          "      [--darwin-asset <name>] [--root <dir>] [--out <file>]\n" +
          "  compose-updater-manifest.ts verify <manifest.json>...",
      );
      return 2;
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(2);
  }
}
