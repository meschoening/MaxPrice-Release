// The ONE fleet merge rule (ADR-0041), defined ONCE for the three stores that
// MUST agree byte-for-byte: the engine's event store
// (apps/sidecar/src/engine/store.ts), the hub archive, and the client replica
// (both packages/usage-core/src/fleet-event-store.ts). Each store re-exports
// these under its own local names; the cross-store parity tests pin the
// invariant. Claude Code writes several rows per assistant message sharing
// `(messageId, requestId)` — 2–3 byte-identical content-block lines plus, for a
// streamed turn, an early `output_tokens: 1` partial ahead of the final row —
// and every store keeps exactly ONE row per distinct key: the largest
// token-total, ties keep first-seen.

// The global dedup key. `JSON.stringify` on a two-element tuple encodes an
// absent requestId (`undefined`) and an empty-string requestId as DISTINCT keys
// (`["id",null]` vs `["id",""]`), as required — `requestId` is `string |
// undefined` on older records.
export function fleetDedupKey(messageId: string, requestId: string | undefined): string {
  return JSON.stringify([messageId, requestId ?? null]);
}

// An event's total token count — the dedup tie-breaker. When two rows share a
// key, the store keeps the one with the larger total (the dedup rule), so a
// streamed message counts its FINAL row, not the `output_tokens: 1` partial
// that precedes it; the byte-identical content-block lines tie, so first-seen
// wins among those. The structural param is satisfied by every StoredEvent /
// UsageRecord / FleetEvent.
export function fleetDedupTokenTotal(r: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}): number {
  return r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens;
}
