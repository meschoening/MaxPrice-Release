// The served rig's Content-Type expectations (#493): the media type each kind
// of dist-page file must be served with, by its extension. A wrong one is a
// page that will not load under `nosniff` (ADR-0124 §8): a script or a style
// sheet served as anything but its own type is refused.

const MEDIA_TYPES: Readonly<Record<string, readonly string[]>> = {
  ".html": ["text/html"],
  ".js": ["text/javascript", "application/javascript"],
  ".css": ["text/css"],
  ".svg": ["image/svg+xml"],
  ".woff2": ["font/woff2"],
  ".json": ["application/json"],
};

/** The media type of a Content-Type value: before any parameter, trimmed, lowercased. */
export function mediaType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/** Null when `contentType` suits a file named `rel`; otherwise what is wrong. */
export function contentTypeProblem(rel: string, contentType: string | null): string | null {
  const dot = rel.lastIndexOf(".");
  const extension = dot === -1 ? "" : rel.slice(dot).toLowerCase();
  const wanted = MEDIA_TYPES[extension];
  if (wanted === undefined) return `${rel}: no Content-Type is expected for "${extension}"`;
  if (contentType === null) return `${rel}: no Content-Type`;
  return wanted.includes(mediaType(contentType))
    ? null
    : `${rel}: Content-Type ${JSON.stringify(contentType)}, expected ${wanted.join(" or ")}`;
}
