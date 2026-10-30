// The Hub page's manifest as every build but the Headless Hub's sees it: empty
// (ADR-0124 §1). It maps a dist-page file's path relative to `/page/` to the
// path `Bun.file()` reads it from. `index.ts` imports it as `#page-manifest`,
// which apps/hub/package.json's `imports` resolves here by default. The
// linux-x64 compile alone passes `--conditions=maxprice-hub-page`, which
// resolves it to `generated/page-manifest.ts` instead: one
// `with { type: "file" }` import per dist-page file, written by
// `scripts/page-manifest.ts` (`scripts/build-binaries.ts` runs both). The tray
// targets therefore embed no page file.
export type PageManifest = Readonly<Record<string, string>>;

export const PAGE_MANIFEST: PageManifest = {};
