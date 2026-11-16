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

/**
 * How full one copy of a key is: its token total and its Attribution evidence
 * tags, an Organization and an Account, each if any.
 */
export interface FleetFullness {
  total: number;
  organizationUuid: string | undefined;
  accountUuid: string | undefined;
}

/** The tags a copy of a key may carry (ADR-0103 §1, ADR-0137 §6). */
export type FleetTags = { organizationUuid?: string; accountUuid?: string };

// `organizationUuid` and `accountUuid` are evidence only: present when a
// record resolved them, absent for "no evidence" — never the Home
// organization, a Presumed membership or an email hash (ADR-0103, ADR-0137).
export function fleetDedupFullness(row: FleetDedupTokens & FleetTags): FleetFullness {
  return {
    total: fleetDedupTokenTotal(row),
    organizationUuid: row.organizationUuid,
    accountUuid: row.accountUuid,
  };
}

// One tag against another, at an equal tag count: a present value beats an
// absent one, and of two present values the lexicographically smaller wins.
// +1: `a` wins, -1: `b` wins, 0: equal (both absent, or the same value).
function compareTag(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return a < b ? 1 : -1;
}

/**
 * THE fullness order, on its parts: a copy of `aTotal` tokens tagged
 * (`aOrganization`, `aAccount`) is strictly fuller than one of `bTotal`
 * tagged (`bOrganization`, `bAccount`) when
 *
 * 1. its total is larger; else, at an equal total,
 * 2. it carries more tags (0–2, a tag being a present `organizationUuid` or
 *    `accountUuid`); else, at an equal count,
 * 3. its Organization tag wins (`compareTag`); else, at an equal one,
 * 4. its Account tag wins.
 *
 * Identical tags are a tie. On distinct tag pairs this is a strict total
 * order, so every store ends on the same copy in any arrival order. With no
 * Account tag anywhere it is exactly #374's order. Every comparison below
 * reads this one definition; it takes parts rather than `FleetFullness`
 * objects because the merge rule runs on every upsert of every feeder and
 * must not allocate (#361).
 */
export function fleetFullnessPartsExceed(
  aTotal: number,
  aOrganization: string | undefined,
  aAccount: string | undefined,
  bTotal: number,
  bOrganization: string | undefined,
  bAccount: string | undefined,
): boolean {
  if (aTotal !== bTotal) return aTotal > bTotal;
  const aCount = (aOrganization === undefined ? 0 : 1) + (aAccount === undefined ? 0 : 1);
  const bCount = (bOrganization === undefined ? 0 : 1) + (bAccount === undefined ? 0 : 1);
  if (aCount !== bCount) return aCount > bCount;
  const organization = compareTag(aOrganization, bOrganization);
  if (organization !== 0) return organization > 0;
  return compareTag(aAccount, bAccount) > 0;
}

/** `a` is strictly fuller than `b` (`fleetFullnessPartsExceed`). */
export function fleetFullnessExceeds(a: FleetFullness, b: FleetFullness): boolean {
  return fleetFullnessPartsExceed(
    a.total,
    a.organizationUuid,
    a.accountUuid,
    b.total,
    b.organizationUuid,
    b.accountUuid,
  );
}

/**
 * The one merge rule: `candidate` replaces `incumbent`. An untagged tie and an
 * identical-tags tie keep first-seen, so single-Organization and
 * single-Account bytes never move; a tie between different tags goes by
 * `fleetFullnessPartsExceed` (#374, ADR-0137 §6).
 */
export function fleetCopySupersedes(
  candidate: FleetDedupTokens & FleetTags,
  incumbent: FleetDedupTokens & FleetTags,
): boolean {
  // Monotone: a tag is never lost at an equal total, and a strictly larger
  // untagged copy still beats a smaller tagged one — no field merging.
  return fleetFullnessPartsExceed(
    fleetDedupTokenTotal(candidate),
    candidate.organizationUuid,
    candidate.accountUuid,
    fleetDedupTokenTotal(incumbent),
    incumbent.organizationUuid,
    incumbent.accountUuid,
  );
}
