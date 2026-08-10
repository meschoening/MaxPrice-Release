import type { ConnectionState } from "@/state/use-live-status";

export type RefreshTone = "live" | "idle" | "warn";

// A semantic discriminant for the label, coarser than its text. The refresh pill
// crossfades between *states*, not on every text change — so all the "Ns ago"
// counter ticks share one state (`live-ago`) and don't fade against each other,
// while "just now" is its own state, so "just now" → the first "Ns ago" does
// crossfade. Drives the pill's `fadeKey`.
export type RefreshState = "offline" | "reconnecting" | "idle" | "live-now" | "live-ago";
export type RefreshLabel = { text: string; tone: RefreshTone; state: RefreshState };

// The topbar refresh pill is an event-driven pulse, not a fixed-interval
// countdown (a Part 3 change from the original mock). This derives its label,
// tone, and state from connection health + the time since the last usage event.
export function formatRefreshLabel(
  connectionState: ConnectionState,
  lastEventAt: number | null,
  now: number,
): RefreshLabel {
  // A connection problem outranks event recency — the user needs to know the
  // pipeline is down even if an event landed moments before it dropped.
  if (connectionState === "disconnected")
    return { text: "offline", tone: "warn", state: "offline" };
  if (connectionState === "reconnecting")
    return { text: "reconnecting…", tone: "warn", state: "reconnecting" };

  if (lastEventAt === null) return { text: "idle", tone: "idle", state: "idle" };

  const age = now - lastEventAt;
  if (age >= 60_000) return { text: "idle", tone: "idle", state: "idle" };
  if (age < 3_000) return { text: "live · just now", tone: "live", state: "live-now" };
  return { text: `live · ${Math.floor(age / 1000)}s ago`, tone: "live", state: "live-ago" };
}
