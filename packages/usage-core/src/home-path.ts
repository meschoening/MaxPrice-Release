// A user's home, and a path as a headless product's messages show it. Both
// take the environment they read, so a test passes its own and none reads
// the real one. The Headless client's paths.ts and the shared service
// modules use them.
//
// Reachable only via the "./home-path" subpath, never index.ts.

import { homedir } from "node:os";
import { sep } from "node:path";

export type Env = Record<string, string | undefined>;

export function home(env: Env): string {
  return env.HOME || homedir();
}

// A path as a message shows it, with the home prefix abbreviated to `~`.
export function displayPath(path: string, env: Env): string {
  const h = home(env);
  if (path === h) return "~";
  if (h !== sep && path.startsWith(h + sep)) return "~" + path.slice(h.length);
  return path;
}
