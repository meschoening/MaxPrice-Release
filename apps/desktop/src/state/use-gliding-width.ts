import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

// Measure an in-flow label's natural width and glide an explicit container width
// to it. CSS can't transition `width: auto`, so the consumer renders a `nowrap`
// label, hands its measured width back to the container, and animates that — the
// label's width is independent of the (animating) container width, so there's no
// feedback loop. `useLayoutEffect` measures before paint.
//
// The width GLIDES whenever the label changes — `transitionId` bumps on every
// change (a state crossfade or the refresh pill's 1Hz "Ns ago" tick) — paired
// with the label crossfade. Only the first measurement on mount snaps, before any
// transition has happened. Measuring + the `animate` flag are set together so the
// CSS transition is live at the moment the width changes.
//
// Re-measure triggers are the measured text (`current`) AND `transitionId`: the
// text changing is what resizes the label, and `transitionId` distinguishes a
// real state change (glide) from the first snap. The hook owns the ref it returns;
// attach it to the measured label.
export type GlidingWidth = {
  ref: RefObject<HTMLSpanElement | null>;
  width: number | null;
  animate: boolean;
};

export function useGlidingWidth(
  current: string,
  transitionId: number,
  slideMs: number,
): GlidingWidth {
  const ref = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [animate, setAnimate] = useState(false);
  const prevTransitionId = useRef(transitionId);

  useLayoutEffect(() => {
    if (!ref.current) return;
    const isTransition = transitionId !== prevTransitionId.current;
    prevTransitionId.current = transitionId;
    setAnimate(isTransition);
    setWidth(Math.ceil(ref.current.getBoundingClientRect().width));
  }, [current, transitionId]);

  // Clear the animate flag once a glide has finished; it is re-set on the next
  // change, so this just keeps the flag from lingering when the label goes idle.
  useEffect(() => {
    if (!animate) return;
    const t = setTimeout(() => setAnimate(false), slideMs);
    return () => clearTimeout(t);
  }, [animate, width, slideMs]);

  return { ref, width, animate };
}
