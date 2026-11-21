// A throwaway update channel's parts, for the self-update tests, the daemon's
// update check and the acceptance rig (ADR-0123 §4, §8): a minisign signer
// that writes what `tauri signer sign` writes, a hand-built tar.gz, a stand-in
// Headless client binary, and Tauri's manifest shape. Each key is generated
// at test time; nothing here is trusted by a production build.
// NOT exported from the package barrel — import via
// "@maxprice/usage-core/test-channel" so compiled binaries never bundle it.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { gzipSync } from "node:zlib";

export const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

// ---------------------------------------------------------------------------
// minisign, as `tauri signer sign` writes it
// ---------------------------------------------------------------------------

export interface SigningKey {
  keyId: Buffer;
  privateKey: KeyObject;
  /** base64 of the two-line public key file, as tauri.conf.json carries it */
  pubkey: string;
}

export function signingKey(keyId: Buffer = randomBytes(8)): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const line = Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64");
  const id = Buffer.from(keyId).reverse().toString("hex").toUpperCase();
  return {
    keyId,
    privateKey,
    pubkey: b64(`untrusted comment: minisign public key: ${id}\n${line}\n`),
  };
}

export function signatureFile(sigLine: Buffer, trustedComment: string, globalSig: Buffer): string {
  return b64(
    "untrusted comment: signature from tauri secret key\n" +
      `${sigLine.toString("base64")}\n` +
      `trusted comment: ${trustedComment}\n` +
      `${globalSig.toString("base64")}\n`,
  );
}

/**
 * A Tauri `.sig` over `bytes`: prehashed ("ED") unless `alg` asks for the
 * legacy "Ed", carrying `keyId` (the signer's own by default).
 */
export function signBytes(
  bytes: Uint8Array,
  trustedComment: string,
  key: SigningKey,
  opts: { keyId?: Buffer; alg?: "ED" | "Ed" } = {},
): string {
  const alg = opts.alg ?? "ED";
  const signed = alg === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes;
  const sig = sign(null, signed, key.privateKey);
  const globalSig = sign(null, Buffer.concat([sig, Buffer.from(trustedComment)]), key.privateKey);
  return signatureFile(
    Buffer.concat([Buffer.from(alg), opts.keyId ?? key.keyId, sig]),
    trustedComment,
    globalSig,
  );
}

/** The trusted comment `tauri signer sign` writes for `file`. */
export const comment = (file: string): string => `timestamp:1792380328\tfile:${file}`;

// ---------------------------------------------------------------------------
// tar.gz, by hand, so a malformed variant is one argument away
// ---------------------------------------------------------------------------

export interface TarEntry {
  name: string;
  data?: string | Buffer;
  /** typeflag: "0" a file, "5" a directory, "2" a symlink, "x" a pax header */
  type?: string;
  /** the header's size, when it should lie about the data */
  size?: number;
}

export function tarHeader(entry: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512);
  const field = (offset: number, width: number, value: string): void => {
    h.write(value.padEnd(width, "\0").slice(0, width), offset, "latin1");
  };
  const octal = (offset: number, width: number, value: number): void =>
    field(offset, width, `${value.toString(8).padStart(width - 1, "0")}\0`);
  field(0, 100, entry.name);
  octal(100, 8, 0o755);
  octal(108, 8, 1000);
  octal(116, 8, 1000);
  octal(124, 12, size);
  octal(136, 12, 1792380328);
  field(148, 8, "        ");
  field(156, 1, entry.type ?? "0");
  field(257, 8, "ustar  \0"); // GNU tar's default (gnu) format magic
  let sum = 0;
  for (const byte of h) sum += byte;
  field(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

export function tar(entries: TarEntry[], { end = true } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    parts.push(tarHeader(entry, entry.size ?? data.length), data);
    parts.push(Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  if (end) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export const tgz = (entries: TarEntry[]): Buffer => gzipSync(tar(entries));

/** A stand-in Headless client whose `--version` prints `version`. */
export const script = (version: string, exit = 0): string =>
  `#!/bin/sh\necho ${version}\nexit ${exit}\n`;

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** A Tauri updater manifest with one platform entry, as `MP-Updates` serves it. */
export function manifest(version: string, platform: string, url: string, signature: string) {
  return {
    version,
    notes: "",
    pub_date: "2026-10-19T00:00:00Z",
    platforms: { [platform]: { url, signature } },
  };
}
