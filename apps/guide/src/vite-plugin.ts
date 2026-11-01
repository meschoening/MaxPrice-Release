// Hands the guide's pages to Vite (ADR-0131 §6). Each page is a virtual HTML
// entry at `<app>/<out>`, so the multi-page build writes it to the same path
// under dist/ and nothing is staged on disk. A build, `--watch` included,
// renders the whole site strictly before Vite reads a page; the dev server
// renders the requested page on each request, and reloads the browser when a
// page's Markdown or a manual changes.
import { resolve } from "node:path";
import { normalizePath, type Plugin, type UserConfig } from "vite";
import { PAGES_DIR, type Page } from "./pages";
import { GuideBuildError, renderPage, renderSite, type Site } from "./render";

/**
 * The guide's Vite config for a site (ADR-0131 §6): every page in `site.pages`
 * becomes a flat .html file under dist/, and `base: "./"` makes every URL
 * relative, so the same output works under /MaxPrice-Release/, under any later
 * domain, and from file:// (ADR-0131 §4). vite.config.ts builds the real site.
 */
export function guideConfig(appDir: string, site: Site): UserConfig {
  return {
    root: appDir,
    base: "./",
    plugins: [guidePagesPlugin(site)],
    clearScreen: false,
    // Beside the desktop's 1420 and the hub tray app's 1421 (ADR-0131 §12).
    server: {
      port: 1422,
      strictPort: true,
      host: "127.0.0.1",
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      target: "es2022",
      // A screenshot is never inlined: a page loads only the frame its theme
      // shows (ADR-0134 §3).
      assetsInlineLimit: 0,
      rollupOptions: {
        input: site.pages.map((page) => pageEntry(appDir, page)),
      },
    },
  };
}

/** Each page's virtual entry, the path the build's `input` lists. */
export function pageEntry(appDir: string, page: Page): string {
  return normalizePath(resolve(appDir, page.out));
}

/** The page the dev server answers a request path with: `/` is `index.html`. */
export function pageAt(pathname: string, pages: readonly Page[]): Page | undefined {
  const path = decodeURIComponent(pathname).replace(/^\/+/, "");
  const out = path === "" || path.endsWith("/") ? `${path}index.html` : path;
  return pages.find((page) => page.out === out);
}

/**
 * Vite marks the stylesheet it injects `crossorigin`, so Chromium fetches it in
 * CORS mode, which file:// does not support: a file:// preview loaded unstyled
 * (ADR-0131 §4). Every asset is the page's own, so no tag needs it. Only tags
 * lose it, never a page's text.
 */
export function stripCrossorigin(html: string): string {
  return html.replace(/<(?:link|script)\b[^>]*>/g, (tag) =>
    tag.replace(/\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=[\s/>])/, ""),
  );
}

export function guidePagesPlugin(site: Site): Plugin {
  let building = false;
  let byEntry = new Map<string, Page>();
  let built: Map<string, string> | null = null;
  return {
    name: "maxprice-guide-pages",
    enforce: "pre",
    configResolved(config) {
      building = config.command === "build";
      byEntry = new Map(site.pages.map((page) => [pageEntry(config.root, page), page]));
    },
    buildStart() {
      if (!building) return;
      try {
        built = renderSite(site);
      } catch (error) {
        if (error instanceof GuideBuildError) this.error(error.message);
        throw error;
      }
    },
    resolveId(id) {
      const entry = normalizePath(id);
      return byEntry.has(entry) ? entry : null;
    },
    load(id) {
      const page = byEntry.get(id);
      return page === undefined ? null : (built?.get(page.out) ?? null);
    },
    transformIndexHtml: { order: "post", handler: stripCrossorigin },
    configureServer(server) {
      // Pages and both manuals. The manuals sit outside the app, so Vite does
      // not watch them unasked; none of the three is in its module graph.
      const watched = [
        normalizePath(resolve(site.root, PAGES_DIR)) + "/",
        ...site.pages.map((page) => normalizePath(resolve(site.root, page.source))),
      ];
      server.watcher.add(watched);
      const reload = (file: string) => {
        const path = normalizePath(file);
        if (path.endsWith(".md") && watched.some((w) => path === w || path.startsWith(w))) {
          server.ws.send({ type: "full-reload" });
        }
      };
      server.watcher.on("change", reload);
      server.watcher.on("add", reload);
      server.watcher.on("unlink", reload);

      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://guide").pathname;
        const page = pageAt(pathname, site.pages);
        if (page === undefined) return next();
        Promise.resolve()
          .then(() => server.transformIndexHtml(pathname, renderPage(site, page)))
          .then((html) => {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(html);
          })
          .catch(next);
      });
    },
  };
}
