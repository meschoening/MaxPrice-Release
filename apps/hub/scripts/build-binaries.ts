// Compiles the hub into a standalone Bun binary suffixed with the
// target triple. Outputs to apps/hub/binaries/maxprice-hub-<triple>
// AND copies into apps/hub-desktop/src-tauri/binaries/ so the MaxPrice Hub
// tray app (ADR-0036) can bundle the daemon as its externalBin sidecar
// (mirrors apps/sidecar/scripts/build-binaries.ts).
//
// linux-x64 is the Headless Hub's target, and it alone embeds the Hub page
// (ADR-0124 §1, §7). Its build orders itself: the page build
// (`bun run build:page` in apps/hub-desktop, into dist-page/), then the page
// manifest (page-manifest.ts, into the git-ignored apps/hub/generated/), then
// the compile under `--conditions=maxprice-hub-page`, which resolves
// `#page-manifest` to that generated module and so embeds every dist-page file.
// Every tray target compiles with the argv it always had, so `#page-manifest`
// resolves to the committed empty src/page-manifest.ts, and never builds or
// reads dist-page. No build rewrites a tracked file.
import { mkdir, copyFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { PAGE_DIST_DIR, PAGE_MANIFEST_FILE, writePageManifest } from "./page-manifest";

const HUB_DIR = resolve(import.meta.dir, "..");
const HUB_DESKTOP_DIR = resolve(HUB_DIR, "..", "hub-desktop");
const TAURI_BIN_DIR = resolve(HUB_DESKTOP_DIR, "src-tauri", "binaries");

// `bun build --compile` writes a `.<hash>.bun-build` temp into the working
// directory and only deletes it on a clean exit — so every interrupted or
// failed compile orphans a ~55MB file. We once found 83 stale temps (4.4GB).
// Sweep them before building (clears orphans from prior hard-kills, where a
// `finally` would never have run) and after each compile (catches the common
// failure/Ctrl-C case). Builds run sequentially, so this never races an
// in-progress temp.
async function sweepBuildTemps() {
  const dirs = [...new Set([process.cwd(), HUB_DIR])];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    await Promise.all(
      names
        .filter((name) => name.endsWith(".bun-build"))
        .map((name) => rm(join(dir, name), { force: true })),
    );
  }
}

export type TargetSpec = { bunTarget: string; triple: string };

// Map Bun --target → Rust target triple.
export const TARGETS: Record<string, TargetSpec> = {
  "darwin-arm64": { bunTarget: "bun-darwin-arm64", triple: "aarch64-apple-darwin" },
  "darwin-x64": { bunTarget: "bun-darwin-x64", triple: "x86_64-apple-darwin" },
  "linux-x64": { bunTarget: "bun-linux-x64", triple: "x86_64-unknown-linux-gnu" },
  "windows-x64": { bunTarget: "bun-windows-x64", triple: "x86_64-pc-windows-msvc" },
};

// Exposed for tests; production callers go through `hostKey()`.
export function hostKeyFrom(platform: string, arch: string): string {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "win32" && arch === "x64") return "windows-x64";
  throw new Error(`Unsupported host: ${platform}/${arch}`);
}

function hostKey(): string {
  return hostKeyFrom(process.platform, process.arch);
}

// The package `imports` condition under which `#page-manifest` resolves to the
// generated manifest (apps/hub/package.json).
export const PAGE_CONDITION = "maxprice-hub-page";

// The Headless Hub's target. The tray app ships on Windows alone (ADR-0050). A
// Linux tray run from source (`bun run dev:hub`) bundles this same binary, page
// and all, but runs it embedded, and an embedded daemon mounts no `/page/`.
const HEADLESS_HUB_TARGET = "linux-x64";

/** Whether a target's binary embeds the Hub page: the Headless Hub's alone. */
export function embedsPage(target: TargetSpec): boolean {
  return target.triple === TARGETS[HEADLESS_HUB_TARGET]!.triple;
}

/**
 * The `bun build --compile` argv for one target. `--define` folds the update
 * channel's test seam away on every target (src/update-channel.ts, ADR-0129
 * §7 with ADR-0123 §9 as amended by #472): defined as `undefined`, its
 * `typeof` check is constant, so the binary carries UPDATE_CHANNEL alone and
 * never looks the global up. Without it a compiled binary would read
 * MAXPRICE_TEST_UPDATE_CHANNEL at runtime, which BUN_OPTIONS=--preload can
 * set, and check and install from that channel. A tray binary never checks
 * or updates (an embedded daemon checks nothing, and `update` is Linux
 * only), but it compiles the same module, so it folds the seam away too.
 * The operator commands' answer bound has the same kind of seam
 * (src/no-answer.ts), folded away the same way on every target.
 */
export function compileArgs(target: TargetSpec, entryPath: string, outfile: string): string[] {
  return [
    "bun",
    "build",
    "--compile",
    `--target=${target.bunTarget}`,
    "--define",
    "MAXPRICE_TEST_UPDATE_CHANNEL=undefined",
    "--define",
    "MAXPRICE_TEST_NO_ANSWER_MS=undefined",
    ...(embedsPage(target) ? [`--conditions=${PAGE_CONDITION}`] : []),
    entryPath,
    "--outfile",
    outfile,
  ];
}

export type BuildSteps = {
  buildPage(): Promise<void>;
  writeManifest(): void | Promise<void>;
  compile(target: TargetSpec): Promise<void>;
};

/** Builds one target: the page and its manifest first when it embeds the page. */
export async function buildTarget(target: TargetSpec, steps: BuildSteps): Promise<void> {
  if (embedsPage(target)) {
    await steps.buildPage();
    await steps.writeManifest();
  }
  await steps.compile(target);
}

async function buildPage() {
  console.log(`[build] Hub page → ${PAGE_DIST_DIR}`);
  const proc = Bun.spawn(["bun", "run", "build:page"], {
    cwd: HUB_DESKTOP_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`the Hub page build failed (exit ${code})`);
}

function writeManifest() {
  const keys = writePageManifest(PAGE_DIST_DIR, PAGE_MANIFEST_FILE);
  console.log(`[build] page manifest: ${keys.length} files → ${PAGE_MANIFEST_FILE}`);
}

async function compile(
  entry: string,
  outName: string,
  target: { bunTarget: string; triple: string },
) {
  const outDir = join(HUB_DIR, "binaries");
  await mkdir(outDir, { recursive: true });
  const ext = target.triple.includes("windows") ? ".exe" : "";
  const outfile = join(outDir, `${outName}-${target.triple}${ext}`);
  const entryPath = join(HUB_DIR, entry);

  console.log(`[build] ${entry} → ${outfile}`);
  try {
    const proc = Bun.spawn(compileArgs(target, entryPath, outfile), {
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`bun build failed for ${entry} (exit ${code})`);
  } finally {
    await sweepBuildTemps();
  }
  // Copy the hub binary into the hub-desktop Tauri externalBin directory.
  await mkdir(TAURI_BIN_DIR, { recursive: true });
  const dest = join(TAURI_BIN_DIR, `${outName}-${target.triple}${ext}`);
  await copyFile(outfile, dest);
  console.log(`[build] copied → ${dest}`);
}

async function main() {
  await sweepBuildTemps();
  const requested = process.argv.slice(2);
  const targetsToBuild =
    requested.length > 0
      ? requested.map((k) => {
          const t = TARGETS[k];
          if (!t)
            throw new Error(`Unknown target: ${k} (known: ${Object.keys(TARGETS).join(", ")})`);
          return t;
        })
      : [TARGETS[hostKey()]!];

  const steps: BuildSteps = {
    buildPage,
    writeManifest,
    compile: (t) => compile("src/index.ts", "maxprice-hub", t),
  };
  for (const t of targetsToBuild) {
    await buildTarget(t, steps);
  }

  const exeExt = process.platform === "win32" ? ".exe" : "";
  const credstoreSrc = join(
    HUB_DIR,
    "credstore",
    "target",
    "release",
    `maxprice-credstore${exeExt}`,
  );
  if (existsSync(credstoreSrc)) {
    const dest = join(HUB_DIR, "binaries", `maxprice-credstore${exeExt}`);
    await copyFile(credstoreSrc, dest);
    console.log(`[build] copied credstore → ${dest}`);
    // Also copy into the hub-desktop externalBin dir, target-triple suffixed
    // (Tauri requires the <name>-<triple> form there).
    const hostTriple = TARGETS[hostKey()]!.triple;
    await mkdir(TAURI_BIN_DIR, { recursive: true });
    const tauriCredstoreDest = join(TAURI_BIN_DIR, `maxprice-credstore-${hostTriple}${exeExt}`);
    await copyFile(credstoreSrc, tauriCredstoreDest);
    console.log(`[build] copied credstore → ${tauriCredstoreDest}`);
  } else {
    console.warn("[build] credstore not built — run `bun --filter @maxprice/hub build:credstore`");
  }

  console.log("[build] done");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
