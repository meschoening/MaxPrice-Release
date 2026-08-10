import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  dailyByMachineKey,
  dailyByMachineResponseSchema,
  type DailyByMachineQueryInput,
  type DailyByMachineResponse,
} from "@maxprice/shared";
import { sidecarFetch } from "@/lib/sidecar";
import {
  appendFilterParams,
  normalize,
  type ReportQueryInput,
  type ReportQueryOptions,
} from "./report-hook";

// /api/daily-by-machine — the machine group-by's daily-span source (ADR-0041
// M6), /api/daily-by-project's counterpart. ADR-0004 four-piece split, spelled
// out by hand (not makeReportHook) because of the extra `byProject` nesting
// flag — the same reason use-intraday.ts is hand-rolled.
export type DailyByMachineHookInput = ReportQueryInput & { byProject?: boolean };

function normalizeInput(opts: DailyByMachineHookInput): DailyByMachineQueryInput {
  return { ...normalize(opts), byProject: opts.byProject };
}

// Piece 1 — the query key ("daily-by-machine" is in DATA_QUERY_KEYS, so
// cost-mode and SSE usage:new invalidation both reach this hook).
export function dailyByMachineQueryKey(
  opts: DailyByMachineHookInput,
): ["daily-by-machine", DailyByMachineQueryInput] {
  return dailyByMachineKey(normalizeInput(opts));
}

// Piece 2 — the URL builder. `byProject=1` is emitted only when TRUE (its
// absent form is the endpoint's false default).
export function buildDailyByMachineUrl(opts: DailyByMachineHookInput): string {
  const input = normalizeInput(opts);
  const params = new URLSearchParams();
  if (input.since) params.set("since", input.since);
  if (input.until) params.set("until", input.until);
  appendFilterParams(params, input);
  if (input.byProject === true) params.set("byProject", "1");
  return `/api/daily-by-machine?${params.toString()}`;
}

// Piece 3 — the fetch.
export async function fetchDailyByMachine(
  opts: DailyByMachineHookInput,
  signal: AbortSignal | undefined,
): Promise<DailyByMachineResponse> {
  const res = await sidecarFetch(buildDailyByMachineUrl(opts), { signal });
  if (!res.ok) throw new Error(`/api/daily-by-machine ${res.status}: ${await res.text()}`);
  return dailyByMachineResponseSchema.parse(await res.json());
}

// Piece 4 — the useQuery wrapper. `options.enabled: false` parks the query
// (mounted, never fetching) — see report-hook.ts's ReportQueryOptions.
export function useDailyByMachine(
  opts: DailyByMachineHookInput,
  options?: ReportQueryOptions,
): UseQueryResult<DailyByMachineResponse> {
  return useQuery<DailyByMachineResponse>({
    queryKey: dailyByMachineQueryKey(opts),
    queryFn: ({ signal }) => fetchDailyByMachine(opts, signal),
    enabled: options?.enabled ?? true,
  });
}
