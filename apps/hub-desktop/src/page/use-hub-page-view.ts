import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { hubPageViewSchema, type HubPageView } from "@maxprice/shared";

// The Hub page's one read (ADR-0124 §4/§5), the ADR-0004 four-piece. Not in
// lib/hub-api.ts: that module reaches the Tauri shell for the operator secret,
// and the page runs in a plain browser behind the user's web server.

export function hubPageViewQueryKey(): readonly ["hub-page-view"] {
  return ["hub-page-view"] as const;
}

// Relative, no leading slash: the page is served at `<prefix>/` and its data
// at `<prefix>/view`, and the Hub cannot know the prefix a web server proxies
// it under (ADR-0124 §7).
export function buildHubPageViewUrl(): string {
  return "view";
}

// A plain GET. The route sits outside /api/*, so it takes no bearer and no
// protocol header. Every failure throws: a network error, any non-2xx (a web
// server's 502, 503 or 504 included) and a body that is not the view (an HTML
// error page) are all the query's isError, which reads "Not responding"
// (ADR-0124 §6).
export async function fetchHubPageView(signal?: AbortSignal): Promise<HubPageView> {
  const res = await fetch(buildHubPageViewUrl(), { signal });
  if (!res.ok) throw new Error(`${buildHubPageViewUrl()} ${res.status}`);
  return hubPageViewSchema.parse(await res.json());
}

// The Popout's clients cadence, 5 s, polled only while the tab is visible:
// TanStack pauses the interval while the document is hidden, and a focus
// refetch (always stale at staleTime 0) catches up the moment it is shown
// (ADR-0124 §5). No retry: each poll is a fresh reading, so a failed one reads
// "Not responding" at once rather than after a hidden retry, and the next poll
// is the retry. A failing query keeps its last view, which dims beneath the
// Hub row rather than vanishing. Always attempt the read even when the browser
// reports offline: the default online mode pauses without an error and leaves
// cached success looking live. Reconnect recovers on the next visible poll;
// `always` defaults refetchOnReconnect to false, so a hidden tab stays paused.
export function useHubPageView(): UseQueryResult<HubPageView> {
  return useQuery({
    queryKey: hubPageViewQueryKey(),
    queryFn: ({ signal }) => fetchHubPageView(signal),
    networkMode: "always",
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
    retry: false,
  });
}
