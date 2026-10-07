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
  // The Organization the LATEST event counts under (#278) — its Owner record
  // evidence, else the Organization its session is asserted to (#309), else
  // its Presumed organization — following the same latest-event rule as
  // `machineId`. ABSENT when that event resolves to no Organization (no
  // evidence, no assertion and no Home to presume), never `null` or `""`. The
  // engine stays one row per session: a session that crosses Organizations
  // never splits and names its latest one (#262 item 5).
  organizationUuid: z.string().optional(),
  // Which source answered, summarised over the SESSION's events rather than
  // read off the latest one (#309): "assigned" if any event resolved through
  // an Organization assertion, else "presumed" if any resolved through the
  // Presumed organization, else "evidence". An assertion names a whole
  // session, so its owner-less rows are all assigned or all presumed, and this
  // reads as "how this session's owner-less usage is attributed, else
  // evidence" — which is what tells a partly owned session (an owned tail
  // naming `organizationUuid`) from a wholly owned one. ABSENT exactly when no
  // event resolves to any Organization, so a Home-less, tag-less machine
  // serves the pre-#309 row.
  organizationResolution: z.enum(["evidence", "assigned", "presumed"]).optional(),
  // The two halves of a PARTLY OWNED session (#312): `ownerless` is the
  // Organization its latest owner-less event (presumed or assigned) counts
  // under, `owned` the one its latest evidence event names. PRESENT exactly
  // when the session's folded events hold both kinds and each resolves to an
  // Organization; ABSENT otherwise, never `null`. The fold runs over the
  // scope-narrowed events, so under one Organization's scope a partly owned
  // session usually shows one half and carries no split. The two may name the
  // same Organization — a tail tagged with the presumption's own is still
  // partly owned, and only its owner-less half can follow an assertion. A
  // session's owner-less target is `organizationSplit?.ownerless ??
  // organizationUuid`.
  organizationSplit: z
    .object({ ownerless: z.string().min(1), owned: z.string().min(1) })
    .optional(),
});

export const sessionsResponseSchema = z.object({
  sessions: z.array(sessionRowSchema),
});

export type SessionRow = z.infer<typeof sessionRowSchema>;
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;
