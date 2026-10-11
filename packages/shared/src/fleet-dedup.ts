// The ONE fleet merge rule (ADR-0041, ADR-0103), defined ONCE for the stores
// that MUST agree byte-for-byte: the engine's event store
// (apps/sidecar/src/engine/store.ts); and the Hub, the client replica and the
// Local archive (all packages/usage-core/src/fleet-sync-store.ts, SQLite — the
// Hub and the archive decide, and the replica mirrors the Hub's decisions and
// runs no comparison of its own).
// The push loop's stamp (usage-core event-sync.ts) and the Local archive sweep
// ask the same question of a copy held elsewhere. Stores that re-export these
// do so under their own local names; the cross-store parity tests pin the
// invariant. Claude Code writes several rows per assistant message sharing
// `(messageId, requestId)` — 2–3 byte-identical content-block lines plus, for a
// streamed turn, an early `output_tokens: 1` partial ahead of the final row —
// and every store keeps exactly ONE row per distinct key: the fullest copy
// (the largest token-total; at an equal total a copy carrying Organization
// evidence over one carrying none, and of two carrying different evidence the
// lexicographically smaller `organizationUuid` — #374), ties keep first-seen.
// The tag order is what lets every store end on the same copy in any arrival
// order, and lets a key's verdict ignore the tracked set (ADR-0103 §2, §5).

// The global dedup key. `JSON.stringify` on a two-element tuple encodes an
// absent requestId (`undefined`) and an empty-string requestId as DISTINCT keys
// (`["id",null]` vs `["id",""]`), as required — `requestId` is `string |
// undefined` on older records.
export function fleetDedupKey(messageId: string, requestId: string | undefined): string {
  return JSON.stringify([messageId, requestId ?? null]);
}

// The four token counts every copy of a key carries. The structural type is
// satisfied by every StoredEvent / UsageRecord / FleetEvent.
export type FleetDedupTokens = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};

// An event's total token count — the dedup tie-breaker. When two rows share a
// key, the store keeps the one with the larger total (the dedup rule), so a
// streamed message counts its FINAL row, not the `output_tokens: 1` partial
// that precedes it; the byte-identical content-block lines tie, so first-seen
// wins among those.
export function fleetDedupTokenTotal(r: FleetDedupTokens): number {
  return r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens;
}

/** How full one copy of a key is: its token total and its Organization evidence, if any. */
export interface FleetFullness {
  total: number;
  organizationUuid: string | undefined;
}

// `organizationUuid` is owner evidence only: present when a record resolved
// it, absent for "no evidence" — never the Home organization or a presumption
// (ADR-0103).
export function fleetDedupFullness(
  row: FleetDedupTokens & { organizationUuid?: string },
): FleetFullness {
  return { total: fleetDedupTokenTotal(row), organizationUuid: row.organizationUuid };
}

/**
 * THE fullness order, on its parts: a copy of `aTotal` tokens with evidence
 * `aOrganization` is strictly fuller than one of `bTotal` with `bOrganization`
 * — a larger total; at an equal total, a tag against none, or of two tags the
 * lexicographically smaller (#374). Two equal tags, or two absent ones, are a
 * tie. Every comparison below reads this one definition; it takes parts rather
 * than `FleetFullness` objects because the merge rule runs on every upsert of
 * every feeder and must not allocate (#361).
 */
export function fleetFullnessPartsExceed(
  aTotal: number,
  aOrganization: string | undefined,
  bTotal: number,
  bOrganization: string | undefined,
): boolean {
  if (aTotal !== bTotal) return aTotal > bTotal;
  return (
    aOrganization !== undefined && (bOrganization === undefined || aOrganization < bOrganization)
  );
}

/** `a` is strictly fuller than `b` (`fleetFullnessPartsExceed`). */
export function fleetFullnessExceeds(a: FleetFullness, b: FleetFullness): boolean {
  return fleetFullnessPartsExceed(a.total, a.organizationUuid, b.total, b.organizationUuid);
}

/**
 * The one merge rule: `candidate` replaces `incumbent`. An untagged tie and a
 * same-tag tie keep first-seen, so single-Organization bytes never move; a tie
 * between two different tags goes to the smaller uuid (#374).
 */
export function fleetCopySupersedes(
  candidate: FleetDedupTokens & { organizationUuid?: string },
  incumbent: FleetDedupTokens & { organizationUuid?: string },
): boolean {
  // Monotone: a tag is never lost at an equal total, and a strictly larger
  // untagged copy still beats a smaller tagged one — no field merging.
  return fleetFullnessPartsExceed(
    fleetDedupTokenTotal(candidate),
    candidate.organizationUuid,
    fleetDedupTokenTotal(incumbent),
    incumbent.organizationUuid,
  );
}
