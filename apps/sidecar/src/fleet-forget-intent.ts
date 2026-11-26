import { readFileSync } from "node:fs";
import { z } from "zod";
import { forgetRequestSessionSchema, hubEventsForgetResponseSchema } from "@maxprice/shared";
import { writeDurably } from "./durable-file";

const intentSchema = z.object({
  hub: z.string(),
  epoch: z.string(),
  localComplete: z.boolean().optional(),
  // #311: the intent's mode. A lossless intent keeps the Local archive, and is
  // also written `localComplete`, which alone cannot tell it from a lossy one
  // whose archive half finished. Only a caller of the same mode may resume it.
  lossless: z.boolean().optional(),
  // #375: the evidence repair's mode, whose Local archive half removes only its
  // pairs' excluded keys and bars nothing. Absent is a user Forget's pair-wide
  // half; an older build's lossy intent (a user's Forget, or the repair's
  // before #375) has neither flag and resumes pair-wide, as it was written.
  excludedOnly: z.boolean().optional(),
  // #777 (ADR-0149 §3): the repair's row-scoped mode. Its batches name rows
  // (`rows` on each pair), and it is written already `localComplete`: the
  // repair took the rows out of the Local archive before it asked.
  rowsOnly: z.boolean().optional(),
  batches: z.array(
    z.object({
      operationId: z.string().uuid(),
      sessions: z.array(forgetRequestSessionSchema),
      receipt: hubEventsForgetResponseSchema.optional(),
    }),
  ),
});
export type FleetForgetIntent = z.infer<typeof intentSchema>;

// A forget's mode, by its Local archive half: pair-wide and barred (a user's
// Forget, ADR-0069 §8), key-scoped (the evidence repair, #375), or none at all
// (the dormant half's lossless forget, #311, and the row-scoped one, #777,
// whose rows the repair already took out of the archive).
export type FleetForgetMode = "pair" | "excluded" | "lossless" | "rows";

export function forgetIntentMode(intent: FleetForgetIntent): FleetForgetMode {
  if (intent.rowsOnly === true) return "rows";
  if (intent.lossless === true) return "lossless";
  if (intent.excludedOnly === true) return "excluded";
  return "pair";
}

// A share-only client also needs this receipt journal. It survives replica
// toggles and prevents a lost HTTP response from becoming a fresh deletion.
export function createForgetIntent(path: string) {
  let value: FleetForgetIntent | null = null;
  let error: unknown = null;
  // How many writes have landed, so a reader can tell the intent changed
  // without reading it (the push view's eligibility, #364).
  let revision = 0;
  try {
    value = intentSchema.nullable().parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code !== "ENOENT") error = caught;
  }
  function write(next: FleetForgetIntent | null): void {
    if (error !== null) throw new Error(`Cannot read pending fleet deletion: ${String(error)}`);
    // Persist a null marker through the same durable replace as ordinary state;
    // unlink alone would not establish durability of the completed intent.
    writeDurably(path, JSON.stringify(next));
    value = structuredClone(next);
    revision++;
  }
  return {
    pending: () => value !== null,
    read: () => structuredClone(value),
    error: () => error,
    revision: () => revision,
    write,
  };
}
