import { useState } from "react";
import { nextThemePref, parseThemePref, resolveTheme, type ThemePref } from "@maxprice/shared";

// The in-app half of the theme mechanism (ADR-0043). public/theme-boot.js
// stamps the resolved data-theme before first paint and owns OS-flip
// re-stamping while the preference is "system"; this hook owns the header
// chip's system → light → dark cycle. Both sides share one contract: the
// localStorage key holds an EXPLICIT preference ("light" | "dark") or is
// absent for "system", and <html data-theme> always carries the RESOLVED
// mode.
//
// That contract's pure half — ThemePref, the cycle, parse/resolve, and the
// chip's label — lives in @maxprice/shared (src/theme.ts), one impl for this
// console and the desktop app alike; it is re-exported below so app code has a
// single theme import. What stays here is genuinely app-local: the storage key
// (it pairs with THIS app's public/theme-boot.js, not with the desktop app's)
// and the document/localStorage access, which the renderer bundle can't share.
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

function stamp(pref: ThemePref): void {
  document.documentElement.dataset.theme = resolve(pref);
}

// Re-run theme-boot.js's read-resolve-stamp against THIS document. The console
// never needs it (boot stamps it, the chip re-stamps it), but the tray popout
// does: its webview is created at launch and only ever hidden/shown, so a
// single boot stamp would be frozen for the whole process and the popout would
// keep the launch mode after the chip cycled. Popout.tsx calls this on mount
// and on every show — see the effect there for why no IPC is involved.
export function applyStoredTheme(): void {
  stamp(readPref());
}

export function useTheme(): { pref: ThemePref; cycle: () => void } {
  const [pref, setPref] = useState<ThemePref>(readPref);
  const cycle = (): void => {
    const next = nextThemePref(pref);
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage denied — the stamp below still applies for this session, which
      // is why this stamps `next` directly instead of calling
      // `applyStoredTheme()`: reading back would return the unwritten value.
    }
    stamp(next);
    setPref(next);
  };
  return { pref, cycle };
}
