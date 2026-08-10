import type { UsageConnection } from "./usage-limits";

// Single source of truth for the usage-limits connection indicator's color +
// label (ADR-0023). Two consumers — the StatusBar dot and the Settings →
// Claude account status line — used to carry divergent maps: `expired` was
// amber in one, red in the other. The canonical `expired` color is `bg-warn`
// (amber): it signals "re-auth needed", not "broken".
//
// LOAD-BEARING CLASS NAMES: usageConnectionDot emits the literal Tailwind
// classes `bg-good` / `bg-warn` / `bg-bad`. Those resolve only because each
// consuming app's theme defines identically-named `--color-good` /
// `--color-warn` / `--color-bad` tokens — in apps/desktop/src/styles/globals.css
// AND apps/hub-desktop/src/styles/globals.css. Renaming those tokens in either
// theme silently breaks this module's output; keep the names in sync.

// Dot color class for a usage-connection state. `disconnected` returns null —
// there is no canonical color for the unconfigured state because the two
// consumers legitimately differ: the StatusBar HIDES the indicator, while the
// Settings section shows a `bg-soft` "Not connected" dot. The consumer decides
// how to present `null`; only the contested connected/expired/error colors are
// centralized here.
export function usageConnectionDot(conn: UsageConnection): string | null {
  switch (conn) {
    case "connected":
      return "bg-good";
    case "expired":
      return "bg-warn";
    case "error":
      return "bg-bad";
    case "disconnected":
      return null;
  }
}

// Human-readable label for a usage-connection state — one label per state,
// reconciling the StatusBar's inline tooltip strings and the Settings section's
// former `connectionLabel`.
export function usageConnectionLabel(conn: UsageConnection): string {
  switch (conn) {
    case "connected":
      return "Connected";
    case "expired":
      return "Session expired";
    case "error":
      return "Connection error";
    case "disconnected":
      return "Not connected";
  }
}

// Text-emphasis class for the Settings status line's label — one class per
// state, centralizing what was a bare-else ternary in UsageConnectionSection.
// The non-null return type makes a missing arm a compile error, keeping this
// exhaustive alongside the dot/label maps above.
//
// DELIBERATE DIVERGENCE (for now): `expired` renders red `text-bad` here even
// though its dot is amber `bg-warn` ("re-auth needed, not broken"). This
// pre-existing text/dot mismatch is preserved intentionally — do not reconcile
// it to `text-warn` without a decision to change the rendered UI.
export function usageConnectionTextClass(conn: UsageConnection): string {
  switch (conn) {
    case "connected":
      return "text-text";
    case "expired":
      return "text-bad";
    case "error":
      return "text-bad";
    case "disconnected":
      return "text-soft";
  }
}
