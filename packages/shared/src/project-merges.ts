import { z } from "zod";

// ADR-0064: an anchor is a durable parent-slug handle plus the last-known
// presentation needed when Storage has removed every report row for it.
export const projectAnchorSnapshotSchema = z
  .object({
    anchor: z.string().min(1),
    name: z.string().min(1),
    path: z.string().min(1),
  })
  .passthrough();
export type ProjectAnchorSnapshot = z.infer<typeof projectAnchorSnapshotSchema>;

// One author's versioned statement for one source anchor. `target: null` is an
// explicit Unmerge tombstone, not absence: old offline merges must never
// resurrect when their author reconnects.
export const projectMergeAssertionSchema = z
  .object({
    authorMachineId: z.string().min(1),
    source: projectAnchorSnapshotSchema,
    target: projectAnchorSnapshotSchema.nullable(),
    updatedAt: z.string().datetime(),
  })
  .passthrough();
export type ProjectMergeAssertion = z.infer<typeof projectMergeAssertionSchema>;

// Renderer -> sidecar action. Attribution and the timestamp are sidecar-owned;
// a renderer can ask for a relationship but cannot author another machine's
// row or mint an unbeatable clock value.
export const projectMergeMutationRequestSchema = z.object({
  source: projectAnchorSnapshotSchema,
  target: projectAnchorSnapshotSchema.nullable(),
});
export type ProjectMergeMutationRequest = z.infer<typeof projectMergeMutationRequestSchema>;

export const projectMergeMutationResponseSchema = z.object({
  assertion: projectMergeAssertionSchema,
});
export type ProjectMergeMutationResponse = z.infer<typeof projectMergeMutationResponseSchema>;

export const PROJECT_MERGE_PATH = "/api/project-identity/merge";

// The authoritative map stores one statement per (author, source anchor). NUL
// is safe because project slugs are printable `-`-encoded paths.
export function projectMergeAssertionKey(
  a: Pick<ProjectMergeAssertion, "authorMachineId" | "source">,
): string {
  return `${a.authorMachineId}\u0000${a.source.anchor}`;
}

// Total version ordering used by stores AND the renderer. Clock skew can make
// "newest" differ from wall-clock intent, but the existing Identity directory
// already accepts that trade; the author tie-break makes convergence total.
export function compareProjectMergeAssertions(
  a: ProjectMergeAssertion,
  b: ProjectMergeAssertion,
): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
  if (a.authorMachineId !== b.authorMachineId)
    return a.authorMachineId < b.authorMachineId ? -1 : 1;
  return projectMergeAssertionKey(a).localeCompare(projectMergeAssertionKey(b));
}

export function mergeProjectMergeAssertions(
  into: Map<string, ProjectMergeAssertion>,
  incoming: readonly ProjectMergeAssertion[],
): boolean {
  let changed = false;
  for (const assertion of incoming) {
    const key = projectMergeAssertionKey(assertion);
    const current = into.get(key);
    if (current === undefined || compareProjectMergeAssertions(assertion, current) > 0) {
      into.set(key, assertion);
      changed = true;
    }
  }
  return changed;
}

// Same pull ownership as evidence rows: self-authored statements merge (the
// hub can restore a lost local file); foreign authors mirror the hub union.
export function adoptHubProjectMergeAssertions(
  local: Map<string, ProjectMergeAssertion>,
  hubAssertions: readonly ProjectMergeAssertion[],
  selfMachineId: string,
): { assertions: Map<string, ProjectMergeAssertion>; changed: boolean } {
  const next = new Map<string, ProjectMergeAssertion>();
  for (const [key, assertion] of local)
    if (assertion.authorMachineId === selfMachineId) next.set(key, assertion);
  for (const assertion of hubAssertions) {
    if (assertion.authorMachineId === selfMachineId) {
      mergeProjectMergeAssertions(next, [assertion]);
    } else {
      next.set(projectMergeAssertionKey(assertion), assertion);
    }
  }
  return { assertions: next, changed: !assertionMapsEqual(local, next) };
}

export type ResolvedProjectMerge = {
  assertion: ProjectMergeAssertion;
  sourceKey: string;
  targetKey: string | null;
  status: "active" | "redundant" | "conflict" | "unmerged";
};

export type ProjectMergeResolution = {
  entries: ResolvedProjectMerge[];
  conflicts: ResolvedProjectMerge[];
  targetOf: (automaticGroupKey: string) => string;
  representativeOf: (terminalGroupKey: string) => ProjectAnchorSnapshot | null;
};

// Resolve LWW statements after the caller's automatic fold. The callback is
// what keeps this module shared and pure: renderer and sidecar can each build
// the same automatic key map from the Identity rows they already hold.
export function resolveProjectMergeAssertions(
  assertions: readonly ProjectMergeAssertion[],
  automaticKeyOf: (parentSlug: string) => string,
): ProjectMergeResolution {
  // First collapse each author's retries, then choose the newest statement for
  // each source anchor across authors.
  const perAuthor = new Map<string, ProjectMergeAssertion>();
  mergeProjectMergeAssertions(perAuthor, assertions);
  const perAnchor = new Map<string, ProjectMergeAssertion>();
  for (const assertion of perAuthor.values()) {
    const current = perAnchor.get(assertion.source.anchor);
    if (current === undefined || compareProjectMergeAssertions(assertion, current) > 0)
      perAnchor.set(assertion.source.anchor, assertion);
  }

  // Automatic folding can later join two formerly distinct source anchors. A
  // resolved group still gets one LWW statement, including a null tombstone.
  const perSourceGroup = new Map<string, ProjectMergeAssertion>();
  for (const assertion of perAnchor.values()) {
    const sourceKey = automaticKeyOf(assertion.source.anchor);
    const current = perSourceGroup.get(sourceKey);
    if (current === undefined || compareProjectMergeAssertions(assertion, current) > 0)
      perSourceGroup.set(sourceKey, assertion);
  }

  const entries: ResolvedProjectMerge[] = [];
  const candidates: ResolvedProjectMerge[] = [];
  for (const [sourceKey, assertion] of perSourceGroup) {
    if (assertion.target === null) {
      entries.push({ assertion, sourceKey, targetKey: null, status: "unmerged" });
      continue;
    }
    const targetKey = automaticKeyOf(assertion.target.anchor);
    if (sourceKey === targetKey) {
      entries.push({ assertion, sourceKey, targetKey, status: "redundant" });
      continue;
    }
    candidates.push({ assertion, sourceKey, targetKey, status: "active" });
  }

  // Oldest first means the later edge that would have been rejected by an
  // online validator is the edge ignored after disconnected reconciliation.
  candidates.sort((a, b) => compareProjectMergeAssertions(a.assertion, b.assertion));
  const edges = new Map<string, string>();
  const conflicts: ResolvedProjectMerge[] = [];
  for (const candidate of candidates) {
    const targetKey = candidate.targetKey;
    if (targetKey === null) continue;
    if (wouldCreateCycle(edges, candidate.sourceKey, targetKey)) {
      const conflict = { ...candidate, status: "conflict" as const };
      entries.push(conflict);
      conflicts.push(conflict);
      continue;
    }
    edges.set(candidate.sourceKey, targetKey);
    entries.push(candidate);
  }

  const targetOf = (key: string): string => {
    let current = key;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const next = edges.get(current);
      if (next === undefined) return current;
      current = next;
    }
    return current;
  };

  // The terminal target's newest accepted incoming assertion supplies the
  // last-known target snapshot. Current report/evidence data may supersede its
  // presentation, but this survives a fully forgotten target.
  const representatives = new Map<string, ProjectMergeAssertion>();
  for (const entry of entries) {
    if (entry.status !== "active" || entry.targetKey === null || entry.assertion.target === null)
      continue;
    const terminal = targetOf(entry.targetKey);
    // An earlier hop's target snapshot names an intermediate group. Only an
    // edge whose direct target is terminal may name the visible identity.
    if (entry.targetKey !== terminal) continue;
    const current = representatives.get(terminal);
    if (current === undefined || compareProjectMergeAssertions(entry.assertion, current) > 0)
      representatives.set(terminal, entry.assertion);
  }

  return {
    entries: entries.sort((a, b) => compareProjectMergeAssertions(b.assertion, a.assertion)),
    conflicts,
    targetOf,
    representativeOf: (key) => representatives.get(key)?.target ?? null,
  };
}

function wouldCreateCycle(edges: Map<string, string>, source: string, target: string): boolean {
  let current = target;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    if (current === source) return true;
    seen.add(current);
    const next = edges.get(current);
    if (next === undefined) return false;
    current = next;
  }
  return true;
}

function assertionMapsEqual(
  left: Map<string, ProjectMergeAssertion>,
  right: Map<string, ProjectMergeAssertion>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const other = right.get(key);
    if (other === undefined || !jsonValuesEqual(value, other)) return false;
  }
  return true;
}

// Assertion schemas are passthrough on the fleet wire. Compare JSON content,
// not construction-time key order, so a future additive field neither gets
// missed nor forces a whole-file fsync on every pull.
function jsonValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => jsonValuesEqual(value, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key]));
}
