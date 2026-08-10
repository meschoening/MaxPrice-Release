import { formatRelativeTime, usageConnectionDot, usageConnectionLabel } from "@maxprice/shared";
import type { HubConnection, UsageConnection } from "@maxprice/shared";
import { hubConnectionDot, hubConnectionLabel } from "./hub-status";
import { STALE_HUB_LINE, STALE_USAGE_LINE } from "./stale-status";
import { dotVariant, type DotVariant } from "./dot-variant";

// The sidebar foot's live lines — claude.ai limits, the hub, and the episodic
// saturation line — derived away from the component so the rules that are easy
// to get wrong are testable: the sticky-connecting rule here, and the stale rule
// in `stale-status.ts` (shared with Settings). The semantic state → colour maps
// stay where they were (usage-status.ts / hub-status.ts); nothing here
// re-decides what a state MEANS, only which state the foot should be presenting
// and whether we still believe it.

export type { DotVariant };

// STICKY CONNECTING. The hub client retries a dead hub every 15s, and every
// attempt passes through `connecting` on its way back to `fallback` — so a
// literal state→colour mapping makes a permanently-visible dot strobe
// grey/amber for as long as the hub is down. Presenting the last SETTLED state
// instead holds it steady at the colour that is actually true (the local poller
// really is on duty throughout the retry, so `fallback`'s label keeps telling
// the truth mid-attempt).
//
// The exception is a FIRST attempt, where there is no settled state to fall
// back on: `off` is not a state to present ("Not configured" would be a lie
// about a connection we are in the middle of opening), so the honest answer is
// the live `connecting` — a soft dot and "Connecting…". This mirrors
// `stateBeforeConnecting` inside the hub client, which reads through
// `connecting` the same way and for the same reason.
//
// SCOPE IS DELIBERATELY FOOT-ONLY — unlike the stale rule, this one does not
// move to `stale-status.ts` for Settings to share. Steadiness is what a
// permanent glance surface wants; on a transient action surface like Settings
// the same rule would swallow feedback, holding the old reading so that pressing
// Save while the hub is down changes nothing on screen.
const FALLEN_BACK: ReadonlySet<HubConnection> = new Set([
  "fallback",
  "keyless",
  "mismatch",
  "unauthorized",
]);

export function stickyHubConnection(
  current: HubConnection,
  lastSettled: HubConnection | null,
): HubConnection {
  if (current !== "connecting") return current;
  // Only a FALLEN-BACK last-settled state is held through `connecting`, which
  // is the only episode the rule exists for: the 15s retry loop always retries
  // from one of these. `connected → connecting` has exactly one producer —
  // hub-client's configure() (teardownCurrent leaves `state` alone) — so
  // holding green there would present the OLD hub's health while the sidecar
  // opens a connection to a NEW one, for up to the 10s status timeout.
  if (lastSettled === null || !FALLEN_BACK.has(lastSettled)) return current;
  return lastSettled;
}

// The sticky rule's other half: what "last settled" MEANS. `off` IS recorded
// here and rejected by the presenter above — the accumulator records what the
// sidecar last settled on; stickyHubConnection decides what is presentable.
export function nextSettledHub(
  prev: HubConnection | null,
  current: HubConnection,
): HubConnection | null {
  return current === "connecting" ? prev : current;
}

// The hub line, or `null` when there is no line to draw. Hidden exactly while
// the sidecar reports `off` — the hub is opt-in, and a machine with no hub
// should not carry a permanent reminder of a feature it doesn't use. That gate
// is the sidecar's own state and not `settings.hubUrl`, so the dot's presence
// always means "the sidecar has a hub relationship", never "a URL is saved
// somewhere".
export type HubFootLine = { variant: DotVariant; title: string };

export function hubFootLine(
  connection: HubConnection,
  lastSettled: HubConnection | null,
  stale: boolean,
): HubFootLine | null {
  if (connection === "off") return null;
  if (stale) return { variant: STALE_HUB_LINE.variant, title: STALE_HUB_LINE.title };
  const presented = stickyHubConnection(connection, lastSettled);
  // Unprefixed, unlike the claude.ai line's "claude.ai limits: …": four of the
  // six labels already begin with "Hub", so a prefix would stutter.
  return { variant: dotVariant(hubConnectionDot(presented)), title: hubConnectionLabel(presented) };
}

// The claude.ai limits line. `hidden` is the no-credential state (the foot has
// never advertised a connection the user hasn't made); `expired` is the one
// state that escalates into a link, because re-pasting a key is an action the
// user can take and Settings is where they take it.
export type UsageFootLine =
  | { kind: "hidden" }
  | { kind: "expired"; variant: DotVariant; title: string }
  | { kind: "state"; variant: DotVariant; title: string };

export function usageFootLine(
  connection: UsageConnection,
  lastSampleAt: string | null,
  now: number,
  stale: boolean,
): UsageFootLine {
  const dot = usageConnectionDot(connection);
  if (dot === null) return { kind: "hidden" };
  // Stale outranks `expired`, and deliberately drops the link with it: with the
  // sidecar down a re-pasted key has nowhere to go, so offering the action
  // would be offering a dead end.
  if (stale) {
    return {
      kind: "state",
      variant: STALE_USAGE_LINE.variant,
      title: STALE_USAGE_LINE.title,
    };
  }
  if (connection === "expired") {
    // The dot comes from the same map as every other line's — only the TEXT
    // colour is the component's own (see StatusBar).
    return {
      kind: "expired",
      variant: dotVariant(dot),
      title: "claude.ai limits: Session expired — click to reconnect",
    };
  }
  const sampled =
    connection === "connected" && lastSampleAt !== null
      ? ` · sampled ${formatRelativeTime(lastSampleAt, now)}`
      : "";
  return {
    kind: "state",
    variant: dotVariant(dot),
    title: `claude.ai limits: ${usageConnectionLabel(connection)}${sampled}`,
  };
}

// The saturation verdict is the third mirror, and the stale rule HIDES it
// rather than softening it: unlike the two connection lines, whose presence
// means "this relationship exists" and only whose reading is unknown, this
// line's presence IS its assertion. A soft "engine catching up (state
// unknown)" asserts nothing. Symmetric with usageFootLine's `hidden`, which
// stale never resurrects.
export function saturationFootLine(saturated: boolean, stale: boolean): boolean {
  return saturated && !stale;
}

// The foot draws a hairline above its lines; with nothing to draw, the hairline
// is a broken-looking surface rather than a quiet one, so the whole block goes.
export function footHasLines(
  usage: UsageFootLine,
  hub: HubFootLine | null,
  showSaturation: boolean,
): boolean {
  return usage.kind !== "hidden" || hub !== null || showSaturation;
}
