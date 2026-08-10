import { RotateCw } from "lucide-react";
import { formatRefreshLabel, type RefreshTone } from "@/lib/refresh-format";
import { cn } from "@/lib/utils";
import { useCrossfadeText } from "@/state/use-crossfade-text";
import { useGlidingWidth } from "@/state/use-gliding-width";
import { useLiveStatus } from "@/state/use-live-status";
import { manualRefreshDisplay, useManualRefresh } from "@/state/use-manual-refresh";
import { useNowTick } from "@/state/use-now-tick";

// Each label state crossfades into the next — the outgoing and incoming labels
// overlap, fading out and in over the same window.
const LABEL_FADE_MS = 130;
// The pill resizes as the label length changes; auto width can't be transitioned
// in CSS, so we measure the label and glide an explicit width to it, paired with
// the label crossfade — on every change, the 1Hz "Ns ago" tick included. Only the
// first measurement (mount) snaps, before any transition has happened.
const WIDTH_SLIDE_MS = 200;

// Glass chip tones: live/idle wear the default chip; warn tints via .chip.warn.
const PILL_TONE: Record<RefreshTone, string> = {
  live: "",
  idle: "",
  warn: "warn",
};

const DOT_TONE: Record<RefreshTone, string> = {
  live: "live",
  idle: "idle",
  warn: "warn",
};

// Topbar refresh pill — a status indicator that doubles as the manual refresh
// control. Two overlaid concerns:
//   - Live status (Part 3): the dot's tone + a one-shot pulse ring that replays
//     on each SSE usage event, and the "live · Ns ago" → "idle" label.
//   - Manual rescan (ADR-0019): clicking the pill (or pressing ⇧R) POSTs a full
//     disk re-scan; while it runs the pill shows a pulsing neutral dot +
//     "refreshing…", then a brief "refreshed · +N" / "up to date" confirm,
//     overriding the live label for that transient window.
// Visual grammar: pulsing neutral dot = your command is running; the green pulse
// ring = a data event landed (organic, or the manual confirm flash).
export function RefreshPill() {
  const connectionState = useLiveStatus((s) => s.connectionState);
  const lastEventAt = useLiveStatus((s) => s.lastEventAt);
  const phase = useManualRefresh((s) => s.phase);
  const added = useManualRefresh((s) => s.added);
  const failure = useManualRefresh((s) => s.failure);
  const trigger = useManualRefresh((s) => s.trigger);
  // 1Hz re-render so the "Ns ago" label stays current; the ring's fill/decay is
  // a one-shot CSS animation, so it needs no JS tick.
  const now = useNowTick(1000);

  // While a manual refresh is in its transient window it owns the label/tone;
  // otherwise the pill shows the lastEventAt-driven live status.
  const manual = manualRefreshDisplay(phase, added, failure);
  const organic = formatRefreshLabel(connectionState, lastEventAt, now);
  const { text, tone } = manual ?? organic;

  // Crossfade between *states*, not on every text change: manual phases key off
  // the phase, and the live status keys off its semantic state — so all the
  // "Ns ago" counter ticks share one key and update in place (no fade), while
  // "just now" → the first "Ns ago" and every real state change crossfade.
  const fadeKey = manual ? `manual:${phase}` : organic.state;
  const { current, previous, transitionId } = useCrossfadeText(text, fadeKey, LABEL_FADE_MS);

  // Measure the in-flow label's natural width and glide the container width to it,
  // paired with the crossfade (every label change bumps transitionId). The hook
  // owns the ref attached to the measured label below.
  const {
    ref: labelRef,
    width: labelWidth,
    animate: animateWidth,
  } = useGlidingWidth(current, transitionId, WIDTH_SLIDE_MS);

  // The confirm pulse plays for an organic live event (keyed on lastEventAt so a
  // new event replays it) and once when a manual refresh lands on "done".
  const organicPulse = manual === null && tone === "live" && lastEventAt !== null;
  const confirmPulse = phase === "done";

  return (
    <button
      type="button"
      onClick={trigger}
      title="Refresh now (⇧R)"
      aria-label="Refresh data now"
      className={cn("chip", PILL_TONE[tone])}
    >
      <RotateCw aria-hidden />
      <span
        className="relative inline-flex justify-start overflow-hidden ease-out"
        style={{
          width: labelWidth === null ? undefined : labelWidth,
          transitionProperty: "width",
          transitionDuration: animateWidth ? `${WIDTH_SLIDE_MS}ms` : "0ms",
        }}
      >
        {/* In-flow current label, fading in (keyed so the animation replays on
            each transition; on a same-key tick the key is stable so the text
            just updates in place). Sized so it drives the measured width. */}
        <span
          ref={labelRef}
          key={`cur-${transitionId}`}
          className="num whitespace-nowrap"
          style={
            previous === null
              ? undefined
              : { animation: `label-fade-in ${LABEL_FADE_MS}ms ease-out` }
          }
        >
          {current}
        </span>
        {/* Outgoing overlay, fading out on top of the current — present only
            during a crossfade so the two labels overlap instead of blanking. */}
        {previous !== null ? (
          <span
            key={`prev-${transitionId}`}
            aria-hidden
            className="num whitespace-nowrap absolute left-0 top-0"
            style={{ animation: `label-fade-out ${LABEL_FADE_MS}ms ease-out forwards` }}
          >
            {previous}
          </span>
        ) : null}
      </span>
      {/* The connection-dot slot (mock: dot on the chip's right edge). While a
          manual refresh runs it pulses neutral — "your command is running";
          otherwise it wears the live/idle/warn tone, and a keyed halo overlay
          replays the 600ms box-shadow ring on each data event (organic SSE
          event, or the manual confirm flash). */}
      <span className="relative inline-flex size-1.5 items-center justify-center">
        {manual?.busy ? (
          <span aria-hidden className="refresh-dot busy" />
        ) : (
          <>
            {organicPulse || confirmPulse ? (
              // Keyed so the one-shot animation replays: a new lastEventAt
              // remounts the organic halo; "manual-done" mounts once on the
              // done flash.
              <span
                key={confirmPulse ? "manual-done" : lastEventAt}
                aria-hidden
                className="refresh-halo"
              />
            ) : null}
            <span className={cn("refresh-dot relative", DOT_TONE[tone])} />
          </>
        )}
      </span>
    </button>
  );
}
