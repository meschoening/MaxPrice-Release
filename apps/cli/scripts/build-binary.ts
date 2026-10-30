// Compiles the Headless client into one Bun binary for Linux x64
// (ADR-0118 §6): apps/cli/binaries/maxprice, git-ignored. Bun cross-compiles,
// so any host builds it. `bun run build:cli` runs this; it stays out of
// `build:binaries`, so `bun run dev` does not wait for it.
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TARGETS } from "../../sidecar/scripts/build-binaries";

const CLI_DIR = resolve(import.meta.dir, "..");
const TARGET = TARGETS["linux-x64"]!;

// The compile's command line. `--define` folds the update channel's test seam
// away (src/update-channel.ts, ADR-0123 §9 as amended by #472): defined as
// `undefined`, its `typeof` check is constant, so the binary carries
// UPDATE_CHANNEL alone and never looks the global up. Without it a compiled
// binary would read MAXPRICE_TEST_UPDATE_CHANNEL at runtime, which
// BUN_OPTIONS=--preload can set, and check and install from that channel.
export function compileArgv(
  entry: string,
  outfile: string,
  bunTarget: string = TARGET.bunTarget,
): string[] {
  return [
    "bun",
    "build",
    "--compile",
    `--target=${bunTarget}`,
    "--define",
    "MAXPRICE_TEST_UPDATE_CHANNEL=undefined",
    entry,
    "--outfile",
    outfile,
  ];
}

// `bun build --compile` leaves a `.<hash>.bun-build` temp in the working
// directory when it is interrupted or fails, as the sidecar's build script
// explains; sweep them before and after.
async function sweepBuildTemps(): Promise<void> {
  for (const dir of new Set([process.cwd(), CLI_DIR])) {
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

async function main(): Promise<void> {
  await sweepBuildTemps();
  const outDir = join(CLI_DIR, "binaries");
  await mkdir(outDir, { recursive: true });
  const entry = join(CLI_DIR, "src", "main.ts");
  const outfile = join(outDir, "maxprice");
  console.log(`[build] ${entry} → ${outfile} (${TARGET.bunTarget})`);
  try {
    const proc = Bun.spawn(compileArgv(entry, outfile), { stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`bun build failed (exit ${code})`);
  } finally {
    await sweepBuildTemps();
  }
  console.log("[build] done");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
