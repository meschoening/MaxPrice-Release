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
  batches: z.array(
    z.object({
      operationId: z.string().uuid(),
      sessions: z.array(forgetSessionRefSchema),
      receipt: hubEventsForgetResponseSchema.optional(),
    }),
  ),
});
export type FleetForgetIntent = z.infer<typeof intentSchema>;

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
