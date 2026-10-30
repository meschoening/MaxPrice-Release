// The guide's inline icons (ADR-0135). Each is drawn in `currentColor` on a
// 24-unit grid and hidden from assistive technology: the label beside it
// carries the meaning.
import { renderToStaticMarkup } from "react-dom/server";

const PATHS = {
  note: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  tip: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  important: '<path d="M4 4h16v12H8l-4 4z"/><path d="M12 7v4M12 13.5h.01"/>',
  warning: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  caution: '<circle cx="12" cy="12" r="9"/><path d="M8 8l8 8M16 8l-8 8"/>',
  terminal: '<path d="M4 6l5 5-5 5M11 18h9"/>',
  external:
    '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
} as const;

type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="ic"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}

/** The icon as HTML, for the blocks a page's Markdown renders to. */
export function iconHtml(name: IconName): string {
  return renderToStaticMarkup(<Icon name={name} />);
}
