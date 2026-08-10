import { z } from "zod";
import { modelBreakdownSchema } from "./models";

export const dailyRowSchema = z.object({
  // A `YYYY-MM-DD` calendar date on the `/api/daily` wire. NOTE: `DailyRow` is
  // also reused renderer-side as the cost chart's row interface, and the
  // intraday adapter (`apps/desktop/src/lib/intraday-adapter.ts`, ADR-0013)
  // deliberately puts an `HH:mm` clock-time LABEL in this slot. So a renderer-
  // side `DailyRow` consumer must treat `date` as an opaque label, never parse
  // it as a calendar date.
  date: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  totalTokens: z.number(),
  totalCost: z.number(),
  // Per-event cache-cost split (ADR-0026) — additive over the golden's daily row,
  // for the `by token type` group-by (renamed by ADR-0040). Optional (engine always populates;
  // renderer-built zero rows / fixtures may omit). ADR-0040 adds the `outputCost`
  // slice so the token-type axis has all four bands; input cost is derived
  // renderer-side as totalCost - cacheCreationCost - cacheReadCost - outputCost.
  cacheCreationCost: z.number().optional(),
  cacheReadCost: z.number().optional(),
  outputCost: z.number().optional(),
  modelsUsed: z.array(z.string()),
  modelBreakdowns: z.array(modelBreakdownSchema),
});

export const dailyResponseSchema = z.object({
  daily: z.array(dailyRowSchema),
  totals: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheCreationTokens: z.number(),
      cacheReadTokens: z.number(),
      totalCost: z.number(),
      totalTokens: z.number(),
    })
    .optional(),
});

export type DailyRow = z.infer<typeof dailyRowSchema>;
export type DailyResponse = z.infer<typeof dailyResponseSchema>;
