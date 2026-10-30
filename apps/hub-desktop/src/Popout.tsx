import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { hubDaemonState, liveClientCount } from "@maxprice/shared";
import { HubStatusRows } from "@/components/HubStatusRows";
import { useHubDaemonExited } from "@/state/use-hub-daemon-exited";
import { useHubStatus } from "@/state/use-hub-status";
import { useHubClients } from "@/state/use-hub-clients";
import { useHubStream } from "@/state/use-hub-stream";
import { useFirewallCheck } from "@/state/use-firewall";
import { hidePopout, openMainWindow, quitApp, relaunchApp, setTrayTooltip } from "@/lib/tauri";
import { applyStoredTheme } from "@/lib/theme";
import { trayTooltip } from "@/lib/presentation";

// Fire a Tauri command and log its rejection — never `void` it. Both sides of
// these calls name the command with a STRING (lib/tauri.test.ts pins all three
// precisely because a one-sided rename fails silently), and the popout is the
// only hub UI on screen when it is open: a dead button that logs nothing is
// indistinguishable from a working one. The label IS the command name, so the
// warning points straight at the pinned string.
function run(command: string, action: () => Promise<void>): void {
  action().catch((err: unknown) => {
    console.warn(`[hub] ${command} failed:`, err);
  });
}

// The tray popout (ADR-0050, T1 variant A "leaf"): the glance surface that
// replaced the native two-item tray menu. Read-only stacked rows — the three
// console card-head chips compressed, then the live clients count — a
// divider, and the two actions. A stopped daemon (ADR-0112) trades the clients
// count for a third action, Restart hub, ahead of the two. The rows and the
// clients line are HubStatusRows, which the Hub page renders too
// (ADR-0124 §7); their words come from @maxprice/shared's hub-rows.ts and the
// tooltip's from presentation.ts. Nothing here re-derives a state.
export function Popout(): React.ReactElement {
  const { data: status, isError } = useHubStatus();
  const { data: firewall } = useFirewallCheck();
  // A focus refetch so re-opening corrects the last-shown count within one
  // loopback round-trip: showing the window flips document.visibilityState,
  // and the app-wide default disables focus refetch — the popout is the
  // surface that wants it. Accepted artifact per T3: the count can be a blink
  // stale on open.
  const { data: clients } = useHubClients({ refetchOnFocus: true });

  const exited = useHubDaemonExited(isError);
  const daemon = hubDaemonState(isError, status, firewall, exited);
  // A stopped daemon (ADR-0112 §6) trades the clients line for the Restart hub
  // door: HubStatusRows drops the line, and the actions put Restart hub ahead
  // of the two. The window is a fixed 224px with no room for a third action,
  // and a dead daemon has no clients to count.
  const stopped = daemon === "stopped";

  // theme-boot.js stamps <html data-theme> once before first paint and
  // re-stamps only on an OS flip. This webview is created at launch and only
  // ever hidden/shown (never reloaded), so that boot stamp would otherwise be
  // frozen for the whole process — cycling the console's theme chip would
  // leave the popout in the launch mode, and globals.css keys the popout's
  // opaque wash off `:root[data-theme]`. Re-stamp from storage on every show.
  //
  // No IPC needed, and deliberately none: the popout blur-hides the instant
  // the console takes focus, so it can never be VISIBLE while the chip is
  // cycled — a stamp on show is always current. The `storage` listener is
  // belt-and-braces (the two webviews are same-origin, so it may fire live),
  // never the path this relies on.
  useEffect(() => {
    applyStoredTheme();
    const onVisibility = (): void => {
      if (document.visibilityState !== "hidden") applyStoredTheme();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("storage", applyStoredTheme);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("storage", applyStoredTheme);
    };
  }, []);

  // Esc dismisses. The keydown is ours; the hide is Rust's (T3: all window
  // manipulation lives in Rust — blur dismissal never reaches this file).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") run("hide_popout", hidePopout);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const count = clients !== undefined ? liveClientCount(clients.clients) : null;

  // `role="group"`, not `role="menu"`: the frame owns three read-only status
  // rows and the clients line as well as the two buttons, and no arrow-key
  // navigation exists (Esc is the only key we handle). The role can't simply
  // be dropped — an `aria-label` on a role-less generic div is not exposed —
  // so it names the surface instead of advertising navigation we don't
  // implement. MachinesCard's `role="menu"` is a real menu and stays.
  return (
    <div className="popout-frame" role="group" aria-label="MaxPrice Hub">
      <HubStatusRows daemon={daemon} status={status} liveClients={count} />
      <div className="pdivider" aria-hidden />
      <PopoutActions restart={stopped} />
    </div>
  );
}

// The two doors out, shared verbatim with the error fallback below — whatever
// else has gone wrong, these must behave identically. A stopped daemon puts
// Restart hub ahead of them (ADR-0112 §6): the shell never respawns the
// daemon, so relaunching the whole hub app is the one way back.
function PopoutActions({ restart = false }: { restart?: boolean }): React.ReactElement {
  return (
    <div className="pactions">
      {restart ? (
        <button type="button" onClick={() => run("relaunch_app", relaunchApp)}>
          Restart hub
        </button>
      ) : null}
      <button type="button" onClick={() => run("open_main_window", openMainWindow)}>
        Open window
      </button>
      <button type="button" onClick={() => run("quit_app", quitApp)}>
        Quit MaxPrice Hub
      </button>
    </div>
  );
}

// The tray tooltip is driven from the popout webview, not the console
// (ADR-0050 amending ADR-0049): the popout is the semantic tray surface, it is
// always-alive (pre-created, only ever hidden), and it must open showing
// current chips — one webview, one writer. Rejections are logged, never
// swallowed: while both windows are hidden the tooltip is the only hub UI,
// and a silently frozen one is indistinguishable from a quiet hub.
//
// It is a render-nothing SIBLING of <Popout/> rather than an effect inside it,
// mounted outside the error boundary: React 19 unmounts the whole root on an
// uncaught render error, so an effect living in Popout would die with it and
// pin the tooltip on its last string forever. The SSE subscription rides along
// for the same reason — it exists to flip this tooltip fast when the daemon
// dies (no directory callbacks; the popout renders no directory).
export function TrayTooltip(): null {
  useHubStream({ directories: false });
  const { data: status, isError } = useHubStatus();
  const { data: firewall } = useFirewallCheck();
  const exited = useHubDaemonExited(isError);

  const tooltip = trayTooltip(
    hubDaemonState(isError, status, firewall, exited),
    status?.usageConnection,
  );
  useEffect(() => {
    setTrayTooltip(tooltip).catch((err: unknown) => {
      console.warn("[hub] tray tooltip update failed:", err);
    });
  }, [tooltip]);

  return null;
}

// The popout's error boundary — local to this file on purpose, not a general
// facility (it is the app's only one). The popout is a frameless 224x224 tray
// surface with no titlebar, no menu and no reload: if its tree throws, React
// 19 tears the whole root down and the tray click re-shows a blank window with
// no way to reach the console or quit the hub. The fallback keeps both doors
// open at the popout's own size and styling.
export class PopoutErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(err: unknown, info: ErrorInfo): void {
    console.error("[hub] popout render failed:", err, info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? <PopoutFallback /> : this.props.children;
  }
}

// One honest row plus the actions. Copy is cut to the popout's width budget
// (the row's `.state` ellipsizes rather than reflows, but it should not have
// to); recovery really is a relaunch — the boundary's state lives as long as
// this never-reloaded webview does.
function PopoutFallback(): React.ReactElement {
  return (
    <div className="popout-frame" role="group" aria-label="MaxPrice Hub">
      <div className="prows">
        <div className="prow">
          <span aria-hidden className="dot bad" />
          <span className="name">Hub UI error</span>
          <span className="state">restart the app</span>
        </div>
      </div>
      <div className="pdivider" aria-hidden />
      <PopoutActions />
    </div>
  );
}
