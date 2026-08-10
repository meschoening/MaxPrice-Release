import { formatRelativeTime } from "@maxprice/shared";
import { useHubClients } from "@/state/use-hub-clients";
import { useNowTick } from "@/state/use-now-tick";
import { dotVariant } from "@/lib/dot-variant";
import {
  clientPrimaryLabel,
  clientStateDot,
  formatCount,
  shortMachineId,
  sortClients,
} from "@/lib/presentation";

// The M3 roster card — the degrade target when the daemon doesn't speak event
// sync (the App swaps here on the 404 probe). Wears the same glass row
// language as the Machines card, minus the kebab flows.

export function ClientsRosterCard(): React.ReactElement {
  const { data, isError, isPending } = useHubClients();
  const now = useNowTick();
  const clients = data !== undefined ? sortClients(data.clients) : [];

  return (
    <section className="panel card" aria-label="Connected clients">
      <div className="card-head">
        <span className="eyebrow">Connected clients</span>
        <span className="status">{data !== undefined ? formatCount(clients.length) : "—"}</span>
      </div>
      <div>
        {isPending ? (
          <p className="hint">Loading…</p>
        ) : isError ? (
          <p className="err">Couldn&rsquo;t reach the hub.</p>
        ) : clients.length === 0 ? (
          <p className="hint">No clients connected.</p>
        ) : (
          clients.map((c) => (
            <div key={c.machineId} className="mrow">
              <div className="mrow-top">
                <span aria-hidden className={`dot ${dotVariant(clientStateDot(c.live))}`} />
                <span className="mname">{clientPrimaryLabel(c)}</span>
                <span className="mid">{shortMachineId(c.machineId)}</span>
                <span className="mcount">
                  {c.live ? "live" : `seen ${formatRelativeTime(c.lastSeenAt, now)}`}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
