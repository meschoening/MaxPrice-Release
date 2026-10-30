// Where the update channel lives and which key signs it, for the products that
// have no tauri.conf.json to carry them: the Headless client and the Headless
// Hub (ADR-0123 §9, ADR-0129 §3). One constant: the trusted pubkey (base64 of a
// minisign public key file) and the base URL of the `MP-Updates` release that
// holds every manifest; a product appends its own manifest name,
// `headless-latest.json` (apps/cli/src/update-channel.ts) or
// `headless-hub-latest.json` (apps/hub/src/update-channel.ts). scripts/updater-manifest.test.ts pins it to both
// tauri.conf.json files' pubkey and endpoints. There is no runtime override.
export const UPDATE_CHANNEL = {
  baseUrl: "https://github.com/meschoening/MP-Updates/releases/latest/download/",
  pubkey:
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEJCNTM3RTIyNkY3RTc0MzEKUldReGRINXZJbjVUdTliT3VoZW5kZHRseDMzY0JFSkcvR1gzbVd2eXo5ZWFaTlZLY2p5WnhaV2cK",
} as const;
