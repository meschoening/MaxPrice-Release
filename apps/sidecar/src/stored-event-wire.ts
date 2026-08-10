import type { StoredEventWire } from "@maxprice/shared";
import type { StoredEvent } from "./engine/store";

// Project a StoredEvent onto the wire shape, omitting undefined optionals so a
// push body matches storedEventWireSchema exactly. ONE definition, two
// consumers: event-sync's hub push (fleet.ts) and the local archive's append
// (local-archive.ts, ADR-0069) — both feed createFleetEventStore.push, which
// re-mints machineId, so the projection deliberately drops it.
export function storedEventToWire(e: StoredEvent): StoredEventWire {
  return {
    timestamp: e.timestamp,
    messageId: e.messageId,
    ...(e.requestId !== undefined ? { requestId: e.requestId } : {}),
    model: e.model,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    cacheCreationTokens: e.cacheCreationTokens,
    cacheReadTokens: e.cacheReadTokens,
    ...(e.cacheCreation !== undefined ? { cacheCreation: e.cacheCreation } : {}),
    ...(e.costUSD !== undefined ? { costUSD: e.costUSD } : {}),
    ...(e.cwd !== undefined ? { cwd: e.cwd } : {}),
    projectSlug: e.projectSlug,
    sessionId: e.sessionId,
  };
}
