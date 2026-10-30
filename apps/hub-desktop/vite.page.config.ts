import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The Hub page's build (ADR-0124 §7): a second Vite build of this app, from
// page.html and src/page/, into dist-page/. A Headless Hub embeds dist-page and
// serves it under /page/ (#493), and the user's web server proxies a path of its
// own to that, so `base: "./"` makes every URL relative and the page works
// under any prefix. The tray app's build (vite.config.ts) is untouched: the
// tray targets never need dist-page.
//
// No Tailwind here: the page renders only glass recipes and this app's shared
// CSS files (src/page/page.css says which).

// The version the page was built with, from the same package.json the tray
// app bakes. The page reloads itself once when the Hub's view reports another
// (ADR-0124 §6).
const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as {
  version: string;
};

// The two unhashed names dist-page needs. Vite names an HTML output after its
// entry, page.html, while the Hub serves `/page/` as index.html (ADR-0124 §3).
// And the favicon is the hub orb itself, the tray icon's icon-source.svg,
// served as a file of its own (ADR-0124 §7): copying it into public/ would add
// it to the tray app's dist too.
function hubPageFiles(): Plugin {
  return {
    name: "maxprice-hub-page-files",
    apply: "build",
    // After vite:build-html has emitted page.html.
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = bundle["page.html"];
      if (html?.type !== "asset") throw new Error("hub page build: no page.html in the bundle");
      delete bundle["page.html"];
      this.emitFile({ type: "asset", fileName: "index.html", source: html.source });
      this.emitFile({
        type: "asset",
        fileName: "favicon.svg",
        source: readFileSync(resolve(__dirname, "src-tauri/icons/icon-source.svg")),
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), hubPageFiles()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  build: {
    outDir: "dist-page",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: resolve(__dirname, "page.html"),
    },
  },
});
