import type { BootProgress } from "@maxprice/shared";
import type { ScanProgress } from "./engine/store";

// The boot splash's progress channel (ADR-0067, amending ADR-0047).
//
// ADR-0047 publishes one bit — `ready` — and gates the splash on it. This
// module publishes what the boot is DOING until that bit flips. It sits between
// the engine store's raw per-file counters and `liveHub.patchStatus`, and owns
// exactly two things the store must not: how often a count is worth a status
// frame, and which local source the boot is on.
//
// The division of labour is the point. The store counts files because it is the
// only thing that can; it reports every single one, unthrottled, with no idea
// what a status frame costs. This module decides that ~4 frames a second is
// enough to look continuous (the renderer's 450ms width transition smooths the
// gaps — it does not invent progress) and that a 1,253-file corpus is not worth
// 1,253 SSE broadcasts. State is updated on EVERY callback and only the
// emission is throttled, so a forced flush always carries the true current
// numbers rather than the last ones that happened to make it out.

// The floor between two progress frames. Not a latency budget — the renderer
// never waits on one of these — just the rate above which extra frames buy
// nothing a human can see.
export const BOOT_PROGRESS_MIN_INTERVAL_MS = 250;

export type BootProgressReporter = {
  // The boot status literal's seed. Must be on the FIRST frame any renderer
  // sees (`EmittedStatusSnapshot` enforces it): a renderer that connects before
  // the first throttled frame would otherwise fall through to the no-progress
  // degrade, on precisely the slow launches this exists for.
  readonly initial: BootProgress;
  // Every file the scan settles (see `EventStore.scan`'s `onProgress`).
  onScanProgress: (p: ScanProgress) => void;
  // The corpus walk is over. Announces the `merging` phase — and only when
  // there is a replica to merge, so a hub-less client never gets a frame whose
  // sole content is "the thing you don't have is next".
  scanFinished: () => void;
  // The terminal snapshot. Deliberately does NOT patch: `ready: true` lands in
  // the same instant (wireReadySignal), and one patch carrying both keeps the
  // two facts from arriving in separate frames — a renderer must never see
  // `ready` beside a `bootProgress` still claiming work in flight.
  finish: () => BootProgress;
};

export function createBootProgressReporter(opts: {
  patch: (patch: { bootProgress: BootProgress }) => void;
  // Whether this client will load a fleet replica at boot (ADR-0041's
  // `replicaWanted`). Known from settings before the scan starts, so the
  // renderer's step list is complete from frame one.
  mergesFleet: boolean;
  now?: () => number;
  minIntervalMs?: number;
}): BootProgressReporter {
  const now = opts.now ?? Date.now;
  const minIntervalMs = opts.minIntervalMs ?? BOOT_PROGRESS_MIN_INTERVAL_MS;

  const state: BootProgress = {
    phase: "scanning",
    filesParsed: 0,
    filesTotal: 0,
    mergesFleet: opts.mergesFleet,
  };

  // `-Infinity` rather than the construction time: the first real frame — the
  // one carrying the denominator — is the most informative of the whole boot
  // and must never be swallowed by a throttle window that started before it.
  let lastEmitAt = -Infinity;

  // A copy per patch. `state` is mutated in place, and `patchStatus` merges the
  // object by reference into the live status — handing out the mutable one
  // would let a later count silently rewrite a frame already broadcast.
  const emit = (): void => {
    lastEmitAt = now();
    opts.patch({ bootProgress: { ...state } });
  };

  return {
    initial: { ...state },
    onScanProgress: (p) => {
      state.filesParsed = p.filesParsed;
      state.filesTotal = p.filesTotal;
      if (now() - lastEmitAt < minIntervalMs) return;
      emit();
    },
    scanFinished: () => {
      if (!state.mergesFleet) return;
      state.phase = "merging";
      emit();
    },
    finish: () => {
      state.phase = "done";
      lastEmitAt = now();
      return { ...state };
    },
  };
}
