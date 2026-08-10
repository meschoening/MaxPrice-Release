import { useEffect, useState } from "react";

// Crossfade a label between *semantic* states: when `transitionKey` changes the
// outgoing text fades out while the incoming text fades in over the same window
// — a true crossfade, the two overlap and the label never blanks between
// states. When only `text` changes under the same key — e.g. the refresh pill's
// 1Hz "Ns ago" tick, which keeps the same "live" key — it updates in place with
// no fade, so the label doesn't flicker every second.
//
// Returns the in-flow `current` text (which the caller also measures for width),
// a `previous` overlay present only mid-transition, and a `transitionId` that
// bumps on each change so the caller can key the two layers to (re)play their
// fade-in / fade-out CSS animations.
export type CrossfadeLabel = {
  current: string;
  previous: string | null;
  transitionId: number;
};

// The animation state the pure decision below operates on: the last semantic key,
// the in-flow text, the fading-out overlay, and the transition counter.
export type CrossfadeState = {
  key: string;
  current: string;
  previous: string | null;
  transitionId: number;
};

export type CrossfadeInput = { key: string; text: string };

export type CrossfadeDecision = CrossfadeState & { startTeardown: boolean };

// The central pill-animation decision, pulled out as a pure reducer so it can be
// unit-tested without a React harness (this repo has none — see
// lib/refresh-format.ts + its test for the pattern). Same key ⇒ the text updates
// in place (a 1Hz tick), `previous` is left untouched and no teardown is
// scheduled. Key change ⇒ the outgoing text becomes the fading-out `previous`,
// `transitionId` bumps so the caller replays the fade animations, and
// `startTeardown` signals the overlay must be cleared once the fade ends.
export function nextCrossfade(state: CrossfadeState, input: CrossfadeInput): CrossfadeDecision {
  if (input.key === state.key) {
    return { ...state, current: input.text, startTeardown: false };
  }
  return {
    key: input.key,
    current: input.text,
    previous: state.current,
    transitionId: state.transitionId + 1,
    startTeardown: true,
  };
}

export function useCrossfadeText(
  text: string,
  transitionKey: string,
  fadeMs = 130,
): CrossfadeLabel {
  const [state, setState] = useState<CrossfadeState>(() => ({
    key: transitionKey,
    current: text,
    previous: null,
    transitionId: 0,
  }));

  // Apply the pure decision on each text/key change. The updater form reads the
  // latest state, so this effect needn't depend on `state` — crucially a tick
  // (text changes, key stable) doesn't re-run the teardown effect below, so it
  // can't cancel a pending overlay teardown mid-fade.
  useEffect(() => {
    setState((prev) => {
      const next = nextCrossfade(prev, { key: transitionKey, text });
      // Skip a redundant render when nothing visible changed (e.g. on mount).
      if (
        next.key === prev.key &&
        next.current === prev.current &&
        next.previous === prev.previous &&
        next.transitionId === prev.transitionId
      ) {
        return prev;
      }
      return {
        key: next.key,
        current: next.current,
        previous: next.previous,
        transitionId: next.transitionId,
      };
    });
  }, [text, transitionKey]);

  // Tear the fading-out overlay down after the fade. `transitionId` bumps exactly
  // when the decision sets `startTeardown` (a key change), so keying the timer on
  // it schedules the teardown precisely then — and a same-key tick, which leaves
  // `transitionId` untouched, never disturbs an in-flight fade.
  useEffect(() => {
    if (state.previous === null) return;
    const t = setTimeout(() => {
      setState((prev) => (prev.previous === null ? prev : { ...prev, previous: null }));
    }, fadeMs);
    return () => clearTimeout(t);
  }, [state.transitionId, state.previous, fadeMs]);

  return { current: state.current, previous: state.previous, transitionId: state.transitionId };
}
