import { UPDATE_CHANNEL } from "@maxprice/shared";
import type { SelfUpdateProduct } from "@maxprice/usage-core/self-update";

// The Headless client's view of the update channel (ADR-0123 §3, §9, amended by
// #472; ADR-0144 §5): `headless-latest.json` on the `MP-Updates` release,
// signed by the key UPDATE_CHANNEL carries, holding a linux-x86_64 and a
// darwin-aarch64 entry, each pointing at a tarball that holds `maxprice`.
// `update` installs from this host's entry, and `serve` checks it at boot and
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

// Node's names for an architecture, as Tauri's platform keys spell them.
const TAURI_ARCH: Record<string, string> = { x64: "x86_64", arm64: "aarch64" };

/**
 * A host's entry on the channel (ADR-0144 §5): Tauri's `<os>-<arch>` key, and
 * the name CI signs that tarball under, which check 3 matches (ADR-0123 §2).
 * linux-x64 is `linux-x86_64` and `maxprice_<v>_linux-x64.tar.gz`, darwin-arm64
 * `darwin-aarch64` and `maxprice_<v>_darwin-arm64.tar.gz`. Any other host gets
 * a key no manifest carries, which the update refuses as it refuses any
 * platform with no entry.
 */
export function channelEntry(
  platform: string,
  arch: string,
): Pick<SelfUpdateProduct, "platform" | "assetName"> {
  return {
    platform: `${platform}-${TAURI_ARCH[arch] ?? arch}`,
    assetName: (version) => `maxprice_${version}_${platform}-${arch}.tar.gz`,
  };
}

export const PRODUCT: SelfUpdateProduct = {
  manifestUrl: testChannel?.manifestUrl ?? UPDATE_CHANNEL.baseUrl + MANIFEST_NAME,
  pubkey: testChannel?.pubkey ?? UPDATE_CHANNEL.pubkey,
  ...channelEntry(process.platform, process.arch),
  binaryName: "maxprice",
};
