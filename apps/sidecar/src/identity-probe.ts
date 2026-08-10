// Which of the engine's known projects live at which LOCAL paths — and the
// prober that turns those paths into Identity-directory rows (ADR-0062 §2).
//
// Only EXACT captures qualify: a cwd that re-encodes to the slug
// (slugFromPath(cwd) === slug) is provably the directory the slug names; a
// wandering session's fallback cwd is not, and probing it would attribute the
// WRONG repo. Foreign machines' rows never qualify — their paths don't exist
// on this filesystem, and rows of machine M are authored only by M.
import { slugFromPath, type ProjectIdentityRow } from "@maxprice/shared";
import { compileAxisMatcher, type EventStore, type StoredEvent } from "./engine/store";
import { probeRepoId, type ProbeResult } from "./repo-probe";

export function selfExactProjectPaths(
  events: readonly StoredEvent[],
  selfMachineId: string,
  // An optional extra membership test, applied per event beside the machine
  // check. `null`/absent means "every event", mirroring `compileAxisMatcher`'s
  // own "no axis filtered" signal — which is exactly what `noticeSlug` passes,
  // so scoping to one slug reuses the ONE axis-matching definition (ADR-0061's
  // worktree prefix included) instead of re-deriving it here.
  accept?: ((e: StoredEvent) => boolean) | null,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.machineId !== selfMachineId) continue;
    if (accept && !accept(e)) continue;
    if (e.cwd === undefined || out.has(e.projectSlug)) continue;
    // The same O(1) guard the engine's `capturePath` carries: `slugFromPath`
    // replaces each non-alphanumeric CODE UNIT with exactly one "-", so it is
    // length-preserving and a cwd of a different length provably cannot encode
    // to this slug. A slug that never latches — a renamed or deleted directory
    // — otherwise re-runs the regex for every event it owns, and this walk sees
    // the whole corpus. Pinned by the length property test in packages/shared.
    if (e.cwd.length === e.projectSlug.length && slugFromPath(e.cwd) === e.projectSlug) {
      out.set(e.projectSlug, e.cwd);
    }
  }
  return out;
}

export type IdentityProber = {
  // Probe every locally-resolvable project. The boot + manual-rescan trigger.
  //
  // TWO costs, not one, and the scan half is the bigger surprise: recovering
  // "which project lives where" walks EVERY stored event (the fleet corpus,
  // not just this machine's), so that half is O(events) — while the probe half
  // is bounded by local project count, a stat plus a small config read each.
  // Measured on the real corpus: ~18 ms for the scan over 77,669 events, plus
  // ~75 ms cold / ~3 ms warm for 15 local projects on Windows — ~95 ms cold, on
  // a loop whose saturation detector trips at 30% of a 60 s window (ADR-0056)
  // and behind a rescan walk that itself costs ~300 ms (ADR-0059). So it runs
  // straight through on the loop rather than pacing itself. (The store query is
  // the memoized shared sorted snapshot — iterated, never copied.)
  //
  // Revisit if either the fleet corpus or the local project count grows by an
  // order of magnitude; the shapes to reach for then are a store-maintained
  // slug → cwd map, or chunking the probes across macrotasks.
  runAll: () => void;
  // A slug the watcher just landed rows for. First sighting probes; every
  // sighting after that is a no-op, so the per-flush hot path costs a Set hit.
  noticeSlug: (slug: string) => void;
};

export function createIdentityProber(deps: {
  getStore: () => EventStore;
  machineId: string;
  // fleet.recordProbes — persists + emits identity:changed + (share-gated)
  // pushes. Called with the probed rows of ONE probe event, never per row.
  record: (rows: ProjectIdentityRow[]) => void;
  probe?: (path: string) => ProbeResult; // seam; default probeRepoId
  nowIso?: () => string; // seam; default () => new Date().toISOString()
}): IdentityProber {
  const probe = deps.probe ?? probeRepoId;
  // `toISOString` is UTC at millisecond precision — the merge everywhere
  // compares probedAt LEXICOGRAPHICALLY, so a second-precision or
  // offset-bearing spelling would sort backwards.
  const nowIso = deps.nowIso ?? ((): string => new Date().toISOString());
  const seen = new Set<string>();

  function probePaths(paths: Map<string, string>): void {
    const rows: ProjectIdentityRow[] = [];
    for (const [slug, path] of paths) {
      seen.add(slug);
      const r = probe(path);
      if (r.kind !== "probed") continue; // unreachable never overwrites (ADR-0062 §2)
      // Stamped on EVERY successful probe, unchanged result included: that
      // re-stamp is what makes the directory's newest-probedAt merge treat each
      // probe event as news, so fleet.recordProbes emits + re-offers the row.
      rows.push({
        machineId: deps.machineId,
        projectSlug: slug,
        path,
        repoId: r.repoId,
        probedAt: nowIso(),
      });
    }
    // One record call per probe EVENT — an all-unreachable sweep records
    // nothing at all rather than an empty change.
    if (rows.length > 0) deps.record(rows);
  }

  return {
    runAll: () => probePaths(selfExactProjectPaths(deps.getStore().query(), deps.machineId)),
    noticeSlug: (slug) => {
      if (seen.has(slug)) return;
      // The scope is SEMANTIC, not a saving. An unfiltered `query()` hands back
      // the store's memoized sorted snapshot — no copy, no iteration — so a
      // filtered store query is strictly MORE work than the unfiltered one, and
      // the scoping cannot be justified on the query's cost. What it bounds is
      // the PROBE set: unscoped, this would hand `probePaths` every project on
      // the machine and re-stat the whole world the first time one new slug
      // appears. The scan is affordable because the `seen` guard above makes
      // this run at most ONCE PER SLUG for the process lifetime — not per
      // watcher flush, which costs only that Set hit.
      //
      // Scoped through the store's own compiled matcher rather than a
      // `slug ===` test because ADR-0061's project axis also admits the slug's
      // WORKTREES, which is wanted — a worktree is its own directory with its
      // own row — and that prefix rule must have exactly one definition.
      const paths = selfExactProjectPaths(
        deps.getStore().query(),
        deps.machineId,
        compileAxisMatcher({ projects: [slug] }),
      );
      // Even a no-cwd / unreachable miss counts as seen, or every subsequent
      // flush for that slug re-queries (and re-stats a dead directory). The
      // boot/rescan runAll re-covers it once a capture or the directory lands.
      seen.add(slug);
      probePaths(paths);
    },
  };
}
