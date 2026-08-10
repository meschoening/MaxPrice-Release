import { invoke } from "@tauri-apps/api/core";
import { insideTauri } from "@/lib/tauri";

// The renderer's feeder into the durable shell log (ADR-0059, issue #115).
//
// ADR-0056 made the sidecar's own output durable — the Tauri shells tee the
// stdout pipe into <app-data>/logs/sidecar.log — because a packaged Windows GUI
// build has no console. The renderer sits outside that pipe entirely: its
// `console.error` goes to the WebView console, which in the configuration users
// actually run is a surface nobody can see. So a renderer-side failure has left
// no trace anywhere, which is precisely how issue #115's failing refresh was
// reported as "it says refresh failed" with nothing to go on.
//
// Deliberately NOT `POST /api/<something>` on the sidecar. The failure with no
// trace today is the rescan TIMEOUT — i.e. "the sidecar did not answer" — so
// using the sidecar as the recording channel would fail in exactly the case
// that needs recording. The Tauri command's path (renderer → shell → file)
// stays up when the sidecar is wedged, unreachable, or dead.
//
// Generic on purpose: this is the channel, not one gesture's logging. The next
// invisible-in-a-packaged-build renderer failure should have somewhere to go
// without re-litigating the transport.

/**
 * Append one line to the durable log, prefixed `[renderer]` by the shell.
 *
 * Fire-and-forget and infallible from the caller's point of view: outside Tauri
 * (renderer-only Vite dev) it falls back to `console.warn`, and an `invoke`
 * rejection is swallowed. ADR-0056's rule — the log must never disturb what it
 * observes — applies in this direction too: a failure report must not itself
 * become a failure inside the gesture that is already failing.
 */
export function logClientEvent(line: string): void {
  if (!insideTauri()) {
    console.warn(`[renderer] ${line}`);
    return;
  }
  void invoke("log_client_event", { line }).catch(() => {
    // Nothing useful to do — the durable channel is the fallback for the
    // console, so there is no further fallback to escalate to.
  });
}
