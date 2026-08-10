import { useEffect, useSyncExternalStore } from "react";

// The boot first-paint latch (ADR-0066) — the second stage of the boot gate.
// ADR-0047's `ready` says the engine finished its scan; it says nothing about
// any report being fetched or drawn, so `BootGate` mounts the frame on `ready`
// and reveals it only once the landing page reports itself DRAWN. This module
// is how the page says so.
//
// Deliberately framework-free (a subscribe/snapshot store behind
// `useSyncExternalStore`, built by a factory): this repo has no component-test
// rig, so the only way to pin the two bug shapes a screenshot cannot see — a
// publisher registering after the first frame, and the empty-corpus branch's
// explicit publish — is to make the store itself unit-testable without React.
//
// Live has TWO publishers, not one, and that is load-bearing. The tiles/rails
// half is `useLiveData().isPending`; the chart half lives behind
// `useChartSource`, which is deliberately scoped AWAY from those five queries
// (ADR-0033 review f1). On the four intraday spans the chart reads
// `/api/intraday` — a sixth query `useLiveData().isPending` never observes — so
// a one-publisher version looks right, passes a 7d/30d smoke, and still reveals
// mid-load on most boots.

export type BootPaintLatch = {
  subscribe(onChange: () => void): () => void;
  snapshot(): boolean;
  // Register (or update) one publisher. Registering a NEW publisher as unsettled
  // un-settles the latch — a page that mounts a second data surface late must be
  // able to pull the gate back, which is why the snapshot is recomputed from the
  // whole map rather than latched forward.
  publish(id: string, settled: boolean): void;
  release(id: string): void;
};

export function createBootPaintLatch(): BootPaintLatch {
  const publishers = new Map<string, boolean>();
  const listeners = new Set<() => void>();
  // Cached so `snapshot` is a cheap, stable read (useSyncExternalStore calls it
  // on every render) and so listeners fire only on a real transition.
  let settled = false;

  // `publishers.size > 0` is required, NOT an empty-map shortcut: publishers
  // register in effects, so the gate's very first read happens with the map
  // empty. Treating "nobody registered" as "everything ready" would reveal on
  // frame one — the exact race this latch exists to lose.
  const recompute = (): void => {
    let next = publishers.size > 0;
    for (const v of publishers.values()) if (!v) next = false;
    if (next === settled) return;
    settled = next;
    for (const fn of listeners) fn();
  };

  return {
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    snapshot: () => settled,
    publish(id, value) {
      if (publishers.get(id) === value) return;
      publishers.set(id, value);
      recompute();
    },
    release(id) {
      if (!publishers.delete(id)) return;
      recompute();
    },
  };
}

// The one process-wide latch. A boot happens once per launch, so there is
// nothing to scope it to and nothing to reset.
export const bootPaintLatch = createBootPaintLatch();

// Publish one surface's settled-ness for the whole time it is mounted.
// Publishing from an effect (not render) is deliberate: the effect runs after
// the commit that drew the data, so "settled" can never be claimed for a frame
// that has not been laid out.
export function useBootPaintPublisher(id: string, settled: boolean): void {
  useEffect(() => {
    bootPaintLatch.publish(id, settled);
  }, [id, settled]);
  useEffect(() => () => bootPaintLatch.release(id), [id]);
}

// The gate's read. Stays subscribed after the reveal — the reveal is sticky, so
// later publish/release churn (navigating off Live) is read but ignored.
export function useBootPaintSettled(): boolean {
  return useSyncExternalStore(bootPaintLatch.subscribe, bootPaintLatch.snapshot);
}
