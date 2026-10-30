// The User guide's one render function (ADR-0131 §1, §6): Markdown in, an HTML
// document out, called by the dev server per request and by the build for every
// page. The build is strict: it fails on any problem below rather than writing
// a page that hides it (#563's drift checks §2, ADR-0135 Consequences).
//
// Runs under Node (vite.config.ts imports it) as well as Bun (its tests), so it
// uses node: modules only.
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { Marked, Parser, type Token, type Tokens } from "marked";
import { getHeadingList, gfmHeadingId, resetHeadings } from "marked-gfm-heading-id";
import { blocks, shapeBlocks } from "./blocks";
import { renderChrome, type Heading } from "./chrome";
import { escapeHtml, htmlText } from "./html";
import { hrefBetween, PAGES_DIR, type Page } from "./pages";
import { pairScreenshot } from "./screenshots";

export type Site = {
  /** The repo root every `Page.source` is relative to. */
  root: string;
  pages: readonly Page[];
  /** apps/guide/package.json's version, stamped into every page (ADR-0132 §6). */
  version: string;
  /**
   * The directories a page's screenshots come from, repo-relative and inside
   * the app: the real site's SCREENSHOTS_DIR, plus a test fixture's in the
   * fixture site, whose real pages still show the real frames.
   */
  screenshots: readonly string[];
};

/** Every problem the build found, one line each, naming its source file. */
export class GuideBuildError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`The User guide does not build:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "GuideBuildError";
  }
}

// GitHub heading ids (ADR-0131 §5), so an anchor written against a manual on
// GitHub resolves on its Reference page too; then the guide's blocks.
const marked = new Marked(gfmHeadingId(), blocks);

/** One page's HTML document; throws a GuideBuildError naming its problems. */
export function renderPage(site: Site, page: Page): string {
  const { html, problems } = render(site, page);
  if (problems.length > 0) throw new GuideBuildError(problems);
  return html;
}

/**
 * Every page, keyed by output path. Throws one GuideBuildError naming every
 * problem in the site, including a `.md` under pages/ that pages.ts lacks.
 */
export function renderSite(site: Site): Map<string, string> {
  const problems: string[] = [];
  const listed = new Set(site.pages.map((p) => p.source));
  for (const source of markdownUnder(site.root, PAGES_DIR)) {
    if (!listed.has(source)) problems.push(`${source}: not in apps/guide/src/pages.ts`);
  }
  const out = new Map<string, string>();
  for (const page of site.pages) {
    const rendered = render(site, page);
    problems.push(...rendered.problems);
    out.set(page.out, rendered.html);
  }
  if (problems.length > 0) throw new GuideBuildError(problems);
  return out;
}

function render(site: Site, page: Page): { html: string; problems: string[] } {
  const problems: string[] = [];
  const problem = (text: string) => problems.push(`${page.source}: ${text}`);
  let source: string;
  try {
    source = readFileSync(join(site.root, page.source), "utf8");
  } catch {
    return { html: "", problems: [`${page.source}: cannot be read`] };
  }

  const segments = splitDropped(marked.lexer(source), page.drop ?? []);
  for (const heading of page.drop ?? []) {
    if (!segments.dropped.has(heading)) {
      problem(`has no "${heading}" section to drop (pages.ts)`);
    }
  }

  // The screenshot an href names, if it names one. A screenshot is shown only
  // as an image alone in its paragraph, which shaping makes a figure: any other
  // reference into its directory is a problem (ADR-0135 §3).
  const screenshotAt = (href: string): string | null => {
    const target = resolveSource(href, page);
    const inside =
      target !== null &&
      site.screenshots.some((dir) => target === dir || target.startsWith(`${dir}/`));
    return inside ? target : null;
  };

  // The guide's blocks, shaped before anything walks the page (blocks.ts).
  const keptSegments = segments.list.filter((s) => s.keep);
  const lead = leadOf(keptSegments.flatMap((s) => s.tokens));
  const shaping = {
    screenshotAt,
    pair: (target: string) => pairScreenshot(site.root, target),
    problem,
  };
  for (const segment of keptSegments) segment.tokens = shapeBlocks(segment.tokens, shaping, lead);
  const kept = keptSegments.flatMap((s) => s.tokens);

  // Every link the page keeps, Markdown or raw HTML, rewritten in place. A link
  // to this page's own anchor is kept aside, to check against what is dropped.
  const ownAnchors: string[] = [];
  const link = (href: string): string => {
    if (screenshotAt(href) !== null) {
      problem(`links "${href}", a screenshot; a page shows one as an image alone in its paragraph`);
      return href;
    }
    const rewritten = rewriteHref(href, page, site.pages);
    if (rewritten === null) {
      problem(`links "${href}", which maps to no page in pages.ts`);
      return href;
    }
    const hashAt = rewritten.indexOf("#");
    const path = hashAt < 0 ? rewritten : rewritten.slice(0, hashAt);
    if (hashAt >= 0 && (path === "" || posix.join(posix.dirname(page.out), path) === page.out)) {
      ownAnchors.push(rewritten.slice(hashAt + 1));
    }
    return rewritten;
  };
  const titles: Tokens.Heading[] = [];
  marked.walkTokens(kept, (token) => {
    if (token.type === "heading" && token.depth === 1) titles.push(token as Tokens.Heading);
    if (token.type === "link") {
      const anchor = token as Tokens.Link;
      anchor.href = link(anchor.href);
    }
    if (token.type === "image" && screenshotAt((token as Tokens.Image).href) !== null) {
      problem(
        `shows "${(token as Tokens.Image).href}" inside other content; a screenshot is an image alone in its paragraph`,
      );
    }
    if (token.type === "html") {
      const html = token as Tokens.HTML;
      for (const url of rawUrls(html.text).filter((u) => screenshotAt(u) !== null)) {
        problem(
          `points raw HTML at "${url}", a screenshot; a page shows one as an image alone in its paragraph`,
        );
      }
      html.text = html.text.replace(
        RAW_HREF,
        (_whole, before: string, quote: string, href: string) =>
          `${before}${quote}${link(href)}${quote}`,
      );
    }
  });
  if (titles.length !== 1) {
    problem(`has ${titles.length} "# " headings; a page has exactly one`);
  }

  // Dropped sections are rendered and thrown away, not skipped, so their
  // headings still take their slugs: every later id stays GitHub's, -1
  // suffixes included. The page's own HTML splits after its lead, where a
  // narrow window shows "On this page".
  resetHeadings();
  const introEnd = kept.find((t) => t.type === "lead") ?? titles[0];
  let intro = "";
  let body = "";
  let introDone = introEnd === undefined;
  const headings: Heading[] = [];
  const droppedIds = new Set<string>();
  for (const segment of segments.list) {
    const before = getHeadingList().length;
    if (!segment.keep) {
      for (const [, id] of marked.parser(segment.tokens).matchAll(HEADING_ID)) droppedIds.add(id!);
      continue;
    }
    const at = introDone ? -1 : segment.tokens.indexOf(introEnd!);
    if (at >= 0) {
      intro += marked.parser(segment.tokens.slice(0, at + 1));
      body += marked.parser(segment.tokens.slice(at + 1));
      introDone = true;
    } else if (introDone) body += marked.parser(segment.tokens);
    else intro += marked.parser(segment.tokens);
    for (const h of getHeadingList().slice(before)) {
      if (h.level === 2) headings.push({ id: h.id, text: htmlText(h.text) });
    }
  }
  for (const id of ownAnchors.filter((a) => droppedIds.has(a))) {
    problem(`links "#${id}", inside a section this page drops (pages.ts)`);
  }

  if (problems.length > 0) return { html: "", problems };
  const chrome = renderChrome({
    page,
    pages: site.pages,
    version: site.version,
    intro,
    body,
    headings,
  });
  return { html: htmlDocument(page, plainText(titles[0]!), chrome, site.version), problems };
}

// The paragraph straight after the page's `# ` heading, which the page shows
// as its lead (ADR-0135 §2).
function leadOf(tokens: readonly Token[]): Token | undefined {
  const title = tokens.findIndex((t) => t.type === "heading" && (t as Tokens.Heading).depth === 1);
  if (title < 0) return undefined;
  const next = tokens.slice(title + 1).find((t) => t.type !== "space");
  return next?.type === "paragraph" ? next : undefined;
}

// A raw-HTML link's `href`, which ADR-0131 §1 lets a page write.
const RAW_HREF = /(<a\s[^>]*?\bhref=)(["'])([^"']*)\2/gi;
// Every URL raw HTML names, in any tag: a `srcset` holds several.
const RAW_URL = /\b(?:href|src|srcset)\s*=\s*(["'])([^"']*)\1/gi;

function rawUrls(html: string): string[] {
  return [...html.matchAll(RAW_URL)].flatMap(([attribute, , value]) =>
    attribute.toLowerCase().startsWith("srcset")
      ? value!.split(",").map((candidate) => candidate.trim().split(/\s+/)[0]!)
      : [value!],
  );
}
const HEADING_ID = /<h[1-6] id="([^"]+)"/g;

type Segment = { keep: boolean; tokens: Token[] };

// The page's tokens in runs, each kept or inside a dropped section. A dropped
// section runs from its heading to the next heading at its level or above, as
// on GitHub's own outline.
function splitDropped(
  tokens: Token[],
  drop: readonly string[],
): { list: Segment[]; dropped: Set<string> } {
  const list: Segment[] = [];
  const dropped = new Set<string>();
  let droppingAt = 0;
  for (const token of tokens) {
    if (token.type === "heading") {
      const { depth, text } = token as Tokens.Heading;
      if (droppingAt > 0 && depth <= droppingAt) droppingAt = 0;
      const line = `${"#".repeat(depth)} ${text}`;
      if (droppingAt === 0 && drop.includes(line)) {
        droppingAt = depth;
        dropped.add(line);
      }
    }
    const keep = droppingAt === 0;
    const last = list.at(-1);
    if (last?.keep === keep) last.tokens.push(token);
    else list.push({ keep, tokens: [token] });
  }
  return { list, dropped };
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A link as the output page must spell it, or null when it names a file that
 * is no page (ADR-0135 §3). A relative link resolves against the page's source
 * file, so it is written as on GitHub: another page's `.md`, or a manual's
 * `README.md`, with any anchor. External and same-page links pass unchanged.
 */
export function rewriteHref(href: string, page: Page, pages: readonly Page[]): string | null {
  const target = resolveSource(href, page);
  if (target === null) return href;
  const hashAt = href.indexOf("#");
  const hash = hashAt < 0 ? "" : href.slice(hashAt);
  const to = pages.find((p) => p.source === target);
  if (to === undefined) return null;
  return hrefBetween(page, to) + hash;
}

/**
 * The repo-relative file a page's href names, resolved against its source
 * file; null for an external or same-page link.
 */
function resolveSource(href: string, page: Page): string | null {
  if (SCHEME.test(href) || href.startsWith("//") || href.startsWith("#")) return null;
  const hashAt = href.indexOf("#");
  const path = hashAt < 0 ? href : href.slice(0, hashAt);
  // A root-relative link is relative to the repo root, as GitHub reads it.
  return path.startsWith("/")
    ? posix.normalize(path.slice(1))
    : posix.join(posix.dirname(page.source), path);
}

function markdownUnder(root: string, dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(root, dir), { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  return names
    .map((name) => posix.join(dir, name.replaceAll("\\", "/")))
    .filter((path) => path.endsWith(".md"))
    .sort();
}

// A heading as the text a <title> carries: its inline marks dropped, unescaped.
function plainText(heading: Tokens.Heading): string {
  const parser = new Parser();
  return parser.parseInline(heading.tokens, parser.textRenderer);
}

// The document. Its asset URLs are root-absolute here and relative once Vite
// has built the page (`base: "./"`, ADR-0131 §4): `/theme-boot.js` and
// `/copy.js` are public/'s, and `/src/guide.css` is bundled with the fonts
// Glass imports. `copy.js` is deferred and optional (ADR-0135 §4).
function htmlDocument(page: Page, title: string, chrome: string, version: string): string {
  const fullTitle = page.section === null ? title : `${title} · MaxPrice User guide`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="maxprice-version" content="${escapeHtml(version)}" />
    <title>${escapeHtml(fullTitle)}</title>
    <script src="/theme-boot.js"></script>
    <link rel="stylesheet" href="/src/guide.css" />
    <script src="/copy.js" defer></script>
  </head>
  <body>
    ${chrome}
  </body>
</html>
`;
}
