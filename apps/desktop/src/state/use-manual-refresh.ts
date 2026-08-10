import { create } from "zustand";
import { RESCAN_PATH, rescanResponseSchema } from "@maxprice/shared";
import { queryClient } from "@/lib/query";
import { logClientEvent } from "@/lib/client-log";
import { reconnectNow, requestInvalidationRound } from "@/lib/live-stream";
import { sidecarFetch } from "@/lib/sidecar";
import { usageAuthHeaders } from "@/lib/usage-credential";
import type { RefreshTone } from "@/lib/refresh-format";
import { useLiveStatus } from "@/state/use-live-status";

// The manual rescan gesture (ADR-0019). ⇧R / the topbar refresh pill POST to
// `/api/rescan`, which forces a full disk re-walk into the engine's event store
// and returns the new-event delta; this store drives the pill's transient
// feedback across that request's lifecycle. It is its OWN track, separate from
// `useLiveStatus` (which is scoped to SSE connection health) — a user-initiated
// action is a different concern from pipeline health, and a manual refresh
// deliberately does not fake an organic `usage:new` pulse.

export type ManualRefreshPhase = "idle" | "refreshing" | "done" | "failed";

// Why a refresh failed, as far as the pill needs to distinguish (ADR-0059).
// `timeout` means the sidecar never answered inside the ceiling — a wedged or
// unreachable engine; `error` means it answered, badly (non-2xx, a network
// refusal, a response that failed its schema). Those are different problems
// with different next steps, and "refresh failed" said neither.
export type ManualRefreshFailure = "timeout" | "error";

// How long each transient phase shows. `refreshing` has a *minimum* so a
// sub-100ms scan still reads as a deliberate action rather than a flicker; the
// terminal phases hold briefly, then release the pill back to its normal
// lastEventAt-driven label.
export const MIN_REFRESHING_MS = 450;
export const DONE_VISIBLE_MS = 1_600;
export const FAILED_VISIBLE_MS = 2_200;

type ManualRefreshState = {
  phase: ManualRefreshPhase;
  // New-event delta from the last rescan — drives "refreshed · +N" vs "up to
  // date". Meaningful only while `phase === "done"`.
  added: number;
  // Why the last refresh failed. Meaningful only while `phase === "failed"`.
  failure: ManualRefreshFailure;
  trigger: () => void;
};

// A hung POST /api/rescan would leave performRescan's promise unsettled forever
// — `settle()` never fires, the phase sticks on "refreshing", and the in-flight
// guard then permanently no-ops every future trigger. Race the request against
// this ceiling so a stalled scan aborts → the logged failure path, instead of
// wedging the pill until a webview reload.
//
// THIS IS A DEADLOCK BREAKER, NOT A LATENCY BUDGET (ADR-0059). Read as a
// budget, 30 s looked generous and was not: issue #115's client crossed it on
// an ordinary first click, because the request was queued behind a saturated
// loop rather than doing 30 s of work. Measured on a 1253-file / 650 MB corpus
// after F1 (#113) and F2 (#114), a no-op rescan is ~0.3 s and even a fully cold
// re-parse of the entire corpus is ~3.4 s — so 120 s is ~35× the legitimate
// worst case and unreachable by the healthy path on any corpus within an order
// of magnitude of that one. If you ever find yourself tuning this number
// because real refreshes are hitting it, the bug is not this number.
export const RESCAN_TIMEOUT_MS = 120_000;

// A successful refresh slower than this leaves a line in the durable log. The
// threshold sits just above the measured cold-re-parse worst case (~3.4 s, the
// cost a click during a boot scan inherits through `engineReady`), so a line
// means "this was not normal", not "this corpus is large". ADR-0056's
// saturation verdict covers the condition globally; this records the gesture.
export const SLOW_RESCAN_LOG_MS = 5_000;

// Injectable clock (the `nowImpl` seam the sidecar already uses) so the slow-
// path test doesn't spend five real seconds proving a threshold.
let nowImpl: () => number = () => Date.now();
export function setNowImplForTests(next: (() => number) | null): void {
  nowImpl = next ?? (() => Date.now());
}

// Distinguishes the ceiling's abort from every other rejection. We set this
// flag in the timeout callback rather than inferring "timeout" from a bare
// `AbortError`: the DOMException name is not ours, and reading intent off a
// generic error is how a future caller-initiated abort would silently start
// reporting itself as a stalled sidecar.
export class RescanTimeoutError extends Error {
  constructor(readonly elapsedMs: number) {
    super(`${RESCAN_PATH} timed out after ${elapsedMs}ms`);
    this.name = "RescanTimeoutError";
  }
}

// POST the rescan, parse the delta, and invalidate every report family (plus
// the Part 5 per-session detail family) so the refetched views reflect what the
// scan merged in. A manual rescan emits no SSE (ADR-0019), so the renderer owns
// this invalidation. Exported for direct testing.
//
// This function — not `trigger` — owns the failure classification and both
// durable log lines, because it is what holds the request lifecycle: the
// controller, the ceiling, the HTTP status, and the schema parse. `trigger`
// keeps only the pill's phase orchestration.
export async function performRescan(): Promise<number> {
  const controller = new AbortController();
  const startedAt = nowImpl();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, RESCAN_TIMEOUT_MS);
  try {
    // The rescan POST carries the per-launch auth token like every other POST
    // the sidecar exposes. `usageAuthHeaders()` resolves to `{}` outside Tauri,
    // so the Vite standalone path (and the bun tests) are unaffected. Awaited
    // INSIDE the try so a failure to mint the header still routes through the
    // timeout-vs-error classification below rather than escaping unclassified.
    const res = await sidecarFetch(RESCAN_PATH, {
      method: "POST",
      headers: await usageAuthHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${RESCAN_PATH} ${res.status}: ${await res.text()}`);
    const { added } = rescanResponseSchema.parse(await res.json());
    // A refresh that worked but dragged is the ADR-0056 saturation story
    // arriving through the gesture the user actually pressed — worth one line,
    // where the global "engine catching up" indicator is not attributable to
    // any single action.
    const elapsedMs = nowImpl() - startedAt;
    if (elapsedMs >= SLOW_RESCAN_LOG_MS) {
      logClientEvent(`manual-refresh: slow — ok after ${elapsedMs}ms (added=${added})`);
    }
    // Request an invalidation round through the live pipeline's completion
    // gate (#114): every report family plus the blanket per-session sweep — a
    // rescan doesn't know which session ids changed, so the prefix invalidation
    // (matching ["session", id] / ["session", id, mode]) is the correct sweep.
    // Immediate when the gate is idle; coalesced into the in-flight round's
    // follow-up otherwise, so a rescan never stacks a concurrent wholesale
    // refetch on top of one already running.
    requestInvalidationRound(queryClient, { sweepSessionRoot: true });
    return added;
  } catch (err) {
    // Classify HERE, where `timedOut` is in scope and unambiguous, and record
    // the line before rethrowing — so the trace exists whatever the caller
    // decides to render. `[renderer]` is prefixed by the shell.
    const elapsedMs = nowImpl() - startedAt;
    if (timedOut) {
      logClientEvent(`manual-refresh: timed out after ${elapsedMs}ms`);
      throw new RescanTimeoutError(elapsedMs);
    }
    logClientEvent(`manual-refresh: failed after ${elapsedMs}ms: ${String(err)}`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// The pill's label/tone/busy state while a manual refresh is in its transient
// window, or `null` when idle — the pill then falls back to the lastEventAt-
// driven label. A pure function so it is trivially testable. The `busy` flag
// signifies "your command is running" — the pill shows a pulsing neutral dot;
// the pulse ring stays reserved for "a data event landed" (and replays it once
// on `done` as a confirm flash).
export type ManualRefreshDisplay = { text: string; tone: RefreshTone; busy: boolean };

export function manualRefreshDisplay(
  phase: ManualRefreshPhase,
  added: number,
  failure: ManualRefreshFailure = "error",
): ManualRefreshDisplay | null {
  switch (phase) {
    case "refreshing":
      return { text: "refreshing…", tone: "idle", busy: true };
    case "done":
      return {
        text: added > 0 ? `refreshed · +${added}` : "up to date",
        tone: "live",
        busy: false,
      };
    case "failed":
      // Two different problems, and the old single label named neither: a
      // timeout is a sidecar that never answered, an error is one that
      // answered badly. The durable log carries the detail (ADR-0059); this is
      // the two-second version the user actually sees.
      return {
        text: failure === "timeout" ? "refresh timed out" : "refresh failed",
        tone: "warn",
        busy: false,
      };
    case "idle":
      return null;
  }
}

// Single pending timer for the current phase's hold/revert, cleared when a new
// trigger supersedes a terminal phase. The in-flight guard means a "refreshing"
// hold timer is never racing a trigger.
let phaseTimer: ReturnType<typeof setTimeout> | null = null;
// Exported for tests: the settle-path's hold/revert schedules onto this
// module-level timer, so a test's afterEach needs a hook to cancel a pending
// DONE_VISIBLE_MS / FAILED_VISIBLE_MS revert and stop it leaking into the next.
export function clearPhaseTimer(): void {
  if (phaseTimer !== null) {
    clearTimeout(phaseTimer);
    phaseTimer = null;
  }
}

export const useManualRefresh = create<ManualRefreshState>((set, get) => ({
  phase: "idle",
  added: 0,
  failure: "error",
  trigger: () => {
    // In-flight guard — a re-trigger while a scan is running is a no-op, so
    // hammering ⇧R / the pill spawns no concurrent scans. The sidecar holds
    // the same invariant for itself now (ADR-0059's corpus-walk gate), so a
    // second client — or a retry after this guard released — cannot put a
    // second walk on the engine's single thread either.
    if (get().phase === "refreshing") return;
    clearPhaseTimer();
    set({ phase: "refreshing", added: 0 });

    // The same gesture re-establishes liveness when the channel is down,
    // skipping a backoff that may be sitting at its 30s cap (ADR-0019).
    if (useLiveStatus.getState().connectionState !== "connected") {
      reconnectNow();
    }

    const startedAt = nowImpl();
    const settle = (
      phase: "done" | "failed",
      added: number,
      failure: ManualRefreshFailure = "error",
    ): void => {
      // Hold "refreshing…" for its minimum so a fast scan still registers.
      const hold = Math.max(0, MIN_REFRESHING_MS - (nowImpl() - startedAt));
      phaseTimer = setTimeout(() => {
        set({ phase, added, failure });
        const visible = phase === "done" ? DONE_VISIBLE_MS : FAILED_VISIBLE_MS;
        phaseTimer = setTimeout(() => {
          phaseTimer = null;
          set({ phase: "idle", added: 0, failure: "error" });
        }, visible);
      }, hold);
    };

    void performRescan().then(
      (added) => settle("done", added),
      (err: unknown) => {
        // `performRescan` has already classified this and written the durable
        // line (ADR-0059); the console stays for a dev terminal, and the phase
        // carries the reason through to the pill's label.
        console.error("[manual-refresh] rescan failed:", err);
        settle("failed", 0, err instanceof RescanTimeoutError ? "timeout" : "error");
      },
    );
  },
}));
