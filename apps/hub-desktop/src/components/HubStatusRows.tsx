import {
  accessDot,
  accessShortLabel,
  hubClientsLine,
  hubDaemonDot,
  hubDaemonLabel,
  hubDotPulse,
  isDeliberateLoopback,
  noFreshReading,
  usageConnectionDot,
  usageConnectionShortLabel,
  type HubDaemonState,
  type HubRowStatus,
} from "@maxprice/shared";
import { dotVariant } from "@/lib/dot-variant";

// The hub Popout's three status rows and its clients line (ADR-0050), as one
// props-only component (ADR-0124 §7): the Popout renders it, and so does the
// Hub page (src/page/HubPage.tsx), over the same CSS recipe
// (styles/hub-rows.css). It reads only
// @maxprice/shared and the dot translation, never the Tauri shell, because the
// page renders it in a plain browser. The words all come from the Hub rows
// (@maxprice/shared's hub-rows.ts); nothing here re-derives a state.
//
// The row NAMES are deliberately shorter than the console cards they mirror
// ("Hub" / "claude.ai", not "Hub status" / "Claude account"): they name a
// subject the surrounding chrome has already established, and every pixel
// they save comes off the window's configured width (tauri.conf.json). Same
// reasoning as `usageConnectionShortLabel` / `accessShortLabel` on the value
// side — this is a glance surface, not a card.
export function HubStatusRows({
  daemon,
  status,
  liveClients,
}: {
  daemon: HubDaemonState;
  // The Popout passes its full HubStatus; the page passes its view.
  status: HubRowStatus | undefined;
  // The live clients count; null while the roster has not been fetched.
  liveClients: number | null;
}): React.ReactElement {
  // No fresh reading while the daemon is starting / not responding / stopped:
  // the dependent rows dim to a soft dot + em-dash rather than rendering stale
  // claims beside a dead-daemon row (the trayTooltip rule, applied twice).
  const dim = noFreshReading(daemon);
  const conn = status?.usageConnection ?? "disconnected";
  const passworded = status?.passwordProtected ?? false;
  const clients = hubClientsLine(daemon, liveClients);

  return (
    <div className="prows" role="group" aria-label="Hub status">
      <Row
        name="Hub"
        dot={dotVariant(hubDaemonDot(daemon, isDeliberateLoopback(status)))}
        pulse={hubDotPulse(daemon)}
        state={hubDaemonLabel(daemon)}
      />
      <Row
        name="claude.ai"
        dim={dim}
        dot={dim ? "soft" : dotVariant(usageConnectionDot(conn))}
        state={dim ? "—" : usageConnectionShortLabel(conn)}
      />
      <Row
        name="Access"
        dim={dim}
        dot={dim ? "soft" : dotVariant(accessDot(passworded))}
        state={dim ? "—" : accessShortLabel(passworded)}
      />
      {/* Left-aligned, no dot (T1): the count leads, flush with the dots'
          edge. Dims with the others — and an unfetched roster reads as the
          same honest em-dash, never a stale number. The noun agrees with the
          count, "1 connected client" (ADR-0124 §7), and stays one text node
          after the <b>, as the line always was. A stopped daemon has none. */}
      {clients === null ? null : (
        <div className={clients.count === null ? "prow dim" : "prow"}>
          <span className="state clients">
            {clients.count === null ? (
              `— ${clients.noun}`
            ) : (
              <>
                <b>{clients.count}</b>
                {` ${clients.noun}`}
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function Row({
  name,
  dot,
  state,
  dim = false,
  pulse = false,
}: {
  name: string;
  dot: string;
  state: string;
  dim?: boolean;
  pulse?: boolean;
}): React.ReactElement {
  return (
    <div className={dim ? "prow dim" : "prow"}>
      <span aria-hidden className={`dot ${dot}${pulse ? " pulse-anim" : ""}`} />
      <span className="name">{name}</span>
      <span className="state">{state}</span>
    </div>
  );
}
