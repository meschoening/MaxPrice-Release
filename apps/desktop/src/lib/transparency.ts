import { useState } from "react";

// The in-app half of the reduce-transparency fallback (T4's a11y obligation,
// landed in M8). public/theme-boot.js stamps data-reduce-transparency on
// <html> before first paint and re-stamps on OS flips; packages/glass keys its
// opaque-material block on that attribute. The RESOLVED state is
// override-OR-OS: the localStorage key holds "1" or is absent, and the OS
// signal is prefers-reduced-transparency — live on Chromium/WebView2, never
// matching on WebKit, which is why macOS gets this hook's Settings switch as
// its only driver (the one sanctioned new control of the redesign).
const STORAGE_KEY = "maxprice-reduce-transparency";

export function resolveReduceTransparency(stored: string | null, osReduced: boolean): boolean {
  return stored === "1" || osReduced;
}

function readOverride(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function osReduced(): boolean {
  return window.matchMedia("(prefers-reduced-transparency: reduce)").matches;
}

export function useReduceTransparency(): { on: boolean; toggle: () => void } {
  const [on, setOn] = useState<boolean>(readOverride);
  const toggle = (): void => {
    const next = !on;
    try {
      if (next) localStorage.setItem(STORAGE_KEY, "1");
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage denied — the stamp below still applies for this session.
    }
    const reduced = resolveReduceTransparency(next ? "1" : null, osReduced());
    if (reduced) document.documentElement.setAttribute("data-reduce-transparency", "");
    else document.documentElement.removeAttribute("data-reduce-transparency");
    setOn(next);
  };
  return { on, toggle };
}
