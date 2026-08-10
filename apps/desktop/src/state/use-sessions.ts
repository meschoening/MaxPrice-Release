import { sessionsKey, sessionsResponseSchema } from "@maxprice/shared";
import { makeReportHook, type ReportQueryInput } from "./report-hook";

// /api/sessions — ADR-0004 four-piece split, factory-built. See use-daily.ts.
export type SessionsQueryInput = ReportQueryInput;

const hook = makeReportHook({
  path: "/api/sessions",
  keyBuilder: sessionsKey,
  schema: sessionsResponseSchema,
});

export const sessionsQueryKey = hook.queryKey;
export const buildSessionsUrl = hook.buildUrl;
export const fetchSessions = hook.fetch;
export const useSessions = hook.useReport;
