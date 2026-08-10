// Renderer-side Repo identity resolution (ADR-0062 §5) — the project axis's
// twin of lib/machines.ts. Rows arrive per (machine, directory); identity is
// resolved at PARENT-slug level (the stage-1 worktree fold's output), newest
// probedAt winning when machines disagree mid-rename.
import {
  buildAutomaticProjectIdentity,
  resolveProjectMergeAssertions,
  type ProjectAnchorSnapshot,
  type ProjectIdentityRow,
  type ProjectMergeAssertion,
  type ResolvedProjectMerge,
} from "@maxprice/shared";

export type IdentityIndex = {
  // The fold key a parent slug belongs to: its repoId, or the slug itself for
  // anything unprobed or origin-less (a definite answer, never a guess).
  keyOf: (parentSlug: string) => string;
  automaticKeyOf: (parentSlug: string) => string;
  // Every parent slug sharing a key, sorted — the closure a filter widens to.
  membersOf: (key: string) => readonly string[];
  // Whether THIS machine has a row for the slug (the local-checkout marker).
  isLocal: (parentSlug: string) => boolean;
  representativeOf: (key: string) => ProjectAnchorSnapshot | null;
  isManualSource: (parentSlug: string) => boolean;
  assertions: readonly ProjectMergeAssertion[];
  mergeEntries: readonly ResolvedProjectMerge[];
  conflicts: readonly ResolvedProjectMerge[];
};

const NO_MEMBERS: readonly string[] = [];

// The identity fold: every slug keys to itself, nothing shares, nothing is
// local. What every surface uses before the directory has loaded (and forever,
// on a hub-less client) — so an absent index is exactly the pre-ADR-0062 app.
export const EMPTY_IDENTITY_INDEX: IdentityIndex = {
  keyOf: (s) => s,
  automaticKeyOf: (s) => s,
  membersOf: () => NO_MEMBERS,
  isLocal: () => false,
  representativeOf: () => null,
  isManualSource: () => false,
  assertions: [],
  mergeEntries: [],
  conflicts: [],
};

export function buildIdentityIndex(
  rows: readonly ProjectIdentityRow[],
  self: string | null,
  assertions: readonly ProjectMergeAssertion[] = [],
): IdentityIndex {
  const automatic = buildAutomaticProjectIdentity(rows, self);
  const automaticKeyOf = (slug: string): string => automatic.keyBySlug.get(slug) ?? slug;
  const resolved = resolveProjectMergeAssertions(assertions, automaticKeyOf);

  // Assertion snapshots keep dormant sources/targets addressable even after
  // Settings > Storage removes every retained report row for them.
  const knownParents = new Set(automatic.keyBySlug.keys());
  for (const assertion of assertions) {
    knownParents.add(assertion.source.anchor);
    if (assertion.target !== null) knownParents.add(assertion.target.anchor);
  }
  const members = new Map<string, string[]>();
  for (const parent of knownParents) {
    const key = resolved.targetOf(automaticKeyOf(parent));
    const list = members.get(key) ?? [];
    list.push(parent);
    members.set(key, list);
  }
  for (const list of members.values()) list.sort();

  const manualSourceKeys = new Set(
    resolved.entries.filter((entry) => entry.status === "active").map((entry) => entry.sourceKey),
  );
  return {
    keyOf: (s) => resolved.targetOf(automaticKeyOf(s)),
    automaticKeyOf,
    membersOf: (k) => members.get(k) ?? NO_MEMBERS,
    isLocal: (s) => automatic.localSlugs.has(s),
    representativeOf: resolved.representativeOf,
    isManualSource: (s) => manualSourceKeys.has(automaticKeyOf(s)),
    assertions: [...assertions],
    mergeEntries: resolved.entries,
    conflicts: resolved.conflicts,
  };
}

// The machine filter's closure-expansion, for projects (ADR-0062 §5): each
// selected parent slug widens to every parent sharing its Repo identity; the
// sidecar's worktree prefix predicate widens each member to its worktrees.
export function expandProjectFilter(selected: readonly string[], index: IdentityIndex): string[] {
  const out = new Set(selected);
  for (const s of selected) for (const m of index.membersOf(index.keyOf(s))) out.add(m);
  return [...out].sort();
}
