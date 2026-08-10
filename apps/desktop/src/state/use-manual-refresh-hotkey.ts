import { useEffect } from "react";
import { shouldTriggerManualRefresh } from "@/lib/manual-refresh-hotkey";
import { useManualRefresh } from "@/state/use-manual-refresh";

// ⇧R triggers a manual rescan (ADR-0019). Mounted once in Layout, beside
// useLiveStream, so it works on every route. Chord matching — bare Shift+R
// outside a text-editing field, Cmd/Ctrl/Alt left to the platform (notably
// Cmd+Shift+R, the webview hard-reload) — lives in the pure
// shouldTriggerManualRefresh predicate, whose input-focus guard is the
// isEditableTarget helper shared with useEscapeToDeselect. The listener adds an
// `e.repeat` early-out so holding the chord doesn't fire a rescan every key
// auto-repeat.
export function useManualRefreshHotkey(): void {
  const trigger = useManualRefresh((s) => s.trigger);
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.repeat) return;
      if (!shouldTriggerManualRefresh(e)) return;
      e.preventDefault();
      trigger();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [trigger]);
}
