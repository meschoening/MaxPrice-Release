// Host-platform detection for the one place the hub's RENDERER has to know
// what it runs on: the popout's macOS corner class (globals.css
// `.popout-rounded`, ADR-0148 §2). A per-app copy of the client's
// `apps/desktop/src/lib/platform.ts` (ADR-0077's copy precedent), trimmed to
// what this app reads.
//
// `navigator.platform` is deprecated but not going anywhere, and it is the one
// signal available before any Tauri API resolves: the popout stamps its body
// classes during module evaluation, ahead of first paint, so an async
// `plugin-os` call would land a frame late and flash square corners.

/** Pure half, so the rule is pinnable without a browser. */
export function isMacOSPlatform(platform: string): boolean {
  return /Mac/i.test(platform);
}

export function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return isMacOSPlatform(navigator.platform);
}
