import type { HubConnection } from "./hub";

// The Hub connection's label (ADR-0035): one line per `hubConnection` state,
// shared by the Desktop client's sidebar foot and Settings › Usage hub and by
// the Headless client's `maxprice status` (ADR-0118 §7's presentation tier,
// moved here by #463). The dot and text-emphasis maps stay in the Desktop
// client's `lib/hub-status.ts`: they are Tailwind classes, and only its
// renderer draws them.

// Human-readable label for a hub connection state — one label per state.
export function hubConnectionLabel(conn: HubConnection): string {
  switch (conn) {
    case "connected":
      return "Connected — hub is polling";
    case "connecting":
      return "Connecting…";
    case "fallback":
      return "Hub unreachable — polling locally";
    case "keyless":
      return "Hub has no working Claude key — polling locally";
    case "mismatch":
      return "Hub version mismatch — update both apps; polling locally";
    case "unauthorized":
      return "Hub password rejected — polling locally";
    case "off":
      return "Not configured";
  }
}
