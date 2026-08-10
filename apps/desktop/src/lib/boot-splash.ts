import type { ConnectionState } from "@/state/use-live-status";

// Boot splash timing + failure semantics (map #75 T4, consuming ADR-0047's
// `ready` signal; visual contract: plans/mocks/redesign/NOTES.md §Boot splash).
// The splash renders at first paint above the whole frame; these helpers are
// the testable core of its state machine — the component owns only timers and
// render.

// Minimum time the splash stays up once shown, so warm boots never strobe.
// The contract locked the 400–600ms range; the T2 mock resolved 500.
export const MIN_SPLASH_DISPLAY_MS = 500;
// The splash's fade-out; the frame enters on the 400ms rise underneath it.
export const SPLASH_FADE_MS = 500;

// The generic pre-ready failure reason when the SSE reconnect budget is spent
// without a recorded terminal sidecar error (live-stream's `disconnected`
// threshold: backoff saturated, sidecar looks genuinely gone).
export const BOOT_RETRY_EXHAUSTED_REASON = "sidecar: connection retries exhausted";

// The client-side boot watchdog ceiling. If the SSE channel is connected (or
// still reconnecting) but a `ready:true` frame never arrives — a hung
// engineReady on a slow/network claudePaths mount, or a stale sidecar — the
// splash would otherwise spin forever. After this ceiling the splash surfaces
// the same error card, honouring the "never an infinite spinner" invariant.
// Sized well past any merely slow (but progressing) boot, so a long scan is
// never mistaken for a stall — the rail itself is what reports that progress
// (ADR-0067), which is why the old 5s reassurance line beneath it is gone.
export const BOOT_WATCHDOG_MS = 25000;

// The lowest-priority (timeout) failure reason: the channel is up but `ready`
// never landed. Phrased as a slow start, not a hard failure — the boot may yet
// complete, so the card copy adapts to avoid a false claim of failure.
export const BOOT_TIMEOUT_REASON =
  "Startup is taking longer than expected — the data engine hasn't signalled ready.";

// The first-paint hold's ceiling, measured from `ready` (ADR-0066). `ready`
// only means the engine finished its scan, so the splash goes on to wait for
// the landing page to draw — but a wedged or pathologically slow report query
// must never hold the window shut. This is a DEADLOCK BREAKER, not a latency
// budget: reading it as a budget is exactly the confusion ADR-0059 had to
// recomment `RESCAN_TIMEOUT_MS` out of. Sized past the worst realistic case (a
// cold ADR-0057 report-cache build behind `/api/projects` on a first launch).
export const BOOT_PAINT_CEILING_MS = 3000;

// The reveal condition (ADR-0066), over two independent clocks. The minimum
// display runs from the splash being SHOWN and stops a warm boot strobing; the
// ceiling runs from `ready` and stops a wedged query holding the window. They
// stay separate deliberately — one clock from splash-shown would make the
// ceiling's meaning depend on how fast the scan happened to be.
//
// No error term: a failed query is settled, not pending (TanStack's `isPending`
// is false once a query errors), so `paintSettled` already covers it. The
// splash owns pre-ready failure ONLY — post-`ready` trouble belongs to the
// StatusBar and the per-endpoint error surfaces, which can only speak once the
// frame is revealed.
export function shouldReveal(gate: {
  minDisplayElapsed: boolean;
  paintSettled: boolean;
  ceilingElapsed: boolean;
}): boolean {
  return gate.minDisplayElapsed && (gate.paintSettled || gate.ceilingElapsed);
}

// How long to keep holding the splash after `ready` lands: the remainder of
// the minimum display, zero once the scan outlasted it. A ready timestamp
// behind `shownAt` (clock weirdness) holds the full minimum rather than
// going negative.
export function revealHoldDelay(shownAtMs: number, readyAtMs: number): number {
  const held = Math.max(0, readyAtMs - shownAtMs);
  return Math.max(0, MIN_SPLASH_DISPLAY_MS - held);
}

// The splash-owned pre-ready failure surface (never an infinite spinner):
// a terminal sidecar startup error (SidecarStatus::Failed / spawn failure,
// recorded as `bootFailure` by live-stream) shows verbatim; otherwise a spent
// reconnect budget (`disconnected`) gets the generic reason; otherwise, if the
// client watchdog fired while the channel is still connected/reconnecting but
// `ready` never arrived, the timeout reason (lowest priority — a real
// bootFailure or a disconnected channel always outranks it). Null = keep
// loading. Callers only consult this pre-ready — post-ready failures belong
// to the StatusBar and the per-endpoint error surfaces.
export function bootErrorReason(
  bootFailure: string | null,
  connectionState: ConnectionState,
  timedOut: boolean,
): string | null {
  if (bootFailure !== null) return bootFailure;
  if (connectionState === "disconnected") return BOOT_RETRY_EXHAUSTED_REASON;
  if (timedOut) return BOOT_TIMEOUT_REASON;
  return null;
}
