// The self-update core shared by the headless products (ADR-0123 §9): the
// manifest fetch, the five checks of §4, the extraction and the swap. The
// mechanics, and the hazards they answer, are in
// docs/research/headless-client-self-update.md (§2 the signature, §4 the swap).
//
// Reachable only via the "./self-update" subpath, never index.ts: the sidecar
// and the Desktop client never update themselves (Tauri's updater does that),
// so their bundles must not carry it.
//
// A caller reads `process.execPath` before ANYTHING else and passes it in. Bun
// memoizes it on first read, from /proc/self/exe; read after a swap it names
// the unlinked file, `…/maxprice (deleted)`, and the rename would land beside
// the binary instead of over it.
//
// The core never logs; every refusal is a SelfUpdateError whose `failure`
// names the check, and the caller says what it means.

import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import {
  accessSync,
  fchmodSync,
  closeSync,
  constants,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";

import { errnoName, tryLockExclusive } from "./flock";

/** One headless product's view of the channel. */
export interface SelfUpdateProduct {
  /** Production: `UPDATE_CHANNEL.baseUrl` plus the product's manifest name. */
  manifestUrl: string;
  /** Production: `UPDATE_CHANNEL.pubkey`, base64 of a minisign public key file. */
  pubkey: string;
  /** The manifest's platform key, such as "linux-x86_64". */
  platform: string;
  /** The tarball's published name, which CI signs it under: "maxprice_<v>_linux-x64.tar.gz". */
  assetName(version: string): string;
  /** The tarball's one entry (ADR-0123 §2), such as "maxprice". */
  binaryName: string;
}

/** The manifest's version and this product's entry, as served: unverified. */
export interface ChannelRelease {
  version: string;
  url: string;
  signature: string;
}

export interface UpdateCheck {
  current: string;
  latest: string;
  available: boolean;
  release: ChannelRelease;
}

/**
 * Which step refused, in installUpdate's order, except that a malformed or
 * legacy (unhashed) signature refuses as "signature" with check 1, before the
 * download:
 * - "unwritable": the caller cannot read, write and search the binary's
 *   directory (checked before the download), or writing `<execPath>.new` there
 *   (including setting its mode and fsyncing it) failed.
 * - "key-id": the signature's key is not the trusted one, or the pubkey is malformed.
 * - "download": the tarball could not be fetched.
 * - "signature": malformed, legacy (unhashed) or not valid over the bytes and
 *   the trusted comment.
 * - "file": the trusted comment does not name this version's asset.
 * - "not-newer": the release is not strictly newer than the running version.
 * - "archive": not a gzipped tar holding exactly the one binary.
 * - "busy": another run holds the lock on the binary's directory.
 * - "version": the new binary did not print the release's version and exit 0
 *   within the deadline, did not run at all, or the check around it could not
 *   run, report the binary's status or clean up after it.
 * - "swap": the directory could not be locked for any reason but another run
 *   (an open or flock(2) error, such as its permissions changing after the
 *   preflight, or no libc to call flock through, as on win32), the installed
 *   binary could not confirm the running version under that lock, or the rename
 *   over execPath failed.
 * "manifest" is checkForUpdate's one failure, and installUpdate's for a release
 * whose version is not x.y.z.
 */
export type SelfUpdateFailure =
  | "manifest"
  | "download"
  | "unwritable"
  | "key-id"
  | "signature"
  | "file"
  | "not-newer"
  | "archive"
  | "busy"
  | "version"
  | "swap";

export class SelfUpdateError extends Error {
  readonly failure: SelfUpdateFailure;

  constructor(failure: SelfUpdateFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SelfUpdateError";
    this.failure = failure;
  }
}

const MANIFEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const VERSION_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 5_000;

const VERSION = /^\d+\.\d+\.\d+$/;

/** Strictly newer, comparing x.y.z numerically; a TypeError unless both are x.y.z. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

/**
 * Fetches the product's manifest and reads only its version and the product's
 * own platform entry. Another entry is never validated: one malformed entry
 * must not fail every product's check (the research's second hazard).
 */
export async function checkForUpdate(
  product: SelfUpdateProduct,
  currentVersion: string,
): Promise<UpdateCheck> {
  let body: unknown;
  try {
    const res = await fetch(product.manifestUrl, {
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new SelfUpdateError("manifest", `${product.manifestUrl} answered HTTP ${res.status}`);
    }
    body = await res.json();
  } catch (err) {
    if (err instanceof SelfUpdateError) throw err;
    throw new SelfUpdateError("manifest", `cannot read ${product.manifestUrl}: ${String(err)}`, {
      cause: err,
    });
  }
  const parsed = z
    .object({
      version: z.string().regex(VERSION),
      platforms: z.object({
        [product.platform]: z.object({ url: z.string().url(), signature: z.string().min(1) }),
      }),
    })
    .safeParse(body);
  if (!parsed.success) {
    throw new SelfUpdateError(
      "manifest",
      `${product.manifestUrl} has no valid version and ${product.platform} entry: ${parsed.error.issues[0]?.message}`,
    );
  }
  const { version, platforms } = parsed.data;
  const { url, signature } = platforms[product.platform]!;
  return {
    current: currentVersion,
    latest: version,
    available: isNewerVersion(version, currentVersion),
    release: { version, url, signature },
  };
}

/**
 * Installs `release` over `opts.execPath` if it passes ADR-0123 §4's five
 * checks, and returns the change. Any failure throws a SelfUpdateError, removes
 * the `<execPath>.new` this run created, and never touches execPath. Never
 * escalates privileges: an unwritable directory is refused (§6).
 *
 * Check 5 runs the new binary as `<execPath>.new --version`, beside a live
 * daemon, so the contract is that the Headless client's `--version` prints the
 * bare version (`0.9.0`) and nothing else, exits 0, and has no side effects.
 * The installed binary must also print `currentVersion` under the directory
 * lock, before any stale `.new` is removed; otherwise the swap refuses as
 * "swap", since another update may have replaced it. Both probes use the same
 * bounded wrapper, each with `versionTimeoutMs` (15 s), and wait at most
 * `cleanupTimeoutMs` (5 s) for the wrapper to go; both are options for tests.
 *
 * One run at a time per directory: from before `.new` is touched until after
 * the rename and the directory fsync, a run holds flock(2) on the directory,
 * and a second run refuses "busy" rather than waiting. Without it, a second run could replace the
 * `.new` the first had checked, and the first would rename that into place.
 */
export async function installUpdate(
  product: SelfUpdateProduct,
  release: ChannelRelease,
  opts: {
    currentVersion: string;
    execPath: string;
    versionTimeoutMs?: number;
    cleanupTimeoutMs?: number;
  },
): Promise<{ from: string; to: string }> {
  const {
    execPath,
    currentVersion,
    versionTimeoutMs = VERSION_TIMEOUT_MS,
    cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
  } = opts;
  const bounds = { versionMs: versionTimeoutMs, cleanupMs: cleanupTimeoutMs };
  parseVersion(currentVersion); // the caller's own version: a TypeError, not a refusal
  if (!VERSION.test(release.version)) {
    throw new SelfUpdateError("manifest", `the release's version ${release.version} is not x.y.z`);
  }
  const dir = dirname(execPath);
  const next = `${execPath}.new`;

  // §6: the swap is a rename in this directory, so the caller must write and
  // search it, and the lock opens it, so the caller must read it too.
  try {
    accessSync(dir, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (err) {
    throw new SelfUpdateError(
      "unwritable",
      `cannot replace ${execPath}: this user must be able to read, write and search ${dir}, which is owned by ${ownerOf(dir)}`,
      { cause: err },
    );
  }

  // Check 1, before the download: the key id.
  const signed = openSignature(release.signature, product.pubkey);

  const tarball = await download(release.url);

  // Check 2: the signature over the bytes and the trusted comment.
  const { trustedComment } = verifyOpened(
    createHash("blake2b512").update(tarball).digest(),
    signed,
  );

  // Check 3: the one signed place that ties the bytes to a version.
  const expected = product.assetName(release.version);
  const file = /^timestamp:\d+\tfile:(.+)$/.exec(trustedComment)?.[1];
  if (file !== expected) {
    throw new SelfUpdateError(
      "file",
      `the signature is for ${file ?? "no file"}, not ${expected}: refusing ${release.url}`,
    );
  }

  // Check 4: no downgrade, no reinstall.
  if (!isNewerVersion(release.version, currentVersion)) {
    throw new SelfUpdateError(
      "not-newer",
      `${release.version} is not newer than the running ${currentVersion}`,
    );
  }

  const binary = extractSingleFile(tarball, product.binaryName);

  // Held from before the stale `.new` is removed until after the directory
  // fsync. The directory's fd, because its identity survives the rename and
  // execPath's inode does not.
  const lock = lockDirectory(dir, execPath);
  let created = false;
  try {
    // Check 4 used the caller's running version. A faster update may have
    // replaced execPath during this download: confirm it under the lock,
    // before touching even a crash's leftover .new, with check 5's deadline
    // and identity-safe process cleanup. Never open execPath writable.
    try {
      await expectVersion(execPath, currentVersion, bounds);
    } catch (err) {
      throw new SelfUpdateError(
        "swap",
        `${execPath}: its version could not be confirmed as the running one (${currentVersion}); another update may have replaced it: ${String(err)}`,
        { cause: err },
      );
    }

    // A stale .new, a crash's leftover, is replaced (§4). rmSync removes a
    // symlink itself, never its target, and the exclusive create never follows one.
    let fd: number;
    try {
      rmSync(next, { force: true });
      fd = openSync(next, "wx", 0o755);
      created = true;
      try {
        let written = 0;
        while (written < binary.length) {
          written += writeSync(fd, binary, written);
        }
        fchmodSync(fd, 0o755); // persist the final mode too, despite the umask
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      throw new SelfUpdateError("unwritable", `cannot write ${next}: ${String(err)}`, {
        cause: err,
      });
    }

    // Check 5: the new binary runs here and is the version the signature named.
    await expectVersion(next, release.version, bounds);

    // Same directory, so never EXDEV; a rename, so never ETXTBSY.
    try {
      renameSync(next, execPath);
    } catch (err) {
      throw new SelfUpdateError("swap", `cannot rename ${next} over ${execPath}: ${String(err)}`, {
        cause: err,
      });
    }
    created = false;
    syncDirectory(lock);
  } finally {
    if (created) {
      try {
        rmSync(next, { force: true });
      } catch {
        // The refusal stands either way, and the next run replaces a leftover.
      }
    }
    closeSync(lock); // releases the flock
  }
  return { from: currentVersion, to: release.version };
}

/**
 * Checks 1 and 2 over a BLAKE2b-512 digest: the key id, then Ed25519 over the
 * digest and over the signature plus its trusted comment. Returns the trusted
 * comment's text. installUpdate runs the same two steps around its download;
 * this entry point is the one the real-signature test vector drives.
 */
export function verifyMinisignDigest(
  digest: Uint8Array,
  signature: string,
  pubkey: string,
): { trustedComment: string } {
  return verifyOpened(digest, openSignature(signature, pubkey));
}

// ---------------------------------------------------------------------------

function parseVersion(version: string): [number, number, number] {
  if (!VERSION.test(version)) throw new TypeError(`not an x.y.z version: ${version}`);
  const [x, y, z] = version.split(".").map(Number) as [number, number, number];
  return [x, y, z];
}

function ownerOf(path: string): string {
  try {
    return `uid ${statSync(path).uid}`;
  } catch {
    return "an unknown owner";
  }
}

/**
 * flock(2) on an fd of the directory, without waiting: another run's lock is
 * "busy". Anything else that stops the lock (an open error, a flock error, no
 * libc) fails closed as "swap", never unlocked. Returns the fd; closing it
 * releases the lock.
 */
function lockDirectory(dir: string, execPath: string): number {
  let fd: number | undefined;
  let errno: number;
  try {
    fd = openSync(dir, "r");
    errno = tryLockExclusive(fd);
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    throw new SelfUpdateError("swap", `cannot lock ${dir} for the update: ${String(err)}`, {
      cause: err,
    });
  }
  if (errno === 0) return fd;
  closeSync(fd);
  if (errno === osConstants.errno.EWOULDBLOCK) {
    throw new SelfUpdateError("busy", `another update of ${execPath} is running`);
  }
  throw new SelfUpdateError(
    "swap",
    `cannot lock ${dir} for the update: flock failed with ${errnoName(errno)}`,
  );
}

async function download(url: string): Promise<Buffer> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new SelfUpdateError("download", `cannot download ${url}: ${String(err)}`, {
      cause: err,
    });
  }
}

// --- minisign --------------------------------------------------------------
//
// Formats (minisign's spec; `tauri signer sign` writes each base64-wrapped):
//   public key:  untrusted comment: …
//                base64("Ed" ‖ key id 8 ‖ Ed25519 key 32)
//   signature:   untrusted comment: …
//                base64("ED" ‖ key id 8 ‖ Ed25519(BLAKE2b-512(file)) 64)
//                trusted comment: <text>
//                base64(Ed25519(signature 64 ‖ <text>) 64)

interface OpenedSignature {
  key: KeyObject;
  signature: Buffer;
  trustedComment: string;
  globalSignature: Buffer;
}

/** Decodes both files and makes check 1: the signature names the trusted key. */
function openSignature(signature: string, pubkey: string): OpenedSignature {
  const pub = decodeLines(pubkey, 2);
  const pubBytes = pub && pub[0]!.startsWith("untrusted comment: ") ? strictBase64(pub[1]!) : null;
  if (pubBytes?.length !== 42 || pubBytes.toString("latin1", 0, 2) !== "Ed") {
    throw new SelfUpdateError("key-id", "the trusted pubkey is not a minisign Ed25519 public key");
  }
  const sig = decodeLines(signature, 4);
  const sigBytes = sig && sig[0]!.startsWith("untrusted comment: ") ? strictBase64(sig[1]!) : null;
  const globalSignature = sig ? strictBase64(sig[3]!) : null;
  if (
    !sig ||
    sigBytes?.length !== 74 ||
    !sig[2]!.startsWith("trusted comment: ") ||
    globalSignature?.length !== 64
  ) {
    throw new SelfUpdateError("signature", "the signature is not a minisign signature file");
  }
  // "ED" is prehashed. The legacy "Ed" signs the raw file; minisign's spec
  // says new implementations must use the hashed format.
  if (sigBytes.toString("latin1", 0, 2) !== "ED") {
    throw new SelfUpdateError("signature", "the signature does not use minisign's hashed format");
  }
  const keyId = sigBytes.subarray(2, 10);
  if (!keyId.equals(pubBytes.subarray(2, 10))) {
    throw new SelfUpdateError(
      "key-id",
      `the signature's key ${formatKeyId(keyId)} is not the trusted ${formatKeyId(pubBytes.subarray(2, 10))}`,
    );
  }
  return {
    key: createPublicKey({
      format: "jwk",
      key: { kty: "OKP", crv: "Ed25519", x: pubBytes.subarray(10).toString("base64url") },
    }),
    signature: sigBytes.subarray(10),
    trustedComment: sig[2]!.slice("trusted comment: ".length),
    globalSignature,
  };
}

/** Check 2. */
function verifyOpened(digest: Uint8Array, opened: OpenedSignature): { trustedComment: string } {
  const { key, signature, trustedComment, globalSignature } = opened;
  if (!verifySignature(null, digest, key, signature)) {
    throw new SelfUpdateError("signature", "the signature does not match the downloaded bytes");
  }
  const covered = Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]);
  if (!verifySignature(null, covered, key, globalSignature)) {
    throw new SelfUpdateError("signature", "the signature's trusted comment has been altered");
  }
  return { trustedComment };
}

/** base64 → text → exactly `count` lines (one trailing newline allowed), or null. */
function decodeLines(file: string, count: number): string[] | null {
  const raw = strictBase64(file);
  if (!raw) return null;
  const lines = raw.toString("utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.length === count ? lines : null;
}

/** Buffer.from(…, "base64") skips what it cannot read; this refuses it. */
function strictBase64(text: string): Buffer | null {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(text) ? Buffer.from(text, "base64") : null;
}

/** minisign prints a key id byte-reversed. */
function formatKeyId(keyId: Buffer): string {
  return Buffer.from(keyId).reverse().toString("hex").toUpperCase();
}

// --- the tarball -----------------------------------------------------------

/**
 * The tarball holds one regular file named `name` at its root (ADR-0123 §2);
 * anything else is refused. A hand-written reader rather than Bun.Archive,
 * because the refusals are the point: a second entry, a link, a directory, a
 * header that lies about its size.
 *
 * Only `name` exactly, by choice: CI packs with `tar -czf … -C <dir> maxprice`,
 * which writes `maxprice`, and a `./maxprice` is refused like any other name.
 * CI must pack with GNU tar's default (gnu) format, or ustar:
 * `--format=posix` writes a pax header ahead of the file, and a long name a
 * GNU long-name header, each an entry of its own and so refused.
 */
function extractSingleFile(tgz: Buffer, name: string): Buffer {
  let tar: Buffer;
  try {
    tar = gunzipSync(tgz);
  } catch (err) {
    throw new SelfUpdateError("archive", `the tarball is not valid gzip: ${String(err)}`, {
      cause: err,
    });
  }
  if (tar.length < 512) refuseArchive("is truncated before its first header");
  const header = tar.subarray(0, 512);
  if (header.every((b) => b === 0)) refuseArchive("holds no entry");

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  if (octal(header, 148, 8) !== sum) refuseArchive("has a header with a bad checksum");

  const typeflag = header[156]!;
  if (typeflag !== 0x30 && typeflag !== 0) {
    refuseArchive(
      `entry is not a regular file (type ${JSON.stringify(String.fromCharCode(typeflag))})`,
    );
  }
  // POSIX ustar splits a long path into prefix/name. GNU's format puts other
  // fields at the prefix's offset, so the prefix is read only under ustar's magic.
  const posixUstar = header.toString("latin1", 257, 263) === "ustar\0";
  const prefix = posixUstar ? cString(header, 345, 155) : "";
  const entry = prefix ? `${prefix}/${cString(header, 0, 100)}` : cString(header, 0, 100);
  if (entry !== name) {
    refuseArchive(`entry is ${JSON.stringify(entry)}, not ${JSON.stringify(name)}`);
  }

  // A base-256 size (the high bit set) is GNU's escape for files over 8 GiB.
  const size = header[124]! & 0x80 ? null : octal(header, 124, 12);
  if (size === null) refuseArchive("has an unreadable entry size");
  const end = 512 + Math.ceil(size / 512) * 512;
  if (end > tar.length) {
    refuseArchive(`is truncated: its entry is ${size} bytes, the archive shorter`);
  }
  // After the one file, only the end-of-archive marker: zero blocks, at least two.
  const rest = tar.subarray(end);
  if (rest.length < 1024) refuseArchive("is truncated before its end-of-archive marker");
  if (!rest.every((b) => b === 0)) refuseArchive("holds more than one entry");
  return tar.subarray(512, 512 + size);
}

function refuseArchive(why: string): never {
  throw new SelfUpdateError("archive", `the tarball ${why}`);
}

function cString(buf: Buffer, offset: number, width: number): string {
  const field = buf.subarray(offset, offset + width);
  const nul = field.indexOf(0);
  return field.toString("utf8", 0, nul === -1 ? width : nul);
}

/** An octal header field, NUL- or space-terminated; null when it is not one. */
function octal(buf: Buffer, offset: number, width: number): number | null {
  const text = buf
    .toString("latin1", offset, offset + width)
    .replace(/[\0 ]+$/, "")
    .replace(/^ +/, "");
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : null;
}

// --- version probes and the swap --------------------------------------------------

/**
 * Both version probes' wrapper, run by expectVersion as
 * `/bin/sh -c VERSION_CHECK_SCRIPT sh <binary> <nonce>` in a session and
 * process group of its own. It exists so that the group is only ever killed
 * from inside: `kill 0` from a live member, whose presence keeps the group's
 * ID reserved, so the kill cannot reach another group, and the updater never
 * signals a process by number.
 *
 * In order: it refuses to run anything unless it leads its own group (were
 * Bun's `detached` ever to stop calling setsid, `kill 0` would hit the
 * updater's group), saying so on stderr. It starts a watcher, its output sent
 * to /dev/null, that reads the stdin the updater never writes to and kills
 * the group at EOF: when the updater closes it, on every way out of the check,
 * or when the updater dies and the kernel closes it. It runs the binary with
 * no stdin and without the watcher's fd, and reports the binary's exit status
 * on stderr as one `<nonce> <status>` line, after a newline so that no partial
 * line from a child can run into it. It then closes its own stdout and stderr,
 * so the pipes end only when the binary and its children have let go, waits
 * for the watcher, and kills the group itself should the watcher be gone.
 *
 * Exported for its guard's test.
 */
export const VERSION_CHECK_SCRIPT = String.raw`n=$2
if [ "$(cut -d' ' -f5 /proc/$$/stat)" != "$$" ]; then
  printf '\n%s not-a-group-leader\n' "$n" >&2
  exit 1
fi
exec 3<&0
(read -r _ <&3; kill -s KILL 0) </dev/null >/dev/null 2>&1 &
"$1" --version </dev/null 3<&-
printf '\n%s %s\n' "$n" "$?" >&2
exec >&- 2>&-
wait
kill -s KILL 0`;

/**
 * The installed-version guard and check 5 share this bounded probe. Each
 * call has one deadline for the wrapper's report and both pipes alike.
 * At the deadline the check is refused without waiting for more output: a
 * child of the binary that inherited the pipes may hold them as long as it
 * likes. On every way out, success included, the wrapper's stdin is closed,
 * its watcher kills the whole group with SIGKILL, which nothing in it can
 * ignore, and the wrapper's exit is awaited for a bounded time, past which the
 * check refuses. So `--version` leaves nothing running (ADR-0123: it must be
 * free of side effects), and if the updater dies mid-check (Ctrl-C, SIGTERM,
 * a crash), the kernel's closing of that stdin does the same. Through sh, a
 * binary this host cannot run exits 126 or 127; a file with neither a `#!`
 * line nor a binary header would run as a script (POSIX's rule for ENOEXEC),
 * which signed candidate bytes make moot; the installed binary must also
 * obey the side-effect-free `--version` contract.
 *
 * Residuals: a descendant that leaves the group itself, by setsid or setpgid,
 * escapes the kill; and a binary that kills both the wrapper and its watcher
 * evades the cleanup, though it is refused, since its status never arrives.
 * When it kills only the wrapper, the watcher still kills the group at the
 * cue, a moment after the check returns. When it kills only the watcher and
 * then hangs, the wrapper and the binary both stay running: endCheck refuses
 * after its bound, so the update fails and the old binary stays, and nothing
 * else is killed. Cleanup resumes if the binary ever exits (the wrapper's
 * `wait` returns and its own `kill 0` runs); otherwise they need killing from
 * outside. All of this is Linux's: win32 never gets here, because the lock
 * fails first.
 */
async function expectVersion(
  binary: string,
  version: string,
  bounds: { versionMs: number; cleanupMs: number },
): Promise<void> {
  const timeoutMs = bounds.versionMs;
  const nonce = randomBytes(16).toString("hex");
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["/bin/sh", "-c", VERSION_CHECK_SCRIPT, "sh", binary, nonce], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (err) {
    throw new SelfUpdateError("version", `cannot start the binary's check: ${String(err)}`, {
      cause: err,
    });
  }
  try {
    const out = proc.stdout.getReader();
    const err = proc.stderr.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(resolve, timeoutMs, null);
    });
    const work = Promise.all([drain(out), drain(err)]);
    work.catch(() => undefined); // read after the deadline only to be dropped
    let finished: Awaited<typeof work> | null;
    try {
      finished = await Promise.race([work, deadline]);
    } catch (e) {
      throw new SelfUpdateError("version", `cannot read the binary's --version: ${String(e)}`, {
        cause: e,
      });
    } finally {
      clearTimeout(timer);
    }
    if (finished === null) {
      void out.cancel().catch(() => undefined);
      void err.cancel().catch(() => undefined);
      throw new SelfUpdateError(
        "version",
        `the binary's --version did not finish within ${timeoutMs} ms`,
      );
    }
    const [stdout, stderr] = finished;
    // The wrapper's report, left out of what the binary said on stderr.
    const marker = new RegExp(`^${nonce} (\\S+)$`);
    let reported: string | undefined;
    const said: string[] = [];
    for (const line of stderr.split("\n")) {
      const match = marker.exec(line);
      if (match) reported = match[1];
      else if (line.trim()) said.push(line.trim());
    }
    const why = said.length > 0 ? ` (${said[0]!.slice(0, 200)})` : "";
    if (reported === "not-a-group-leader") {
      throw new SelfUpdateError(
        "version",
        "the check could not run in a process group of its own, so it ran nothing",
      );
    }
    if (reported === undefined || !/^\d+$/.test(reported)) {
      throw new SelfUpdateError(
        "version",
        `the binary's --version ended without its status reaching the check${why}`,
      );
    }
    const exitCode = Number(reported); // 126 or 127 when sh could not run it
    const printed = stdout.trim();
    if (exitCode !== 0 || printed !== version) {
      const result =
        exitCode === 0 ? `printed ${JSON.stringify(printed.slice(0, 80))}` : `exited ${exitCode}`;
      throw new SelfUpdateError(
        "version",
        `the binary's --version ${result}, not ${version}${why}`,
      );
    }
  } finally {
    await endCheck(proc, bounds.cleanupMs);
  }
}

/**
 * Closes the wrapper's stdin, the watcher's cue to kill the group, and waits
 * for the wrapper to go. Never signals anything itself: if the wrapper is
 * still there after the bound, the check refuses rather than kill by number.
 */
async function endCheck(
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
  cleanupMs: number,
): Promise<void> {
  try {
    void Promise.resolve(proc.stdin.end()).catch(() => undefined);
  } catch {
    // already closed: the wrapper is gone, and the watcher has its EOF
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gone = await Promise.race([
    proc.exited.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(resolve, cleanupMs, false);
    }),
  ]);
  clearTimeout(timer);
  if (!gone) {
    throw new SelfUpdateError("version", "could not clean up the check's processes");
  }
}

async function drain(reader: {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * The rename reaches the disk only once its directory is fsynced (fsync(2)),
 * through the lock's fd. Best effort: the rename has already happened, so a
 * filesystem that refuses a directory fsync (some network and FUSE mounts
 * answer EINVAL) is no reason to report a failed update for a binary that has
 * been replaced.
 */
function syncDirectory(dirFd: number): void {
  try {
    fsyncSync(dirFd);
  } catch {
    // see above
  }
}
