// The Hub page URL's one validator (ADR-0125 §2), which `page set`, hub.json's
// schema and `page`'s report share. A valid value is an absolute http(s) URL
// with no userinfo, query or fragment, whose path segments hold only
// [A-Za-z0-9._~-] and are never empty, `.` or `..`: nothing in the path can
// break out of an Apache directive, and `.` is the only character the
// snippet's RedirectMatch has to escape. The stored form is the parser's,
// with the trailing slash the page's relative URLs need.

export type HubPageUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

function reject(reason: string): HubPageUrlCheck {
  return { ok: false, reason };
}

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

export function checkHubPageUrl(value: unknown): HubPageUrlCheck {
  if (typeof value !== "string") return reject("it is not a string");
  if (value === "") return reject("it is empty");
  // Checked on the raw text, since the URL parser strips tabs and newlines and
  // reads a backslash as a slash.
  if (!/^[\x21-\x7e]+$/.test(value) || value.includes("\\")) {
    return reject("it may hold only printable ASCII, with no spaces or backslashes");
  }
  const scheme = /^https?:\/\//i.exec(value);
  if (scheme === null) return reject("it must start with http:// or https://");
  if (/[?#]/.test(value)) return reject("it must not carry a query or a fragment");
  // The raw authority and path, before the parser normalizes either: it
  // would resolve a dot segment away, and percent-encode what it dislikes.
  const rest = value.slice(scheme[0].length);
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "/" : rest.slice(slash);
  if (authority.includes("@")) return reject("it must not carry a user name or password");
  if (authority === "") return reject("it names no host");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return reject("it is not a valid URL");
  }
  const segments = path.slice(1).split("/");
  // One trailing "" is the trailing slash, or the root.
  if (segments.at(-1) === "") segments.pop();
  for (const segment of segments) {
    if (segment === "") return reject("its path must not hold an empty segment");
    if (segment === "." || segment === "..") {
      return reject('its path must not hold a "." or ".." segment');
    }
    if (!SEGMENT.test(segment)) {
      return reject(
        `its path segment ${JSON.stringify(segment)} may hold only letters, digits, ".", "_", "~" and "-"`,
      );
    }
  }
  // Every segment is the parser's own already, so nothing is re-encoded.
  url.pathname = segments.length === 0 ? "/" : `/${segments.join("/")}/`;
  return { ok: true, url: url.href };
}
