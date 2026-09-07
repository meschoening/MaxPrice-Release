import { useEffect, useRef, useState } from "react";
import { performPricingRefresh } from "@/lib/pricing-refresh";
import {
  classifyRefreshError,
  classifyRefreshResponse,
  pricingSectionView,
  type PricingSectionState,
} from "@/lib/pricing-section";
import { cn } from "@/lib/utils";
import { useLiveStatus } from "@/state/use-live-status";
import { DONE_VISIBLE_MS, FAILED_VISIBLE_MS, MIN_REFRESHING_MS } from "@/state/use-manual-refresh";
import { useNowTick } from "@/state/use-now-tick";
import { useSettings } from "@/state/use-settings";

// PricingSection — Settings › Pricing (ADR-0085): the manual "Refresh prices"
// control beside the pricing provenance that used to be the App info row.
// Worn as the Updates section is (a glass chip, a hint line beside it, a
// hairline in flight); every string and the state → strings mapping live in
// `lib/pricing-section.ts`. This file is structure and wiring only.
//
// Local state, not a store: the outcome is transient (it reverts to the
// provenance line on the rescan pill's timers), and the provenance itself comes
// from the live-status store, which the sidecar patches over SSE on every
// settled attempt. Leaving the page mid-flight loses nothing durable.
export function PricingSection(): React.ReactElement {
  const pricing = useLiveStatus((s) => s.pricing);
  const { data: settings } = useSettings();
  // Minute-grained: the provenance line's relative times need no finer tick.
  const now = useNowTick(60_000);
  const [state, setState] = useState<PricingSectionState>({ kind: "idle" });

  // One pending hold/revert timer, cleared on a new click and on unmount.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = (): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  // Set on unmount so a request that settles after the section is gone
  // schedules no hold/revert timers (BootSplash's `cancelled` ref idiom).
  const unmounted = useRef(false);
  useEffect(
    () => () => {
      unmounted.current = true;
      clearTimer();
    },
    [],
  );

  const run = (): void => {
    if (state.kind === "refreshing") return;
    clearTimer();
    setState({ kind: "refreshing" });
    const startedAt = Date.now();
    const settle = (next: PricingSectionState): void => {
      if (unmounted.current) return;
      // Hold "Refreshing…" for its minimum so a joined, already-settled attempt
      // still reads as a deliberate action rather than a flicker.
      const hold = Math.max(0, MIN_REFRESHING_MS - (Date.now() - startedAt));
      timer.current = setTimeout(() => {
        setState(next);
        const visible = next.kind === "failed" ? FAILED_VISIBLE_MS : DONE_VISIBLE_MS;
        timer.current = setTimeout(() => {
          timer.current = null;
          setState({ kind: "idle" });
        }, visible);
      }, hold);
    };
    performPricingRefresh().then(
      (response) => settle(classifyRefreshResponse(response)),
      (err: unknown) => {
        // `performPricingRefresh` has already written the durable line.
        console.error("[pricing-refresh] failed:", err);
        settle(classifyRefreshError(err));
      },
    );
  };

  const view = pricingSectionView(state, pricing, now, settings?.timezone);
  // `view.status` is the provenance line at rest and in flight, and the outcome
  // for a settled attempt's hold. Only the latter is an announcement.
  const settled = state.kind === "refreshed" || state.kind === "failed";
  const outcome = settled ? view.status : null;

  return (
    <>
      <div className="row-line" style={{ width: "auto", gap: 8 }}>
        <button type="button" className="chip" disabled={view.chip.disabled} onClick={run}>
          {view.chip.label}
        </button>
        {/* One visible span in the row, so the flex `gap` between the chip and
            the text is the Updates grammar's single 8px (an always-mounted but
            empty live span sitting here would be a second flex item, and the
            gap would read as 16px at rest).

            The visible line is NOT a live region: `view.status` is the
            provenance at rest, whose relative time re-renders on every minute
            tick — inside `role="status"` that would re-announce to a screen
            reader every minute for as long as Settings is open (Updates has no
            such problem: its resting line is static).

            The tint goes on a NESTED span, never as `hint-line err`: both are
            single-class selectors and `.hint-line` is declared later, so the
            combination would lose the tint (the Updates section's note). */}
        <span className="hint-line" title={view.statusTitle ?? undefined}>
          {view.statusTone === "" ? (
            view.status
          ) : (
            <span className={view.statusTone === "err" ? "err" : "ai-note warn"}>
              {view.status}
            </span>
          )}
        </span>
      </div>

      {/* The announcement: permanently mounted (so the region exists before its
          text changes) but visually hidden and outside the row, carrying ONLY a
          settled attempt's outcome — empty at rest and in flight. */}
      <span className="sr-only" role="status">
        {outcome}
      </span>

      {view.track ? (
        <span className="busy-hairline update-track" aria-hidden>
          <i />
        </span>
      ) : null}

      {view.note !== null ? (
        <p className={cn("ai-note", view.noteTone)} title={view.statusTitle ?? undefined}>
          {view.note}
        </p>
      ) : null}
    </>
  );
}
