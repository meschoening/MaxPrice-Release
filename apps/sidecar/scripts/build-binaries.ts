// Compiles the sidecar into a standalone Bun binary suffixed with the
// target triple expected by Tauri's `externalBin`.
//
// Outputs to apps/sidecar/binaries/maxprice-sidecar-<triple>
//
// The `maxprice-` prefix is load-bearing, not cosmetic (ADR-0072): the Windows
// installer hook kills the sidecar by process name before extracting, and a
// generic `sidecar.exe` would make that a global name collision.
// and copies into apps/desktop/src-tauri/binaries/ for Tauri to bundle.
import { mkdir, copyFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const SIDECAR_DIR = resolve(import.meta.dir, "..");
const TAURI_BIN_DIR = resolve(SIDECAR_DIR, "..", "desktop", "src-tauri", "binaries");

// `bun build --compile` writes a `.<hash>.bun-build` temp into the working
// directory and only deletes it on a clean exit — so every interrupted or
// failed compile orphans a ~55MB file. We once found 83 stale temps (4.4GB).
// Sweep them before building (clears orphans from prior hard-kills, where a
// `finally` would never have run) and after each compile (catches the common
// failure/Ctrl-C case). Builds run sequentially, so this never races an
// in-progress temp.
async function sweepBuildTemps() {
  const dirs = [...new Set([process.cwd(), SIDECAR_DIR])];
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

// Map Bun --target → Rust target triple Tauri expects.
export const TARGETS: Record<string, TargetSpec> = {
  "darwin-arm64": { bunTarget: "bun-darwin-arm64", triple: "aarch64-apple-darwin" },
  "darwin-x64": { bunTarget: "bun-darwin-x64", triple: "x86_64-apple-darwin" },
  "linux-x64": { bunTarget: "bun-linux-x64", triple: "x86_64-unknown-linux-gnu" },
  "windows-x64": { bunTarget: "bun-windows-x64", triple: "x86_64-pc-windows-msvc" },
};

/**
 * A target that is ASSEMBLED from compiled ones rather than compiled itself.
 *
 * Only macOS has one, and it exists because `tauri build --target
 * universal-apple-darwin` lipos the app's OWN binary but NOT its externalBin
 * sidecars — it looks for a single `binaries/<name>-universal-apple-darwin` and
 * fails bundling outright if it is absent (tauri-apps/tauri#3355, still the
 * behaviour in v2). Supplying both arch-suffixed sidecars is not enough, which
 * is exactly what the release workflow used to do.
 *
 * Fusing is sound here because Bun's `--compile` payload lives INSIDE the
 * Mach-O (bun manipulates the image itself — see src/macho.zig and the
 * LC_CODE_SIGNATURE sizing bug fixed in 1.3.14), so its offsets are
 * slice-relative and survive lipo. That is a claim about someone else's file
 * format, so the release workflow runs the fused binary and waits for the
 * ADR-0002 LISTENING handshake rather than trusting it — a payload that stopped
 * resolving would otherwise bundle, sign, notarize and ship perfectly green.
 */
export type FusedSpec = { triple: string; from: string[] };

export const FUSED_TARGETS: Record<string, FusedSpec> = {
  "darwin-universal": {
    triple: "universal-apple-darwin",
    from: ["darwin-arm64", "darwin-x64"],
  },
};

/** What `lipo` calls each triple's architecture, for verifying a fuse. */
const LIPO_ARCHS: Record<string, string> = {
  "aarch64-apple-darwin": "arm64",
  "x86_64-apple-darwin": "x86_64",
};

/** The arch names a fused binary must report, in `lipo -archs` spelling. */
export function expectedArchs(spec: FusedSpec): string[] {
  return spec.from.map((key) => {
    const triple = TARGETS[key]?.triple;
    const arch = triple === undefined ? undefined : LIPO_ARCHS[triple];
    if (arch === undefined) throw new Error(`No lipo arch name for target ${key}`);
    return arch;
  });
}

export type BuildPlan = { compile: TargetSpec[]; fuse: FusedSpec[] };

/**
 * Resolve requested keys into what to compile and what to fuse afterwards.
 *
 * Pure, and exported for tests, because the interesting property — asking for
 * `darwin-universal` compiles BOTH darwin slices first — is the one a Windows
 * machine can still check, while the lipo it feeds can only run on macOS.
 */
export function planBuild(requested: string[]): BuildPlan {
  const compile: TargetSpec[] = [];
  const fuse: FusedSpec[] = [];
  const seen = new Set<string>();

  const addCompile = (key: string) => {
    const spec = TARGETS[key];
    if (!spec) {
      const known = [...Object.keys(TARGETS), ...Object.keys(FUSED_TARGETS)].join(", ");
      throw new Error(`Unknown target: ${key} (known: ${known})`);
    }
    // Requesting a fused target and one of its parts must not compile it twice.
    if (seen.has(spec.triple)) return;
    seen.add(spec.triple);
    compile.push(spec);
  };

  for (const key of requested) {
    const fused = FUSED_TARGETS[key];
    if (fused) {
      for (const part of fused.from) addCompile(part);
      fuse.push(fused);
      continue;
    }
    addCompile(key);
  }

  return { compile, fuse };
}

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

async function compile(
  entry: string,
  outName: string,
  target: { bunTarget: string; triple: string },
) {
  const outDir = join(SIDECAR_DIR, "binaries");
  await mkdir(outDir, { recursive: true });
  const ext = target.triple.includes("windows") ? ".exe" : "";
  const outfile = join(outDir, `${outName}-${target.triple}${ext}`);
  const entryPath = join(SIDECAR_DIR, entry);

  console.log(`[build] ${entry} → ${outfile}`);
  try {
    const proc = Bun.spawn(
      [
        "bun",
        "build",
        "--compile",
        `--target=${target.bunTarget}`,
        entryPath,
        "--outfile",
        outfile,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    const code = await proc.exited;
    if (code !== 0) throw new Error(`bun build failed for ${entry} (exit ${code})`);
  } finally {
    await sweepBuildTemps();
  }

  // Copy into Tauri's externalBin directory.
  await mkdir(TAURI_BIN_DIR, { recursive: true });
  const dest = join(TAURI_BIN_DIR, `${outName}-${target.triple}${ext}`);
  await copyFile(outfile, dest);
  console.log(`[build] copied → ${dest}`);
}

/** Run `lipo`, returning its stdout. macOS only — it ships with the Xcode CLT. */
async function lipo(args: string[]): Promise<string> {
  const proc = Bun.spawn(["lipo", ...args], { stdout: "pipe", stderr: "inherit" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`lipo ${args.join(" ")} failed (exit ${code})`);
  return out;
}

/** Fuse already-compiled slices into one multi-arch binary. */
async function fuse(outName: string, spec: FusedSpec) {
  if (process.platform !== "darwin") {
    throw new Error(
      `${spec.triple} can only be assembled on macOS: lipo ships with the Xcode ` +
        `command line tools and has no cross-platform equivalent here.`,
    );
  }

  const outDir = join(SIDECAR_DIR, "binaries");
  const inputs = spec.from.map((key) => join(outDir, `${outName}-${TARGETS[key]!.triple}`));
  const outfile = join(outDir, `${outName}-${spec.triple}`);

  console.log(`[build] lipo → ${outfile}`);
  await lipo(["-create", ...inputs, "-output", outfile]);

  // Assert the fuse produced what it claims. `lipo -create` over a single input
  // succeeds and yields a THIN binary, so a mis-specified `from` would leave a
  // correctly-named file that silently drops an architecture — and the arch it
  // dropped is by definition the one nobody on this machine can launch.
  const archs = (await lipo(["-archs", outfile])).trim().split(/\s+/).sort();
  const wanted = expectedArchs(spec).sort();
  if (archs.join(" ") !== wanted.join(" ")) {
    throw new Error(
      `${outfile} reports [${archs.join(", ")}] but should carry [${wanted.join(", ")}]`,
    );
  }

  await mkdir(TAURI_BIN_DIR, { recursive: true });
  const dest = join(TAURI_BIN_DIR, `${outName}-${spec.triple}`);
  await copyFile(outfile, dest);
  console.log(`[build] copied → ${dest} (${archs.join(", ")})`);
}

async function main() {
  await sweepBuildTemps();
  const requested = process.argv.slice(2);
  const plan = planBuild(requested.length > 0 ? requested : [hostKey()]);

  for (const t of plan.compile) {
    await compile("src/index.ts", "maxprice-sidecar", t);
  }
  for (const spec of plan.fuse) {
    await fuse("maxprice-sidecar", spec);
  }

  console.log("[build] done");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
