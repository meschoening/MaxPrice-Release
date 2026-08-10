import { useMemo } from "react";
import type { ProjectIdentityRow, ProjectMergeAssertion } from "@maxprice/shared";
import {
  buildIdentityIndex,
  expandProjectFilter,
  type IdentityIndex,
} from "@/lib/project-identity";
import { useFilters } from "./filters";
import { useProjectIdentity } from "./use-project-identity";

// ADR-0062 — the project axis, `use-machine-axis.ts`'s twin: the ONE place the
// persisted project selection becomes query params. Every report hook reads
// `projectParams`; only the checkbox UI reads `selected`.
//
// Deliberately NOT gated. The machine axis is setting-gated because a hub-less
// client has no fleet to attribute rows to; Repo identity has no such
// precondition — two local checkouts of one repo fold with no hub at all
// (ADR-0062 §4, "the fold itself is never gated"), and the loopback directory
// is this machine's own probe. Hub gating lives on the TRANSPORT (push rides
// `hubShareEvents`, pull rides `hubFleetReplica`), which decides what rows the
// directory holds, not whether the fold runs.
//
// Persisted selections stay PARENT slugs — the expansion is query-build-time
// only, so nothing here owes a filters-version migration, and `index.keyOf` /
// `index.isLocal` (which answer for parent slugs alone) are never handed a
// worktree slug from this path.
export type ProjectAxis = {
  // The raw persisted selection — checkbox state, in its stored order.
  selected: string[];
  // Closure-expanded and sorted: what the report queries emit as `project=`.
  // The sidecar widens each member to its own worktrees via the ADR-0061 prefix
  // predicate, so worktrees are never enumerated renderer-side.
  projectParams: string[];
  // The fold, for options + row grouping (Task 11's surfaces).
  index: IdentityIndex;
  self: string | null;
};

// Module-level so a directory that hasn't loaded yet hands `useMemo` the SAME
// reference every render — an inline `?? []` would churn the memo, and with it
// every downstream memo keyed on the axis.
const NO_ROWS: ProjectIdentityRow[] = [];
const NO_ASSERTIONS: ProjectMergeAssertion[] = [];

export function useProjectAxis(): ProjectAxis {
  const selected = useFilters((s) => s.projects);
  const identityQ = useProjectIdentity();
  const rows = identityQ.data?.rows ?? NO_ROWS;
  const assertions = identityQ.data?.assertions ?? NO_ASSERTIONS;
  const self = identityQ.data?.self ?? null;

  // TWO memos, deliberately: the fold and the filter expansion have different
  // inputs, and only the expansion depends on the selection. Folded into one
  // memo, every checkbox click rebuilt the index — two Maps, a Set, and a
  // per-key sort — and, worse, minted a fresh `index` REFERENCE, which is a dep
  // of use-chart-source's assembly memo and reaches use-live-data: a pure
  // presentation change cascaded into work that has nothing to do with it.
  // Splitting on the real dep boundary makes `index` change only when the
  // directory does.
  const index = useMemo(() => buildIdentityIndex(rows, self, assertions), [rows, self, assertions]);
  return useMemo<ProjectAxis>(
    () => ({ selected, projectParams: expandProjectFilter(selected, index), index, self }),
    [selected, index, self],
  );
}
