import { z } from "zod";
import { modelBreakdownSchema } from "./models";

// Part 5 — the `/api/session/:id/events` NDJSON frame contract.
//
// The session-events endpoint streams three kinds of newline-delimited JSON
// frames, discriminated by the `type` field. This module is the frozen
// contract that ties the sidecar (Phase A) to the renderer's session detail
// page (Phase B). Both sides import from here; neither defines the shapes
// locally.
//
// Stream layout:
//   line 1 : exactly one `summary` frame — totals + per-model breakdown
//   lines 2+ : one `event` frame per stored event, timestamp-ascending
//   (on mid-stream failure only) : a synthetic `error` frame
//
// Names are chosen to avoid collisions with:
//   - `UsageEvent`  — the SSE signal type in `./live.ts`
//   - `UsageRecord` — the engine parser's output type in the sidecar

// ---------------------------------------------------------------------------
// Summary frame — always the first line
// ---------------------------------------------------------------------------

// Aggregated totals across all events in the session. `totalTokens` is the
// sum of all four token counts; `totalCost` is the plain float sum of each
// event's `computeCost` result — NOT rounded, so the float-arithmetic
// artifacts in the per-session golden are preserved. `modelBreakdowns` is
// built from the shared `emptyModelRollup` / `foldModelUsage` primitives,
// guaranteeing parity with the `SessionRow.totalCost` that `aggregateSessions`
// reports for the same session (both consume the same store, the same
// `computeCost` invocation, and the same fold).
export const sessionSummaryFrameSchema = z.object({
  type: z.literal("summary"),
  sessionId: z.string(),
  eventCount: z.number().int().nonnegative(),
  totalTokens: z.number(),
  totalCost: z.number(),
  modelBreakdowns: z.array(modelBreakdownSchema),
  // Machines that contributed streamed events, first-seen order (ADR-0041 M5).
  // Event frames deliberately do NOT carry machineId — the summary is the
  // attribution surface.
  machines: z.array(z.string()),
});

export type SessionSummaryFrame = z.infer<typeof sessionSummaryFrameSchema>;

// ---------------------------------------------------------------------------
// Event frame — one per stored event, timestamp-ascending
// ---------------------------------------------------------------------------

// A single assistant usage event. `cost` is that event's incremental
// `computeCost` in the requested mode — the same value that was summed into
// `summary.totalCost`, so the sum of all `event.cost` values equals
// `summary.totalCost` exactly.
export const sessionEventFrameSchema = z.object({
  type: z.literal("event"),
  timestamp: z.string(),
  messageId: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  cost: z.number(),
});

export type SessionEventFrame = z.infer<typeof sessionEventFrameSchema>;

// ---------------------------------------------------------------------------
// Error frame — synthetic, only on mid-stream failure
// ---------------------------------------------------------------------------

// Emitted as the last NDJSON line when the endpoint fails after writing the
// HTTP 200 header. The renderer should surface this gracefully (e.g. a
// toast) rather than treating it as a protocol error.
export const sessionErrorFrameSchema = z.object({
  type: z.literal("error"),
  error: z.string(),
});

export type SessionErrorFrame = z.infer<typeof sessionErrorFrameSchema>;

// ---------------------------------------------------------------------------
// Discriminated union — the full frame type
// ---------------------------------------------------------------------------

export const sessionEventsFrameSchema = z.discriminatedUnion("type", [
  sessionSummaryFrameSchema,
  sessionEventFrameSchema,
  sessionErrorFrameSchema,
]);

export type SessionEventsFrame = z.infer<typeof sessionEventsFrameSchema>;
