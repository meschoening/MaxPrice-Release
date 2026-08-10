import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { CostMode, QueryInput } from "@maxprice/shared";
import type { z } from "zod";
import { sidecarFetch } from "@/lib/sidecar";

// The uniform query-input shape accepted by every /api/<report> hook. `mode`
// is optional here and defaults to "auto" in `normalize`; `projects` /
// `models` are the filter rail's multi-select passthroughs (Part 4).
export type ReportQueryInput = {
  since?: string;
  until?: string;
  mode?: CostMode;
  // `tz` (Part 6, ADR-0015) — the IANA zone reports bucket local days into.
  // Optional; an omitted `tz` defaults to the host zone sidecar-side.
  tz?: string;
  projects?: string[];
  models?: string[];
  // The machine filter axis (ADR-0041 M6) — raw machine ids post-alias-expansion
  // (the renderer expands merge-alias closures before calling). Serialized as
  // repeated `machine=` params, mirroring `models`.
  machines?: string[];
};

// Collapse a hook's loose input into the canonical QueryInput used for both
// the cache key and the URL params, defaulting `mode` to "auto". One copy —
// the key, the URL, and the fetch all normalize identically so TanStack's
// cache keying stays stable (ADR-0004).
export function normalize(opts: ReportQueryInput): QueryInput {
  return {
    since: opts.since,
    until: opts.until,
    mode: opts.mode ?? "auto",
    tz: opts.tz,
    projects: opts.projects,
    models: opts.models,
    machines: opts.machines,
  };
}

// Shared serializer for the filter params common to every report URL — `mode`,
// the optional `tz`, and the repeated `project` / `model` multi-selects. Called
// by `buildReportUrl` and `buildIntradayUrl` (use-intraday.ts) AFTER each has
// set its own window param (since/until vs span), so the produced query strings
// stay byte-identical to the two hand-rolled copies this replaced (f21).
export function appendFilterParams(
  params: URLSearchParams,
  input: { mode: string; tz?: string; projects?: string[]; models?: string[]; machines?: string[] },
): void {
  params.set("mode", input.mode);
  if (input.tz) params.set("tz", input.tz);
  // Multi-value filters serialize as repeated params: ?project=a&project=b.
  // The sidecar reads them back with Hono's c.req.queries(key).
  for (const p of input.projects ?? []) params.append("project", p);
  for (const m of input.models ?? []) params.append("model", m);
  // ADR-0041 (M6): the machine filter axis, repeated `machine=` params — absent
  // when unset, so non-machine URLs stay byte-identical to pre-M6.
  for (const m of input.machines ?? []) params.append("machine", m);
}

// Shared URL composer for every /api/<report> endpoint. The param shape is
// uniform; reports vary only the path. Part 5's NDJSON reader composes against
// a report's `build<Name>Url` re-export without going through useQuery.
export function buildReportUrl(path: string, input: QueryInput): string {
  const params = new URLSearchParams();
  if (input.since) params.set("since", input.since);
  if (input.until) params.set("until", input.until);
  appendFilterParams(params, input);
  return `${path}?${params.toString()}`;
}

// The ADR-0004 four-piece hook: key + URL + fetch + useQuery wrapper. Each
// `use-<report>.ts` calls makeReportHook once and re-exports these four pieces
// under the report-specific names (`dailyQueryKey`, `buildDailyUrl`, …) so the
// documented naming convention and the by-key / by-URL external entry points
// are preserved.
// The wrapper's per-call query options. `enabled: false` parks the query —
// mounted but never fetching (the chart-source hook's laziness mechanism: all
// four source queries are called unconditionally, only the active one fetches).
export type ReportQueryOptions = { enabled?: boolean };

export type ReportHook<T, K extends readonly [string, QueryInput]> = {
  queryKey: (opts: ReportQueryInput) => K;
  buildUrl: (opts: ReportQueryInput) => string;
  fetch: (opts: ReportQueryInput, signal: AbortSignal | undefined) => Promise<T>;
  useReport: (opts: ReportQueryInput, options?: ReportQueryOptions) => UseQueryResult<T>;
};

export function makeReportHook<
  S extends z.ZodTypeAny,
  K extends readonly [string, QueryInput],
>(config: {
  path: string;
  keyBuilder: (input: QueryInput) => K;
  schema: S;
}): ReportHook<z.infer<S>, K> {
  const { path, keyBuilder, schema } = config;
  type T = z.infer<S>;

  const queryKey = (opts: ReportQueryInput): K => keyBuilder(normalize(opts));
  const buildUrl = (opts: ReportQueryInput): string => buildReportUrl(path, normalize(opts));
  const fetchReport = async (
    opts: ReportQueryInput,
    signal: AbortSignal | undefined,
  ): Promise<T> => {
    const res = await sidecarFetch(buildUrl(opts), { signal });
    if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return schema.parse(json) as T;
  };
  const useReport = (opts: ReportQueryInput, options?: ReportQueryOptions): UseQueryResult<T> =>
    useQuery<T>({
      queryKey: queryKey(opts),
      queryFn: ({ signal }) => fetchReport(opts, signal),
      enabled: options?.enabled ?? true,
    });

  return { queryKey, buildUrl, fetch: fetchReport, useReport };
}
