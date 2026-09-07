import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { insideTauri } from "../lib/tauri";
import { popoutView, type PopoutHead, type PopoutViewState } from "../lib/popout-view";
import { ringStrokeDasharray } from "../lib/active-block-tile-state";
import { usePendingUpdate, usePopoutData } from "../state/use-popout-data";
import { useNowTick } from "../state/use-now-tick";
import { useSettings, useTimeDisplay } from "../state/use-settings";

// The tray popout mini-dashboard (map #168 M3; the T3-approved "leaf" variant,
// ADR-0050): a 54px-ring live header, quiet
// 5-hour-limit / Weekly-limit / <Model>-limit (wire- AND setting-gated) /
// Today (cost · tokens) rows, a pending-only accent update row, and
// Open / Quit as kmenu items. Every quantity is a popout-owned sidecar fetch
// (use-popout-data — T5 decision 8); every window manipulation lives Rust-side
// (ADR-0050 — blur dismissal never reaches this file; Esc invokes hide_popout).
//
// The event this bundle listens for ("popout:shown") and the two commands the
// buttons invoke are the popout's whole IPC surface, per the ACL note in
// capabilities/popout.json.

// Fire a Tauri command and log its rejection — never `void` it (the hub's
// rule): the popout is the only UI on screen when it is open, and a dead
// button that logs nothing is indistinguishable from a working one.
function run(command: string, action: () => Promise<unknown>): void {
  action().catch((err: unknown) => {
    console.warn(`[popout] ${command} failed:`, err);
  });
}

export function Popout(): React.ReactElement {
  // Esc dismisses; the hide lives Rust-side like every window manipulation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && insideTauri()) void invoke("hide_popout");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <PopoutErrorBoundary>
      <PopoutDash />
    </PopoutErrorBoundary>
  );
}

function PopoutDash(): React.ReactElement {
  const data = usePopoutData();
  const pendingUpdate = usePendingUpdate();
  const display = useTimeDisplay();
  const { data: settings } = useSettings();
  // 1Hz so the ring countdown crawls, like the Live tile. Throttled by the OS
  // while the window is hidden, which is exactly when nobody is looking.
  const now = useNowTick(1000);

  const view = popoutView({
    anyError: data.anyError,
    settled: data.settled,
    ready: data.ready,
    hasData: data.hasData,
    block: data.block,
    usageWindow: data.usageWindow,
    weeklyWindow: data.weeklyWindow,
    modelWindow: data.modelWindow,
    showModelLimit: settings?.showModelLimit ?? false,
    usageConnected: data.usageConnected,
    todayCost: data.todayCost,
    todayTokens: data.todayTokens,
    now,
    display,
  });

  return (
    <div className="popout-root" role="group" aria-label="MaxPrice">
      <PopoutBody view={view} />
      <div className="pdivider" aria-hidden />
      {pendingUpdate !== null ? <UpdateRow version={pendingUpdate} /> : null}
      <PopoutActions />
    </div>
  );
}

function PopoutBody({ view }: { view: PopoutViewState }): React.ReactElement {
  if (view.kind === "loading") return <div className="pbody" />;
  if (view.kind === "down") {
    return (
      <div className="pbody centered">
        <div className="pinset bad">
          <span className="pdot" aria-hidden />
          MaxPrice isn&apos;t responding — open the window to retry.
        </div>
      </div>
    );
  }
  if (view.kind === "no-data") {
    return (
      <div className="pbody centered">
        <div className="pinset">
          <span className="mini-orb" aria-hidden />
          No usage yet — MaxPrice is waiting for your first Claude Code session.
        </div>
      </div>
    );
  }

  return (
    <div className="pbody">
      <PopoutHeadRow head={view.head} />
      <LimitRow label="5-hour limit" pct={view.limitPct} />
      <LimitRow label="Weekly limit" pct={view.weeklyPct} />
      {view.modelRow !== null ? (
        <LimitRow label={view.modelRow.label} pct={view.modelRow.pct} />
      ) : null}
      <div className="prow">
        <span className="name">Today</span>
        <span className="state">
          <b className="num">{view.todayText}</b>
          <span className="num">· {view.todayTokensText}</span>
        </span>
      </div>
    </div>
  );
}

// One usage-limit row: the mini meter + percent, or the ADR-0030 em-dash at
// 0.55 row opacity when there is no fresh reading — never a stale percent.
function LimitRow({ label, pct }: { label: string; pct: number | null }): React.ReactElement {
  return (
    <div className={pct === null ? "prow limit dim" : "prow limit"}>
      <span className="name">{label}</span>
      {pct === null ? (
        <span className="state">
          <span className="num">—</span>
        </span>
      ) : (
        <span className="state">
          <span
            className="limit-meter"
            role="meter"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${label} used`}
          >
            <i style={{ width: `${pct}%` }} />
          </span>
          <b className="num">{pct}%</b>
        </span>
      )}
    </div>
  );
}

const RING_VIEWBOX = 96; // the globals.css ring recipe: viewBox 96, r 40, stroke 7

function PopoutHeadRow({ head }: { head: PopoutHead }): React.ReactElement {
  if (head.kind === "idle") {
    return <div className="pinset">No active block — start a Claude Code session to open one.</div>;
  }
  const dash = ringStrokeDasharray(head.ringFrac);
  return (
    <div className="a-head">
      <div className="ring-wrap">
        <svg
          viewBox={`0 0 ${RING_VIEWBOX} ${RING_VIEWBOX}`}
          aria-label={`Block time elapsed: ${Math.round(head.ringFrac * 100)}%`}
        >
          <defs>
            <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" className="stop-a" />
              <stop offset="1" className="stop-b" />
            </linearGradient>
          </defs>
          <circle className="ring-track" cx="48" cy="48" r="40" />
          {dash === null ? null : (
            <circle
              className="ring-fill"
              cx="48"
              cy="48"
              r="40"
              strokeDasharray={dash}
              transform="rotate(-90 48 48)"
            />
          )}
        </svg>
        <span className="ring-label">
          <b className="num">{head.centerLabel ?? "—"}</b>
        </span>
      </div>
      <div className="hd">
        <span className="eyebrow">Active block</span>
        <div className="value num">
          {head.costText}
          <span className="tokens">· {head.tokensText}</span>
        </div>
        <div className="meta num">{head.metaText}</div>
      </div>
    </div>
  );
}

// The pending-only accent update row (charter decision 6; UpdateGate's words).
// Clicking it re-raises the gate in the main window — the broadcast reaches
// UpdateGate's listener even after a "Later" dismissal — then opens the main
// window in the same gesture (the blur of which hides this popout, Rust-side).
function UpdateRow({ version }: { version: string }): React.ReactElement {
  const open = (): void => {
    if (!insideTauri()) return;
    run("open update flow", async () => {
      await emit("update:open-gate", { version });
      await invoke("open_main_window");
    });
  };
  return (
    <button type="button" className="update-row" onClick={open}>
      <span className="up" aria-hidden>
        ↑
      </span>
      Update available
      <span className="ver num">v{version}</span>
    </button>
  );
}

// The two doors out — shared verbatim with the error fallback below: whatever
// else has gone wrong, these must behave identically.
function PopoutActions(): React.ReactElement {
  return (
    <div className="actions-menu">
      <button
        type="button"
        onClick={() => run("open_main_window", () => invoke("open_main_window"))}
      >
        Open MaxPrice
      </button>
      <button type="button" onClick={() => run("quit_app", () => invoke("quit_app"))}>
        Quit MaxPrice
      </button>
    </div>
  );
}

// The popout's error boundary (the hub's pattern): a frameless tray surface
// has no titlebar, no menu and no reload — if its tree throws, React 19 tears
// the whole root down and a tray click re-shows a blank window with no way to
// reach the app or quit it. The fallback keeps both doors open.
class PopoutErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(err: unknown, info: ErrorInfo): void {
    console.error("[popout] render failed:", err, info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? <PopoutFallback /> : this.props.children;
  }
}

function PopoutFallback(): React.ReactElement {
  return (
    <div className="popout-root" role="group" aria-label="MaxPrice">
      <div className="pbody centered">
        <div className="pinset bad">
          <span className="pdot" aria-hidden />
          Popout UI error — restart the app.
        </div>
      </div>
      <div className="pdivider" aria-hidden />
      <PopoutActions />
    </div>
  );
}
