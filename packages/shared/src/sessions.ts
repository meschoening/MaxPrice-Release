import { z } from "zod";
import { modelBreakdownSchema } from "./models";

// The `/api/sessions` wire shape — the response the usage engine's sessions
// aggregator produces. Each row carries `sessionId`, `projectPath` (the slug
// form, e.g. `-Users-max-Documents-git-foo`), and `lastActivity` (YYYY-MM-DD).
// No `firstActivity` / `label` fields; Part 5 derives them from per-event
// parsing when it ships.
//
// `path` is the project's real working directory, derived from the JSONL `cwd`
// field (ADR-0009) — the faithful counterpart to the lossy `projectPath` slug.
// Display helpers (`deriveProjectName` / `deriveProjectPath`) take `path`, not
// `projectPath`.
const sessionRowSchema = z.object({
  sessionId: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  totalTokens: z.number(),
  totalCost: z.number(),
  lastActivity: z.string(),
  modelsUsed: z.array(z.string()),
  modelBreakdowns: z.array(modelBreakdownSchema),
  projectPath: z.string(),
  path: z.string(),
  // The LATEST event's machine (ADR-0041 M5) — attribution follows where the
  // session lives and flips exactly once at a machine migration. Model-/
  // machine-filtered queries narrow the events first, so the latest MATCHING
  // event decides.
  machineId: z.string(),
});

export const sessionsResponseSchema = z.object({
  sessions: z.array(sessionRowSchema),
});

export type SessionRow = z.infer<typeof sessionRowSchema>;
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;
