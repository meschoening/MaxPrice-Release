import { isIP } from "node:net";
import type { Context, Hono } from "hono";
import { hubPageViewSchema, type ErrorResponse, type HubStatus } from "@maxprice/shared";
import type { PageManifest } from "./page-manifest";
import { isLoopbackPeer, socketPeerAddress } from "./peer";

// The Hub page's routes (ADR-0124 §2–§4, §8): a read-only mirror of the hub
// Popout that a Headless Hub serves under /page/ to loopback peers only. The
// user's web server reverse-proxies a path to http://127.0.0.1:<port>/page/
// and decides who may see it; the Hub password does not gate it.

// ADR-0124 §8, verbatim. `img-src data:` admits the favicon the page redraws
// with its status badge (§7), and `font-src data:` the font face Vite inlines
// as a data: URL.
export const HUB_PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Hashed assets never change under their name; everything else (index.html,
// the view, theme-boot.js, the favicon, the redirect) is re-read every load.
// No ETag and no Last-Modified: mod_deflate suffixes a proxied ETag with
// `-gzip`, so revalidation would always be a full 200 anyway (ADR-0124's
// research), and `new Response(Bun.file())` from a fetch handler adds neither.
const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_STORE = "no-store";

function pageHeaders(cacheControl: string): Record<string, string> {
  return {
    "Content-Security-Policy": HUB_PAGE_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": cacheControl,
  };
}

// An admitted request's answer for a /page path that has none: Hono's 404 text,
// with §8's headers, which every /page/ response carries. Only a refused request
// gets the ordinary 404 without them, since a refusal must be byte-identical
// to an unknown route's (§2).
function pageNotFound(c: Context): Response {
  return c.text("404 Not Found", 404, pageHeaders(NO_STORE));
}

// Validate the raw Host authority, never a URL parser's normalized hostname:
// URL parsing accepts shorthand/hex IPv4, userinfo and other non-authorities.
// A tunnel's local port can differ from the Hub's, so any canonical TCP port
// (or the implicit HTTP port) is allowed. No DNS name except localhost is.
function isPageAuthority(authority: string | undefined): boolean {
  if (authority === undefined) return false;
  const match = /^(localhost|\[::1\]|127\.[0-9]+\.[0-9]+\.[0-9]+)(?::([1-9][0-9]{0,4}))?$/i.exec(
    authority,
  );
  if (match === null || match[0] !== authority) return false;
  const host = match[1]!;
  if (host.startsWith("127.") && isIP(host) !== 4) return false;
  return match[2] === undefined || Number(match[2]) <= 65535;
}

// What a Headless Hub serves the page from: the dist-page files its build
// embedded (empty in every build but the linux-x64 one, ADR-0124 §1) and the
// Hub's package version, which the page compares with its own build's.
export type HubPageDeps = { manifest: PageManifest; version: string };

export type MountHubPageOptions = HubPageDeps & {
  status: () => HubStatus;
  liveClients: () => number;
  // buildHubApp's boot-readiness gate (F1). Absent ⇒ the view never waits.
  ready?: Promise<void>;
};

export function mountHubPage(app: Hono, opts: MountHubPageOptions): void {
  const { manifest, version, status, liveClients, ready } = opts;

  // Loopback is the socket peer's address, on every listener (ADR-0124 §2):
  // a wildcard bind has one listener for loopback and remote peers alike, so
  // the listener's own address says nothing. X-Forwarded-For is never read:
  // every request a web server proxies arrives from loopback, and the web
  // server already decided who may see the page. A refused request gets
  // Hono's ordinary 404, byte-identical to an unknown route, so the page is
  // absent from the tailnet rather than forbidden there. `/page/*` matches the
  // bare `/page` too (measured), and this runs before every route below, for
  // every method.
  app.use("/page/*", async (c, next) => {
    // A browser on this host also arrives from loopback after DNS rebinding.
    // Only the wire Host counts; Forwarded/X-Forwarded-* cannot admit it.
    // Apache's default ProxyPreserveHost Off sends its loopback target here.
    if (!isLoopbackPeer(socketPeerAddress(c)) || !isPageAuthority(c.req.header("host"))) {
      return c.notFound();
    }
    return next();
  });

  // The page's data (ADR-0124 §4): hubPageViewSchema strips every other status
  // key, so no usage reading, Organization id or credential provenance leaves.
  // Outside /api/*, so no password, protocol or CSRF gate applies; it awaits
  // `ready` as /api/status does, so a booting Hub holds the request and the
  // page reads "Starting…". The page's files never wait.
  app.get("/page/view", async (c) => {
    if (ready !== undefined) await ready;
    const view = hubPageViewSchema.safeParse({ ...status(), liveClients: liveClients(), version });
    if (view.success) return c.json(view.data, 200, pageHeaders(NO_STORE));
    // The app's ordinary 500 (server.ts's onError), with §8's headers.
    console.error("[hub] route error:", view.error);
    const body: ErrorResponse = { error: "internal" };
    return c.json(body, 500, pageHeaders(NO_STORE));
  });

  // A relative target, so the redirect resolves under any proxy prefix. Before
  // the file route, which `/page/*` would otherwise hand the bare path.
  app.get("/page", () => {
    return new Response(null, {
      status: 301,
      headers: { ...pageHeaders(NO_STORE), Location: "page/" },
    });
  });

  // `/page/` is index.html; every other file is its dist-relative key. Only an
  // exact own key of the manifest is served, never a path joined onto disk. A
  // key whose file is gone (a stale dev manifest) is a miss too.
  app.get("/page/*", async (c) => {
    const rel = c.req.path.slice("/page/".length) || "index.html";
    const path = Object.hasOwn(manifest, rel) ? manifest[rel] : undefined;
    if (path === undefined) return pageNotFound(c);
    const file = Bun.file(path);
    if (!(await file.exists())) return pageNotFound(c);
    return new Response(file, {
      headers: pageHeaders(rel.startsWith("assets/") ? IMMUTABLE : NO_STORE),
    });
  });

  // Every other method on every /page path, the bare one included.
  app.all("/page/*", (c) => pageNotFound(c));
}
