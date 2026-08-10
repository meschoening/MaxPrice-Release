import { z } from "zod";

// Wire contract for POST /api/rescan — the manual rescan endpoint (ADR-0019).
// The sidecar's one *action* endpoint (every other /api/* route is a GET
// report): it re-walks every JSONL under the watched roots into the event
// store — a full scan, not the watcher's incremental tail-read — then reports
// how many rows that walk changed. The renderer triggers it from
// ⇧R / the topbar refresh pill and, on the response, invalidates every report
// family itself, because a manual rescan emits no SSE.
export const RESCAN_PATH = "/api/rescan";

export const rescanResponseSchema = z.object({
  // How many rows THIS walk changed in the store: new events, plus existing
  // events replaced by a fuller version (the merge rule keeps the larger token
  // total, so a streamed message's final row landing over an `output_tokens: 1`
  // partial counts — the row genuinely changed even though the key count did
  // not). Exact and local to this scan: a concurrent watcher flush, settings
  // scan, or fleet-replica pull can no longer misattribute its rows here.
  // Note `added` and `total` are not the same currency — `total` is the store's
  // whole deduped count INCLUDING fleet-replica rows (ADR-0041), which this
  // walk never produces. 0 in the common case means the live pipeline was
  // already current; the pill surfaces that as "up to date".
  added: z.number().int().nonnegative(),
  // The store's total deduped event count after the rescan.
  total: z.number().int().nonnegative(),
});

export type RescanResponse = z.infer<typeof rescanResponseSchema>;
