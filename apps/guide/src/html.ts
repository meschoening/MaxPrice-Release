// Text into and out of the HTML a page is built from.

/** Text made safe for an element's content or a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

/**
 * Rendered inline HTML as plain text: its tags dropped, and marked's escapes
 * undone. (marked-gfm-heading-id's own `raw` drops `&amp;` and its kin.)
 */
export function htmlText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => ENTITIES[entity]!);
}
