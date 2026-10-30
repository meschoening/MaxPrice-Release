// The blocks a page's Markdown writes, and the HTML each becomes (ADR-0135
// §3). Every block is written in syntax GitHub renders too, so a page's source
// reads correctly there (ADR-0131 §10):
//
//   - a GitHub alert (`> [!NOTE]` …) is a callout in its Glass token;
//   - a `sh` fence is a Terminal block, any other fence a code block labelled
//     with its language;
//   - `### ` sections between `<!-- platforms -->` and `<!-- /platforms -->`
//     render stacked, after a row of jump links;
//   - an image alone in its paragraph that names a screenshot's light frame is
//     a <figure> whose <picture> swaps in the dark frame;
//
// and, from the prose layer (§2), an external link carries an arrow.
//
// `shapeBlocks` turns a page's tokens into the guide's own block tokens before
// anything walks them, so a link inside a callout or a platform section is
// rewritten and checked like any other. `blocks` renders them.
import { Renderer, type MarkedExtension, type Token, type Tokens } from "marked";
import { escapeHtml } from "./html";
import { iconHtml } from "./icons";
import type { Screenshot } from "./screenshots";

/** What shaping needs from the page it shapes. */
export type ShapeContext = {
  /** The screenshot an href names, repo-relative; null for any other href. */
  screenshotAt: (href: string) => string | null;
  /** The pair for a screenshot's light frame, or the problem with it. */
  pair: (target: string) => Screenshot | string;
  /** Reports a problem with the page; the build then fails. */
  problem: (text: string) => void;
};

const ALERTS = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
} as const;

type AlertKind = keyof typeof ALERTS;

type AlertToken = { type: "alert"; raw: string; kind: AlertKind; tokens: Token[] };
type PlatformsToken = { type: "platforms"; raw: string; tokens: Token[] };
type FigureToken = Screenshot & {
  type: "figure";
  raw: string;
  /** The image's alt, still as inline tokens. */
  alt: Token[];
  caption: string | null;
};
type LeadToken = { type: "lead"; raw: string; tokens: Token[] };

// GitHub's alert syntax: the marker alone on the blockquote's first line.
const ALERT_MARKER = /^\[!([A-Z]+)\][ \t]*(?:\n|$)/;
const PLATFORMS_OPEN = "<!-- platforms -->";
const PLATFORMS_CLOSE = "<!-- /platforms -->";
const PLATFORMS_ANY = /<!--\s*\/?\s*platforms\s*-->/;

/**
 * The page's top-level tokens with the guide's blocks in place. `lead` is the
 * paragraph to render as the lead, if the page has one.
 */
export function shapeBlocks(
  tokens: readonly Token[],
  context: ShapeContext,
  lead: Token | undefined,
): Token[] {
  return groupPlatforms(tokens, context).map((token) => shapeToken(token, context, lead));
}

function shapeToken(token: Token, context: ShapeContext, lead: Token | undefined): Token {
  if (token.type === "platforms") {
    const platforms = token as PlatformsToken;
    platforms.tokens = platforms.tokens.map((t) => shapeToken(t, context, undefined));
    return platforms;
  }
  if (token.type === "blockquote") return shapeAlert(token as Tokens.Blockquote, context);
  if (token.type === "paragraph") {
    const paragraph = token as Tokens.Paragraph;
    const figure = shapeFigure(paragraph, context);
    if (figure !== null) return figure;
    if (token === lead) {
      return { type: "lead", raw: paragraph.raw, tokens: paragraph.tokens } satisfies LeadToken;
    }
  }
  return token;
}

function shapeAlert(quote: Tokens.Blockquote, context: ShapeContext): Token {
  const inner = quote.tokens.map((t) => shapeToken(t, context, undefined));
  const first = inner[0];
  const marker = first?.type === "paragraph" ? first.text.match(ALERT_MARKER) : null;
  if (first === undefined || marker === null) return { ...quote, tokens: inner };
  // The marker opens the paragraph's first text token: strip it there, and
  // drop the paragraph when the marker was all it held.
  const paragraph = first as Tokens.Paragraph;
  const text = paragraph.tokens[0];
  if (text?.type !== "text" || !text.raw.startsWith(marker[0])) return { ...quote, tokens: inner };
  const kind = marker[1]!;
  if (!(kind in ALERTS)) {
    context.problem(
      `writes "[!${kind}]", which is no GitHub alert (${Object.keys(ALERTS).join(", ")})`,
    );
    return { ...quote, tokens: inner };
  }
  const rest = text.text.slice(marker[0].length);
  const body =
    rest === "" && paragraph.tokens.length === 1
      ? inner.slice(1)
      : [
          {
            ...paragraph,
            text: paragraph.text.slice(marker[0].length),
            tokens: [{ ...text, raw: rest, text: rest }, ...paragraph.tokens.slice(1)],
          },
          ...inner.slice(1),
        ];
  return { type: "alert", raw: quote.raw, kind: kind as AlertKind, tokens: body } as AlertToken;
}

// A paragraph that is one image naming a screenshot becomes a figure. Any other
// reference into the screenshots' directory is a problem the caller finds.
function shapeFigure(
  paragraph: Tokens.Paragraph,
  context: ShapeContext,
): FigureToken | Tokens.Space | null {
  const [image, ...others] = paragraph.tokens;
  if (image?.type !== "image" || others.length > 0) return null;
  const { href, title, tokens } = image as Tokens.Image;
  const target = context.screenshotAt(href);
  if (target === null) return null;
  const pair = context.pair(target);
  if (typeof pair === "string") {
    // The page will not be written; dropping the image reports it once.
    context.problem(pair);
    return { type: "space", raw: paragraph.raw };
  }
  return { type: "figure", raw: paragraph.raw, ...pair, alt: tokens, caption: title ?? null };
}

// Folds each `<!-- platforms -->` … `<!-- /platforms -->` run into one token
// holding its `### ` sections.
function groupPlatforms(tokens: readonly Token[], context: ShapeContext): Token[] {
  const out: Token[] = [];
  let open: PlatformsToken | null = null;
  for (const token of tokens) {
    const marker = token.type === "html" ? platformsMarker(token as Tokens.HTML, context) : null;
    if (marker === "open") {
      if (open !== null) {
        context.problem(`opens "${PLATFORMS_OPEN}" inside another; they do not nest`);
      }
      open = { type: "platforms", raw: token.raw, tokens: [] };
      continue;
    }
    if (marker === "close") {
      if (open === null) {
        context.problem(`writes "${PLATFORMS_CLOSE}" with no "${PLATFORMS_OPEN}" before it`);
        continue;
      }
      checkPlatforms(open, context);
      out.push(open);
      open = null;
      continue;
    }
    if (open === null) out.push(token);
    else {
      open.raw += token.raw;
      open.tokens.push(token);
    }
  }
  if (open !== null) {
    context.problem(`opens "${PLATFORMS_OPEN}" and never closes it`);
    out.push(...open.tokens);
  }
  return out;
}

function platformsMarker(token: Tokens.HTML, context: ShapeContext): "open" | "close" | null {
  const text = token.text.trim();
  if (text === PLATFORMS_OPEN) return "open";
  if (text === PLATFORMS_CLOSE) return "close";
  if (PLATFORMS_ANY.test(text)) {
    context.problem(
      `writes a platforms marker that is not "${PLATFORMS_OPEN}" or "${PLATFORMS_CLOSE}" on a line of its own, with a blank line after it`,
    );
  }
  return null;
}

function checkPlatforms(platforms: PlatformsToken, context: ShapeContext): void {
  const inner = platforms.tokens.filter((t) => t.type !== "space");
  const first = inner[0];
  if (first?.type !== "heading" || (first as Tokens.Heading).depth !== 3) {
    context.problem(`a platforms block starts with a "### " heading`);
  }
  for (const heading of inner.filter((t): t is Tokens.Heading => t.type === "heading")) {
    if (heading.depth < 3) {
      context.problem(
        `a platforms block holds only "### " sections; it holds "${heading.raw.trim()}"`,
      );
    }
  }
}

/** A link that leaves the guide for the web. */
function isExternal(href: string): boolean {
  return /^(https?:)?\/\//i.test(href);
}

const defaultRenderer = new Renderer();

/** The marked extension that renders the guide's blocks. */
export const blocks: MarkedExtension = {
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const language = (lang ?? "").match(/^\S*/)![0];
      const code = `<pre><code>${escapeHtml(text)}</code></pre>`;
      if (language === "sh") {
        // copy.js adds a Copy button to the head; without it, one click on the
        // code selects all of it (ADR-0135 §4).
        return `<div class="terminal"><div class="block-head">${iconHtml("terminal")}<span>Terminal</span></div>${code}</div>\n`;
      }
      const head = language === "" ? "" : `<div class="block-head">${escapeHtml(language)}</div>`;
      return `<div class="code">${head}${code}</div>\n`;
    },
    link(token: Tokens.Link) {
      const html = defaultRenderer.link.call(this, token);
      if (!isExternal(token.href)) return html;
      return html
        .replace(/^<a /, '<a class="external" ')
        .replace(/<\/a>$/, `${iconHtml("external")}</a>`);
    },
    table(token: Tokens.Table) {
      return `<div class="table-wrap">${defaultRenderer.table.call(this, token)}</div>\n`;
    },
  },
  extensions: [
    {
      name: "alert",
      renderer(token) {
        const { kind, tokens } = token as AlertToken;
        const name = kind.toLowerCase() as Lowercase<AlertKind>;
        return `<div class="alert alert-${name}" role="note"><p class="alert-title">${iconHtml(name)}${ALERTS[kind]}</p>${this.parser.parse(tokens)}</div>\n`;
      },
    },
    {
      name: "platforms",
      renderer(token) {
        const sections: Token[][] = [];
        for (const t of (token as PlatformsToken).tokens) {
          if (t.type === "heading" && (t as Tokens.Heading).depth === 3) sections.push([t]);
          else sections.at(-1)?.push(t);
        }
        const rendered = sections.map((section) => {
          const html = this.parser.parse(section);
          // The heading's id and inline HTML, its tags dropped for the jump link.
          const [, id, title] = html.match(/^<h3 id="([^"]+)">([\s\S]*?)<\/h3>/)!;
          return { html, id: id!, title: title!.replace(/<[^>]*>/g, "") };
        });
        const jump = rendered.map((s) => `<a href="#${s.id}">${s.title}</a>`).join("");
        const body = rendered.map((s) => `<section class="platform">${s.html}</section>`).join("");
        return `<div class="platforms"><nav class="platform-jump" aria-label="Platforms">${jump}</nav>${body}</div>\n`;
      },
    },
    {
      name: "figure",
      renderer(token) {
        const { light, dark, width, height, alt: altTokens, caption } = token as FigureToken;
        const alt = this.parser.parseInline(altTokens, this.parser.textRenderer);
        const figcaption =
          caption === null ? "" : `<figcaption>${escapeHtml(caption)}</figcaption>`;
        return `<figure class="screenshot"><picture><source srcset="${escapeHtml(dark)}" media="(prefers-color-scheme: dark)" /><img src="${escapeHtml(light)}" alt="${escapeHtml(alt)}" width="${width}" height="${height}" loading="lazy" /></picture>${figcaption}</figure>\n`;
      },
    },
    {
      name: "lead",
      renderer(token) {
        return `<p class="lead">${this.parser.parseInline((token as LeadToken).tokens)}</p>\n`;
      },
    },
  ],
};
