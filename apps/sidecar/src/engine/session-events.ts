import { computeCostBreakdown, type CostMode, type SessionSummaryFrame } from "@maxprice/shared";
import { byTimestamp, emptyModelRollup, flushRollup, foldModelUsage } from "./model-rollup";
import { isParseableTimestamp } from "./local-date";
import type { StoredEvent } from "./store";

// Part 5 — the session-events aggregator (review finding f10).
//
// `GET /api/session/:id/events` streams one `summary` frame then one `event`
// frame per stored event. The per-event fold that builds the summary used to
// live inline in the route handler; this module is its home, so ADR-0010's
// "one aggregator per report" holds structurally, and the ADR-0012 parity with
// `aggregateSessions` is enforced by shared engine code rather than by two
// hand-synced copies of the fold.
//
// Like every other aggregator it folds a `byTimestamp` event list exactly once:
//   - `byTimestamp` makes the timestamp-ascending frame order and the
//     `modelBreakdowns` first-seen insertion order true by construction.
//   - the `!isParseableTimestamp(...)` skip is the same malformed-timestamp
//     drop `aggregateSessions` applies (via its own `localDate(...) === null`
//     check), so a bad event is dropped from BOTH the summary fold and the
//     event frames — this endpoint's totals can never diverge from the
//     `SessionRow` the sessions aggregator reports for the same session. This
//     endpoint needs no `tz` (ADR-0015): it never buckets by calendar date,
//     only filters malformed timestamps, which is timezone-independent.
//   - `computeCostBreakdown` runs once per event; its `.total` is summed into the
//     summary AND returned per-event, guaranteeing `sum(eventCosts) === totalCost`.

// The aggregate the route handler streams: the `summary` frame, the frame-
// ordered `events` (parseable-timestamp only), and `eventCosts` — `eventCosts[i]`
// is the cost of `events[i]`, reused verbatim in event `i`'s frame.
export type SessionEventsAggregate = {
  summary: SessionSummaryFrame;
  events: StoredEvent[];
  eventCosts: number[];
};

// Fold one session's events into the `/api/session/:id/events` summary plus the
// per-event cost list. `events` is a raw `store.query({ sessions: [id] })`
// result; `sessionId` is echoed verbatim into the summary frame.
export function aggregateSessionEvents(
  events: StoredEvent[],
  mode: CostMode,
  sessionId: string,
): SessionEventsAggregate {
  const rollup = emptyModelRollup();
  const frameEvents: StoredEvent[] = [];
  const eventCosts: number[] = [];
  // Machines that contributed streamed events, first-seen order (ADR-0041 M5)
  // — a Set preserves insertion order. The summary is the attribution surface;
  // the per-event frames carry no machineId.
  const machines = new Set<string>();

  for (const event of byTimestamp(events)) {
    if (!isParseableTimestamp(event.timestamp)) continue;
    const cost = computeCostBreakdown(
      event.model,
      {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheCreationTokens: event.cacheCreationTokens,
        cacheReadTokens: event.cacheReadTokens,
      },
      mode,
      event.costUSD,
    );
    foldModelUsage(rollup, event, cost);
    frameEvents.push(event);
    eventCosts.push(cost.total);
    machines.add(event.machineId);
  }

  // `flushRollup` owns the `totalTokens` formula (the sum of the four token
  // counts) and the first-seen `modelBreakdowns` flush — reused here so the
  // summary's token/cost/breakdown fields are not a second hand-kept copy of
  // that arithmetic (review finding f11).
  const rolled = flushRollup(rollup);
  const summary: SessionSummaryFrame = {
    type: "summary",
    sessionId,
    eventCount: frameEvents.length,
    totalTokens: rolled.totalTokens,
    totalCost: rolled.totalCost,
    modelBreakdowns: rolled.modelBreakdowns,
    machines: Array.from(machines),
  };

  return { summary, events: frameEvents, eventCosts };
}
