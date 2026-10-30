import {
  hashKey,
  useQuery,
  type PlaceholderDataFunction,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  buildReportUrl,
  normalize,
  type QueryInput,
  type ReportQueryInput,
} from "@maxprice/shared";
import type { z } from "zod";
import { sidecarFetch } from "@/lib/sidecar";

// The ADR-0004 four-piece hook: key + URL + fetch + useQuery wrapper. Each
// `use-<report>.ts` calls makeReportHook once and re-exports these four pieces
// under the report-specific names (`dailyQueryKey`, `buildDailyUrl`, …) so the
// documented naming convention and the by-key / by-URL external entry points
// are preserved.
// The wrapper's per-call query options. `enabled: false` parks the query —
// mounted but never fetching (the chart-source hook's laziness mechanism: all
// four source queries are called unconditionally, only the active one fetches).
//
// `keepPrevious: true` holds the last key's data while a NEW key's first fetch
// is in flight, instead of blanking to `undefined`. Per-call rather than a
// global default in `lib/query.ts`: every report hook would then keep stale
// rows across an ordinary filter edit, which is a different (and unasked-for)
// product decision. The one caller today is the anchored previous-week query
// (ADR-0083), whose instant-bounded `until` moves with the current week's
// fetch — see use-live-data.ts. The report factory only retains rows across
// that right-edge move; scope and anchor changes clear the placeholder.
export type ReportQueryOptions = { enabled?: boolean; keepPrevious?: boolean };

// Only the moving right edge may reuse rows. A new Organization, filter, or
// week anchor must wait for its own data, even when `until` changes with it.
export function keepPreviousUntil<T>(
  key: readonly [string, QueryInput],
): PlaceholderDataFunction<T> {
  const scopeHash = hashKey([key[0], { ...key[1], until: undefined }]);
  return (data, previous) => {
    if (!previous) return undefined;
    const [family, input] = previous.queryKey;
    if (typeof input !== "object" || input === null) return undefined;
    return hashKey([family, { ...input, until: undefined }]) === scopeHash ? data : undefined;
  };
}

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
      placeholderData: options?.keepPrevious ? keepPreviousUntil<T>(queryKey(opts)) : undefined,
    });

  return { queryKey, buildUrl, fetch: fetchReport, useReport };
}
