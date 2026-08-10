import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { HubStatus } from "@maxprice/shared";
import { fetchHubStatus, hubStatusQueryKey } from "@/lib/hub-api";

export function useHubStatus(): UseQueryResult<HubStatus> {
  return useQuery({
    queryKey: hubStatusQueryKey(),
    queryFn: ({ signal }) => fetchHubStatus(signal),
    refetchInterval: 30_000, // backstop if the SSE channel drops
    // LOAD-BEARING, do not strip (ADR-0049, re-aimed by ADR-0050). Both hub
    // windows are hidden as their NORMAL state — the console closes to tray,
    // the popout only ever hides — and the hidden popout is the tray tooltip's
    // one writer, composed from THIS query; it must also open already showing
    // current chips. TanStack gates its interval fetch on
    // `refetchIntervalInBackground || focusManager.isFocused()`, and
    // `isFocused()` is `document.visibilityState !== "hidden"`; without this
    // flag the poll would stop exactly in the fault case, freezing `status` /
    // `isError` and pinning the tooltip on a stale reading (in either
    // direction). It is a loopback GET, so polling while hidden costs nothing.
    //
    // The console shares this hook, so a hidden console also keeps polling —
    // no reader, and it is deliberately NOT gated behind an option. The cost is
    // one loopback GET per 30s per hidden webview, on top of an SSE-driven
    // refetch that already fires about once a minute; nothing expensive hangs
    // off it (the `netsh` firewall check is `useFirewallCheck`, which is
    // focus-driven with no interval). An accepted no-op, and the same flag is
    // what keeps the popout's rows warm before it is ever shown.
    //
    // Honest caveat: hidden-page timer throttling can stretch the interval, so
    // this bounds staleness in practice rather than guaranteeing 30s — fast
    // detection comes from `useHubStream`'s `onDisconnect` invalidation.
    refetchIntervalInBackground: true,
  });
}
