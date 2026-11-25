import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import {
  LIMIT_STATE_WORDS,
  popoutView,
  rankedPopoutView,
  type PopoutHead,
  type PopoutLimitRow,
  type PopoutViewState,
  type RankedPopoutRow,
  type RankedPopoutViewState,
} from "@maxprice/shared";
import { insideTauri } from "../lib/tauri";
import { relaunchApp } from "../lib/relaunch";
import { ringStrokeDasharray } from "../lib/ring-stroke";
import { cn } from "../lib/utils";
import { MembershipNameView } from "./membership-name";
import { usePendingUpdate, usePopoutData } from "../state/use-popout-data";
import { useNowTick } from "../state/use-now-tick";
import { useSettings } from "../state/use-settings";

// The tray popout mini-dashboard (map #168 M3; the T3-approved "leaf" variant,
// ADR-0050): a 54px ring on the most used window (ADR-0142 §2), quiet limit
// rows — a row per window the plan reports, <Model>-limit setting-gated, or
// with several Memberships a row each — then Today (cost · tokens), a
// pending-only accent update row, and Open / Quit as kmenu items. Every quantity is a popout-owned sidecar fetch
// (use-popout-data — T5 decision 8); every window manipulation lives Rust-side
// (ADR-0050 — blur dismissal never reaches this file; Esc invokes hide_popout).
//
// The event this bundle listens for ("popout:shown") and the commands the
// buttons invoke (Open, Quit, and Relaunch after an Engine stop) are the
// popout's whole IPC surface, per the ACL note in capabilities/popout.json.

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
  // 1Hz so the head's reset countdown stays current. Throttled by the OS
  // while the window is hidden, which is exactly when nobody is looking.
  const now = useNowTick(1000);
  const data = usePopoutData();
  const pendingUpdate = usePendingUpdate();
  const { data: settings } = useSettings();

  const ladder = {
    anyError: data.anyError,
    engineStopped: data.engineStopped,
    settled: data.settled,
    ready: data.ready,
    hasData: data.hasData,
    todayCost: data.todayCost,
    todayTokens: data.todayTokens,
    now,
    allOrganizations: data.allOrganizations,
  };
  const ranked = data.ranked === null ? null : rankedPopoutView({ ...ladder, ...data.ranked });
  const view = popoutView({
    ...ladder,
    reading: data.reading,
    usageConnection: data.usageConnection,
    limits: data.limits,
    windowStates: data.windowStates,
    plan: data.plan,
    showModelLimit: settings?.showModelLimit ?? false,
    quotaTag: data.quotaTag,
  });

  const drawn = ranked ?? view;

  return (
    <div className="popout-root" role="group" aria-label="MaxPrice">
      {ranked === null ? <PopoutBody view={view} /> : <RankedPopoutBody view={ranked} />}
      <div className="pdivider" aria-hidden />
      {pendingUpdate !== null ? <UpdateRow version={pendingUpdate} /> : null}
      <PopoutActions relaunch={drawn.kind === "down" && drawn.stopped} />
    </div>
  );
}

// Exported for its test: pure over the view state, unlike the hook-fed dash.
export function PopoutBody({ view }: { view: PopoutViewState }): React.ReactElement {
  if (view.kind === "loading") return <div className="pbody" />;
  if (view.kind === "down") {
    return (
      <div className="pbody centered">
        <div className="pinset bad">
          <span className="pdot" aria-hidden />
          {view.stopped ? (
            "MaxPrice’s engine stopped — relaunch to start it again."
          ) : (
            <>MaxPrice isn&apos;t responding — open the window to retry.</>
          )}
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
      {view.rows.map((row) => (
        <LimitRow key={row.kind} row={row} />
      ))}
      <TodayRow label={view.todayLabel} cost={view.todayText} tokens={view.todayTokensText} />
    </div>
  );
}

function TodayRow({
  label,
  cost,
  tokens,
}: {
  label: string;
  cost: string;
  tokens: string;
}): React.ReactElement {
  return (
    <div className="prow">
      <span className="name">{label}</span>
      <span className="state">
        <b className="num">{cost}</b>
        <span className="num">· {tokens}</span>
      </span>
    </div>
  );
}

// The ranked Popout (#638; #610's "head + ranked"): the most used window's
// head, the four most used Memberships a row each, `+N more` past four, then
// Today. Every row is one `.prow` (30px and a 1px gap), the height the shell
// gives each limit row (`popout_content_height`). Exported for its test; the
// ladder's other states are `PopoutBody`'s.
export function RankedPopoutBody({ view }: { view: RankedPopoutViewState }): React.ReactElement {
  if (view.kind !== "ranked") return <PopoutBody view={view} />;
  return (
    <div className="pbody">
      <PopoutHeadRow head={view.head} />
      {view.rows.map((row) => (
        <RankedRow key={row.key} row={row} />
      ))}
      {view.more !== null ? (
        <div className={cn("prow pmore", view.more.hot && "hot")}>
          <span className="name">{view.more.text}</span>
          {view.more.note !== null ? <span className="state num">{view.more.note}</span> : null}
        </div>
      ) : null}
      <TodayRow label={view.todayLabel} cost={view.todayText} tokens={view.todayTokensText} />
    </div>
  );
}

// One Membership: its name (`wk` for a window that is not the 5-hour one),
// then its most used live window's meter and percent. A stale reading keeps
// its last-known percent, greyed, with "key expired" in the meter's place; an
// idle one the em-dash on an empty track (#320); the rest its state's words
// (`LIMIT_STATE_WORDS`), dimmed. The name keeps its plan word ahead of its
// Account half, whose end stays (`MembershipNameView`), and its meter is
// narrower than the one-Membership rows' to leave the name the room (#746).
function RankedRow({ row }: { row: RankedPopoutRow }): React.ReactElement {
  const name = (
    <span className="name pname">
      <MembershipNameView name={row.name} className="pname-text" title={row.label} />
      {row.windowTag !== null ? <span className="pwtag">{row.windowTag}</span> : null}
    </span>
  );
  if (row.state === "readable" && row.pct !== null) {
    return (
      <div className="prow limit">
        {name}
        <span className="state">
          <span
            className="limit-meter"
            role="meter"
            aria-valuenow={row.pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${row.label} used`}
          >
            <i style={{ width: `${row.pct}%` }} data-tone={row.tone ?? undefined} />
          </span>
          <b className="num">{row.pct}%</b>
        </span>
      </div>
    );
  }
  if (row.state === "stale") {
    return (
      <div className="prow limit stale" data-state="stale">
        {name}
        <span className="state">
          <span className="pnote">{LIMIT_STATE_WORDS.stale}</span>
          <b className="num">{row.pct === null ? "—" : `${row.pct}%`}</b>
        </span>
      </div>
    );
  }
  if (row.state === "idle" || row.state === "readable") {
    return (
      <div className="prow limit dim">
        {name}
        <span className="state">
          <span className="limit-meter" aria-hidden />
          <span className="num">—</span>
        </span>
      </div>
    );
  }
  return (
    <div className="prow limit dim" data-state={row.state}>
      {name}
      <span className="state">
        <span className="pnote">{LIMIT_STATE_WORDS[row.state]}</span>
      </span>
    </div>
  );
}

// One limit row of the one-Membership Popout: the mini meter + percent, or
// the ADR-0030 em-dash at 0.55 row opacity when there is no fresh reading —
// never a stale percent. An idle window's em-dash keeps the meter's track
// beside it (#320), unfilled and hidden from assistive tech, so the row
// keeps its bar without the bar reading as a measured 0%. A plan with no
// such limit says so in the meter's place (`none on Ultra`, ADR-0142 §2).
function LimitRow({ row }: { row: PopoutLimitRow }): React.ReactElement {
  const { label, pct } = row;
  return (
    <div className={pct === null ? "prow limit dim" : "prow limit"}>
      <span className="name">{label}</span>
      {row.note !== null ? (
        <span className="state">
          <span className="pnote">{row.note}</span>
        </span>
      ) : pct === null ? (
        <span className="state">
          {row.emptyTrack ? <span className="limit-meter" aria-hidden /> : null}
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
            <i style={{ width: `${pct}%` }} data-tone={row.tone ?? undefined} />
          </span>
          <b className="num">{pct}%</b>
        </span>
      )}
    </div>
  );
}

const RING_VIEWBOX = 96; // the globals.css ring recipe: viewBox 96, r 40, stroke 7

// The head (ADR-0142 §2): the most used window's ring, its eyebrow
// `Most used · <Membership>` while it names one (the Membership alone when its
// name has an Account half, #746), else `Most used · <window>`
// (the window then leads the meta line), `64% used` and its reset, and
// `Ultra: no 5-hour limit` on a line of its own where it applies; an empty
// ring reading `Nothing used` while no window is in flight; the inset while
// no limit can be read. The Membership's name keeps its plan word ahead of
// its Account half, whose end stays (`MembershipNameView`).
function PopoutHeadRow({ head }: { head: PopoutHead }): React.ReactElement {
  if (head.kind === "none") {
    return <div className="pinset">No limits read — connect an Account in Settings.</div>;
  }
  // A name with an Account half (two Memberships of one Organization) takes
  // the lead's place: beside `Most used`, the eyebrow's 142px held neither
  // its plan word nor its Account whole (#746).
  const named = head.name;
  const lead = <span className="eyebrow-lead">Most used</span>;
  const eyebrow = (
    <span className="eyebrow eyebrow-named">
      {named === null ? (
        <>
          {lead}
          {head.kind === "ring" ? (
            <span className="eyebrow-tag eyebrow-window"> · {head.window}</span>
          ) : null}
        </>
      ) : named.account !== null ? (
        <MembershipNameView name={named} className="eyebrow-tag" title={head.title} />
      ) : (
        <>
          {lead}
          <span className="eyebrow-tag eyebrow-sep"> · </span>
          <MembershipNameView name={named} className="eyebrow-tag" title={head.title} />
        </>
      )}
    </span>
  );
  if (head.kind === "idle") {
    return (
      <div className="a-head idle-ring">
        <HeadRing frac={0} label={null} ariaLabel="No window in use" />
        <div className="hd">
          {eyebrow}
          <div className="value idle-value">Nothing used</div>
        </div>
      </div>
    );
  }
  return (
    <div className="a-head">
      <HeadRing
        frac={head.ringFrac}
        label={head.centerLabel}
        ariaLabel={`Most used limit: ${head.valueText}`}
      />
      <div className="hd">
        {eyebrow}
        <div className="value num">{head.valueText}</div>
        <div className="meta num">{head.metaText}</div>
        {head.note !== null ? <div className="meta note">{head.note}</div> : null}
      </div>
    </div>
  );
}

function HeadRing({
  frac,
  label,
  ariaLabel,
}: {
  frac: number;
  label: string | null;
  ariaLabel: string;
}): React.ReactElement {
  const dash = ringStrokeDasharray(frac);
  return (
    <div className="ring-wrap">
      <svg viewBox={`0 0 ${RING_VIEWBOX} ${RING_VIEWBOX}`} aria-label={ariaLabel}>
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
        <b className="num">{label ?? "—"}</b>
      </span>
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
// else has gone wrong, these must behave identically. After an Engine stop a
// third leads them (ADR-0112 §4): Relaunch, the one way back, which restarts
// the app without `--hidden` so the window comes back even after a login
// launch. Exported for its test.
export function PopoutActions({ relaunch = false }: { relaunch?: boolean }): React.ReactElement {
  return (
    <div className="actions-menu">
      {relaunch ? (
        <button type="button" onClick={() => run("relaunch_app", relaunchApp)}>
          Relaunch MaxPrice
        </button>
      ) : null}
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
