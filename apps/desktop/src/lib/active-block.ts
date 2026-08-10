import { formatWallClock, type BlockRow, type TimeDisplay } from "@maxprice/shared";

// Pure derivation for the Active block tile (apps/desktop/src/components/
// active-block-tile.tsx) — extracted from the component so the timestamp/NaN
// guards and the countdown math are unit-testable without rendering.

// Blocks are ~5-hour quota windows. A non-positive or implausibly large
// totalMs means a malformed timestamp pair reached us — the remaining
// label degrades to an em-dash rather than an unbounded multi-digit h:mm.
export const BLOCK_MAX_MS = 6 * 60 * 60 * 1000;

// Pure view-state for the tile, derived from the block plus the current time.
// `empty` covers no block, a gap, an elapsed window, and — crucially —
// malformed timestamps, so the render path never feeds NaN into the ring.
export type BlockState =
  | { kind: "empty" }
  | {
      kind: "active";
      block: BlockRow;
      startMs: number;
      endMs: number;
      elapsedFrac: number;
      remainingLabel: string;
    };

export function blockState(block: BlockRow | null, now: number): BlockState {
  if (block === null || block.isGap) return { kind: "empty" };

  const startMs = new Date(block.startTime).getTime();
  const endMs = new Date(block.endTime).getTime();
  // A malformed timestamp (getTime() → NaN) must not slip through: `now >= NaN`
  // is false, so without this guard the block would read as live and propagate
  // NaN into the ring's strokeDasharray, silently rendering no arc.
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return { kind: "empty" };
  // A block whose 5-hour window has elapsed is no longer active — drop to the
  // empty state at once rather than waiting for the next blocks refetch.
  if (now >= endMs) return { kind: "empty" };

  const totalMs = endMs - startMs;
  const elapsedMs = Math.max(0, Math.min(totalMs, now - startMs));
  const elapsedFrac = totalMs <= 0 ? 0 : elapsedMs / totalMs;
  const remainingMs = Math.max(0, totalMs - elapsedMs);
  const remainingLabel =
    totalMs > 0 && totalMs <= BLOCK_MAX_MS ? formatRemaining(remainingMs) : "—";
  return { kind: "active", block, startMs, endMs, elapsedFrac, remainingLabel };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// startMs / endMs are validated non-NaN by blockState before this is reached.
// `display` (ADR-0060) carries the Settings timezone — so the shown range
// matches the day the engine bucketed into — and the 24h/AM-PM shape:
// "09:05 – 14:30" or "9:05 AM – 2:30 PM".
export function formatRange(startMs: number, endMs: number, display: TimeDisplay): string {
  return `${formatWallClock(startMs, display)} – ${formatWallClock(endMs, display)}`;
}

export function formatRemaining(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${pad(m)}`;
}

// Like formatRemaining but for windows that can span days (the weekly usage
// limit) — "3d 4h" / "5h" / "23m". Minute precision is dropped above an hour
// because a multi-day countdown doesn't need it.
export function formatRemainingLong(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

export function abbreviate(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return value.toFixed(0);
}
