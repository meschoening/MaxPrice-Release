// The pure half of the theme mechanism (ADR-0043) — the preference contract
// both apps' theme chips speak. Two consumers, one implementation: the desktop
// topbar chip (apps/desktop/src/components/Topbar.tsx) and the hub console's
// header chip (apps/hub-desktop/src/App.tsx). They used to carry byte-identical
// copies of the cycle, the parse/resolve rules, and the chip label template —
// em dash included — kept aligned only by a pair of "keep in lockstep"
// comments. Nothing enforced that; this module removes the need to.
//
// Everything here is DOM-free. Each app's src/lib/theme.ts owns the parts that
// touch the machine — the localStorage key it shares with its own
// public/theme-boot.js, the <html data-theme> stamp, and the useTheme hook —
// and re-exports this contract so app code has one theme import.

export type ThemePref = "system" | "light" | "dark";

// The chip's cycle order. "system" leads because it is the default and a
// meaningful state of its own, not merely the absence of a preference.
const CYCLE: readonly ThemePref[] = ["system", "light", "dark"];

export function nextThemePref(pref: ThemePref): ThemePref {
  return CYCLE[(CYCLE.indexOf(pref) + 1) % CYCLE.length] ?? "system";
}

// The stored preference is EXPLICIT ("light" | "dark") or absent for "system".
// Anything else — a stale value, a hand-edited one — reads as "system".
export function parseThemePref(stored: string | null): ThemePref {
  return stored === "light" || stored === "dark" ? stored : "system";
}

// The resolved mode that <html data-theme> carries. `osDark` is the caller's
// prefers-color-scheme reading, taken as a parameter so this stays DOM-free.
export function resolveTheme(pref: ThemePref, osDark: boolean): "light" | "dark" {
  return pref === "system" ? (osDark ? "dark" : "light") : pref;
}

// Accessible name (and tooltip) for the icon-only theme chip. The chips show a
// glyph and no words, so this string IS the accessible name in both apps. It
// names the NEXT state as well as the current one — the ambiguity a bare cycle
// button otherwise leaves you to guess at.
export function themeChipLabel(pref: ThemePref): string {
  return `Theme: ${pref} — click for ${nextThemePref(pref)}`;
}
