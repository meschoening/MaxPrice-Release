import { dailyByProjectKey, dailyByProjectResponseSchema } from "@maxprice/shared";
import { makeReportHook, type ReportQueryInput } from "./report-hook";

// /api/daily-by-project — ADR-0004 four-piece split. Backs the cost chart's
// `by project` group-by. See use-daily.ts.
export type DailyByProjectQueryInput = ReportQueryInput;

const hook = makeReportHook({
  path: "/api/daily-by-project",
  keyBuilder: dailyByProjectKey,
  schema: dailyByProjectResponseSchema,
});

export const dailyByProjectQueryKey = hook.queryKey;
export const buildDailyByProjectUrl = hook.buildUrl;
export const fetchDailyByProject = hook.fetch;
export const useDailyByProject = hook.useReport;
