import { z } from "zod";
import { dailyRowSchema } from "./daily";

// Response for /api/daily-by-machine (ADR-0041 M6) — the per-machine daily
// series behind the cost chart's machine group-by on the daily spans, the
// counterpart of /api/daily-by-project. Entries carry no `path` (machines have
// no working directory; names resolve renderer-side from the machine
// directory). When the request carries `byProject=1` (machine + project both
// selected) each machine additionally nests its own per-project sub-map —
// entries shaped exactly like /api/daily-by-project's — so the renderer's
// machine × project cross stays exact. Keys are machineId-ascending.
export const dailyByMachineResponseSchema = z.object({
  machines: z.record(
    z.string(),
    z.object({
      rows: z.array(dailyRowSchema),
      projects: z
        .record(z.string(), z.object({ path: z.string(), rows: z.array(dailyRowSchema) }))
        .optional(),
    }),
  ),
});

export type DailyByMachineResponse = z.infer<typeof dailyByMachineResponseSchema>;
