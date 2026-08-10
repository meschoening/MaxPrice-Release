import { z } from "zod";

// The blocks wire shape, including two fields the golden does not carry:
// `fiveHourLimitPct` (ADR-0025/0030) and `windowSource` (ADR-0028/0029). Field
// names DIFFER from the other reports — note `costUSD` (not `totalCost`), the
// nested `tokenCounts` with `cacheCreationInputTokens` / `cacheReadInputTokens`
// (not the flat `cacheCreationTokens` shape), and the first-class `isGap` flag.
// The `burnRate` and `projection` sub-objects are present only on the active
// block; both are `null` on completed and gap rows. The Active block tile's
// "typical" row is NOT carried on the wire — it derives client-side as the
// MEDIAN `totalTokens` across the completed (non-gap, non-active) blocks
// (`typicalBlockTokens`, `apps/desktop/src/lib/aggregate.ts`). Under a model
// filter (ADR-0017), `entries` / `tokenCounts` / `totalTokens` / `costUSD` /
// `models` count matching events only; `burnRate` / `projection` stay
// all-model — they describe the real 5-hour quota window.
const tokenCountsSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  cacheReadInputTokens: z.number(),
});

const burnRateSchema = z.object({
  tokensPerMinute: z.number(),
  tokensPerMinuteForIndicator: z.number(),
  costPerHour: z.number(),
});

const projectionSchema = z.object({
  totalTokens: z.number(),
  totalCost: z.number(),
  remainingMinutes: z.number(),
});

// How a block's window was formed (ADR-0028/0029) — the single source for this
// vocabulary, shared with the `block` intraday span's `blockWindow.source`
// (`./intraday`) so the two can't drift. See the `windowSource` field below for
// what each value means.
export const windowSourceSchema = z.enum(["observed", "annulled", "heuristic"]);

const blockRowSchema = z.object({
  id: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  actualEndTime: z.string().nullable(),
  isActive: z.boolean(),
  isGap: z.boolean(),
  entries: z.number(),
  tokenCounts: tokenCountsSchema,
  totalTokens: z.number(),
  costUSD: z.number(),
  models: z.array(z.string()),
  // Machines whose events matched the row's filters, first-seen order —
  // parallel to `models` (ADR-0041 M5). Like the model filter (ADR-0017), a
  // machine filter narrows entries/tokenCounts/totalTokens/costUSD/models/
  // machines ONLY: formation, boundaries, isActive, burnRate, projection, and
  // fiveHourLimitPct NEVER narrow (quota truth is account-wide). Gap rows: [].
  machines: z.array(z.string()),
  burnRate: burnRateSchema.nullable(),
  projection: projectionSchema.nullable(),
  // 5-hour Usage limit utilization for this block (ADR-0025, narrowed by
  // ADR-0030 to a REAL-WINDOW property): peak observed in the block's window;
  // the live latest value for the active block; null when no Usage history
  // covers the block — never fabricated. Heuristic rows are ALWAYS null — an
  // estimated row has no real window to have a % of.
  fiveHourLimitPct: z.number().nullable(),
  // ADR-0028/0029: how this row's window was formed — "observed" = the real
  // [reset−5h → reset) window recovered from the usage history (exact);
  // "annulled" = a real window cut short by an out-of-band reset (start exact,
  // end at its successor window's start, span under 5h — ADR-0029);
  // "heuristic" = the hour-floor reconstruction (an estimate). Gap
  // rows are always "heuristic" (their bounds derive from neighboring events).
  // Invariant: a row's startTime/endTime is exactly the extent its events
  // were partitioned by.
  windowSource: windowSourceSchema,
});

export const blocksResponseSchema = z.object({
  blocks: z.array(blockRowSchema),
});

export type TokenCounts = z.infer<typeof tokenCountsSchema>;
export type BurnRate = z.infer<typeof burnRateSchema>;
export type Projection = z.infer<typeof projectionSchema>;
export type BlockRow = z.infer<typeof blockRowSchema>;
export type BlocksResponse = z.infer<typeof blocksResponseSchema>;
