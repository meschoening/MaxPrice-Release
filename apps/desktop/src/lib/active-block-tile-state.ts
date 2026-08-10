import { BLOCK_WINDOW_MS, type BlockRow, type UsageWindow } from "@maxprice/shared";
import { blockState, type BlockState } from "@/lib/active-block";
import { usageRingState } from "@/lib/usage-ring";

type ActiveState = Extract<BlockState, { kind: "active" }>;

export type ActiveBlockTileState =
  | { kind: "empty-inset" }
  | {
      kind: "tile";
      active: ActiveState | null;
      accountWindow: { startMs: number; endMs: number } | null;
      ringFrac: number;
      ringCenterLabel: string | null;
      // The tile's "5-hour limit used" meter — the account-level reading, so it
      // follows the live sample rather than the block: null whenever there is
      // no usable one (disconnected, absent, or a reset already elapsed). Not
      // the Blocks column, which is a real-window property (ADR-0030).
      limitPct: number | null;
    };

const RING_CIRCUMFERENCE = 2 * Math.PI * 40;

// A zero-length dash with a round linecap still paints a dot. Returning null
// lets the SVG omit the fill circle so an idle ring is visually empty.
export function ringStrokeDasharray(fraction: number): string | null {
  if (!Number.isFinite(fraction) || fraction <= 0) return null;
  const clamped = Math.min(1, fraction);
  return `${(clamped * RING_CIRCUMFERENCE).toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`;
}

// Join the local event-derived block and the account-level usage sample at one
// explicit view seam. A FUTURE account reset is independently useful while a
// newly-started window is still rounded to 0% and has no event-derived block.
// An expired sample is rejected by usageRingState, so the same fallback cannot
// survive a reset and make an idle account look active.
export function activeBlockTileState(
  block: BlockRow | null,
  usageWindow: UsageWindow | null,
  connected: boolean,
  now: number,
): ActiveBlockTileState {
  const state = blockState(block, now);
  const active = state.kind === "active" ? state : null;

  if (active === null && !connected) return { kind: "empty-inset" };

  const ring = usageRingState(connected ? usageWindow : null, now);
  // Same gate as the ring's own live branch: a connected reading whose reset is
  // still ahead. The meter and the ring center therefore appear and disappear
  // together, and a sample that outlived its window drives neither.
  const limitPct =
    ring.kind === "limit" && usageWindow !== null ? Math.round(usageWindow.utilizationPct) : null;

  if (active !== null) {
    return {
      kind: "tile",
      active,
      accountWindow: null,
      ringFrac: active.elapsedFrac,
      ringCenterLabel: active.remainingLabel,
      limitPct,
    };
  }

  if (ring.kind === "limit" && usageWindow !== null) {
    const endMs = Date.parse(usageWindow.resetAt);
    const startMs = endMs - BLOCK_WINDOW_MS;
    const elapsedFrac = Math.max(0, Math.min(1, (now - startMs) / BLOCK_WINDOW_MS));
    return {
      kind: "tile",
      active: null,
      accountWindow: { startMs, endMs },
      ringFrac: elapsedFrac,
      ringCenterLabel: ring.centerLabel,
      limitPct,
    };
  }

  return {
    kind: "tile",
    active: null,
    accountWindow: null,
    ringFrac: 0,
    ringCenterLabel: null,
    limitPct,
  };
}
