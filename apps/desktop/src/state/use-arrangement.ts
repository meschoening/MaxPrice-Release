import { useSyncExternalStore } from "react";
import { arrangementFor, type Arrangement } from "@/lib/arrangement";

/* The arrangement, published into React (map #151 / T13 #164, ADR-0073).

   ONE ResizeObserver for the whole app — the app's second, after the chart's —
   held at module scope rather than per component, because three list pages and
   the session timeline all ask the same question and four observers on one
   element would answer it four times per resize frame.

   The state is the derived ARRANGEMENT, never the measured width: the pages
   re-render only when the band changes, so dragging a window across 900px of
   medium sets no state and renders nothing. (The same shape the chart's
   observer settled on for its view width — see ADR-0073's T12 note.)

   The observed element is `.app-content`, which is the `content` query
   container itself, so JS and CSS measure the same box. It is deliberately not
   `<main>`: `.thin-scroll` is a layout-consuming scrollbar on Chromium/WebView2
   and an overlay one on WKWebView, so a container there measures ~10px narrower
   on Windows only and can oscillate across a boundary as the scrollbar comes
   and goes. */

let observer: ResizeObserver | null = null;
let pendingRaf: number | null = null;
let snapshot: Arrangement = "medium";
const listeners = new Set<() => void>();

function publish(width: number): void {
  const next = arrangementFor(width);
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function attach(): void {
  if (observer !== null || typeof ResizeObserver === "undefined") return;
  const el = document.querySelector(".app-content");
  // The frame mounts above every consumer, so this resolves on the first try in
  // the app; the retry is for a page rendered outside the frame (a test host, a
  // future standalone route) where giving up would freeze every consumer on
  // `medium` for the session. `pendingRaf` keeps that ONE retry loop: `attach`
  // runs per subscriber, so in the case the retry exists for — several
  // consumers waiting on a missing element — an unguarded schedule would give
  // each of them its own frame-by-frame loop, each re-scheduling every frame.
  if (el === null) {
    if (pendingRaf !== null) return;
    pendingRaf = requestAnimationFrame(() => {
      pendingRaf = null;
      if (listeners.size > 0) attach();
    });
    return;
  }
  observer = new ResizeObserver(([entry]) => {
    if (entry) publish(entry.contentRect.width);
  });
  observer.observe(el);
  // Then measure once, synchronously, instead of waiting for the observer's own
  // first callback: the snapshot is cleared on teardown (below) and
  // `useSyncExternalStore` re-reads it as soon as this returns, so a frame-late
  // first measurement would fail that check on every navigation between list
  // pages and re-render each of them at `medium` and back. The two halves only
  // work together. One forced layout read per attach — one per app run in
  // practice — is what it costs; the element carries no padding or border, so
  // this border box is the content box the observer reports.
  publish(el.getBoundingClientRect().width);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  attach();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
      // Cancelled rather than left to no-op on the `listeners.size` guard
      // above: it costs one call and keeps `pendingRaf !== null` meaning
      // exactly "a retry is still coming".
      if (pendingRaf !== null) {
        cancelAnimationFrame(pendingRaf);
        pendingRaf = null;
      }
      // The value dies with the measurement that produced it: nothing observes
      // the element from here until the next `attach`, so a snapshot kept
      // across the gap would be asserted as truth about a window that may have
      // been resized in it. Safe only because `attach` re-measures
      // synchronously — on its own this would re-render every navigation.
      snapshot = "medium";
    }
  };
}

// Before the first measurement lands — and again in the gap after the last
// listener leaves — the answer is `medium`, the arrangement that writes no
// rules, so an unmeasured frame can only ever under-decorate, never draw a wide
// bar into a narrow window. In the app neither is observable: `attach` measures
// synchronously as it subscribes, and the observer's later callbacks run after
// layout and before paint.
function getSnapshot(): Arrangement {
  return snapshot;
}

export function useArrangement(): Arrangement {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
