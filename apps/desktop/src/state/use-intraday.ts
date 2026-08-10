import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  intradayKey,
  intradayResponseSchema,
  type CostMode,
  type IntradayQueryInput,
  type IntradayResponse,
  type Span,
} from "@maxprice/shared";
import { sidecarFetch } from "@/lib/sidecar";
import { appendFilterParams, type ReportQueryOptions } from "./report-hook";

// /api/intraday — the renderer half of Part 5's intraday span tabs (T5.4b).
//
// This honors the ADR-0004 four-piece hook split (key + URL + fetch + wrapper)
// but does NOT go through `makeReportHook`: that helper builds a `since/until`
// date-window URL, whereas `/api/intraday` windows itself on a fixed `span`
// ("15m"/"1h"/"block"/"today" — and, since ADR-0018, the endpoint serves all six
// spans, "7d"/"30d" included). So the four pieces are spelled out here,
// mirroring `report-hook.ts`'s structure with `span` in place of `since`/`until`.
//
// `/api/intraday` returns a plain JSON body (not a stream), so the wrapper is
// an ordinary TanStack `useQuery`.

// The hook's loose input. `mode` is optional and defaults to "auto" in
// `normalize` below; `projects` / `models` are the filter rail's multi-select
// passthroughs, serialized as repeated query params.
export type IntradayHookInput = {
  span: Span;
  mode?: CostMode;
  // `tz` (Part 6, ADR-0015) — the `today` span anchors its calendar-day window
  // to local midnight in this zone (ADR-0020), so it is load-bearing there; the
  // now-relative spans (`15m`/`1h`/`7d`/`30d`) and the server-resolved `block`
  // window ignore it. Carried for every span so a Timezone-setting change re-keys.
  tz?: string;
  // The bucket duration in ms (ADR-0018). Omitted → the endpoint's per-span
  // bars default; the line path passes `lineGranularityFor(span)`.
  bucketMs?: number;
  // Lean-payload flags (ADR-0018). Default true (the endpoint's default); a
  // caller sets `includePrevious: false` when the ghost is off and
  // `includeByProject: false` outside the by-project group-by, so the dense
  // line spans don't ship series they won't draw.
  includePrevious?: boolean;
  includeByProject?: boolean;
  // ADR-0041 (M6): the per-machine map, mirroring `includeByProject`. Changes
  // the response body, so it re-keys; a caller sets it true only for the machine
  // group-by. Emitted as `byMachine=1` ONLY when true — its absent form is the
  // endpoint's false default, keeping every non-machine URL byte-identical.
  includeByMachine?: boolean;
  projects?: string[];
  models?: string[];
  // The machine filter axis (ADR-0041 M6) — raw machine ids, serialized as
  // repeated `machine=` params (same passthrough as `models`).
  machines?: string[];
};

// Collapse the loose hook input into the canonical `IntradayQueryInput` used
// for both the cache key and the URL params, defaulting `mode` to "auto". One
// copy — key, URL, and fetch all normalize identically so TanStack's cache
// keying stays stable (ADR-0004).
function normalize(opts: IntradayHookInput): IntradayQueryInput {
  return {
    span: opts.span,
    mode: opts.mode ?? "auto",
    tz: opts.tz,
    bucketMs: opts.bucketMs,
    includePrevious: opts.includePrevious,
    includeByProject: opts.includeByProject,
    includeByMachine: opts.includeByMachine,
    projects: opts.projects,
    models: opts.models,
    machines: opts.machines,
  };
}

// Piece 1 — the query key. `["intraday", <normalized input>]`; the key family
// "intraday" is in `DATA_QUERY_KEYS`, so cost-mode and SSE `usage:new`
// invalidation both reach this hook.
export function intradayQueryKey(opts: IntradayHookInput): ["intraday", IntradayQueryInput] {
  return intradayKey(normalize(opts));
}

// Piece 2 — the URL builder. Sets the `span` window param, then defers to the
// shared `appendFilterParams` (report-hook.ts) for `mode` / `tz` / repeated
// `project` / `model` — the same serialization `buildReportUrl` uses, so the
// query strings stay byte-identical across the two builders (f21).
export function buildIntradayUrl(opts: IntradayHookInput): string {
  const input = normalize(opts);
  const params = new URLSearchParams();
  params.set("span", input.span);
  appendFilterParams(params, input);
  // ADR-0018: an explicit bucket size for the line path. `prev` / `byProject`
  // are only emitted when FALSE — their absent form is the endpoint's `true`
  // default, so the bars/short-span URLs stay byte-identical to before.
  if (input.bucketMs !== undefined) params.set("bucketMs", String(input.bucketMs));
  if (input.includePrevious === false) params.set("prev", "0");
  if (input.includeByProject === false) params.set("byProject", "0");
  // ADR-0041 (M6): the machine map is emitted only when TRUE — its absent form
  // is the endpoint's false default, so every non-machine URL stays
  // byte-identical to pre-M6 (the two-bit sourcing rule).
  if (input.includeByMachine === true) params.set("byMachine", "1");
  return `/api/intraday?${params.toString()}`;
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
// unconditionally and enables only the active one.
export function useIntraday(
  opts: IntradayHookInput,
  options?: ReportQueryOptions,
): UseQueryResult<IntradayResponse> {
  return useQuery<IntradayResponse>({
    queryKey: intradayQueryKey(opts),
    queryFn: ({ signal }) => fetchIntraday(opts, signal),
    enabled: options?.enabled ?? true,
  });
}
