import { readFileSync, renameSync, unlinkSync } from "node:fs";

// The v6 → v7 boot conversion the Label directory and the Membership
// assertion directory share (#635, ADR-0139 §7): each v7 file replaced a v6
// one under a new name, and each converts it once, at the first boot that
// finds no v7 file. Each module keeps its own entry parsing, its envelope and
// its atomic `write`; this is only the load-or-convert IO between them.
//
// Answers the text the module then loads (its own salvage), or null for a
// first boot or a file this boot could not read:
// - no v7 file and a v6 one: the v6 file converted (`convert`, the module's
//   pure function `restore` also uses), the v7 file written first and the v6
//   one removed only once it is durable, so a crash between the two leaves
//   both. A failed write keeps the converted text in memory and the v6 file
//   in place, and the next boot converts again. A v6 file `convert` cannot
//   read (not JSON, or no v1 envelope) is moved aside as `.bak`, so the next
//   boot does not read it again, and the directory starts empty;
// - both files: an earlier conversion stopped before it removed the v6 one,
//   so the v7 file is the converted one and wins, and the v6 one is removed;
// - a v7 file this boot cannot read is never converted over, and a v6 file
//   this boot cannot read is never converted: in either case the v6 file is
//   moved aside as `.bak`, its bytes kept, and the directory starts empty.
//   Left in place, it would be removed unread by a later boot, which would
//   find it beside the v7 file this boot's first edit writes and take that
//   for an earlier conversion. The same holds beside a v7 file the module
//   cannot load (not JSON, or not its envelope), which it then sets aside
//   itself: the v6 file is kept as `.bak` rather than removed.
export function loadOrConvertDirectory(opts: {
  path: string;
  // The v6 file beside it (serve passes it; a store without one converts
  // nothing).
  legacyPath?: string;
  // The directory's name and its v6 file's, for the log lines.
  name: string;
  legacyName: string;
  // The directory's cap, which a v6 file over it fails like any other file
  // `convert` cannot read: named in the log line, so it says why.
  max: number;
  // Whether a v7 file's text is one the module loads (its envelope parses):
  // only then is a v6 file beside it an earlier conversion's leftover.
  loads: (text: string) => boolean;
  convert: (raw: unknown) => { text: string; skipped: number } | null;
  write: (text: string) => void;
}): string | null {
  const { path, name } = opts;

  // The file's text; null when it is not there (ENOENT), and "unreadable"
  // for any other fault, which starts empty too but says so.
  function readText(file: string): string | null | "unreadable" {
    try {
      return readFileSync(file, "utf8");
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
      console.warn(`[hub] ${name}: ${file} could not be read; starting empty: ${err}`);
      return "unreadable";
    }
  }

  const current = readText(path);
  const rawBytes = current === "unreadable" ? null : current;
  const legacy = opts.legacyPath === undefined ? null : readText(opts.legacyPath);
  if (legacy === null) return rawBytes;
  const legacyPath = opts.legacyPath!;
  if (legacy === "unreadable" || current === "unreadable") {
    const which = legacy === "unreadable" ? legacyPath : path;
    try {
      renameSync(legacyPath, `${legacyPath}.bak`);
      console.warn(
        `[hub] ${name}: ${which} could not be read, so ${legacyPath} is not converted (kept ${legacyPath}.bak)`,
      );
    } catch (err) {
      console.warn(`[hub] ${name}: could not move ${legacyPath} aside: ${err}`);
    }
    return rawBytes;
  }
  const legacyBytes = legacy;
  if (rawBytes !== null && !opts.loads(rawBytes)) {
    try {
      renameSync(legacyPath, `${legacyPath}.bak`);
      console.warn(
        `[hub] ${name}: ${path} cannot be loaded, so ${legacyPath} is not converted (kept ${legacyPath}.bak)`,
      );
    } catch (err) {
      console.warn(`[hub] ${name}: could not move ${legacyPath} aside: ${err}`);
    }
    return rawBytes;
  }
  if (rawBytes !== null) {
    try {
      unlinkSync(legacyPath);
      console.log(`[hub] ${name}: removed ${legacyPath}, already converted`);
    } catch (err) {
      console.warn(`[hub] ${name}: could not remove ${legacyPath}: ${err}`);
    }
    return rawBytes;
  }
  let converted: ReturnType<typeof opts.convert> = null;
  try {
    converted = opts.convert(JSON.parse(legacyBytes));
  } catch {
    // not JSON: the recovery path below
  }
  if (converted === null) {
    try {
      renameSync(legacyPath, `${legacyPath}.bak`);
    } catch {
      // best-effort — never block boot on the backup copy
    }
    console.warn(
      `[hub] ${opts.legacyName} is not JSON, or not a version 1 file of at most ${opts.max} entries; starting an empty ${name} (kept ${legacyPath}.bak)`,
    );
    return null;
  }
  try {
    opts.write(converted.text);
    unlinkSync(legacyPath);
    console.log(`[hub] ${name}: converted ${legacyPath} to ${path}`);
  } catch (err) {
    console.warn(`[hub] ${name}: could not convert ${legacyPath}: ${err}`);
  }
  if (converted.skipped > 0) {
    console.warn(
      `[hub] ${name}: dropped ${converted.skipped} unreadable ${converted.skipped === 1 ? "entry" : "entries"} of ${legacyPath}`,
    );
  }
  return converted.text;
}
