import { getCurrentWindow } from "@tauri-apps/api/window";
import { insideTauri } from "@/lib/tauri";
import { logClientEvent } from "@/lib/client-log";

// Putting the OS window on screen — the stage BEFORE the boot gate's two
// (ADR-0066). The vocabulary is kept distinct on purpose: **show** is the
// window arriving on screen; **reveal** is the splash giving way to the app
// frame. They are different moments, ~a second apart, and conflating them is
// how a future reader would wire the wrong one.
//
// The main window is created hidden (`visible: false` in tauri.conf.json).
// Created visible, the OS shows it the instant the process starts and the user
// watches the page assemble itself: the webview's own white background first,
// then the glass wash alone once theme-boot.js + the stylesheet land, and only
// then the splash — once ~740 kB of bundle has parsed and React has committed.
// Two blank flashes in front of the screen whose entire job is to cover the
// boot. Created hidden, the window's first frame IS the splash.
//
// This is renderer-driven because the renderer is the only side that knows when
// the splash exists. The shell keeps its own guarantee that a launched app
// always ends up on screen: `WINDOW_SHOW_FALLBACK_MS` in src-tauri/src/lib.rs
// shows the window if nobody asked (a bundle that fails to parse would
// otherwise leave a running process with no window and no way to reach it).

/**
 * How long we wait for the two frames before showing the window regardless.
 *
 * The backstop for a page that reports itself visible but never paints. The
 * expected hidden case is handled exactly rather than by timeout (see
 * `scheduleWindowShow`) — precisely because a hidden page's timers are
 * throttled to ~1 s alignment by Chromium, so a budget is a poor instrument
 * there: it would show the window a second late on every launch.
 *
 * Deliberately well under `MIN_SPLASH_DISPLAY_MS`, so waiting it out can never
 * push the splash's own minimum display or delay the ADR-0066 reveal.
 */
export const WINDOW_SHOW_FRAME_BUDGET_MS = 150;

export type WindowShowHost = {
  /** Whether the page is currently painting nothing — `visibilityState`. */
  pageIsHidden: () => boolean;
  requestFrame: (cb: () => void) => void;
  setTimer: (cb: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
  show: () => void;
};

/**
 * Call `host.show` exactly once: immediately if the page is hidden, else after
 * two animation frames or `WINDOW_SHOW_FRAME_BUDGET_MS`, whichever is first.
 *
 * The hidden branch is the one that runs in the packaged app, and it is not a
 * concession — it is the correct answer. A hidden window composites nothing:
 * WebView2 stops driving the controller, so `requestAnimationFrame` never
 * fires and no paint can happen **until we show**. Waiting for one would delay
 * the window without buying a single drawn pixel; the first painted frame
 * lands after the show either way.
 *
 * Where the page does report visible, two frames — rather than one, for the
 * same reason `BootGate` uses two: one `requestAnimationFrame` only guarantees
 * we run *before* the next paint, not *after* the last one.
 */
export function scheduleWindowShow(host: WindowShowHost): void {
  if (host.pageIsHidden()) {
    host.show();
    return;
  }
  let fired = false;
  // Assigned below, but `fire` closes over it — the budget must be armed
  // before the frames are requested, and cleared by whichever path wins.
  let timer: number | undefined = undefined;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    if (timer !== undefined) host.clearTimer(timer);
    host.show();
  };
  timer = host.setTimer(fire, WINDOW_SHOW_FRAME_BUDGET_MS);
  host.requestFrame(() => {
    host.requestFrame(fire);
  });
}

// Module-level, so React StrictMode's double-invoked mount effect asks once.
let asked = false;

/**
 * Put the window on screen, now that there is something worth looking at.
 *
 * Idempotent and a no-op outside Tauri (renderer-only Vite dev has no window to
 * show). A rejection is durable-logged rather than merely `console.error`d: the
 * shell's fallback timer hides this failure by fixing it a few seconds later,
 * so without a line in the log a launch that took four seconds to appear would
 * leave no trace of why.
 */
export function showAppWindow(): void {
  if (asked || !insideTauri()) return;
  asked = true;
  const win = getCurrentWindow();
  scheduleWindowShow({
    pageIsHidden: () => document.visibilityState === "hidden",
    requestFrame: (cb) => {
      requestAnimationFrame(cb);
    },
    setTimer: (cb, ms) => window.setTimeout(cb, ms),
    clearTimer: (handle) => {
      window.clearTimeout(handle);
    },
    show: () => {
      void win
        .show()
        .then(() => win.setFocus())
        .catch((err: unknown) => {
          console.error("[boot] window show failed:", err);
          logClientEvent(`[boot] window show failed: ${String(err)}`);
        });
    },
  });
}
