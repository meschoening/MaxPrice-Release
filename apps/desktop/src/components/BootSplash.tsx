import { useEffect, useRef, useState } from "react";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import { useLiveStatus } from "@/state/use-live-status";
import { insideTauri } from "@/lib/tauri";
import { detectUpdate, applyUpdate } from "@/lib/updater";
import { useBootPaintSettled } from "@/lib/boot-paint";
import { BootPhaseContext } from "@/lib/boot-phase";
import { bootProgressView, bootStoppedWhere } from "@/lib/boot-steps";
import { showAppWindow } from "@/lib/window-show";
import {
  BOOT_PAINT_CEILING_MS,
  BOOT_WATCHDOG_MS,
  SPLASH_FADE_MS,
  bootErrorReason,
  revealHoldDelay,
  shouldReveal,
} from "@/lib/boot-splash";

// The full-window boot splash gate (map #75 T4; visual contract NOTES §Boot
// splash — the resolved `still` variant; signal contract ADR-0047). From
// first paint until the engine's `ready` lands on the status stream, every
// route is gated: BootGate renders the splash INSTEAD of the app frame — no
// sidebar, no topbar — over the body's own wash, so the reveal never jumps
// background. Once ready has been shown for the minimum display, the frame
// mounts (entering on the 400ms rise via `.boot-frame`) while the splash
// fades 500ms above it, then unmounts.
//
// The splash owns pre-ready failure (never an infinite spinner): a terminal
// sidecar startup error (`bootFailure`, recorded by live-stream from
// SidecarStatus::Failed), a spent SSE reconnect budget (`disconnected`), OR a
// client-side watchdog (BOOT_WATCHDOG_MS) firing on a connected-but-never-ready
// channel — a hung engineReady on a slow/network mount — swaps the gate stack
// for a glass error card. The card's copy adapts: a hard failure vs a mere
// timeout (which may yet complete), so the timeout is never a false claim of
// failure. "Try again" relaunches the whole app (T4's recorded call): the Rust
// shell never respawns a dead sidecar in place, so a full relaunch is the only
// true rerun of the boot sequence. "Check for updates" runs the OTA flow in
// place — pre-ready, UpdateGate (which wraps below BootGate) has not yet
// probed, so the error card is the only place the one thing that could ship a
// fix is reachable. A healed connection (the `open` handler clears
// `bootFailure`) drops the card back to the loading arc; `ready` always wins.

export function BootGate({ children }: { children: React.ReactNode }): React.ReactElement {
  const ready = useLiveStatus((s) => s.ready);
  // Stage 1 (ADR-0047): the engine's scan is done, so the frame MOUNTS — but
  // hidden beneath the still-opaque splash, so Live's queries run during the
  // hold instead of after it. Before ADR-0066 this mounted at reveal time, which
  // is why the app used to arrive before its contents did.
  const mounted = ready === true;
  // Stage 2 (ADR-0066): the landing page reports its data drawn.
  const paintSettled = useBootPaintSettled();
  // `revealing` starts the splash fade + the frame's rise; `splashGone`
  // unmounts the splash after that fade has run.
  const [revealing, setRevealing] = useState(false);
  const [splashGone, setSplashGone] = useState(false);
  const [minDisplayElapsed, setMinDisplayElapsed] = useState(false);
  const [ceilingElapsed, setCeilingElapsed] = useState(false);
  // When the splash first painted — the minimum-display clock. Stamped on
  // the first render, surviving re-renders (a StrictMode remount re-stamps
  // milliseconds later, which is harmless).
  const shownAtRef = useRef<number | null>(null);
  shownAtRef.current ??= performance.now();

  // The minimum-display floor, armed once the frame mounts: the remainder of
  // MIN_SPLASH_DISPLAY_MS, zero once the scan already outlasted it.
  useEffect(() => {
    if (!mounted) return;
    const shownAt = shownAtRef.current ?? performance.now();
    const timer = setTimeout(
      () => setMinDisplayElapsed(true),
      revealHoldDelay(shownAt, performance.now()),
    );
    return () => clearTimeout(timer);
  }, [mounted]);

  // The deadlock breaker, on its own clock from `ready`.
  useEffect(() => {
    if (!mounted) return;
    const timer = setTimeout(() => setCeilingElapsed(true), BOOT_PAINT_CEILING_MS);
    return () => clearTimeout(timer);
  }, [mounted]);

  useEffect(() => {
    if (revealing) return;
    if (!shouldReveal({ minDisplayElapsed, paintSettled, ceilingElapsed })) return;
    // Two frames, so the commit carrying real numbers has actually PAINTED
    // before the splash starts fading off it. One rAF only guarantees we run
    // before the next paint, not after the last one.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setRevealing(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [revealing, minDisplayElapsed, paintSettled, ceilingElapsed]);

  useEffect(() => {
    if (!revealing) return;
    const timer = setTimeout(() => setSplashGone(true), SPLASH_FADE_MS);
    return () => clearTimeout(timer);
  }, [revealing]);

  return (
    <>
      {mounted ? (
        <BootPhaseContext.Provider value={revealing ? "reveal" : "hold"}>
          {children}
        </BootPhaseContext.Provider>
      ) : null}
      {splashGone ? null : <BootSplash revealing={revealing} />}
    </>
  );
}

function retryBoot(): void {
  if (insideTauri()) {
    relaunch().catch((err: unknown) => console.error("[boot] relaunch failed:", err));
  } else {
    window.location.reload();
  }
}

function quitApp(): void {
  if (insideTauri()) {
    exit(0).catch((err: unknown) => console.error("[boot] exit failed:", err));
  } else {
    window.close();
  }
}

// The inline "Check for updates" affordance on the error card. Pre-ready,
// UpdateGate has not run yet, so this is the only reachable OTA path.
type UpdateAction =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "installing" }
  | { phase: "note"; text: string };

function BootSplash({ revealing }: { revealing: boolean }): React.ReactElement {
  const ready = useLiveStatus((s) => s.ready);
  const progress = useLiveStatus((s) => s.bootProgress);
  const bootFailure = useLiveStatus((s) => s.bootFailure);
  const connectionState = useLiveStatus((s) => s.connectionState);
  const paintSettled = useBootPaintSettled();
  // Client-side boot watchdog: after BOOT_WATCHDOG_MS a connected-but-never-
  // ready channel surfaces the same error card (the timeout reason). Always
  // armed on mount; the pre-ready gate below suppresses it once ready/revealing.
  const [timedOut, setTimedOut] = useState(false);
  const [updateAction, setUpdateAction] = useState<UpdateAction>({ phase: "idle" });
  const retryBtn = useRef<HTMLButtonElement>(null);
  // Guard the async update flow against setState-after-unmount (BootGate
  // unmounts the splash once the fade completes).
  const cancelled = useRef(false);

  // Pre-ready failure only: once ready is known (or the reveal has begun)
  // the card can never appear — post-ready trouble belongs to the StatusBar.
  const errorReason =
    revealing || ready === true ? null : bootErrorReason(bootFailure, connectionState, timedOut);
  const phase = errorReason !== null ? "error" : revealing ? "reveal" : "loading";
  // The four-step progress model (ADR-0067). `null` = no bar: either the wire
  // carried no progress (a pre-ADR-0067 sidecar) or — on the error card — there
  // is nothing left to report. The splash falls back to ADR-0047's quiet line.
  const view = bootProgressView({ ready, progress, paintSettled, revealing });
  const stoppedWhere = phase === "error" ? bootStoppedWhere(view) : null;
  // A hard failure (dead/unreachable sidecar) vs a mere timeout (the channel is
  // up, ready just hasn't landed and may yet). The copy softens for the latter.
  const hardFailure = bootFailure !== null || connectionState === "disconnected";

  // The window is created hidden; this commit is the first thing worth looking
  // at, so it is what puts the window on screen (see lib/window-show.ts). Here
  // rather than in BootGate because BootGate's first render is the splash — but
  // it is also the render that mounts the app frame later, and the window must
  // follow the splash, not the frame. Every boot path reaches this component,
  // the pre-ready error card included.
  useEffect(() => {
    showAppWindow();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), BOOT_WATCHDOG_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    return () => {
      cancelled.current = true;
    };
  }, []);

  // The card is the splash's one interactive state — land focus on its
  // primary action (the UpdateGate pattern).
  useEffect(() => {
    if (phase === "error") retryBtn.current?.focus();
  }, [phase]);

  // Run the OTA flow in place (mirrors UpdateGate's install handler). A manual
  // click is itself the consent; applyUpdate relaunches on success, so its
  // resolved branch never runs — only a failure returns us to the card.
  const checkForUpdates = (): void => {
    setUpdateAction({ phase: "checking" });
    detectUpdate()
      .then((probe) => {
        if (cancelled.current) return;
        if (probe.status === "available") {
          setUpdateAction({ phase: "installing" });
          applyUpdate(probe.update).catch((err: unknown) => {
            console.error("[boot] update install failed:", err);
            if (cancelled.current) return;
            setUpdateAction({ phase: "note", text: "The update failed to install." });
          });
        } else if (probe.status === "up-to-date") {
          setUpdateAction({ phase: "note", text: "You’re up to date." });
        } else {
          setUpdateAction({ phase: "note", text: "Updates aren’t available here." });
        }
      })
      .catch((err: unknown) => {
        console.warn("[boot] update check failed:", err);
        if (cancelled.current) return;
        setUpdateAction({ phase: "note", text: "Couldn’t check for updates." });
      });
  };

  // The Check button locks while a probe/install is in flight; the escape
  // hatches (Try again / Quit) lock only during the destructive install — a
  // hung probe must never trap the user on the card.
  const updateInstalling = updateAction.phase === "installing";
  const updateBusy = updateAction.phase === "checking" || updateInstalling;
  const updateLabel =
    updateAction.phase === "checking"
      ? "Checking…"
      : updateAction.phase === "installing"
        ? "Installing…"
        : "Check for updates";

  return (
    <div className="boot-splash" data-phase={phase}>
      {phase === "error" ? (
        <div
          className="boot-error panel"
          role="alertdialog"
          aria-label={hardFailure ? "Startup failed" : "Startup delayed"}
        >
          <div className="err-head">
            <span className={hardFailure ? "dot bad" : "dot warn"} aria-hidden />
            <h2>{hardFailure ? "MaxPrice couldn’t start" : "MaxPrice is still starting"}</h2>
          </div>
          <p>
            {hardFailure
              ? "The data engine didn’t come up, so there’s nothing to show yet."
              : "This is taking longer than a usual launch."}
          </p>
          {/* The payoff of having steps at all (ADR-0067): name WHERE it
              stopped, with the count it stopped at. "Stopped while reading
              session files — 825 / 1,253 files." is a report a user can act on
              and forward; the technical reason in the inset below is not. */}
          {stoppedWhere !== null ? <p className="boot-where">{stoppedWhere}</p> : null}
          <div className={hardFailure ? "inset danger" : "inset warn"}>
            <p className="lead">{errorReason}</p>
            <p>Trying again restarts MaxPrice and its data engine.</p>
          </div>
          {updateAction.phase === "note" ? <p>{updateAction.text}</p> : null}
          <div className="err-actions" style={{ flexWrap: "wrap" }}>
            <button
              ref={retryBtn}
              type="button"
              className="chip active"
              disabled={updateInstalling}
              onClick={retryBoot}
            >
              Try again
            </button>
            <button type="button" className="chip" disabled={updateBusy} onClick={checkForUpdates}>
              {updateLabel}
            </button>
            <button type="button" className="chip" disabled={updateInstalling} onClick={quitApp}>
              Quit MaxPrice
            </button>
          </div>
        </div>
      ) : (
        <div className="boot-gate" role="status">
          <span className="logo dollar" aria-hidden />
          <div className="boot-lockup">
            <span className="wordmark">MaxPrice</span>
            <span className="ver num">v{__APP_VERSION__}</span>
          </div>
          {view === null ? (
            // The no-progress degrade (ADR-0067): a sidecar that reports no
            // boot progress gives us no way to tell a long scan from a wedged
            // one, and ADR-0047's indeterminate line is the honest rendering of
            // that. Kept verbatim rather than shown as a bar stuck at 8%.
            <p className="boot-quiet">
              Reading your Claude usage
              <span className="boot-dots" aria-hidden>
                <i>.</i>
                <i>.</i>
                <i>.</i>
              </span>
            </p>
          ) : (
            <div className="boot-prog">
              {/* The bar carries aria-valuenow rather than living inside the
                  gate's polite live region: a percentage that moves ~4×/second
                  would be a screen-reader firehose, and a progressbar's value
                  is not announced on change. The step NAME below stays in the
                  live region — it changes four times a boot and each change is
                  the one thing worth hearing. */}
              <div
                className="boot-track"
                role="progressbar"
                aria-label="Startup progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={view.percent}
              >
                <i className="fill" style={{ width: `${view.percent}%` }} />
                <span className="sheen" aria-hidden />
              </div>
              <div className="boot-statline">
                <span className="sname">
                  {view.activeName}
                  <span className="boot-dots" aria-hidden>
                    <i>.</i>
                    <i>.</i>
                    <i>.</i>
                  </span>
                </span>
                {/* Both volatile readouts are hidden from the live region for
                    the same reason the bar is — the bar already carries the
                    value for assistive tech. */}
                {view.count !== null ? (
                  <span className="scount num" aria-hidden>
                    {view.count}
                  </span>
                ) : null}
                <span className="spct num" aria-hidden>
                  {view.percent}%
                </span>
              </div>
              <ol className="boot-steps" aria-hidden>
                {view.steps.map((step) => (
                  <li key={step.key} data-state={step.state}>
                    <span className="glyph" />
                    <span className="sname">{step.short}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
