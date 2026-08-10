import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { hubMachinesQueryKey, hubStatusQueryKey } from "@/lib/hub-api";
import { subscribeHubStream } from "@/lib/hub-stream";

// Opens the hub SSE channel for the window's lifetime; a hub:status / hub:sample
// frame invalidates the status query (which re-fetches connection, sampleCount,
// last sample). The roster has its own refetchInterval (no client-event frames).
//
// `machines: false` is the popout's option (ADR-0050): it renders no directory,
// so there is nothing for a directory frame to refresh. Its subscription exists
// for the other half — the popout owns the tray tooltip, and this is what flips
// it fast when the daemon dies instead of waiting out the status query's 30s
// backstop. A second loopback SSE connection beside the console's is negligible.
export function useHubStream({ machines = true }: { machines?: boolean } = {}): void {
  const qc = useQueryClient();
  useEffect(() => {
    return subscribeHubStream({
      onStatus: () => void qc.invalidateQueries({ queryKey: hubStatusQueryKey() }),
      // A directory change (registration / rename / merge / purge) refreshes
      // the Machines card immediately; stats drift is covered by its 5s poll.
      ...(machines
        ? { onMachines: () => void qc.invalidateQueries({ queryKey: hubMachinesQueryKey() }) }
        : {}),
      // Losing the channel is itself a status change: the same dead daemon that
      // drops the SSE read also fails /api/status. Re-run the query NOW rather
      // than waiting out its 30s interval — `invalidateQueries` refetches active
      // observers directly, with no `focusManager` gate, which matters because
      // the window is normally hidden (ADR-0049). This also recovers the
      // inverse: a query that errored before the daemon's LISTENING handshake
      // landed gets retried the moment the stream reconnects and drops again.
      // Rate-limited by subscribeHubStream's backoff — one call per cycle.
      onDisconnect: () => void qc.invalidateQueries({ queryKey: hubStatusQueryKey() }),
    });
  }, [qc, machines]);
}
