import { useState } from "react";
import { nextThemePref, parseThemePref, resolveTheme, type ThemePref } from "@maxprice/shared";

// The in-app half of the theme mechanism (ADR-0043). public/theme-boot.js
// stamps the resolved data-theme before first paint and owns OS-flip
// re-stamping while the preference is "system"; this hook owns the topbar
// chip's system → light → dark cycle. Both sides share one contract: the
// localStorage key holds an EXPLICIT preference ("light" | "dark") or is
// absent for "system", and <html data-theme> always carries the RESOLVED
// mode.
//
// That contract's pure half — ThemePref, the cycle, parse/resolve, and the
// chip's label — lives in @maxprice/shared (src/theme.ts), one impl for this
// app and the hub console alike; it is re-exported below so app code has a
// single theme import. What stays here is genuinely app-local: the storage key
// (it pairs with THIS app's public/theme-boot.js, not with the hub's) and the
// document/localStorage access, which the renderer bundle can't share.
const STORAGE_KEY = "maxprice-theme";

export {
  nextThemePref,
  parseThemePref,
  resolveTheme,
  themeChipLabel,
  type ThemePref,
} from "@maxprice/shared";

function readPref(): ThemePref {
  try {
    return parseThemePref(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "system";
  }
}

function resolve(pref: ThemePref): "light" | "dark" {
  return resolveTheme(pref, window.matchMedia("(prefers-color-scheme: dark)").matches);
}

export function useTheme(): { pref: ThemePref; cycle: () => void } {
  const [pref, setPref] = useState<ThemePref>(readPref);
  const cycle = (): void => {
    const next = nextThemePref(pref);
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage denied — the stamp below still applies for this session.
    }
    document.documentElement.dataset.theme = resolve(next);
    setPref(next);
  };
  return { pref, cycle };
}
