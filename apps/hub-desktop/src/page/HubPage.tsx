import type { UseQueryResult } from "@tanstack/react-query";
import { hubDaemonState, type HubDaemonState, type HubPageView } from "@maxprice/shared";
import { HubStatusRows } from "@/components/HubStatusRows";
import { useHubPageView } from "./use-hub-page-view";
import { useTab } from "./use-tab";
import { useVersionReload } from "./version-reload";

// The Hub page (ADR-0124 §7, layout D of #452's prototype): a read-only mirror
// of the hub Popout's rows for a Headless Hub, which has no tray. Its own
// state is one poll of the view; the rows and their words are the Popout's
// (HubStatusRows over @maxprice/shared's hub-rows.ts), and nothing here
// re-derives one.
export function HubPage({ host }: { host: string }): React.ReactElement {
  const query = useHubPageView();
  const view = query.data;
  const daemon = pageDaemonState(query);
  useTab(daemon, view);
  useVersionReload(view?.version);
  return <HubPageLayout host={host} daemon={daemon} view={view} />;
}

// The Hub row's state from the page's one query. A browser has no firewall
// verdict and no exit record, the two shell facts the Popout adds, so the page
// never reads "Stopped": every failure is "Not responding" (ADR-0124 §6).
//
// And it stays "Not responding" until a poll succeeds. TanStack Query puts a
// query that holds no data back to `pending` whenever a fetch starts, so
// `isError` alone would turn a page whose polls have only ever failed back to
// "Starting…" at every poll, for as long as each poll takes. Starting… is for
// the first poll alone; `errorUpdateCount` remembers that one has failed. A
// page that holds a view keeps `isError` through the next fetch on its own.
export function pageDaemonState({
  data,
  isError,
  errorUpdateCount,
}: Pick<UseQueryResult<HubPageView>, "data" | "isError" | "errorUpdateCount">): HubDaemonState {
  const failed = isError || (data === undefined && errorUpdateCount > 0);
  return hubDaemonState(failed, data, undefined, false);
}

// The page's markup, props only: the console's pill header with the host on
// its right, one Glass panel holding the rows, then the footer. The version
// is the view's, the Hub's own, absent until a view arrives; a failing poll
// keeps its last view, so the version stays while the rows dim.
export function HubPageLayout({
  host,
  daemon,
  view,
}: {
  // location.host, verbatim: the web server's name, or 127.0.0.1:<port>
  // through an SSH tunnel.
  host: string;
  daemon: HubDaemonState;
  view: HubPageView | undefined;
}): React.ReactElement {
  return (
    <div className="hub-page">
      <header className="hub-header">
        <span className="logo rack" aria-hidden />
        <h1 className="wordmark">MaxPrice Hub</h1>
        <span className="hub-page-host">{host}</span>
      </header>
      <main className="hub-page-main">
        <div className="panel hub-page-card">
          <HubStatusRows daemon={daemon} status={view} liveClients={view?.liveClients ?? null} />
        </div>
        <p className="hub-page-foot">
          {`Read-only · refreshes every 5 s${view === undefined ? "" : ` · v${view.version}`}`}
        </p>
      </main>
    </div>
  );
}
