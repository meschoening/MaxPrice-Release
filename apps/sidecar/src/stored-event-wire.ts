import type { StoredEventWire } from "@maxprice/shared";
import type { StoredEvent } from "./engine/store";

// Project a StoredEvent onto the wire shape, omitting undefined optionals so a
// push body matches storedEventWireSchema exactly. ONE definition, two
// consumers: event-sync's hub push (fleet.ts) and the local archive's append
// (local-archive.ts, ADR-0069) — both feed a fleet store's `push` (the Hub's,
// or the archive's), which re-mints machineId, so the projection deliberately
// drops it.
//
// `organizationUuid` and `accountUuid` are the store's RESOLVED tags — evidence
// only, never a presumption (ADR-0103, ADR-0137 §6) — and ride LAST, the
// Organization then the Account, each only when present, so an untagged row's
// JSON is byte-identical to the pre-v5 projection and an Organization-only
// row's to v6's (organization-wire.test.ts pins it). `accountEmailHash` is
// never projected: a Pending account's rows carry no Account tag, and the hash
// never leaves the machine.
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
    ...(e.organizationUuid !== undefined ? { organizationUuid: e.organizationUuid } : {}),
    ...(e.accountUuid !== undefined ? { accountUuid: e.accountUuid } : {}),
  };
}
