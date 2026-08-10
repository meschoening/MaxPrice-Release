import { z } from "zod";
import { modelBreakdownSchema } from "./models";

// The projects report is produced by the engine's `aggregateProjects`
// (`apps/sidecar/src/engine/projects.ts`), which folds stored events directly:
// it groups every event by `projectSlug` and folds the ones inside the
// requested date window. There is no daily-row intermediate — the
// `{ projects: { "<slug>": [DailyRow, ...] } }` map is a different endpoint's
// shape (`/api/daily-by-project`, ./daily-by-project).
//
// EVERY FIELD HERE IS SCOPED TO THE REQUESTED DATE WINDOW, with one exception:
// `firstActivity`, the earliest activity date across all history, whose
// all-time scope is the point of the stat. It is the only optional field left,
// and only because renderer-built rows and test fixtures omit it.
//
// ADR-0068 removed the two all-time siblings this row used to carry — a
// `costAllTime` column and an all-time `sessions` count, both from ADR-0006's
// additive Part-4 widening. `sessions` stayed but became range-scoped, and its
// `.optional()` went with the change: it was there for ADR-0008's debounced
// cold cache, which ADR-0010 deleted years of commits ago. Setting the date
// range to all-time reproduces the removed figures exactly.
//
// `path` is the project's real working directory, resolved sidecar-side from
// the JSONL `cwd` field (ADR-0009). The `slug` is lossy and can't be reversed
// to a path, so the human name + display path derive renderer-side from `path`
// (`deriveProjectName` / `deriveProjectPath`, project-path.ts). Staleness
// derives renderer-side from `lastActivity` (the 90-day threshold) and shows as
// a dimmed row — the Status column that used to spell it out is gone.
const projectRowSchema = z.object({
  slug: z.string(),
  path: z.string(),
  costRange: z.number(),
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  modelsUsed: z.array(z.string()),
  modelBreakdowns: z.array(modelBreakdownSchema),
  lastActivity: z.string(),
  // Machines that contributed IN-WINDOW events, first-seen order (ADR-0041 M5)
  // — range-scoped, parallel to modelsUsed.
  machines: z.array(z.string()),
  // Distinct sessions with at least one in-window event (ADR-0068).
  sessions: z.number(),
  // The one all-time field (ADR-0068). Optional per ADR-0006's additive rule.
  firstActivity: z.string().optional(),
});

export const projectsResponseSchema = z.object({
  projects: z.array(projectRowSchema),
});

export type ProjectRow = z.infer<typeof projectRowSchema>;
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;
