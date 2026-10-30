import { UPDATE_CHANNEL } from "@maxprice/shared";
import type { SelfUpdateProduct } from "@maxprice/usage-core/self-update";

// The Headless Hub's view of the update channel (ADR-0129 §3, §4, §7):
// `headless-hub-latest.json` on the `MP-Updates` release, signed by the key
// UPDATE_CHANNEL carries, holding one linux-x86_64 entry whose tarball holds
// `maxprice-hub`. `update` installs from it, and a Headless `serve` checks it
// at boot and every 6 h. The Headless client's is apps/cli/src/update-channel.ts;
// `hub-latest.json` stays the Windows tray app's, read by Tauri's updater.
//
// The one seam is build-time, the Headless client's (ADR-0123 §9, amended by
// #472). A test build's channel, and only a test build's: `bun build --define`
// (or `bun --define` from source, as test-serve.ts's spawns do) replaces this
// identifier with {manifestUrl, pubkey} JSON. The production compile
// (scripts/build-binaries.ts's compileArgs) defines it as `undefined`, so the
// lookup folds away and the binary carries UPDATE_CHANNEL alone and reads
// nothing at runtime. Without that define a compiled Bun binary would look the
// global up at runtime, where BUN_OPTIONS=--preload can set it.
//
// Keep this file the only non-test source in src that names the identifier
// (test-serve.ts spells it only to define it for the spawned tests), and keep
// it small: Bun's runtime transpiler cache keeps only large files, so a
// define from source always reaches this one.
declare const MAXPRICE_TEST_UPDATE_CHANNEL: { manifestUrl: string; pubkey: string } | undefined;

export const MANIFEST_NAME = "headless-hub-latest.json";

const testChannel =
  typeof MAXPRICE_TEST_UPDATE_CHANNEL === "undefined" ? undefined : MAXPRICE_TEST_UPDATE_CHANNEL;

export const PRODUCT: SelfUpdateProduct = {
  manifestUrl: testChannel?.manifestUrl ?? UPDATE_CHANNEL.baseUrl + MANIFEST_NAME,
  pubkey: testChannel?.pubkey ?? UPDATE_CHANNEL.pubkey,
  platform: "linux-x86_64",
  // ADR-0129 §4: the name CI signs the tarball under, which check 3 matches.
  assetName: (version) => `maxprice-hub_${version}_linux-x64.tar.gz`,
  binaryName: "maxprice-hub",
};
