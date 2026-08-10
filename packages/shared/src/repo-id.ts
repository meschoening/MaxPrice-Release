// ADR-0062 §1 — the Repo identity key: normalized `origin` remote + "#subpath".
// An OPAQUE FOLD KEY, never displayed, so normalization is aggressive:
// scheme-blind (ssh here, https there must fold), whole-key lowercase (Windows
// slugs already split on case; GitHub is case-insensitive), credentials and
// default ports stripped. Pure string work — the .git/config READ stays
// sidecar-side; both renderer and sidecar import this via @maxprice/shared.

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
// scp-like `user@host:path`. Host may not contain `/`, `:`, `@` or `\`; the
// lookahead keeps `host://x` out; a one-char host is a Windows drive letter.
const SCP_RE = /^(?:[^@/\\]+@)?([^:/@\\]+):(?!\/)(.+)$/;
const DEFAULT_PORTS: Record<string, string> = {
  "ssh:": "22",
  "http:": "80",
  "https:": "443",
  "git:": "9418",
};

// A project's directory below its repo toplevel, in key form. Empty for a
// project that IS the toplevel; separators normalized so the same monorepo
// package keys identically from a Windows and a POSIX checkout.
export function normalizeSubpath(subpath: string): string {
  return subpath
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

// The fold key for one checkout, or null when the remote cannot identify a repo
// across machines. Null is a definite answer — the project stays slug-keyed.
export function repoIdFromRemote(remote: string, subpath: string): string | null {
  const raw = remote.trim();
  if (raw === "") return null;

  let host: string;
  let port = "";
  let path: string;

  if (SCHEME_RE.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    // file:// is machine-local by nature — no cross-machine identity (§1).
    if (url.protocol === "file:") return null;
    // An IPv6 literal keeps its brackets here, which is what keeps the `:port`
    // join below unambiguous.
    host = url.hostname;
    if (host === "") return null;
    const def = DEFAULT_PORTS[url.protocol];
    if (url.port !== "" && url.port !== def) port = url.port;
    // WHATWG `pathname` is percent-ENCODED (`/foo bar/` → `/foo%20bar/`, `fóo`
    // → `f%C3%B3o`) while the scp-like branch keeps the literal text, so
    // without this a space or a non-ASCII character in the path makes the two
    // spellings of ONE repo key differently — precisely the SSH-on-the-Mac /
    // HTTPS-on-Windows pair the key exists to fold (self-hosted forges and
    // Azure DevOps project names are where it bites). Decoded BEFORE the
    // whole-key lowercase below, because lowercasing an escape leaves the byte
    // it names untouched, so a later decode would smuggle `%41` past it as an
    // uppercase `A` while the scp branch's literal `A` folded down.
    // A malformed escape (`%zz`) makes decodeURIComponent throw and this is a
    // pure key function that must never throw: the literal pathname is then
    // the key — stable, just unfoldable with an scp twin that cannot exist.
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      path = url.pathname;
    }
  } else {
    const m = SCP_RE.exec(raw);
    // No scheme and no scp form ⇒ a bare local path — no repoId.
    if (m === null) return null;
    host = m[1] as string;
    path = m[2] as string;
    // `D:\x` / `C:/x` parse scp-like with a one-letter "host": a drive, not a hostname.
    if (/^[a-zA-Z]$/.test(host)) return null;
  }

  path = path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/g, "");
  if (path === "") return null;
  // `#` joins the subpath below, so a `#` inside the PATH would make
  // `host/a#b` mean either "repo a#b" or "repo a, subpath b" — a wrong FOLD,
  // merging two genuinely different projects, which is the failure §1 added
  // the subpath to prevent in the first place. Escaped in BOTH branches so the
  // two spellings still fold with each other: a scheme-bearing remote can only
  // deliver one as `%23` (URL splits a literal `#` off as the fragment, so the
  // decode above is the only route here), an scp-like one only literally.
  // A decoded `%2F` is deliberately NOT re-escaped: it collides only within
  // URL grammar, which is git's business, not with this key's own grammar.
  path = path.replace(/#/g, "%23");

  let key = `${host}${port === "" ? "" : `:${port}`}/${path}`.toLowerCase();
  if (key.endsWith(".git")) key = key.slice(0, -4);
  key = key.replace(/\/+$/g, "");

  const sub = normalizeSubpath(subpath);
  return sub === "" ? key : `${key}#${sub}`;
}
