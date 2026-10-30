import { UPDATE_CHANNEL } from "@maxprice/shared";
import type { SelfUpdateProduct } from "@maxprice/usage-core/self-update";

// The Headless client's view of the update channel (ADR-0123 §3, §9, amended by
// #472): `headless-latest.json` on the `MP-Updates` release, signed by the key
// UPDATE_CHANNEL carries, holding one linux-x86_64 entry whose tarball holds
// `maxprice`. `update` installs from it, and `serve` checks it at boot and
// every 6 h.
//
// The one seam is build-time. A test build's channel, and only a test build's:
// `bun build --define` (or `bun --define` from source, as test-utils' spawns
// do) replaces this identifier with {manifestUrl, pubkey} JSON. The production
// build (scripts/build-binary.ts) defines it as `undefined`, so the lookup
// folds away and the binary carries UPDATE_CHANNEL alone and reads nothing at
// runtime. Without that define a compiled Bun binary would look the global up
// at runtime, where BUN_OPTIONS=--preload can set it.
//
// Keep this file small, and the only one in src that names the identifier:
// Bun's runtime transpiler cache keeps only large files, so a define from
// source always reaches this one.
declare const MAXPRICE_TEST_UPDATE_CHANNEL: { manifestUrl: string; pubkey: string } | undefined;

export const MANIFEST_NAME = "headless-latest.json";

const testChannel =
  typeof MAXPRICE_TEST_UPDATE_CHANNEL === "undefined" ? undefined : MAXPRICE_TEST_UPDATE_CHANNEL;

export const PRODUCT: SelfUpdateProduct = {
  manifestUrl: testChannel?.manifestUrl ?? UPDATE_CHANNEL.baseUrl + MANIFEST_NAME,
  pubkey: testChannel?.pubkey ?? UPDATE_CHANNEL.pubkey,
  platform: "linux-x86_64",
  // ADR-0123 §2: the name CI signs the tarball under, which check 3 matches.
  assetName: (version) => `maxprice_${version}_linux-x64.tar.gz`,
  binaryName: "maxprice",
};
