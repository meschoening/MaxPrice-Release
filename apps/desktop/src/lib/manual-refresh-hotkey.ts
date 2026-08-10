import { isEditableTarget } from "@/lib/dom";

// Pure predicate for the ⇧R manual-refresh chord (ADR-0019), extracted from
// useManualRefreshHotkey so the chord logic is unit-testable without a window or
// React. True only for a bare Shift+R (or Shift+r) outside a text-editing field:
// any Cmd/Ctrl/Alt modifier is left to the platform (notably Cmd+Shift+R, the
// webview hard-reload), and a focused input/textarea/contentEditable types the
// letter normally (shared isEditableTarget guard with useEscapeToDeselect).
//
// The listener layers an `e.repeat` early-out on top of this (see
// useManualRefreshHotkey) — that's about event lifecycle, not chord identity, so
// it deliberately stays out of the predicate.
export function shouldTriggerManualRefresh(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (!e.shiftKey) return false;
  if (e.key.toLowerCase() !== "r") return false;
  if (isEditableTarget(e.target)) return false;
  return true;
}
