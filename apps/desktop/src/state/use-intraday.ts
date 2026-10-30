import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  buildIntradayUrl,
  intradayKey,
  intradayResponseSchema,
  normalizeIntradayInput,
  type IntradayHookInput,
  type IntradayQueryInput,
  type IntradayResponse,
} from "@maxprice/shared";
import { sidecarFetch } from "@/lib/sidecar";
import type { ReportQueryOptions } from "./report-hook";

// /api/intraday — the renderer half of Part 5's intraday span tabs (T5.4b).
//
// This honors the ADR-0004 four-piece hook split (key + URL + fetch + wrapper)
// but does NOT go through `makeReportHook`: that helper builds a `since/until`
// date-window URL, whereas `/api/intraday` windows itself on a fixed `span`
// ("15m"/"1h"/"block"/"today" — and, since ADR-0018, the endpoint serves all six
// spans, "week"/"30d" included). So the four pieces are spelled out by hand —
// the input, its normalization and the URL builder in `@maxprice/shared`'s
// `report-url.ts`, the rest here — mirroring `makeReportHook`'s structure with
// `span` in place of `since`/`until`.
//
// `/api/intraday` returns a plain JSON body (not a stream), so the wrapper is
// an ordinary TanStack `useQuery`.

// Piece 1 — the query key. `["intraday", <normalized input>]`; the key family
// "intraday" is in `DATA_QUERY_KEYS`, so cost-mode and SSE `usage:new`
// invalidation both reach this hook.
export function intradayQueryKey(opts: IntradayHookInput): ["intraday", IntradayQueryInput] {
  return intradayKey(normalizeIntradayInput(opts));
}

// Piece 3 — the fetch. Issues the GET, surfaces a non-2xx as an Error carrying
// the status + body text, and parses the body with `intradayResponseSchema`.
export async function fetchIntraday(
  opts: IntradayHookInput,
  signal: AbortSignal | undefined,
): Promise<IntradayResponse> {
  const res = await sidecarFetch(buildIntradayUrl(opts), { signal });
  if (!res.ok) throw new Error(`/api/intraday ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return intradayResponseSchema.parse(json);
}

// Piece 4 — the `useQuery` wrapper. `options.enabled: false` parks the query
// (mounted, never fetching) — the chart-source hook calls every source
// unconditionally and enables only the active one. `keepPrevious` is honoured
// here too: this wrapper is hand-rolled off `makeReportHook`'s SHARED options
// type, so silently ignoring one of its fields would make the same option mean
// different things at different call sites.
export function useIntraday(
  opts: IntradayHookInput,
  options?: ReportQueryOptions,
): UseQueryResult<IntradayResponse> {
  return useQuery<IntradayResponse>({
    queryKey: intradayQueryKey(opts),
    queryFn: ({ signal }) => fetchIntraday(opts, signal),
    enabled: options?.enabled ?? true,
    placeholderData: options?.keepPrevious ? keepPreviousData : undefined,
  });
}
