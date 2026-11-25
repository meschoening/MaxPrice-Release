import { UPDATE_CHANNEL } from "@maxprice/shared";
import { channelEntry, type SelfUpdateProduct } from "@maxprice/usage-core/self-update";

// The Headless Hub's view of the update channel (ADR-0129 §3, §4, §7):
// `headless-hub-latest.json` on the `MP-Updates` release, signed by the key
// UPDATE_CHANNEL carries, holding a linux-x86_64 and a darwin-aarch64 entry
// (ADR-0147 §6), each pointing at a tarball that holds `maxprice-hub`.
// `update` installs from this host's entry, and a Headless `serve` checks it
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
  // This host's entry and the name CI signs its tarball under, which check 3
  // matches (ADR-0129 §4, ADR-0147 §6): usage-core's `channelEntry`.
  ...channelEntry("maxprice-hub", process.platform, process.arch),
  binaryName: "maxprice-hub",
};
