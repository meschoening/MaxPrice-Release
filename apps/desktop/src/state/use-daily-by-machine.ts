import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  buildDailyByMachineUrl,
  dailyByMachineKey,
  dailyByMachineResponseSchema,
  normalizeDailyByMachineInput,
  type DailyByMachineHookInput,
  type DailyByMachineQueryInput,
  type DailyByMachineResponse,
} from "@maxprice/shared";
import { sidecarFetch } from "@/lib/sidecar";
import type { ReportQueryOptions } from "./report-hook";

// /api/daily-by-machine — the machine group-by's daily-span source (ADR-0041
// M6), /api/daily-by-project's counterpart. ADR-0004 four-piece split, spelled
// out by hand (not makeReportHook) because of the extra `byProject` nesting
// flag — the same reason use-intraday.ts is hand-rolled. The input, its
// normalization and Piece 2 live in `@maxprice/shared`'s `report-url.ts`.

// Piece 1 — the query key ("daily-by-machine" is in DATA_QUERY_KEYS, so
// cost-mode and SSE usage:new invalidation both reach this hook).
export function dailyByMachineQueryKey(
  opts: DailyByMachineHookInput,
): ["daily-by-machine", DailyByMachineQueryInput] {
  return dailyByMachineKey(normalizeDailyByMachineInput(opts));
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
// (mounted, never fetching) — see report-hook.ts's ReportQueryOptions, whose
// `keepPrevious` is honoured here as well: this wrapper shares that options
// type, so every field of it has to mean the same thing at every call site.
export function useDailyByMachine(
  opts: DailyByMachineHookInput,
  options?: ReportQueryOptions,
): UseQueryResult<DailyByMachineResponse> {
  return useQuery<DailyByMachineResponse>({
    queryKey: dailyByMachineQueryKey(opts),
    queryFn: ({ signal }) => fetchDailyByMachine(opts, signal),
    enabled: options?.enabled ?? true,
    placeholderData: options?.keepPrevious ? keepPreviousData : undefined,
  });
}
