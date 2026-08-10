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

  for (const t of targetsToBuild) {
    await compile("src/index.ts", "maxprice-sidecar", t);
  }

  console.log("[build] done");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
