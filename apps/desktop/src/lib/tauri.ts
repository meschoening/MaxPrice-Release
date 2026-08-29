import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// Tauri host detection. The renderer can run standalone under Vite with no
// Tauri host, where `invoke` and the dialog/opener/updater plugin calls all
// throw. Every entry point that touches a Tauri API guards on this first.
//
// Lives in the lib layer so both lib/ (sidecar, updater) and state/
// (use-settings) can depend on it without a state→… inversion (ADR-0004's
// lib→state direction).
export function insideTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Which window this bundle woke up in (ADR-0050 pattern; map #168 / M2): ONE
// dist serves both the app (label `main`) and the tray popout (label
// `popout`); main.tsx mounts the matching root component. Outside Tauri,
// `?window=popout` selects the popout for browser-driven debug
// (Vite + Playwright).
//
// Both `window` reads are guarded. `insideTauri()` already short-circuits on a
// missing global, so a Tauri-LESS BROWSER — the documented Vite/Playwright
// debug path — takes the query-string branch with a perfectly good `window`.
// The one host with no `window` at all is `bun test` (this app has no SSR and
// no workers); it can't be a popout, so it falls through to the main default
// rather than throwing.
export function currentWindowLabel(): "main" | "popout" {
  let label: string | null = null;
  if (insideTauri()) label = getCurrentWebviewWindow().label;
  else if (typeof window !== "undefined")
    label = new URLSearchParams(window.location.search).get("window");
  return label === "popout" ? "popout" : "main";
}
