// Host-platform detection for the two places the RENDERER has to know what it
// is running on. Both are cosmetic-but-real: the popout's macOS corner class
// (globals.css `.popout-rounded`) and Settings' macOS-only reduce-transparency
// switch (WebKit ships no `prefers-reduced-transparency`, so macOS is the one
// platform that cannot detect it and needs an explicit control).
//
// `navigator.platform` is deprecated but not going anywhere, and it is the one
// signal available before any Tauri API resolves — the popout stamps its body
// classes during module evaluation, ahead of first paint, so an async
// `plugin-os` call would land a frame late and flash square corners.
//
// Deliberately NOT a home for `backgroundResidencySupportedOn`: that answers
// "can a tray exist here", which is a capability question that happens to be
// spelled with platforms today. This is the plain fact.

/** Pure half, so the rule is pinnable without a browser. */
export function isMacOSPlatform(platform: string): boolean {
  return /Mac/i.test(platform);
}

export function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return isMacOSPlatform(navigator.platform);
}
