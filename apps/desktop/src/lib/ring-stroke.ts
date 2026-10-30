// The ring's SVG stroke, for the r=40 circle the Active block tile and the
// popout both draw. Renderer-only: the ring's fraction is the shared tile state
// (packages/shared/src/active-block-tile-state.ts); only the SVG needs a dash.
const RING_CIRCUMFERENCE = 2 * Math.PI * 40;

// A zero-length dash with a round linecap still paints a dot. Returning null
// lets the SVG omit the fill circle so an idle ring is visually empty.
export function ringStrokeDasharray(fraction: number): string | null {
  if (!Number.isFinite(fraction) || fraction <= 0) return null;
  const clamped = Math.min(1, fraction);
  return `${(clamped * RING_CIRCUMFERENCE).toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`;
}
