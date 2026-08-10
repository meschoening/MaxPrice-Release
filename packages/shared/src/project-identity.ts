import { z } from "zod";
import { projectMergeAssertionSchema } from "./project-merges";
import { isWorktreeSlug, parentProjectSlug } from "./project-path";

// The Identity directory's row — wire payload AND disk line (ADR-0062 §3).
// One row per (machineId, projectSlug): which repo a machine's project
// directory is a checkout of. `.passthrough()` + `.optional()`-only evolution
// forever, like every fleet-crossing shape (the hub.ts rule).
export const projectIdentityRowSchema = z
  .object({
    machineId: z.string(),
    projectSlug: z.string(),
    // The directory's real absolute path on that machine (native separators).
    path: z.string(),
    // The Repo identity fold key, or null for a probed directory with no
    // usable origin — a definite answer, not a missing one (ADR-0062 §1).
    repoId: z.string().nullable(),
    // ISO capture time; the merge rule everywhere is newest-probedAt-wins.
    // VALIDATED, not a bare string, because this value is the sole tiebreaker
    // for an authoritative store that is never wiped — and the comparison is
    // LEXICOGRAPHIC (mergeIdentityRows / adoptHubIdentityRows below, plus the
    // renderer's newest-per-parent index). Any string sorting above digits (a
    // tilde, a letter) would win its (machineId, projectSlug) key FOREVER: no
    // honest probe could overwrite it, and a client adopts such a row even for
    // its own machineId. The hub's POST filter only proves a row's machineId
    // matches the caller's header, so the stamp is untrusted on both sides —
    // the wire is the only place to reject it. `.datetime()` keeps the
    // lexicographic order faithful to chronological order (fixed-width UTC).
    probedAt: z.string().datetime(),
  })
  .passthrough();
export type ProjectIdentityRow = z.infer<typeof projectIdentityRowSchema>;

// One route name on hub and client loopback alike, distinct from the hub's
// /api/machines and the client's /api/projects so logs stay readable.
export const PROJECT_IDENTITY_PATH = "/api/project-identity";

// Cross-machine wire (hub) -------------------------------------------------
export const hubProjectIdentityResponseSchema = z.object({
  rows: z.array(projectIdentityRowSchema),
  // ADR-0064. Optional on the fleet wire per the hub's additive-only rule;
  // current client and Hub ship together and always emit it.
  assertions: z.array(projectMergeAssertionSchema).optional(),
});
export type HubProjectIdentityResponse = z.infer<typeof hubProjectIdentityResponseSchema>;

export const hubProjectIdentityPushRequestSchema = z.object({
  rows: z.array(projectIdentityRowSchema).max(10_000).optional().default([]),
  assertions: z.array(projectMergeAssertionSchema).max(10_000).optional().default([]),
});
// How many rows one push REQUEST carries (the client's send-side chunk size).
// Deliberately far below the accept-side `.max(10_000)` above, and deliberately
// NOT a reason to lower it: hub and client are separately-installed builds, so
// tightening the accept side would 400 an older client's perfectly legal
// payload. The two numbers therefore answer different questions — "what will I
// send" (this, revisable at will) vs "what must I keep accepting" (that, frozen
// by the installed fleet). Own-row growth is MONOTONIC (a dead directory's row
// is never pruned — ADR-0062 §3), so an unchunked full-state push would one day
// cross the cap and 400 forever, permanently and silently stranding that
// machine's rows out of the fleet union.
export const IDENTITY_PUSH_BATCH_MAX = 1000;
export const hubProjectIdentityPushResponseSchema = z.object({
  merged: z.number().int().nonnegative(),
});

// Loopback contract (renderer ↔ sidecar; NOT covered by HUB_PROTOCOL_VERSION)
export const sidecarProjectIdentityResponseSchema = z.object({
  self: z.string(),
  rows: z.array(projectIdentityRowSchema),
  assertions: z.array(projectMergeAssertionSchema),
});
export type SidecarProjectIdentityResponse = z.infer<typeof sidecarProjectIdentityResponseSchema>;

// The map key both stores index rows by. NUL joiner — slugs are `-`-encoded
// paths, so no printable joiner is collision-free.
export function identityRowKey(r: Pick<ProjectIdentityRow, "machineId" | "projectSlug">): string {
  return `${r.machineId}\u0000${r.projectSlug}`;
}

export type AutomaticProjectIdentityIndex = {
  keyBySlug: ReadonlyMap<string, string>;
  membersByKey: ReadonlyMap<string, readonly string[]>;
  localSlugs: ReadonlySet<string>;
};

// ONE automatic-fold implementation for renderer and sidecar validation. The
// latter must reject a user-created cycle against the exact same graph the UI
// will render, including newest-row and deterministic tie-break semantics.
export function buildAutomaticProjectIdentity(
  rows: readonly ProjectIdentityRow[],
  selfMachineId: string | null,
): AutomaticProjectIdentityIndex {
  const newest = new Map<string, ProjectIdentityRow>();
  const localSlugs = new Set<string>();
  for (const row of rows) {
    // Worktree rows corroborate their parent but never determine its repo key;
    // see ADR-0062 and the renderer's pre-0064 implementation.
    if (isWorktreeSlug(row.projectSlug)) continue;
    const parent = parentProjectSlug(row.projectSlug);
    if (selfMachineId !== null && row.machineId === selfMachineId) localSlugs.add(parent);
    const current = newest.get(parent);
    if (
      current === undefined ||
      row.probedAt > current.probedAt ||
      (row.probedAt === current.probedAt && identityRowKey(row) < identityRowKey(current))
    ) {
      newest.set(parent, row);
    }
  }

  const keyBySlug = new Map<string, string>();
  const membersByKey = new Map<string, string[]>();
  for (const [parent, row] of newest) {
    const key = row.repoId ?? parent;
    keyBySlug.set(parent, key);
    const members = membersByKey.get(key) ?? [];
    members.push(parent);
    membersByKey.set(key, members);
  }
  for (const members of membersByKey.values()) members.sort();
  return { keyBySlug, membersByKey, localSlugs };
}

// Newest-probedAt-wins upsert (ADR-0062 §3). Commutative and idempotent; a
// tie keeps the incumbent so replaying a push is a no-op.
export function mergeIdentityRows(
  into: Map<string, ProjectIdentityRow>,
  incoming: readonly ProjectIdentityRow[],
): boolean {
  let changed = false;
  for (const row of incoming) {
    const key = identityRowKey(row);
    const cur = into.get(key);
    if (cur === undefined || row.probedAt > cur.probedAt) {
      into.set(key, row);
      changed = true;
    }
  }
  return changed;
}

// Pull semantics (ADR-0062 §4): the hub's union is authoritative for FOREIGN
// machines — mirrored wholesale, so a purged machine's rows vanish on the next
// pull — while SELF rows merge by newest probedAt, which is what lets the hub
// restore a dead-directory row after a local data-dir loss.
export function adoptHubIdentityRows(
  local: Map<string, ProjectIdentityRow>,
  hubRows: readonly ProjectIdentityRow[],
  selfMachineId: string,
): { rows: Map<string, ProjectIdentityRow>; changed: boolean } {
  const next = new Map<string, ProjectIdentityRow>();
  for (const [k, r] of local) if (r.machineId === selfMachineId) next.set(k, r);
  for (const row of hubRows) {
    if (row.machineId === selfMachineId) {
      mergeIdentityRows(next, [row]);
    } else {
      next.set(identityRowKey(row), row);
    }
  }
  let changed = next.size !== local.size;
  if (!changed) {
    for (const [k, r] of next) {
      const cur = local.get(k);
      if (cur === undefined || !identityRowsEqual(cur, r)) {
        changed = true;
        break;
      }
    }
  }
  return { rows: next, changed };
}

// STRUCTURAL, not field-by-field. The row schema is `.passthrough()` and the
// header above promises optional-only evolution FOREVER (ADR-0062 §3 names
// `mergedInto` as the next field to land), so a comparison that enumerates
// today's fields silently under-reports tomorrow's: the changed row lands in
// `next` and `changed: false` throws it away — adoptUnion keeps the stale map,
// nothing persists, no identity:changed fires, and the client is quietly
// behind the hub on a field it can already parse. The whole point of
// passthrough is that this file need not be edited when a field is added, so
// the change detector must not be the one place that has to be.
//
// Deliberately NOT `JSON.stringify(a) === JSON.stringify(b)`: key order is
// INSERTION order, and these rows reach us from two different constructions —
// a zod parse (schema-shape order, then extras) for hub- and file-sourced rows,
// and the prober's own object literal for locally recorded ones. Two rows equal
// in content but built differently would then report changed on every single
// pull: a persist (a whole-file fsync'd rewrite) plus a renderer poke per
// minute, forever. Recursive because a passthrough field may carry any JSON.
function identityRowsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => identityRowsEqual(v, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  // Count + hasOwn compares the key SETS, which is the order-independence this
  // function exists for; hasOwn rather than an `!== undefined` value probe so a
  // field carrying an explicit undefined is still seen as present on both sides.
  if (keys.length !== Object.keys(right).length) return false;
  for (const k of keys) {
    if (!Object.hasOwn(right, k)) return false;
    if (!identityRowsEqual(left[k], right[k])) return false;
  }
  return true;
}
