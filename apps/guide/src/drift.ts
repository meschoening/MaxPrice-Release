// The User guide's drift checks (#563's resolution §3–§5, and #565's Q7): they
// read a built dist/ and name every problem in it, one line each, so the test
// that builds the guide can hold the list empty. The build's own strictness
// (§2) is render.ts's; the permanent paths (§7) are pages.test.ts's.
//
// - Links and assets: every internal `href`, `src` and `srcset` in a page, and
//   every `url()` in its CSS, names a built file, and a `#anchor` an id on
//   the page it names. External links are never fetched.
// - Commands, on guide pages only (a Reference page is its manual, which its
//   own readme.test.ts holds): no fenced block runs `maxprice` or
//   `maxprice-hub` (ADR-0133 §3), and an inline `maxprice …` names a command
//   and options that the binary's `--help` lists.
// - Images: each image under the app is a built file some page or stylesheet
//   reaches, byte for byte, and every `<img>` has alt text.
// - Static accessibility: `<html lang>`, one `<h1>`, and no skipped heading
//   level.
//
// Bun-only (HTMLRewriter): only the tests import it.
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { htmlText } from "./html";
import { APP_DIR, type Page } from "./pages";

/**
 * A terminal binary as its `--help` lists it, read the way its readme.test.ts
 * reads it: apps/cli's COMMANDS or apps/hub's VERBS, each command with the
 * options its parser takes.
 */
export type Binary = {
  name: string;
  commands: Record<string, { options: Record<string, { short?: string }> }>;
};

export type Build = {
  /** The built site: what `vite build` wrote. */
  dist: string;
  pages: readonly Page[];
  /** The app directory, absolute, whose images the build must reach. */
  appDir: string;
  binaries: readonly Binary[];
};

/** Every problem in the build, each naming the page or file it is in. */
export function checkBuild(build: Build): string[] {
  const problems: string[] = [];
  const files = new Set(filesUnder(build.dist, () => true));
  const scans = new Map(
    build.pages.map((page) => [
      page.out,
      scanPage(readFileSync(join(build.dist, page.out), "utf8")),
    ]),
  );
  // Every built file a page or stylesheet reaches, for the image check.
  const reached = new Set<string>();

  // A URL in `from` must name a built file, and its anchor an id on that page.
  // An external URL passes unread.
  const reach = (from: string, url: string, problem: (text: string) => void) => {
    let target: ReturnType<typeof internalTarget>;
    try {
      target = internalTarget(from, url);
    } catch {
      // decodeURIComponent's URIError: a `%` that escapes nothing.
      problem(`"${url}" is no well-formed URL`);
      return;
    }
    if (target === null) return;
    if (!files.has(target.file)) {
      problem(`"${url}" names no file in the build`);
      return;
    }
    reached.add(target.file);
    if (target.anchor === "") return;
    const scan = scans.get(target.file);
    if (scan === undefined) {
      problem(`"${url}" has an anchor, but ${target.file} is no page`);
    } else if (!scan.ids.has(target.anchor)) {
      problem(`"${url}": ${target.file} has no element with id "${target.anchor}"`);
    }
  };

  for (const page of build.pages) {
    const scan = scans.get(page.out)!;
    const problem = (text: string) => problems.push(`${page.source} (${page.out}): ${text}`);

    if (!scan.lang?.trim()) problem("its <html> has no lang");
    const h1s = scan.headings.filter((h) => h.level === 1).length;
    if (h1s !== 1) problem(`has ${h1s} <h1> elements; a page has exactly one`);
    let level = 0;
    for (const heading of scan.headings) {
      if (heading.level > level + 1) {
        problem(
          `skips a heading level: ${describeHeading(heading)} follows ${level === 0 ? "no heading" : `an <h${level}>`}`,
        );
      }
      level = heading.level;
    }

    for (const { tag, attribute, url } of scan.urls) {
      reach(page.out, url, (text) => problem(`<${tag} ${attribute}>: ${text}`));
    }
    for (const src of scan.imagesWithoutAlt) problem(`<img src="${src}"> has no alt text`);

    // A Reference page is its manual, held by that manual's readme.test.ts.
    if (!page.source.startsWith(`${APP_DIR}/`)) continue;
    for (const fence of scan.fences) {
      for (const line of fence.split("\n")) {
        const runs = build.binaries.find((b) => runsBinary(line, b.name));
        if (runs !== undefined) {
          problem(
            `a fenced block runs ${runs.name}: "${line.trim()}"; link its Reference section instead (ADR-0133 §3)`,
          );
        }
      }
    }
    for (const code of scan.inlineCode) {
      for (const binary of build.binaries) {
        const wrong = commandProblem(binary, code);
        if (wrong !== null) problem(`\`${code}\`: ${wrong}`);
      }
    }
  }

  for (const css of [...files].filter((f) => f.endsWith(".css"))) {
    const text = readFileSync(join(build.dist, css), "utf8");
    for (const [, url] of text.matchAll(CSS_URL)) {
      // `url(#id)` names an SVG element in the document, not a file.
      if (url!.startsWith("#")) continue;
      reach(css, url!, (text) => problems.push(`${css}: url(${url}): ${text}`));
    }
  }

  // An image is shown when a reached file is its bytes under its own name
  // (public/'s copy) or under Vite's `<name>-<8-character hash><ext>`, so a
  // stale copy of a shown frame does not pass for it.
  const shown = [...reached]
    .filter((file) => IMAGE.test(file))
    .map((file) => ({ name: posix.basename(file), sha: sha256(join(build.dist, file)) }));
  for (const image of filesUnder(build.appDir, (dir) => !SKIPPED_DIRS.has(dir))) {
    if (!IMAGE.test(image)) continue;
    const name = posix.basename(image);
    const ext = posix.extname(name);
    const stem = name.slice(0, -ext.length);
    const sha = sha256(join(build.appDir, image));
    const builtAs = (built: string) =>
      built === name ||
      (built.length === name.length + 9 && built.startsWith(`${stem}-`) && built.endsWith(ext));
    if (!shown.some((s) => s.sha === sha && builtAs(s.name))) {
      problems.push(`${APP_DIR}/${image}: no page or stylesheet shows it`);
    }
  }
  return problems;
}

// --- reading a page --------------------------------------------------------------

type ScannedHeading = { level: number; id: string | null; text: string };

type PageScan = {
  lang: string | null;
  headings: ScannedHeading[];
  ids: Set<string>;
  urls: { tag: string; attribute: string; url: string }[];
  imagesWithoutAlt: string[];
  /** Each `<pre>`'s text. */
  fences: string[];
  /** Each `<code>` outside a `<pre>`, its whitespace collapsed. */
  inlineCode: string[];
};

function scanPage(html: string): PageScan {
  const scan: PageScan = {
    lang: null,
    headings: [],
    ids: new Set(),
    urls: [],
    imagesWithoutAlt: [],
    fences: [],
    inlineCode: [],
  };
  // The elements whose text is being read: headings, <pre>s and inline
  // <code>s, which nest (a heading may hold code).
  const reading = new Set<{ text: string }>();
  const read = (element: HTMLRewriterTypes.Element, done: (text: string) => void) => {
    const current = { text: "" };
    reading.add(current);
    element.onEndTag(() => {
      reading.delete(current);
      done(htmlText(current.text));
    });
  };
  let inPre = false;

  new HTMLRewriter()
    .on("html", {
      element(element) {
        scan.lang = attribute(element, "lang");
      },
    })
    .on("*", {
      element(element) {
        const id = attribute(element, "id");
        if (id !== null) scan.ids.add(id);
        for (const name of ["href", "src", "srcset"]) {
          const value = attribute(element, name);
          if (value === null) continue;
          const urls = name === "srcset" ? srcsetUrls(value) : [value];
          for (const url of urls) scan.urls.push({ tag: element.tagName, attribute: name, url });
        }
      },
    })
    .on("h1, h2, h3, h4, h5, h6", {
      element(element) {
        const level = Number(element.tagName.slice(1));
        const id = attribute(element, "id");
        read(element, (text) => scan.headings.push({ level, id, text }));
      },
    })
    .on("img", {
      element(element) {
        if ((attribute(element, "alt") ?? "").trim() === "") {
          scan.imagesWithoutAlt.push(attribute(element, "src") ?? "");
        }
      },
    })
    .on("pre", {
      element(element) {
        inPre = true;
        read(element, (text) => {
          scan.fences.push(text);
          inPre = false;
        });
      },
    })
    .on("code", {
      element(element) {
        if (inPre) return;
        read(element, (text) => scan.inlineCode.push(text.replace(/\s+/g, " ").trim()));
      },
    })
    .onDocument({
      text(chunk) {
        for (const current of reading) current.text += chunk.text;
      },
    })
    .transform(html);
  return scan;
}

// An attribute's value, its entities undone: HTMLRewriter hands it raw.
function attribute(element: HTMLRewriterTypes.Element, name: string): string | null {
  const value = element.getAttribute(name);
  return value === null ? null : htmlText(value);
}

function describeHeading(heading: ScannedHeading): string {
  const id = heading.id === null ? "" : ` id="${heading.id}"`;
  return `<h${heading.level}${id}> "${heading.text.trim()}"`;
}

// A srcset's URLs: each candidate's first word.
function srcsetUrls(srcset: string): string[] {
  return srcset
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0]!)
    .filter((url) => url !== "");
}

// --- links ------------------------------------------------------------------------

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const CSS_URL = /url\(\s*["']?([^"')]+?)["']?\s*\)/g;

/**
 * The file under dist/ a URL in `from` names, with its anchor, or null for an
 * external URL. A path outside dist/ starts with `../`, so it names no built
 * file. Throws a URIError on a malformed escape.
 */
function internalTarget(from: string, url: string): { file: string; anchor: string } | null {
  if (SCHEME.test(url) || url.startsWith("//")) return null;
  const hashAt = url.indexOf("#");
  const anchor = hashAt < 0 ? "" : decodeURIComponent(url.slice(hashAt + 1));
  const path = decodeURIComponent((hashAt < 0 ? url : url.slice(0, hashAt)).replace(/\?.*$/, ""));
  if (path === "") return { file: from, anchor };
  let file = path.startsWith("/")
    ? posix.normalize(path.slice(1))
    : posix.join(posix.dirname(from), path);
  if (path.endsWith("/")) file = posix.join(file, "index.html");
  return { file, anchor };
}

// --- commands ---------------------------------------------------------------------

// Every command takes these, and the top level `--version` too (both binaries'
// top-level help, Options).
const HELP_OPTIONS = ["--help", "-h"];
const TOP_OPTIONS = [...HELP_OPTIONS, "--version"];

// A word that ends the command: a shell operator, or `--`, after which no word
// is an option.
const COMMAND_END = new Set(["--", "|", "||", "&&", ";", ">", ">>", "2>", "2>&1"]);

/** Whether the word runs the binary, by name or by path. */
function isBinary(word: string, name: string): boolean {
  return word === name || word.endsWith(`/${name}`);
}

/** Whether a line of a fenced block runs the binary. */
function runsBinary(line: string, name: string): boolean {
  return line.split(/[\s;&|()`]+/).some((word) => isBinary(word, name));
}

/**
 * What is wrong with an inline `maxprice …` (by name or path, after any
 * `sudo`), or null, also for code that does not run the binary. A
 * `<placeholder>`, `…`, or `[optional]` or `a|b` word is read as the usage
 * lines write it.
 */
function commandProblem(binary: Binary, code: string): string | null {
  // Keep the argument before a semicolon, but ignore the next shell command.
  const all = code.split(";", 1)[0]!.split(" ");
  const at = all[0] === "sudo" ? 1 : 0;
  if (all[at] === undefined || !isBinary(all[at], binary.name)) return null;
  const args = all.slice(at + 1);
  const end = args.findIndex((word) => COMMAND_END.has(word));
  const words = (end < 0 ? args : args.slice(0, end))
    .flatMap((word) => word.replace(/[[\]]/g, "").split("|"))
    .filter((word) => word !== "");
  const isOption = (word: string) => word.length > 1 && word.startsWith("-");
  // `--since=x` is `--since`, and `-n50` is `-n`.
  const optionName = (word: string) =>
    word.startsWith("--") ? word.split("=")[0]! : word.slice(0, 2);
  const isPlaceholder = (word: string) => /^<.*>$/.test(word) || word === "…" || word === "...";
  const unknown = (options: readonly string[], scope: string) => {
    const bad = words
      .filter(isOption)
      .map(optionName)
      .find((o) => !options.includes(o));
    return bad === undefined ? null : `${scope} --help lists no option "${bad}"`;
  };

  const [first, ...rest] = words;
  if (first === undefined) return null;
  if (isOption(first)) return unknown(TOP_OPTIONS, binary.name);
  const named = (word: string) => isPlaceholder(word) || Object.hasOwn(binary.commands, word);
  if (first === "help") {
    const command = rest.find((word) => !isOption(word));
    if (command !== undefined && !named(command)) {
      return `${binary.name} --help lists no command "${command}"`;
    }
    return unknown(HELP_OPTIONS, `${binary.name} help`);
  }
  if (!named(first)) return `${binary.name} --help lists no command "${first}"`;
  if (isPlaceholder(first)) return unknown(HELP_OPTIONS, `${binary.name} ${first}`);
  const options = Object.entries(binary.commands[first]!.options).flatMap(([option, { short }]) =>
    short === undefined ? [`--${option}`] : [`--${option}`, `-${short}`],
  );
  return unknown([...HELP_OPTIONS, ...options], `${binary.name} ${first}`);
}

// --- files ------------------------------------------------------------------------

// The app's directories that hold no source of the guide: its build, its
// packages, and the fixture site (test/), whose frames only its own page shows.
const SKIPPED_DIRS = new Set(["dist", "node_modules", "test"]);
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|ico)$/i;

/**
 * Every file under `root`, relative and forward-slashed, skipping dot
 * directories and each directory whose relative path `keep` refuses.
 */
function filesUnder(root: string, keep: (dir: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (keep(path) && !entry.name.startsWith(".")) walk(path);
      } else if (entry.isFile()) found.push(path);
    }
  };
  walk("");
  return found.sort();
}

function sha256(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}
