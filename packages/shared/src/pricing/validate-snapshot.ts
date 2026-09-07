import { z } from "zod";
import type { PricingSnapshot } from "./snapshot";

const price = z.number().finite().min(0).max(1).optional();
const model = z
  .object({
    input_cost_per_token: price,
    output_cost_per_token: price,
    cache_creation_input_token_cost: price,
    cache_read_input_token_cost: price,
    cache_creation_input_token_cost_above_1hr: price,
  })
  .strict()
  .refine((entry) => Object.values(entry).some((value) => value !== undefined));
const schema = z
  .object({
    capturedAt: z.string().datetime({ offset: true }),
    models: z
      .record(z.string().regex(/claude/i), model)
      .refine((entries) => Object.keys(entries).length > 0),
  })
  .strict();

// Cached and checked-in snapshots cross the same trust boundary. Reject a damaged
// file whole rather than quietly dropping the models whose prices were damaged.
export function parsePricingSnapshot(value: unknown): PricingSnapshot {
  return schema.parse(value);
}
