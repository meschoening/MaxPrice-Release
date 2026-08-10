import { projectsKey, projectsResponseSchema } from "@maxprice/shared";
import { makeReportHook, type ReportQueryInput } from "./report-hook";

// /api/projects — ADR-0004 four-piece split, factory-built. See use-daily.ts.
export type ProjectsQueryInput = ReportQueryInput;

const hook = makeReportHook({
  path: "/api/projects",
  keyBuilder: projectsKey,
  schema: projectsResponseSchema,
});

export const projectsQueryKey = hook.queryKey;
export const buildProjectsUrl = hook.buildUrl;
export const fetchProjects = hook.fetch;
export const useProjects = hook.useReport;
