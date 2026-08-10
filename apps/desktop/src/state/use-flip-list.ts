import { useCallback, useLayoutEffect, useRef } from "react";

// FLIP glide (INTERACTIONS.md): rail rows overtaking each other slide to
// their new slot — 350ms on the glass curve, reused (keyed) nodes only.
// Before paint, compare each keyed element's offsetTop to its previous one
// and play the inverted delta via WAAPI. WAAPI ignores the global CSS
// animation kill, so reduced motion is guarded here explicitly.
export function useFlipList(dep: unknown): (key: string) => (el: HTMLElement | null) => void {
  const nodes = useRef(new Map<string, HTMLElement>());
  const prevTops = useRef(new Map<string, number>());
  const refFns = useRef(new Map<string, (el: HTMLElement | null) => void>());

  useLayoutEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const tops = new Map<string, number>();
    for (const [key, el] of nodes.current) {
      if (!el.isConnected) {
        nodes.current.delete(key);
        continue;
      }
      tops.set(key, el.offsetTop);
    }
    // Keep the ref-callback cache bounded: drop closures for keys the node
    // map no longer tracks. Pruned here (not from the ref callback itself) so
    // StrictMode's node→null→node cycle can't thrash the identity cache.
    for (const key of refFns.current.keys()) {
      if (!nodes.current.has(key)) refFns.current.delete(key);
    }
    if (!reduced) {
      for (const [key, el] of nodes.current) {
        const prev = prevTops.current.get(key);
        const next = tops.get(key);
        if (prev === undefined || next === undefined) continue;
        const delta = prev - next;
        if (Math.abs(delta) < 1) continue;
        el.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], {
          duration: 350,
          easing: "cubic-bezier(0.22, 0.8, 0.36, 1)",
        });
      }
    }
    prevTops.current = tops;
  }, [dep]);

  // Stable per-key ref callbacks so React doesn't detach/reattach on every
  // render (a fresh function identity per render would).
  return useCallback((key: string) => {
    let fn = refFns.current.get(key);
    if (!fn) {
      fn = (el: HTMLElement | null) => {
        if (el) nodes.current.set(key, el);
        else nodes.current.delete(key);
      };
      refFns.current.set(key, fn);
    }
    return fn;
  }, []);
}
