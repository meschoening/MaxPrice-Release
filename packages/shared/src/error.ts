import { z } from "zod";

// Wire contract for any non-2xx response from the sidecar. The renderer
// reads this via `await res.text()` today; defining the schema here pins
// the shape so future fields require a deliberate edit on both sides
// rather than drifting.
//
// `issues` is the array of Zod issues from `safeParse(...).error.issues`
// — present on 502 responses (schema validation failed) and absent on
// 400/500 responses (validation rejection or generic runner failure).
const issueSchema = z.object({
  code: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  error: z.string(),
  issues: z.array(issueSchema).optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
