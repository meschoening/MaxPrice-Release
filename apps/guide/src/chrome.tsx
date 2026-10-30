// The page's frame, the Desktop client's (ADR-0135 §1), rendered to static HTML
// (ADR-0131 §9): a detached sidebar beside one Glass page panel, and below
// 920px a frosted pill header whose Menu opens the same tree. Every control is
// a link or a <details>, so no navigation needs JavaScript.
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "./icons";
import { hrefBetween, SECTIONS, type Page } from "./pages";

/** A `## ` heading the page keeps, for "On this page". */
export type Heading = { id: string; text: string };

export type PageView = {
  page: Page;
  /** Every page, in manifest order. */
  pages: readonly Page[];
  version: string;
  /** The page's HTML up to its lead paragraph: the title, and the lead. */
  intro: string;
  /** The rest of the page's HTML. */
  body: string;
  headings: readonly Heading[];
};

/** "On this page" lists the `## ` headings of a page with this many or more. */
const ON_THIS_PAGE_MIN = 3;

const RELEASES_URL = "https://github.com/meschoening/MaxPrice-Release/releases";

/** The <body>'s content for one page. */
export function renderChrome(view: PageView): string {
  return renderToStaticMarkup(<Frame {...view} />);
}

function Frame({ page, pages, version, intro, body, headings }: PageView) {
  const landing = pages[0]!;
  const onThisPage = headings.length >= ON_THIS_PAGE_MIN;
  return (
    <>
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <header className="top-bar panel">
        <Identity href={hrefBetween(page, landing)} />
        <details className="guide-menu">
          <summary className="chip">Menu</summary>
          <nav className="menu-leaf panel" aria-label="Guide">
            <NavTree page={page} pages={pages} />
          </nav>
        </details>
      </header>
      <div className="frame">
        <aside className="sidebar panel">
          <Identity href={hrefBetween(page, landing)} />
          <nav className="sidebar-nav" aria-label="Guide">
            <NavTree page={page} pages={pages} />
          </nav>
        </aside>
        <main id="content" className={onThisPage ? "page panel has-rail" : "page panel"}>
          <div className="page-column">
            <article className="prose">
              {page.section !== null && <p className="kicker eyebrow">{page.section}</p>}
              <Html html={intro} />
              {onThisPage && <OnThisPage headings={headings} variant="box" />}
              <Html html={body} />
            </article>
            <Pager page={page} pages={pages} />
          </div>
          {onThisPage && <OnThisPage headings={headings} variant="rail" />}
        </main>
      </div>
      <footer className="site-foot">
        <span>User guide for MaxPrice {version}</span>
        <a className="external" href={RELEASES_URL}>
          Releases
          <Icon name="external" />
        </a>
      </footer>
    </>
  );
}

function Identity({ href }: { href: string }) {
  return (
    <a className="identity" href={href}>
      <span className="logo dollar" aria-hidden="true" />
      <span className="wordmark">MaxPrice</span>
      <span className="badge">User guide</span>
    </a>
  );
}

// Home, then one open group per section, in SECTIONS' order; the current page
// wears the accent pill, and its section's chevron the accent.
function NavTree({ page, pages }: { page: Page; pages: readonly Page[] }) {
  const landing = pages[0]!;
  return (
    <>
      <NavLink from={page} to={landing} className="nav-home" />
      {SECTIONS.filter((section) => pages.some((p) => p.section === section)).map((section) => (
        <details
          key={section}
          className={page.section === section ? "nav-group current" : "nav-group"}
          open
        >
          <summary>
            <Icon name="chevron" />
            <span>{section}</span>
          </summary>
          <ul>
            {pages
              .filter((p) => p.section === section)
              .map((p) => (
                <li key={p.out}>
                  <NavLink from={page} to={p} />
                </li>
              ))}
          </ul>
        </details>
      ))}
    </>
  );
}

function NavLink({ from, to, className }: { from: Page; to: Page; className?: string }) {
  const current = from === to;
  const classes = [className, current ? "active" : undefined].filter(Boolean).join(" ");
  return (
    <a
      className={classes === "" ? undefined : classes}
      href={hrefBetween(from, to)}
      aria-current={current ? "page" : undefined}
    >
      {to.label}
    </a>
  );
}

function OnThisPage({
  headings,
  variant,
}: {
  headings: readonly Heading[];
  variant: "box" | "rail";
}) {
  return (
    <nav className={`on-this-page ${variant}`} aria-label="On this page">
      <p className="eyebrow">On this page</p>
      <ul>
        {headings.map((h) => (
          <li key={h.id}>
            <a href={`#${h.id}`}>{h.text}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// The previous and next pages in manifest order.
function Pager({ page, pages }: { page: Page; pages: readonly Page[] }) {
  const at = pages.indexOf(page);
  const card = (to: Page | undefined, rel: "prev" | "next") =>
    to !== undefined && (
      <a className={rel} href={hrefBetween(page, to)} rel={rel}>
        <span className="eyebrow">
          {rel === "prev" ? "Previous" : "Next"}
          {to.section === null ? "" : ` · ${to.section}`}
        </span>
        <span className="pager-label">{to.label}</span>
      </a>
    );
  return (
    <nav className="pager" aria-label="Previous and next">
      {card(pages[at - 1], "prev")}
      {card(pages[at + 1], "next")}
    </nav>
  );
}

// A page's rendered Markdown, which the renderer has already escaped.
function Html({ html }: { html: string }): ReactNode {
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
