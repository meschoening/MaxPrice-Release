// Build, pack and sign the two Headless release tarballs: the Headless
// client's, maxprice_<v>_linux-x64.tar.gz (ADR-0123 §1, §2), then the Headless
// Hub's, maxprice-hub_<v>_linux-x64.tar.gz (ADR-0129 §1).
//
//   bun scripts/build-headless.ts --tag vX.Y.Z [--out <dir>] [--unsigned] [--root <dir>]
//
// PUBLIC-ONLY FILE, with one private caller. It lives in the private repo under
// release/overlay/ and reaches the public build repo through the overlay pass
// (ADR-0070 §5), where CI's `build-headless` job runs it as
// scripts/build-headless.ts and signs with the TAURI_SIGNING_* secrets. The
// local fallback pipeline (ADR-0052) runs the same file at its private path,
// release/overlay/scripts/build-headless.ts, inside release_linux.sh's
// container, with --unsigned: no signing key ever reaches a build machine
// (ADR-0071 §3), so a hand-built release advances no channel,
// headless-latest.json and headless-hub-latest.json included (ADR-0123 §10,
// ADR-0129 §8). Uploading is the workflow's own step, not this script's, so
// both callers run the same file to the same end.
//
// THE ROOT is --root, or else the working directory, and never this file's own
// location: the file sits at scripts/ in one repo and at
// release/overlay/scripts/ in the other, so a root derived from import.meta.dir
// would be right in only one of them. For the same reason it imports nothing
// from either repo, only node builtins and Bun, so each compile's command and
// the path it writes are spelled here, in PRODUCTS.
//
// compose-updater-manifest.ts, its sibling at both paths, imports the asset
// names (`headlessAssetName`, `headlessHubAssetName`) and `signedFileOf` from
// it, so the composer and this script agree on each asset's name and on what a
// `.sig` names. Importing it has no side effects: the CLI runs only under
// `import.meta.main`.
//
// TWO PRODUCTS, in turn: the client whole, then the Hub, so a client that
// refuses costs no Hub build. Each goes through the same steps, every one of
// which refuses (exit 1) rather than carry on:
//
//   1. compile   in the root. The client's is `bun run build:cli`, which
//                writes apps/cli/binaries/maxprice. The Hub's is
//                `bun apps/hub/scripts/build-binaries.ts linux-x64`, which
//                builds apps/hub-desktop's dist-page, writes the page manifest
//                and compiles
//                apps/hub/binaries/maxprice-hub-x86_64-unknown-linux-gnu with
//                the page embedded, in ADR-0124's order.
//   2. stage     only where the compile's file is not already named for the
//                tarball's one entry, which is the Hub's: build-binaries.ts
//                names it for its target triple, the form Tauri's externalBin
//                wants and the path the acceptance rigs run it from, so it is
//                left there under that name; and it copies a credstore helper
//                beside it whenever one has been built, while the Linux Hub
//                ships no helper (ADR-0126 §1). So a copy named
//                `maxprice-hub` goes alone into a fresh directory under
//                os.tmpdir(), which is removed again on every path. The
//                client's `maxprice` is packed where the compile wrote it.
//                Either way the file packed is made 0755 here, whatever mode
//                the compile left, and steps 3 and 4 run on it: for the Hub,
//                the copy, the bytes that ship. (A host whose tmpdir is
//                mounted noexec refuses at step 3; point TMPDIR elsewhere.)
//   3. version   `<binary> --version` exits 0 and prints the tag minus its v,
//                exactly. Each binary prints its bare version (ADR-0123 §4's
//                amendment, ADR-0129 §2), and each one's `update`, as ADR-0123
//                §4 and ADR-0129 §4 specify it, runs this same check on the
//                binary it extracts (check 5), so a binary that failed it here
//                would fail every install's update.
//   4. pack      GNU tar, then the archive is read back. The update's reader
//                (packages/usage-core/src/self-update.ts) takes one regular
//                file named exactly for its product, `maxprice` or
//                `maxprice-hub`, and refuses anything else (ADR-0123 §2's
//                amendment, ADR-0129 §1). `-C <dir> <binary>` writes that
//                name, where `.` would write `./<binary>`. `--format=gnu`
//                because `--format=posix` writes a pax header ahead of the
//                file, an entry of its own; it is GNU tar's default today, and
//                pinned so a host whose default changes cannot change the
//                archive. `--owner=0 --group=0 --numeric-owner` because a root
//                extraction, as into a shared /usr/local/bin, keeps the
//                archive's owner: without them the binary would belong to
//                whatever uid the CI runner had, and the archive would carry
//                that runner's user names.
//   5. sign      `tauri signer sign`, run as the desktop workspace's tauri-cli
//                (ADR-0123 §1), writes <asset>.sig. Its trusted comment's
//                `file:` must name the asset exactly: each `update`, as ADR-0123
//                §4 check 3 and ADR-0129 §4 specify it, computes the asset name
//                from the manifest's version and refuses any other `file:`, so a
//                tarball signed under another name, a temp copy's, an older
//                version's or the other product's, ships a manifest every
//                install refuses. Skipped under --unsigned.
//
// --out holds both tarballs and their .sigs; without it each goes to its own
// workspace's binaries/, beside its compiled binary, where the fallback stages
// it from. Both products' previous <asset> and <asset>.sig are removed before
// the client's compile, and a refusal anywhere removes every tarball and .sig
// the run wrote, both products', so the only tarballs left are from a run that
// passed every step for both. A stale .sig matters most: left beside a new
// tarball, it would sign other bytes, and it would stand in for a signer that
// wrote nothing.
//
// Exit 0 when every step passed for both, 1 when one refused, 2 on a usage
// error.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export type Env = Record<string, string | undefined>;

/** The two binaries this script ships, each alone in a tarball of its own. */
export type Binary = "maxprice" | "maxprice-hub";

/** Compiles `binary` in `root`, resolving to the exit code. */
export type Compile = (root: string, binary: Binary) => Promise<number>;

/** Signs `asset` (an absolute path) into `<asset>.sig`, resolving to the exit code. */
export type Sign = (asset: string, ctx: { root: string; env: Env }) => Promise<number>;

export type BuildOptions = {
  root: string;
  tag: string;
  /** Where both tarballs go; each defaults to defaultOutDir(root, binary). */
  out?: string;
  unsigned?: boolean;
  compile?: Compile;
  sign?: Sign;
  env?: Env;
  log?: (line: string) => void;
};

/** One product's tarball and its `.sig`, which is null under --unsigned. */
export type BuildResult = { binary: Binary; tarball: string; signature: string | null };

/** A step refused; the CLI exits 1 with its message. */
export class BuildRefused extends Error {}

const KEY_VAR = "TAURI_SIGNING_PRIVATE_KEY";
const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
// check 5's deadline in self-update.ts: a `--version` slower than that would
// fail every install's update anyway.
const VERSION_TIMEOUT_MS = 15_000;

/** The client's tarball's published name, which CI signs it under and `maxprice update` computes. */
export function headlessAssetName(version: string): string {
  return `maxprice_${version}_linux-x64.tar.gz`;
}

/** The Hub's tarball's published name, which CI signs it under and ADR-0129 §4's `maxprice-hub update` computes. */
export function headlessHubAssetName(version: string): string {
  return `maxprice-hub_${version}_linux-x64.tar.gz`;
}

type Product = {
  /** The tarball's one entry, and the command its install runs. */
  binary: Binary;
  /** Its GLOSSARY.md headword, for the log. */
  label: string;
  assetName: (version: string) => string;
  /** The compile, run in the root. */
  compile: readonly string[];
  /** Its workspace's binaries/, from the root: where the compile writes, and the default --out. */
  binaries: string;
  /** The file the compile writes there. */
  compiled: string;
};

// In build order.
const PRODUCTS: readonly Product[] = [
  {
    binary: "maxprice",
    label: "the Headless client",
    assetName: headlessAssetName,
    compile: ["bun", "run", "build:cli"],
    binaries: "apps/cli/binaries",
    compiled: "maxprice",
  },
  {
    binary: "maxprice-hub",
    label: "the Headless Hub",
    assetName: headlessHubAssetName,
    // linux-x64 is the one target that embeds the Hub page, which this
    // command builds first (ADR-0124 §1).
    compile: ["bun", "apps/hub/scripts/build-binaries.ts", "linux-x64"],
    binaries: "apps/hub/binaries",
    compiled: "maxprice-hub-x86_64-unknown-linux-gnu",
  },
];

function productOf(binary: Binary): Product {
  return PRODUCTS.find((p) => p.binary === binary)!;
}

/**
 * Where `binary`'s compile writes it, its workspace's binaries/, and so its
 * tarball's default --out. The fallback stages each tarball from here:
 * release-assets.ts lists it under that workspace, at `binaries/<asset>`.
 */
export function defaultOutDir(root: string, binary: Binary): string {
  return join(root, productOf(binary).binaries);
}

/** The version a `vX.Y.Z` tag names, or null for anything else. */
export function versionOfTag(tag: string): string | null {
  return TAG.exec(tag)?.[1] ?? null;
}

/**
 * The file a Tauri `.sig` was signed under: the `file:` of its trusted comment,
 * or null when that comment cannot be read. Tauri writes base64 of a four-line
 * minisign file whose third line is `trusted comment: timestamp:<n>\tfile:<name>`.
 * Once surrounding whitespace is trimmed, this finds that comment by the update
 * reader's own rules for it (strict base64, exactly four lines, the untrusted
 * comment first and the trusted one third) and reads `file:` with check 3's
 * pattern. It checks nothing else the reader does, neither signature line's
 * base64 or length nor the algorithm, so a `.sig` whose name this reads can
 * still fail the reader's checks 1 and 2.
 */
export function signedFileOf(signature: string): string | null {
  const text = signature.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const lines = Buffer.from(text, "base64").toString("utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 4) return null;
  if (!lines[0]!.startsWith("untrusted comment: ")) return null;
  if (!lines[2]!.startsWith("trusted comment: ")) return null;
  const comment = lines[2]!.slice("trusted comment: ".length);
  return /^timestamp:\d+\tfile:(.+)$/.exec(comment)?.[1] ?? null;
}

type TarHeader = { name: string; type: string; mode: number; uid: number; gid: number };

/**
 * Everything wrong with `binary`'s packed tarball, by the update reader's
 * rules plus root ownership; empty when it is right. Every header counts as an
 * entry, as it does for the reader, so a pax or GNU long-name header is a
 * second entry.
 */
export function checkArchive(tgz: Buffer, binary: Binary): string[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(tgz);
  } catch (err) {
    return [`it is not valid gzip: ${err instanceof Error ? err.message : String(err)}`];
  }
  const headers = readHeaders(tar);
  if (typeof headers === "string") return [headers];
  if (headers.length !== 1) {
    const names = headers.map((h) => JSON.stringify(h.name)).join(", ");
    return [`it holds ${headers.length} entries (${names}), not one`];
  }
  const entry = headers[0]!;
  const problems: string[] = [];
  if (entry.name !== binary) {
    problems.push(`its entry is ${JSON.stringify(entry.name)}, not ${JSON.stringify(binary)}`);
  }
  if (entry.type !== "0" && entry.type !== "\0") {
    problems.push(`its entry is not a regular file (type ${JSON.stringify(entry.type)})`);
  }
  if (entry.mode !== 0o755) {
    problems.push(`its entry's mode is 0${entry.mode.toString(8)}, not 0755`);
  }
  if (entry.uid !== 0 || entry.gid !== 0) {
    problems.push(`its entry is owned by ${entry.uid}:${entry.gid}, not 0:0`);
  }
  return problems;
}

function readHeaders(tar: Buffer): TarHeader[] | string {
  const headers: TarHeader[] = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const [size, mode, uid, gid] = [
      octal(h, 124, 12),
      octal(h, 100, 8),
      octal(h, 108, 8),
      octal(h, 116, 8),
    ];
    if (size === null || mode === null || uid === null || gid === null) {
      return `entry ${headers.length + 1} has an unreadable header`;
    }
    // POSIX ustar splits a long path into prefix/name; GNU's format keeps
    // other fields at the prefix's offset, so it is read only under ustar's magic.
    const prefix = h.toString("latin1", 257, 263) === "ustar\0" ? cString(h, 345, 155) : "";
    const name = cString(h, 0, 100);
    headers.push({
      name: prefix ? `${prefix}/${name}` : name,
      type: String.fromCharCode(h[156]!),
      mode,
      uid,
      gid,
    });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return headers;
}

function cString(buf: Buffer, offset: number, width: number): string {
  const field = buf.subarray(offset, offset + width);
  const nul = field.indexOf(0);
  return field.toString("utf8", 0, nul === -1 ? width : nul);
}

function octal(buf: Buffer, offset: number, width: number): number | null {
  const text = buf
    .toString("latin1", offset, offset + width)
    .replace(/[\0 ]+$/, "")
    .replace(/^ +/, "");
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : null;
}

const realCompile: Compile = (root, binary) =>
  Bun.spawn([...productOf(binary).compile], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  }).exited;

// The signer runs in the env whose key buildHeadless checked, passed
// explicitly: Bun's spawn would otherwise hand it the environment this process
// started with.
const realSign: Sign = (asset, { root, env }) =>
  Bun.spawn(["bun", "run", "tauri", "signer", "sign", asset], {
    cwd: join(root, "apps", "desktop"),
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).exited;

export async function buildHeadless(options: BuildOptions): Promise<BuildResult[]> {
  const { root, tag, unsigned = false, env = process.env } = options;
  const compile = options.compile ?? realCompile;
  const sign = options.sign ?? realSign;
  const log = options.log ?? ((line: string) => console.log(line));

  const version = versionOfTag(tag);
  if (version === null) throw new BuildRefused(`the tag ${JSON.stringify(tag)} is not vX.Y.Z`);
  // Before the first compile, so a run that cannot sign costs nothing.
  if (!unsigned && !env[KEY_VAR]) {
    throw new BuildRefused(
      `${KEY_VAR} is not set, so the tarballs cannot be signed. ` +
        `Pass --unsigned for tarballs no channel will serve (the fallback's).`,
    );
  }

  const outputs = PRODUCTS.map((product) => {
    const out = options.out ?? defaultOutDir(root, product.binary);
    const tarball = join(out, product.assetName(version));
    return { product, tarball, signature: `${tarball}.sig` };
  });
  const clear = () => {
    for (const { tarball, signature } of outputs) {
      rmSync(tarball, { force: true });
      rmSync(signature, { force: true });
    }
  };

  clear();
  try {
    const results: BuildResult[] = [];
    for (const output of outputs) {
      results.push(
        await buildProduct({ ...output, root, tag, version, unsigned, compile, sign, env, log }),
      );
    }
    return results;
  } catch (err) {
    clear();
    throw err;
  }
}

type ProductRun = {
  product: Product;
  tarball: string;
  signature: string;
  root: string;
  tag: string;
  version: string;
  unsigned: boolean;
  compile: Compile;
  sign: Sign;
  env: Env;
  log: (line: string) => void;
};

/** One product's steps; the caller removes both products' outputs when any refuses. */
async function buildProduct(run: ProductRun): Promise<BuildResult> {
  const { product, tarball, signature, root, tag, version, log } = run;
  const { binary } = product;
  const asset = basename(tarball);
  const command = product.compile.join(" ");
  const compiled = join(defaultOutDir(root, binary), product.compiled);

  log(`[build-headless] compiling ${product.label} in ${root}`);
  const code = await run.compile(root, binary);
  if (code !== 0) throw new BuildRefused(`\`${command}\` exited ${code}`);
  if (!existsSync(compiled)) {
    throw new BuildRefused(`\`${command}\` exited 0 but wrote no ${compiled}`);
  }

  const stage =
    basename(compiled) === binary ? null : mkdtempSync(join(tmpdir(), `build-headless-${binary}-`));
  try {
    const packed = stage === null ? compiled : join(stage, binary);
    // What the refusals call the probed file: the copy is gone by the time
    // anyone reads them.
    const probed = stage === null ? compiled : `${binary} (a copy of ${compiled})`;
    if (stage !== null) {
      log(`[build-headless] staging ${binary} alone in ${stage}`);
      copyFileSync(compiled, packed);
    }
    chmodSync(packed, 0o755);

    log(`[build-headless] checking ${binary} --version prints ${version}`);
    const probe = spawnSync(packed, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: VERSION_TIMEOUT_MS,
    });
    if (probe.error) {
      throw new BuildRefused(`${probed} --version could not run: ${probe.error.message}`);
    }
    if (probe.status !== 0) {
      throw new BuildRefused(
        `${probed} --version exited ${probe.status ?? probe.signal}: ${probe.stderr.trim()}`,
      );
    }
    const printed = probe.stdout.trim();
    if (printed !== version) {
      throw new BuildRefused(
        `${probed} --version printed ${JSON.stringify(printed)}, not ${version} ` +
          `(${tag} minus its v): ${binary} update would refuse this binary at its check 5`,
      );
    }

    log(`[build-headless] packing ${tarball}`);
    mkdirSync(dirname(tarball), { recursive: true });
    const tar = spawnSync(
      "tar",
      [
        "--format=gnu",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-czf",
        tarball,
        "-C",
        dirname(packed),
        binary,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (tar.status !== 0) {
      throw new BuildRefused(`tar exited ${tar.status ?? tar.signal}: ${tar.stderr.trim()}`);
    }
    const problems = checkArchive(readFileSync(tarball), binary);
    if (problems.length > 0) {
      throw new BuildRefused(
        `${asset} is not what ${binary} update can install: ${problems.join("; ")}`,
      );
    }
  } finally {
    if (stage !== null) rmSync(stage, { recursive: true, force: true });
  }

  if (run.unsigned) {
    log(`[build-headless] --unsigned: no ${asset}.sig`);
    return { binary, tarball, signature: null };
  }

  log(`[build-headless] signing ${asset}`);
  const signed = await run.sign(tarball, { root, env: run.env });
  if (signed !== 0) throw new BuildRefused(`the signer (tauri signer sign) exited ${signed}`);
  if (!existsSync(signature)) {
    throw new BuildRefused(`the signer exited 0 but wrote no ${signature}`);
  }
  const file = signedFileOf(readFileSync(signature, "utf8"));
  if (file === null) {
    throw new BuildRefused(`${signature} has no readable trusted comment naming a file`);
  }
  if (file !== asset) {
    throw new BuildRefused(
      `${signature} signs file:${file}, not file:${asset}. ${binary} update refuses any ` +
        `file: but the asset name for the manifest's version (ADR-0123 §4 check 3)`,
    );
  }
  return { binary, tarball, signature };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(why: string): number {
  console.error(
    `${why}\n\nusage: build-headless.ts --tag vX.Y.Z [--out <dir>] [--unsigned] [--root <dir>]`,
  );
  return 2;
}

async function main(argv: string[]): Promise<number> {
  const values: Partial<Record<"--tag" | "--out" | "--root", string>> = {};
  let unsigned = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--unsigned") {
      unsigned = true;
    } else if (arg === "--tag" || arg === "--out" || arg === "--root") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) return usage(`${arg} needs a value`);
      values[arg] = value;
    } else {
      return usage(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  const tag = values["--tag"];
  if (tag === undefined) return usage("missing --tag");
  if (versionOfTag(tag) === null) return usage(`--tag ${JSON.stringify(tag)} is not vX.Y.Z`);

  try {
    const results = await buildHeadless({
      root: resolve(values["--root"] ?? process.cwd()),
      tag,
      out: values["--out"] === undefined ? undefined : resolve(values["--out"]),
      unsigned,
    });
    for (const result of results) {
      console.log(`Built  ${result.tarball}`);
      if (result.signature !== null) console.log(`Signed ${result.signature}`);
    }
    return 0;
  } catch (err) {
    if (!(err instanceof BuildRefused)) throw err;
    console.error(`\nRefusing to build the Headless tarballs: ${err.message}\n`);
    return 1;
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
