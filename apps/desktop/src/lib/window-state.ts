import { invoke } from "@tauri-apps/api/core";
import { insideTauri } from "@/lib/tauri";
import { logClientEvent } from "@/lib/client-log";

// The renderer's one hand on window-state persistence (map #151, T8).
//
// Persisting size / position / maximized is otherwise entirely a shell concern:
// `tauri-plugin-window-state` restores before the webview runs and saves on
// `CloseRequested` and `RunEvent::Exit`, so nothing here participates in the
// normal path — and `relaunch()` is normal, since plugin-process calls
// `app.request_restart()`, which goes through the event loop.
//
// The exception is the Windows update install, which ends the process with
// `std::process::exit(0)` and runs no hook at all (see `save_window_geometry`
// in src-tauri/src/lib.rs). Only the renderer knows that moment is coming.

/**
 * Flush the window's geometry to disk before an exit that will run no hook.
 *
 * Awaitable but never rejecting: a failed flush costs one session's geometry —
 * the previous save is still on disk — and must not stand between the user and
 * an update they have already agreed to. The failure is durable-logged instead,
 * because a Windows update install leaves no console behind to read.
 */
export async function saveWindowGeometry(): Promise<void> {
  if (!insideTauri()) return;
  try {
    await invoke("save_window_geometry");
  } catch (err: unknown) {
    logClientEvent(`[window-state] geometry save failed: ${String(err)}`);
  }
}
