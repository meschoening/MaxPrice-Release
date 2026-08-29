import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { insideTauri } from "@/lib/tauri";
import { setInvalidationPaused } from "@/lib/live-stream";

// Is the MAIN window on screen? (F9)
//
// The renderer cannot answer that question for itself. WebView2 leaves
// `document.visibilityState === "visible"` right through a window hide, so
// `visibilitychange`, `document.hidden`, and every library that layers on them
// are permanently stuck at "visible" here — the whole reasoning lives once, in
// src-tauri/src/popout.rs's "Window-visibility events" note. So the shell says
// it out loud and this module is the main window's ear.
//
// It exists because ADR-0079 windows are only ever hidden and shown, never
// destroyed: a main window closed to the tray — or a `--hidden` autostart
// launch that never shows one at all — keeps its React tree mounted, its query
// observers live, and (until this) ADR-0058's invalidation rounds refetching
// every report for nobody.
//
// The transport is the GLOBAL `listen`, unlike the popout's
// `getCurrentWebviewWindow().listen` — the events are emitted `emit_to("main",
// …)`, so only the main webview receives them, and one webview must never
// react to the other's visibility (both run the same bundle).

// Keep in lockstep with popout.rs's MAIN_SHOWN_EVENT / MAIN_HIDDEN_EVENT.
const MAIN_SHOWN_EVENT = "main:shown";
const MAIN_HIDDEN_EVENT = "main:hidden";

// Module-level, not React state: the `--hidden` seed below is async and races
// the first `main:shown`, and StrictMode double-invokes the mount effect. The
// seed must never pause a window that has already been shown.
let sawShow = false;

/**
 * Record that the main window is (or is no longer) on screen.
 *
 * Exported for `window-show.ts`: the renderer's own boot show path calls
 * `WebviewWindow.show()` directly and so never goes through Rust — no
 * `main:shown` is emitted for it, and it must set the flag itself. Together
 * with the two events below that covers every path that puts this window on
 * screen.
 */
export function setMainWindowShown(shown: boolean): void {
  if (shown) sawShow = true;
  setInvalidationPaused(!shown);
}

/**
 * Mount-once: follow the main window's visibility for the app's lifetime.
 *
 * Belongs beside `useLiveStream()` in Layout — it drives that module's pause,
 * and both live exactly as long as the app does.
 */
export function useMainWindowVisibility(): void {
  useEffect(() => {
    if (!insideTauri()) return;
    let torn = false;

    // The startup seed. A `--hidden` autostart launch (ADR-0077) never shows
    // the main window, so there is no hide to hear: without this the app would
    // run the whole session unpaused — the worst case this fix exists for.
    // Fail OPEN, mirroring `showAppWindow`'s gate on the same command: an
    // unreadable answer resolves to "shown", because pausing a window the user
    // is looking at is much the worse mistake of the two.
    void invoke<boolean>("launched_hidden")
      .catch(() => false)
      .then((hidden) => {
        if (torn || !hidden || sawShow) return;
        setInvalidationPaused(true);
      });

    const unlistenShown = listen(MAIN_SHOWN_EVENT, () => {
      setMainWindowShown(true);
    });
    const unlistenHidden = listen(MAIN_HIDDEN_EVENT, () => {
      setMainWindowShown(false);
    });
    return () => {
      torn = true;
      void unlistenShown.then((off) => off());
      void unlistenHidden.then((off) => off());
    };
  }, []);
}
