import { dailyKey, dailyResponseSchema } from "@maxprice/shared";
import { makeReportHook, type ReportQueryInput } from "./report-hook";

// /api/daily. The ADR-0004 four-piece split (key + URL + fetch + wrapper) is
// produced by `makeReportHook` and re-exported below under the documented
// `<name>QueryKey` / `build<Name>Url` / `fetch<Name>` / `use<Name>` names.
export type DailyQueryInput = ReportQueryInput;

const hook = makeReportHook({
  path: "/api/daily",
  keyBuilder: dailyKey,
  schema: dailyResponseSchema,
});

export const dailyQueryKey = hook.queryKey;
export const buildDailyUrl = hook.buildUrl;
export const fetchDaily = hook.fetch;
export const useDaily = hook.useReport;
