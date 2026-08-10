import type { ConnectionState } from "@/state/use-live-status";

// THE STALE RULE, and the presentations it resolves to — shared by every
// surface that draws a mirror of sidecar-owned state (the sidebar foot's two
// connection lines and its saturation line; Settings' hub + claude.ai status
// lines). Those surfaces sit inches apart in the same window, so the rule and
// its copy live here rather than being re-derived per surface: a foot saying
// "state unknown" beside a Settings line asserting a green "Connected — hub is
// polling" is the exact drift this module exists to prevent.
//
// `stickyHubConnection` deliberately does NOT live here — it stays foot-only
// (see `foot-status.ts`). The sticky rule buys STEADINESS, which is what a
// permanent glance surface wants; on a transient action surface like Settings
// it would swallow feedback instead, holding the old reading so that pressing
// Save while the hub is down changes nothing on screen.

// Both `hubConnection` and `usageConnection` are mirrors of sidecar-owned
// state, refreshed only by `status:changed` frames — so once the SSE channel is
// gone they hold their last value indefinitely, and a green dot starts
// asserting something no one has confirmed for minutes. `disconnected` (the
// renderer's backoff has saturated: "genuinely gone") rather than
// `!== "connected"`, so a transient blip doesn't strobe the very dots the
// sticky rule just steadied.
export function isStale(connectionState: ConnectionState): boolean {
  return connectionState === "disconnected";
}

// The two stale presentations, frozen as shared constants so the foot and the
// Settings sections cannot drift in either the colour or the wording.
//
// `textClass` is unused by the sidebar foot (its lines take their text colour
// from the surrounding block); it is here for the Settings status lines, which
// colour their label per state and need the same soft treatment when stale.
export const STALE_HUB_LINE = {
  variant: "soft",
  textClass: "text-soft",
  title: "Sidecar offline — hub state unknown",
} as const;

export const STALE_USAGE_LINE = {
  variant: "soft",
  textClass: "text-soft",
  title: "Sidecar offline — claude.ai limits state unknown",
} as const;
