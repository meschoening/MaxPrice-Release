// A screenshot a page names by its light frame, paired with its dark frame
// (ADR-0134 §7, ADR-0135 §3). Runs under Node as well as Bun, so it uses node:
// modules only.
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { APP_DIR, SCREENSHOT_SCALE } from "./pages";

/** A screenshot's two frames, as the page's HTML spells them. */
export type Screenshot = {
  light: string;
  dark: string;
  /** The frame's size in CSS pixels. */
  width: number;
  height: number;
};

// The PNG signature, and the IHDR chunk that opens every PNG with its size.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The pair for the light frame at `target` (repo-relative, under `root`), or
 * the problem with it. Each frame's URL is root-absolute, so Vite bundles it
 * as an asset; the size is in CSS pixels.
 */
export function pairScreenshot(root: string, target: string): Screenshot | string {
  const name = target.match(/^(.+)\.light\.png$/)?.[1];
  if (name === undefined) {
    return `shows "${target}"; a screenshot names its light frame, "<name>.light.png"`;
  }
  const light = pngSize(join(root, target));
  if (typeof light === "string") return `shows "${target}", which ${light}`;
  const darkTarget = `${name}.dark.png`;
  const dark = pngSize(join(root, darkTarget));
  if (typeof dark === "string") {
    return `shows "${target}", whose dark frame "${darkTarget}" ${dark}`;
  }
  if (dark.width !== light.width || dark.height !== light.height) {
    return `shows "${target}", ${light.width}×${light.height}, whose dark frame is ${dark.width}×${dark.height}`;
  }
  const url = (path: string) => `/${posix.relative(APP_DIR, path)}`;
  return {
    light: url(target),
    dark: url(darkTarget),
    width: Math.round(light.width / SCREENSHOT_SCALE),
    height: Math.round(light.height / SCREENSHOT_SCALE),
  };
}

function pngSize(path: string): { width: number; height: number } | string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return "does not exist";
  }
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.toString("latin1", 12, 16) !== "IHDR"
  ) {
    return "is not a PNG";
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
