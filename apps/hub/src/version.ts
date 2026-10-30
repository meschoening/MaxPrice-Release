import pkg from "../package.json";

// The Hub's version (ADR-0124 §4): GET /page/view reports it, and the Hub page
// reloads itself once when it differs from the version the page was built
// with (§6), the same one a release sets in apps/hub-desktop/package.json.
// `bun build --compile` inlines the package.json, so it is the version the
// binary was built at, which is why `scripts/version-files.ts` lists the file
// as `baked` (apps/cli/src/version.ts is the same pattern).
export const VERSION: string = pkg.version;
