import {
  hubDaemonDot,
  hubDaemonLabel,
  isDeliberateLoopback,
  type HubDaemonState,
  type HubRowStatus,
} from "@maxprice/shared";
import { dotVariant } from "@/lib/dot-variant";

// The Hub page's browser tab (ADR-0124 §7): its title and favicon both read
// the Hub row, so a pinned tab says how the Hub is without being looked at.
// Pure, so it tests without Vite; use-tab.ts applies it to the document.

type Dot = ReturnType<typeof dotVariant>;

export function pageTitle(daemon: HubDaemonState): string {
  return `${hubDaemonLabel(daemon)} · MaxPrice Hub`;
}

// #452's approved badge colours. Hex, not the glass tokens' oklch: a favicon
// rasterizer may not read oklch.
export const FAVICON_BADGE: Record<Dot, string> = {
  good: "#1f9d61",
  warn: "#c9901f",
  bad: "#d9453b",
  soft: "#8b8ba3",
};

// The orb with a status badge on its lower right (the prototype's geometry on
// the orb's 1024 viewBox), as a data: URL, which the CSP's `img-src 'self'
// data:` allows (ADR-0124 §8).
export function badgedFavicon(orbSvg: string, dot: Dot): string {
  const badge = `<circle cx="790" cy="790" r="225" fill="${FAVICON_BADGE[dot]}" stroke="#fff" stroke-width="70"/>`;
  const close = orbSvg.lastIndexOf("</svg>");
  const svg = `${orbSvg.slice(0, close)}${badge}${orbSvg.slice(close)}`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// The favicon for the Hub row's state, or null while starting: until the first
// poll settles the page keeps page.html's plain orb. The badge is the Hub
// row's dot, so a deliberate loopback bind is calm and a tailnet bind that
// found no interface warns, as in the Popout.
export function pageFavicon(
  daemon: HubDaemonState,
  status: HubRowStatus | undefined,
  orbSvg: string,
): string | null {
  if (daemon === "starting") return null;
  return badgedFavicon(orbSvg, dotVariant(hubDaemonDot(daemon, isDeliberateLoopback(status))));
}
