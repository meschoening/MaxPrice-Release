import { invoke } from "@tauri-apps/api/core";
import { insideTauri } from "@/lib/tauri";

// The operator window's feeder into the durable shell log — the hub's copy of
// the client's `lib/client-log.ts` (ADR-0059), carried over for the same reason
// and with the same discipline.
//
// ADR-0056 made the DAEMON's output durable: the shell tees the sidecar's
// stdout/stderr into <app-data>/logs/hub.log, because a packaged Windows GUI
// build has no console. The operator webview sits outside that pipe entirely —
// its `console.warn` lands in the WebView console, which on the tray app is a
// surface nobody running it can see. So a renderer-side failure has had nowhere
// to go.
//
// The Updates card (map #143) is what needed the channel: a launch update probe
// that fails is deliberately swallowed rather than shown — the hub autostarts at
// login, so the probe routinely races the network coming up, and surfacing that
// in a console nobody opens for three days is a false alarm about a condition
// that resolved in ninety seconds. The card's own error copy tells the operator
// the reason is in hub.log; without this channel that sentence would be false.
//
// Generic on purpose, like the client's: this is the channel, not one gesture's
// logging.

/**
 * Append one line to hub.log, prefixed `[renderer]` by the shell.
 *
 * Fire-and-forget and infallible from the caller's point of view: outside Tauri
 * (renderer-only Vite dev) it falls back to `console.warn`, and an `invoke`
 * rejection is swallowed. ADR-0056's rule — the log must never disturb what it
 * observes — applies in this direction too: a failure report must not itself
 * become a failure inside the gesture that is already failing.
 */
export function logHubEvent(line: string): void {
  if (!insideTauri()) {
    console.warn(`[renderer] ${line}`);
    return;
  }
  void invoke("log_hub_event", { line }).catch(() => {
    // Nothing useful to do — the durable channel is the fallback for the
    // console, so there is no further fallback to escalate to.
  });
}
