// The screenshots directory's manifest, and the static checks `bun run test`
// holds it to without a browser (ADR-0134 §7, §10). The capture script
// (scripts/guide-screenshots.ts) writes the manifest through `manifestText`;
// frames.test.ts runs `frameProblems` over the committed directory.
//
// Every frame is a pair, `<name>.light.png` and `<name>.dark.png`, and the
// manifest lists each file the script took with its SHA-256 and pixel size. So
// a hand-dropped or hand-edited image, a missing theme, or a frame past its cap
// each fails a test, and only a rerun of the script can make them pass.
//
// Runs under Node as well as Bun, so it uses node: modules only.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_FILE = "manifest.json";

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/**
 * The caps, from the first capture's measured sizes (#570, ADR-0134 §10 as
 * amended). The Landing pair is a full 1280×800 window at device scale factor
 * 2, 0.93 MB light and 1.10 MB dark, and Chromium's PNGs are already tight:
 * re-deflating them with per-row filters at level 9 grew them 2%. ADR-0133 §6
 * lists about twenty pairs, several cropped to nearly the whole window, so a
 * file may reach 1.5 MB and the directory 40 MB.
 */
export const FILE_CAP_BYTES = 1_500_000;
export const DIRECTORY_CAP_BYTES = 40_000_000;

export interface ManifestFile {
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

export interface Manifest {
  readonly version: 1;
  /** Keyed by frame name, in name order; each frame has both themes. */
  readonly frames: Readonly<Record<string, Readonly<Record<Theme, ManifestFile>>>>;
}

export function frameFile(name: string, theme: Theme): string {
  return `${name}.${theme}.png`;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The manifest as the script writes it: frames in name order, two-space JSON, one trailing newline. */
export function manifestText(manifest: Manifest): string {
  const frames = Object.fromEntries(
    Object.keys(manifest.frames)
      .sort()
      .map((name) => [name, manifest.frames[name]]),
  );
  return `${JSON.stringify({ version: manifest.version, frames }, null, 2)}\n`;
}

/** The PNG's size from its IHDR chunk, or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function parseManifest(text: string): Manifest | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return `${MANIFEST_FILE} is not JSON (${String(err)})`;
  }
  const v = value as Partial<Manifest> | null;
  if (v === null || typeof v !== "object" || v.version !== 1 || typeof v.frames !== "object") {
    return `${MANIFEST_FILE} is not a version 1 manifest`;
  }
  return v as Manifest;
}

/**
 * Every way the directory breaks ADR-0134 §10, each naming its file; empty when
 * it holds. A directory that does not exist yet holds trivially, before the
 * first frame is committed.
 */
export function frameProblems(
  dir: string,
  caps: { readonly file: number; readonly directory: number } = {
    file: FILE_CAP_BYTES,
    directory: DIRECTORY_CAP_BYTES,
  },
): string[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).sort();
  const manifestPath = join(dir, MANIFEST_FILE);
  if (!files.includes(MANIFEST_FILE)) {
    return files.length === 0 ? [] : [`${MANIFEST_FILE} is missing beside ${files.join(", ")}`];
  }
  const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
  if (typeof manifest === "string") return [manifest];

  const problems: string[] = [];
  const listed = new Map<string, ManifestFile>();
  for (const [name, themes] of Object.entries(manifest.frames)) {
    for (const theme of THEMES) {
      const entry = themes?.[theme];
      if (entry === undefined)
        problems.push(`frame "${name}" has no ${theme} entry in ${MANIFEST_FILE}`);
      else listed.set(frameFile(name, theme), entry);
    }
  }

  let total = statSync(manifestPath).size;
  for (const file of files.filter((f) => f !== MANIFEST_FILE)) {
    const path = join(dir, file);
    const bytes = new Uint8Array(readFileSync(path));
    total += bytes.length;
    const entry = listed.get(file);
    if (entry === undefined) {
      problems.push(`${file} is not in ${MANIFEST_FILE}: only the capture script writes frames`);
      continue;
    }
    if (sha256(bytes) !== entry.sha256) {
      problems.push(`${file} does not match its ${MANIFEST_FILE} hash: rerun the capture script`);
    }
    const size = pngSize(bytes);
    if (size === null) problems.push(`${file} is not a PNG`);
    else if (size.width !== entry.width || size.height !== entry.height) {
      problems.push(
        `${file} is ${size.width}×${size.height}, but ${MANIFEST_FILE} says ${entry.width}×${entry.height}`,
      );
    }
    if (bytes.length > caps.file) {
      problems.push(`${file} is ${bytes.length} bytes, over the ${caps.file}-byte cap`);
    }
  }
  for (const file of listed.keys()) {
    if (!files.includes(file)) problems.push(`${file} is in ${MANIFEST_FILE} but missing`);
  }
  for (const name of Object.keys(manifest.frames)) {
    const light = manifest.frames[name]?.light;
    const dark = manifest.frames[name]?.dark;
    if (light && dark && (light.width !== dark.width || light.height !== dark.height)) {
      problems.push(
        `frame "${name}" is ${light.width}×${light.height} light but ${dark.width}×${dark.height} dark`,
      );
    }
  }
  if (total > caps.directory) {
    problems.push(`the directory holds ${total} bytes, over the ${caps.directory}-byte cap`);
  }
  return problems;
}
