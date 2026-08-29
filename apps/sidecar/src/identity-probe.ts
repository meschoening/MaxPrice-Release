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

// A local probe is a stat plus a kilobyte-scale config read: ~5 ms each, ~75 ms
// cold for 15 projects. Five seconds is three orders of magnitude past that, so
// crossing it means something is wrong rather than slow — and the thing it is
// built to catch ran for nearly ten minutes.
export const SLOW_PROBE_WARN_MS = 5_000;

// The other half: a probe that never answers must not strand the round behind
// it. Option A moved the read off the event loop, so a wedged `open(2)` costs
// one Bun pool thread instead of the whole sidecar — but probes are
// SEQUENTIAL, so without a deadline one stuck path still holds up every
// project after it, for as long as the wait lasts (observed: 9m51s).
//
// 30s is far past any plausible healthy probe — ~5 ms each, ~75 ms cold for a
// whole 15-project round, and the watchdog above has already said something at
// 5 s — and far short of what was actually observed. Erring EARLY is cheap by
// construction: ADR-0062 §2 makes an `unreachable` result never overwrite a
// persisted row, so a deadline that fires on a merely-slow probe costs one
// skipped re-stamp and nothing else.
export const PROBE_DEADLINE_MS = 30_000;

export type IdentityProber = {
  // Probe every locally-resolvable project. The boot + manual-rescan trigger.
  //
  // TWO costs, not one, and they now live on different threads.
  //
  // The SCAN half — recovering "which project lives where" — walks EVERY
  // stored event (the fleet corpus, not just this machine's), so it is
  // O(events) and it runs on the loop. Measured on the real corpus: ~18 ms
  // over 77,669 events. That is affordable against a rescan walk of ~300 ms
  // (ADR-0059) and a saturation detector that trips at 30% of a 60 s window
  // (ADR-0056). (The store query is the memoized shared sorted snapshot —
  // iterated, never copied.)
  //
  // The PROBE half is bounded by local project count — a stat plus a small
  // config read each, ~75 ms cold / ~3 ms warm for 15 projects on Windows —
  // and since issue #183 it is ASYNCHRONOUS, so those reads occupy a thread
  // from Bun's pool rather than the one event loop. That is not a speed
  // change; it is the difference between a wedged `open(2)` costing one probe
  // and costing the entire sidecar for as long as it lasts.
  //
  // Probes stay SEQUENTIAL. Nothing here is latency-critical, one path at a
  // time bounds the pool cost to a single thread, and it keeps the
  // one-record-call-per-probe-event rule below trivially true. Sequential is
  // also why each probe carries a DEADLINE (`PROBE_DEADLINE_MS`): without one,
  // a single wedged path would hold up every project queued behind it.
  //
  // Revisit if either the fleet corpus or the local project count grows by an
  // order of magnitude; the shape to reach for then is a store-maintained
  // slug → cwd map for the scan half.
  runAll: () => Promise<void>;
  // A slug the watcher just landed rows for. First sighting probes; every
  // sighting after that is a no-op, so the per-flush hot path costs a Set hit.
  noticeSlug: (slug: string) => Promise<void>;
};

export function createIdentityProber(deps: {
  getStore: () => EventStore;
  machineId: string;
  // fleet.recordProbes — persists + emits identity:changed + (share-gated)
  // pushes. Called with the probed rows of ONE probe event, never per row.
  record: (rows: ProjectIdentityRow[]) => void;
  probe?: (path: string) => Promise<ProbeResult>; // seam; default probeRepoId
  nowIso?: () => string; // seam; default () => new Date().toISOString()
  // Slow-probe watchdog seams (issue #183).
  warn?: (line: string) => void;
  monoImpl?: () => number;
  slowProbeMs?: number;
  probeDeadlineMs?: number;
  setTimeoutImpl?: (cb: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
}): IdentityProber {
  const probe = deps.probe ?? probeRepoId;
  // `toISOString` is UTC at millisecond precision — the merge everywhere
  // compares probedAt LEXICOGRAPHICALLY, so a second-precision or
  // offset-bearing spelling would sort backwards.
  const nowIso = deps.nowIso ?? ((): string => new Date().toISOString());
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const mono = deps.monoImpl ?? ((): number => performance.now());
  const slowProbeMs = deps.slowProbeMs ?? SLOW_PROBE_WARN_MS;
  const probeDeadlineMs = deps.probeDeadlineMs ?? PROBE_DEADLINE_MS;
  const setTimeoutImpl =
    deps.setTimeoutImpl ?? ((cb: () => void, ms: number): unknown => setTimeout(cb, ms));
  const clearTimeoutImpl =
    deps.clearTimeoutImpl ??
    ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const seen = new Set<string>();
  // Paths whose probe blew the deadline and has STILL not returned. Skipped
  // while they sit here — see `abandon`.
  const abandoned = new Set<string>();

  // Names the path a probe is stuck on (issue #183, the half that async alone
  // cannot supply). `lsof` cannot answer this — a blocking `open(2)` has no
  // file descriptor yet — and the wedged process could not log it either,
  // because the loop that would write the line was the thing that stopped.
  // Now the loop survives the wait, so it can say which file it is waiting on
  // while it is still waiting. Silent on a healthy probe.
  async function timedProbe(path: string): Promise<ProbeResult> {
    const startedAt = mono();
    let warned = false;
    const timer = setTimeoutImpl(() => {
      warned = true;
      warn(`[identity-probe] still reading git metadata under ${path} after ${slowProbeMs}ms`);
    }, slowProbeMs);
    try {
      return await probe(path);
    } finally {
      clearTimeoutImpl(timer);
      // Only after a warning — the pair is what makes the episode bounded in
      // the log, and an unwarned probe has nothing worth saying.
      if (warned) {
        warn(`[identity-probe] finished ${path} after ${Math.round(mono() - startedAt)}ms`);
      }
    }
  }

  // Walk away from a probe that blew the deadline — and keep walking away from
  // that path until the read it is waiting on returns.
  //
  // The skip is not tidiness. The abandoned read still holds a Bun pool thread
  // (the OS does not cancel an `open` in progress), so re-probing the same
  // wedged path on every rescan would leak one thread per gesture until the
  // pool is gone — issue #183's own failure mode, one indirection out. One
  // stuck path costs one thread, whatever the user does.
  //
  // If it ever DOES return, the path is healthy again: the skip lifts, and a
  // definite answer is recorded then rather than discarded, because the round
  // that would re-probe it may never come — `runAll` fires at boot and on the
  // manual rescan, and `noticeSlug` fires once per slug per process.
  function abandon(slug: string, path: string, pending: Promise<ProbeResult>): void {
    abandoned.add(path);
    warn(
      `[identity-probe] giving up on ${path} after ${probeDeadlineMs}ms ` +
        `— its identity row stays as it was`,
    );
    void pending
      .then((late) => {
        abandoned.delete(path);
        if (late.kind !== "probed") return; // unreachable never overwrites
        // Its own probe EVENT, hence its own record call: the round it
        // belonged to finished long ago.
        deps.record([
          {
            machineId: deps.machineId,
            projectSlug: slug,
            path,
            repoId: late.repoId,
            probedAt: nowIso(),
          },
        ]);
      })
      // Nothing above may reject unattended. This continuation outlives the
      // round, so there is no caller left to guard it, and an unhandled
      // rejection exits a sidecar the Rust shell never respawns. Covers both a
      // rejecting probe and a throwing `record`; in either case the path did
      // return, so the skip lifts.
      .catch((err: unknown) => {
        abandoned.delete(path);
        warn(`[identity-probe] the abandoned probe of ${path} failed: ${String(err)}`);
      });
  }

  async function probeWithDeadline(slug: string, path: string): Promise<ProbeResult> {
    // Raced OUTSIDE `timedProbe`, deliberately: that leaves its `finally`
    // intact, so whenever the abandoned read finally lands, the closing
    // "finished ... after Nms" line still reaches the log. An opening line
    // with no closing one reads as "still stuck" forever.
    const pending = timedProbe(path);
    let timer: unknown;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeoutImpl(() => resolve("deadline"), probeDeadlineMs);
    });
    let outcome: ProbeResult | "deadline";
    try {
      outcome = await Promise.race([pending, deadline]);
    } finally {
      clearTimeoutImpl(timer);
    }
    if (outcome !== "deadline") return outcome;
    abandon(slug, path, pending);
    return { kind: "unreachable" };
  }

  async function probePaths(paths: Map<string, string>): Promise<void> {
    const rows: ProjectIdentityRow[] = [];
    for (const [slug, path] of paths) {
      seen.add(slug);
      // Still wedged from an earlier round. `abandon` announced it once; a
      // line per skipped round would only bury it.
      if (abandoned.has(path)) continue;
      const r = await probeWithDeadline(slug, path);
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
    // `async` so the SCAN half's failures (a throwing `getStore`, a throwing
    // walk) arrive as a rejection like the probe half's. Both call sites guard
    // a promise; a synchronous throw would sail straight past that guard, and
    // the boot one would then reach `unhandledRejection` — which exits the
    // sidecar the Rust shell never respawns.
    runAll: async () => probePaths(selfExactProjectPaths(deps.getStore().query(), deps.machineId)),
    noticeSlug: async (slug) => {
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
      await probePaths(paths);
    },
  };
}
