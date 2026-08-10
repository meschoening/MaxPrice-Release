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
