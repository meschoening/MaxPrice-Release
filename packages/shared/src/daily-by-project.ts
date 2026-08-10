import { z } from "zod";
import { dailyRowSchema } from "./daily";

// Response for /api/daily-by-project — the per-project daily series behind the
// cost chart's `by project` group-by (Part 4). Each entry carries the
// project's real working-directory `path` (resolved sidecar-side per ADR-0009
// — the slug key is a lossy encoding that cannot be reversed to a path)
// alongside its daily `rows`. The renderer buckets the top-N projects plus an
// "other" series and derives each legend label from `path`, not from the slug.
export const dailyByProjectResponseSchema = z.object({
  projects: z.record(
    z.string(),
    z.object({
      path: z.string(),
      rows: z.array(dailyRowSchema),
    }),
  ),
});

export type DailyByProjectResponse = z.infer<typeof dailyByProjectResponseSchema>;
