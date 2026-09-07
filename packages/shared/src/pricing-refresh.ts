import { z } from "zod";
import { pricingStatusSchema } from "./live";

// Wire contract for POST /api/pricing/refresh — the manual pricing refresh
// (ADR-0085), the sidecar's second *action* endpoint after POST /api/rescan.
// It runs one best-effort fetch of the upstream LiteLLM price list through the
// same single-flight attempt the startup arm and the ~24h loop use (a request
// arriving mid-attempt JOINS it and shares its answer), and reports the
// attempt's outcome. The status snapshot's `pricing` object is rebuilt and
// broadcast over SSE on every settled attempt regardless, so this response
// exists for the gesture's own feedback line, not for keeping the status row
// current.
export const PRICING_REFRESH_PATH = "/api/pricing/refresh";

export const pricingRefreshResponseSchema = z.object({
  // The status snapshot's pricing object as rebuilt after this attempt —
  // REQUIRED here, unlike its `.optional()` twin on `StatusSnapshot`, because a
  // sidecar serving this route is by definition new enough to carry it.
  pricing: pricingStatusSchema,
  // How many model keys the ACTIVE snapshot prices after the attempt that it
  // did not price before. 0 on any failure (the snapshot did not change) and 0
  // on a success that only moved prices — "up to date" in the renderer. Counted
  // sidecar-side so a joined request gets the same truthful answer as the one
  // that started the attempt, and so a 24h tick landing between click and
  // response cannot skew a client-side diff.
  newModels: z.number().int().nonnegative(),
});

export type PricingRefreshResponse = z.infer<typeof pricingRefreshResponseSchema>;
