import {
  readFileSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { forgetSessionRefSchema, hubEventsForgetResponseSchema } from "@maxprice/shared";

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
  batches: z.array(
    z.object({
      operationId: z.string().uuid(),
      sessions: z.array(forgetSessionRefSchema),
      receipt: hubEventsForgetResponseSchema.optional(),
    }),
  ),
});
export type FleetForgetIntent = z.infer<typeof intentSchema>;

// A forget's mode, by its Local archive half: pair-wide and barred (a user's
// Forget, ADR-0069 §8), key-scoped (the evidence repair, #375), or none at all
// (the dormant half's lossless forget, #311).
export type FleetForgetMode = "pair" | "excluded" | "lossless";

export function forgetIntentMode(intent: FleetForgetIntent): FleetForgetMode {
  if (intent.lossless === true) return "lossless";
  if (intent.excludedOnly === true) return "excluded";
  return "pair";
}

// A share-only client also needs this receipt journal. It survives replica
// toggles and prevents a lost HTTP response from becoming a fresh deletion.
export function createForgetIntent(path: string) {
  let value: FleetForgetIntent | null = null;
  let error: unknown = null;
  try {
    value = intentSchema.nullable().parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code !== "ENOENT") error = caught;
  }
  function write(next: FleetForgetIntent | null): void {
    if (error !== null) throw new Error(`Cannot read pending fleet deletion: ${String(error)}`);
    mkdirSync(dirname(path), { recursive: true });
    // Persist a null marker through the same durable replace as ordinary state;
    // unlink alone would not establish durability of the completed intent.
    const temporary = `${path}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next));
      const fd = openSync(temporary, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
      value = structuredClone(next);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return {
    pending: () => value !== null,
    read: () => structuredClone(value),
    error: () => error,
    write,
  };
}
