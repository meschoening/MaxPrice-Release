import { blocksKey, blocksResponseSchema } from "@maxprice/shared";
import { makeReportHook, type ReportQueryInput } from "./report-hook";

// /api/blocks — ADR-0004 four-piece split, factory-built. See use-daily.ts.
// blocks intentionally ignores `project` at the sidecar (the 5-hour quota
// window is cross-project); it's still accepted on the input for query-key
// symmetry. The `models` filter IS honoured (ADR-0017): it narrows each
// block's cost/token sums while block boundaries + projection stay all-model.
export type BlocksQueryInput = ReportQueryInput;

const hook = makeReportHook({
  path: "/api/blocks",
  keyBuilder: blocksKey,
  schema: blocksResponseSchema,
});

export const blocksQueryKey = hook.queryKey;
export const buildBlocksUrl = hook.buildUrl;
export const fetchBlocks = hook.fetch;
export const useBlocks = hook.useReport;
