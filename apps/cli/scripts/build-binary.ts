// Compiles the Headless client into one Bun binary (ADR-0118 §6, ADR-0144
// §1): for linux-x64 by default, apps/cli/binaries/maxprice; for another
// target, apps/cli/binaries/<target>/maxprice, so a cross-compile never takes
// the Linux binary's place. All git-ignored. Bun cross-compiles, so any host
// builds either. `bun run build:cli [target]` runs this; it stays out of
// `build:binaries`, so `bun run dev` does not wait for it.
//
// A darwin binary Bun compiles, on a Mac or off one, carries an ad-hoc
// signature `codesign --verify --strict` calls invalid: re-sign it on the Mac
// with `codesign --force --sign -` before it runs (ADR-0144 §2; mac-leg.ts
// smoke).
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { TARGETS, type TargetSpec } from "../../sidecar/scripts/build-binaries";

const CLI_DIR = resolve(import.meta.dir, "..");

// The platforms the Headless client ships for (ADR-0143 §1, ADR-0144 §1),
// each a key of the sidecar's TARGETS.
export const CLI_TARGETS = ["linux-x64", "darwin-arm64"] as const;
export type CliTarget = (typeof CLI_TARGETS)[number];
export const DEFAULT_TARGET: CliTarget = "linux-x64";

// The target an argv names, the default when it names none; a usage error
// for any other, or for more than one.
export function parseTarget(argv: readonly string[]): CliTarget {
  if (argv.length > 1) throw new Error(`build-binary takes one target, not ${argv.join(" ")}`);
  const name = argv[0] ?? DEFAULT_TARGET;
  if (!(CLI_TARGETS as readonly string[]).includes(name)) {
    throw new Error(`unknown target ${name}; one of ${CLI_TARGETS.join(", ")}`);
  }
  return name as CliTarget;
}

// Where a target's binary lands: the Linux one where the release and the
// rigs have always found it, any other under a directory of its own.
export function outfileFor(cliDir: string, target: CliTarget): string {
  const binaries = join(cliDir, "binaries");
  return target === DEFAULT_TARGET
    ? join(binaries, "maxprice")
    : join(binaries, target, "maxprice");
}

export function targetSpec(target: CliTarget): TargetSpec {
  return TARGETS[target]!;
}

// The compile's command line. `--define` folds the update channel's test seam
// away (src/update-channel.ts, ADR-0123 §9 as amended by #472): defined as
// `undefined`, its `typeof` check is constant, so the binary carries
// UPDATE_CHANNEL alone and never looks the global up. Without it a compiled
// binary would read MAXPRICE_TEST_UPDATE_CHANNEL at runtime, which
// BUN_OPTIONS=--preload can set, and check and install from that channel.
export function compileArgv(
  entry: string,
  outfile: string,
  bunTarget: string = targetSpec(DEFAULT_TARGET).bunTarget,
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
  const target = parseTarget(process.argv.slice(2));
  const { bunTarget } = targetSpec(target);
  const outfile = outfileFor(CLI_DIR, target);
  await sweepBuildTemps();
  await mkdir(dirname(outfile), { recursive: true });
  const entry = join(CLI_DIR, "src", "main.ts");
  console.log(`[build] ${entry} → ${outfile} (${bunTarget})`);
  try {
    const proc = Bun.spawn(compileArgv(entry, outfile, bunTarget), {
      stdout: "inherit",
      stderr: "inherit",
    });
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
