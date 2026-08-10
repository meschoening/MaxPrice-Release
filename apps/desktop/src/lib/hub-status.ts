import type { HubConnection } from "@maxprice/shared";

// Dot + label for the hub connection state (ADR-0035), the usage-status.ts
// pattern. `off` returns null — there is no canonical color for the
// unconfigured state; the Settings section shows its own "Not configured"
// treatment, the consumer decides how to present `null`.
export function hubConnectionDot(conn: HubConnection): string | null {
  switch (conn) {
    case "connected":
      return "bg-good";
    case "connecting":
      return "bg-soft";
    case "fallback":
      return "bg-warn";
    case "keyless":
      return "bg-warn";
    case "mismatch":
      return "bg-bad";
    case "unauthorized":
      return "bg-bad";
    case "off":
      return null;
  }
}

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
      return "Hub version mismatch — polling locally";
    case "unauthorized":
      return "Hub password rejected — polling locally";
    case "off":
      return "Not configured";
  }
}

// Text-emphasis class for the Settings status line's label — one class per
// state, centralizing what was a bare-else ternary in HubSection. The non-null
// return type makes a missing arm a compile error, keeping this exhaustive
// alongside the dot/label maps above.
export function hubConnectionTextClass(conn: HubConnection): string {
  switch (conn) {
    case "connected":
      return "text-text";
    case "connecting":
      return "text-soft";
    case "fallback":
      return "text-warn";
    case "keyless":
      return "text-warn";
    case "mismatch":
      return "text-bad";
    case "unauthorized":
      return "text-bad";
    case "off":
      return "text-soft";
  }
}
