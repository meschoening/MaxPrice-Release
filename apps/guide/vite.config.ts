import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PAGES, SCREENSHOTS_DIR } from "./src/pages";
import { guideConfig } from "./src/vite-plugin";

// The User guide's build (ADR-0131 §6): src/vite-plugin.ts's guideConfig over
// every page in src/pages.ts.

// The version every page is stamped with (ADR-0132 §6). VERSION_FILES lists
// this package.json, so a release bumps it with the products.
const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as {
  version: string;
};

export default defineConfig(
  guideConfig(__dirname, {
    root: resolve(__dirname, "../.."),
    pages: PAGES,
    version: pkg.version,
    screenshots: [SCREENSHOTS_DIR],
  }),
);
