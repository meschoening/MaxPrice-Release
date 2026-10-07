import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { ForgetSessionRef } from "@maxprice/shared";
import type { FleetForgetResult } from "./fleet";

// The one-shot repair of already-synced history (ADR-0098). Once the walk has
// classified sessions as holding foreign events, drop THIS machine's rows for
// those sessions from the hub archive (ADR-0063's forget — the epoch bump
// reseeds every replica) and only their excluded keys from the local archive
// (#375: the admitted rows stay, and no pair is barred), then rebuild so the
// engine is derived from the pruned copies. The ordinary re-push then restores
// a mixed session's admitted rows on the Hub. Safe by construction: a session
// is on the list only because a transcript proved it foreign, so it is backed
// and re-pushable.
//
// Progress is durable PER TARGET in `organization-repair.json`, so a hub that
// is offline today is retried on a timer without repeating the archive rewrite,
// and a completed repair costs nothing on later boots. The marker is keyed by
// the sorted tracked set (#276): a different set is a different classification.
// The moment a real, differently-keyed marker is found, its done lists are
// wiped and the empty marker is saved immediately — even when there is nothing
// to repair this run — so a set that is excluded, re-tracked, and excluded
// again can never meet a done list a prior exclusion wrote under the same key.
// `reset()` is the same wipe without a run: the settings driver calls it when a
// change's own repair is skipped, because a skipped repair is also a skipped
// rekey (#276).
//
// The dormant half (#311, ADR-0107 §12) runs after the evidence half on every
// run, whether or not anything is foreign. A dormant row is an owner-less own
// row of a session asserted to an Organization this machine does not track: the
// store refuses it, but its transcript and archive line stay, so it comes back
// once the assertion clears. So its pairs are forgotten on the Hub alone,
// LOSSLESSLY: no Local archive rewrite and no rebuild. Its progress is the
// marker's own `dormantHubDone`, keyed by `dormant`, a digest of the dormant
// session set. A different digest wipes that list only, and is persisted at
// once for the same reason a tracked rekey is; a different hub target wipes it
// with `hubDone`, and `reset()` wipes it with everything. A marker written
// before #311 parses with both fields defaulted, which is the key of an empty
// dormant set, so an upgraded machine with no assertion rewrites nothing.
//
// A v0.7.1 marker is MIGRATED, not discarded (#368). That release wrote
// `version: 2` keyed by `home`, and under it `home: H` was the resolved tracked
// set {H}, so the file reads as the v3 marker `tracked: [H]` with its hub target
// and both done lists, the dormant fields defaulted as a pre-#311 v3 marker's
// are. `home: null` reads as the null set's key, `[]`. `loadMarker`'s ordinary
// comparison then decides: a set still equal to {H} keeps the done lists, any
// other rekeys. Either way the v3 body is persisted at once, so the v2 file is
// read once. Both versions' `pairKey` is `${projectSlug}\u0000${sessionId}`, so
// the done lists carry over verbatim. Without this, an upgraded machine
// repeated its whole completed repair: a Hub forget per foreign pair, and a
// Local archive rewrite that, before #375, dropped a mixed session's tracked
// rows until the next boot's sweep. A v2 body that fails its own schema is
// still absent.
// The done lists it carries are trusted no further than the Local archive
// agrees: v0.7.1 read no Login record, so a pair it finished can still hold
// rows this tree excludes, and the evidence half strikes such a pair from the
// lists, under any marker, persisting the strike before any forget
// (`archivedExcludedPairs`, #368 review).

const markerSchema = z.object({
  version: z.literal(3),
  tracked: z.array(z.string()),
  hubTarget: z.string().nullable(),
  archiveDone: z.array(z.string()),
  hubDone: z.array(z.string()),
  dormant: z.string().default(""),
  dormantHubDone: z.array(z.string()).default([]),
});
type Marker = z.infer<typeof markerSchema>;

// v0.7.1's marker (`git show 994afaf:apps/sidecar/src/organization-repair.ts`).
// Its `home` was never null on disk (v0.7.1 returned before writing without
// one); a null is read anyway, as the key of a null set.
const markerV2Schema = z.object({
  version: z.literal(2),
  home: z.string().nullable(),
  hubTarget: z.string().nullable(),
  archiveDone: z.array(z.string()),
  hubDone: z.array(z.string()),
});

// The on-disk document as a v3 marker, or null when it is neither version.
// `migrated` is true for a v2 body: the file must be rewritten even when the
// comparison keeps everything.
function parseMarker(raw: unknown): { data: Marker; migrated: boolean } | null {
  const v3 = markerSchema.safeParse(raw);
  if (v3.success) return { data: v3.data, migrated: false };
  const v2 = markerV2Schema.safeParse(raw);
  if (!v2.success) return null;
  const { home, hubTarget, archiveDone, hubDone } = v2.data;
  return {
    data: markerSchema.parse({
      version: 3,
      tracked: home === null ? [] : [home],
      hubTarget,
      archiveDone,
      hubDone,
    }),
    migrated: true,
  };
}

const DEFAULT_RETRY_MS = 300_000;

const trackedKey = (set: ReadonlySet<string>): string[] => [...set].sort();

function sameKey(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

// #311: the dormant half's key. Sorted, JSON-encoded (a session id is any string),
// hashed; "" for nothing dormant, which is also what a pre-#311 marker defaults to,
// so an upgraded machine with no claim meets its own key and rewrites nothing.
export function dormantDigest(ids: ReadonlySet<string>): string {
  if (ids.size === 0) return "";
  return createHash("sha256")
    .update(JSON.stringify([...ids].sort()))
    .digest("hex");
}

// Transient: the hub disconnected, the replica detached, or another forget on
// this machine is already doing the work. Retried by the timer. Anything else
// (e.g. an unsupported endpoint) is permanent, retried only on a later run.
function transient(result: Extract<FleetForgetResult, { ok: false }>): boolean {
  return result.reason === "unavailable" || result.reason === "busy" || result.retryable === true;
}

export type OrganizationRepairDeps = {
  markerPath: string;
  trackedOrganizations: () => ReadonlySet<string> | null;
  foreignSessions: () => ForgetSessionRef[];
  hubTarget: () => string | null;
  // Automatic fleet forget is independent of replica attachment. Transport,
  // server and receipt failures carry retryable=true; permanent refusals don't.
  forgetOnHub: (
    sessions: readonly ForgetSessionRef[],
    target: string,
  ) => Promise<FleetForgetResult>;
  // The archive-only forget (no Hub target, or a Hub forget that did not
  // complete), key-scoped (#375, `localArchive.forgetExcludedKeys`): the
  // pairs' excluded keys go, their admitted rows stay, and nothing is barred.
  // Never the user Forget's pair-wide rewrite, which would drop a mixed
  // session's admitted rows.
  forgetExcludedFromLocalArchive: (sessions: readonly ForgetSessionRef[]) => Promise<void>;
  // fleet.rebuildEngine — after an archive-only forget.
  rebuild: () => Promise<void>;
  // The dormant half (#311), read from main()'s live engine store: its dormant
  // session snapshot (the marker's `dormant` key), the locally backed pairs it
  // refused as dormant, and the lossless Hub forget of those pairs, which never
  // rewrites the Local archive. Within one run the two reads can come from
  // different stores: the digest is read before the evidence half's awaits
  // (its forget and its `rebuild()`, which swaps the store, or any rebuild that
  // lands meanwhile), and the pairs after. That is safe: the pairs are marked
  // under the older digest, so if the newer store's set differs, the next run
  // meets a different digest, wipes the list and forgets again.
  dormantSessions: () => ReadonlySet<string>;
  dormantPairs: () => ForgetSessionRef[];
  forgetDormantOnHub: (
    sessions: readonly ForgetSessionRef[],
    target: string,
  ) => Promise<FleetForgetResult>;
  // #368 review: every (projectSlug, sessionId) whose Local archive rows
  // include a key the live store excludes (`localArchive.excludedPairs()`).
  // Such a pair is struck from the done lists before either half runs.
  archivedExcludedPairs: () => ForgetSessionRef[];
  // Injectable publication boundary for marker concurrency tests.
  renameMarker?: (from: string, to: string) => Promise<void>;
  retryMs?: number;
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
};

export type OrganizationRepair = {
  // Idempotent; concurrent calls coalesce into the in-flight run — but a call
  // that arrives mid-run schedules one more pass after the in-flight one
  // settles, so its own request (e.g. a session that became foreign, or a
  // tracked-set change, during the in-flight run) is actually served before
  // the returned promise resolves, not silently dropped.
  run: () => Promise<void>;
  // Live evidence may classify another row in a previously repaired session.
  invalidate: (sessions: readonly ForgetSessionRef[]) => Promise<void>;
  // Discard the durable progress WITHOUT repairing anything (#276). The
  // settings driver calls this whenever it skips a change's repair: the repair
  // is what rekeys the marker, so skipping it would leave a set that returns to
  // a previously repaired key meeting that key's old done lists. Wipes the
  // dormant list too (#311). Forgets nothing, reads no store verdict (only the
  // keys), and never rejects.
  reset: () => Promise<void>;
  stop: () => void;
};

function pairKey(s: ForgetSessionRef): string {
  return `${s.projectSlug}\u0000${s.sessionId}`;
}

export function createOrganizationRepair(deps: OrganizationRepairDeps): OrganizationRepair {
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;
  const setIntervalImpl = deps.setIntervalImpl ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalImpl =
    deps.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  let inflight: Promise<void> | null = null;
  let retry: unknown = null;
  let stopped = false;
  let rerun = false;
  const invalidated = new Set<string>();
  // Bumped by every `reset()`, synchronously at the call. A run that read the
  // marker under an earlier generation must not write its done lists back over
  // the wipe — see `persist`.
  let markerGeneration = 0;
  // The generation whose wipe has actually landed on disk. While it trails
  // `markerGeneration`, the file still holds done lists a reset has already
  // discarded, and a run must not read them — see `runInner`.
  let diskGeneration = 0;
  // Runs and resets share one queue, including every marker write and rename.
  let operations: Promise<void> = Promise.resolve();

  function freshMarker(tracked: string[], dormant: string, hubTarget: string | null): Marker {
    return {
      version: 3,
      tracked,
      hubTarget,
      archiveDone: [],
      hubDone: [],
      dormant,
      dormantHubDone: [],
    };
  }

  // `persistNow` is true when a REAL, readable marker exists for a different
  // tracked set or dormant set (a rekey) — never for an absent or corrupt
  // file, which carries no prior classification to wipe — or when the file is
  // a v0.7.1 marker, which is rewritten as v3 whatever the comparison keeps
  // (#368).
  async function loadMarker(
    tracked: string[],
    dormant: string,
    hubTarget: string | null,
  ): Promise<{ marker: Marker; persistNow: boolean }> {
    try {
      const parsed = parseMarker(JSON.parse(await readFile(deps.markerPath, "utf8")));
      if (parsed !== null) {
        const { data, migrated } = parsed;
        if (sameKey(data.tracked, tracked)) {
          const sameHub = data.hubTarget === hubTarget;
          // #311: a different dormant set wipes only its own done list, and,
          // like a tracked rekey, is persisted at once, before any return.
          const sameDormant = data.dormant === dormant;
          return {
            marker: {
              ...data,
              hubTarget,
              hubDone: sameHub ? data.hubDone : [],
              dormant,
              dormantHubDone: sameHub && sameDormant ? data.dormantHubDone : [],
            },
            persistNow: migrated || !sameDormant,
          };
        }
        return { marker: freshMarker(tracked, dormant, hubTarget), persistNow: true };
      }
    } catch {
      // Absent or unreadable: nothing has been repaired under this tracked set.
    }
    return { marker: freshMarker(tracked, dormant, hubTarget), persistNow: false };
  }

  async function saveMarker(marker: Marker): Promise<void> {
    const tmp = `${deps.markerPath}.tmp`;
    await writeFile(tmp, JSON.stringify(marker));
    await (deps.renameMarker ?? rename)(tmp, deps.markerPath);
  }

  // Every save a RUN makes goes through here. A `reset()` that landed after the
  // run read the marker has already discarded the progress this would write,
  // and the run's own completions are safe to lose: re-forgetting a session
  // already gone is an empty deletion (ADR-0100), so the next run simply
  // repairs the whole classification again.
  async function persist(marker: Marker, generation: number): Promise<void> {
    if (generation !== markerGeneration) return;
    await saveMarker(marker);
  }

  function armRetry(): void {
    if (retry !== null || stopped) return;
    retry = setIntervalImpl(() => void run(), retryMs);
  }

  function disarmRetry(): void {
    if (retry === null) return;
    clearIntervalImpl(retry);
    retry = null;
  }

  async function runInner(): Promise<void> {
    // Captured before the marker is read, so ANY reset from here on marks this
    // pass's view of the done lists stale.
    const generation = markerGeneration;
    const tracked = deps.trackedOrganizations();
    // A null tracked set (nothing excluded) is a key of its own, represented
    // on disk as `tracked: []` — a resolved non-null set always contains
    // Home, so the empty array can never collide with a real one.
    const trackedKeyArr = tracked === null ? [] : trackedKey(tracked);
    const dormant = dormantDigest(deps.dormantSessions());
    const hubTarget = deps.hubTarget()?.replace(/\/+$/, "") ?? null;
    const { marker, persistNow } =
      generation === diskGeneration
        ? await loadMarker(trackedKeyArr, dormant, hubTarget)
        : // A reset has been called whose wipe has not landed yet (or failed):
          // the file still carries the done lists it discarded. Start from an
          // empty marker instead of reading them — the wipe, when it lands,
          // only ever wipes, so nothing this run writes is trusted more than
          // it should be.
          { marker: freshMarker(trackedKeyArr, dormant, hubTarget), persistNow: false };
    if (persistNow) {
      // A real marker exists for a different tracked set or dormant set: its
      // done lists (or, for the dormant set, its dormant list) don't apply to
      // this classification. Persist the wipe now, BEFORE either half can
      // return early, so a set that is excluded, re-tracked, and excluded
      // again (or cleared to null and restored, or asserted, cleared and
      // asserted again) can never meet a done list the prior exclusion wrote
      // under the same key. A migrated v0.7.1 marker (#368) is persisted here
      // too, as the v3 body its comparison produced.
      await persist(marker, generation);
    }
    if (tracked === null) {
      // Nothing is excluded, so nothing is dormant either: no forget, no
      // rebuild — just the rekey above, if any.
      disarmRetry();
      return;
    }
    const archiveDone = new Set(marker.archiveDone);
    const hubDone = new Set(marker.hubDone);
    const dormantHubDone = new Set(marker.dormantHubDone);
    const snapshot = (): Marker => ({
      version: 3,
      tracked: trackedKeyArr,
      hubTarget,
      archiveDone: [...archiveDone],
      hubDone: [...hubDone],
      dormant,
      dormantHubDone: [...dormantHubDone],
    });
    let changed = false;
    let hubPending = false;
    // The pairs THIS run's evidence forget attempted, whatever its answer.
    const evidenceAttempted = new Set<string>();

    // 1. The evidence half (#276). An empty list no longer returns: the
    //    dormant half below must run whether or not anything is foreign.
    const sessions = deps.foreignSessions();
    if (sessions.length > 0) {
      // A done pair whose Local archive rows still include a key the store
      // excludes is not done (#368 review). A done list records that a forget
      // RAN, under the attribution rule of the build that ran it; the archive
      // says whether its rows are still owed. So such a pair re-enters both
      // halves: the Hub forget deletes its own rows there and the resync
      // re-pushes the admitted ones tagged, or, with no Hub, the archive
      // forget drops them. When it removes anything it is persisted at once,
      // before either forget, as an invalidation is: the archive stops being
      // durable evidence the moment the Local archive forget below erases
      // those very rows. A Hub forget that fails transiently, then
      // a rebuild that throws or a process that dies mid-walk, would otherwise
      // leave the pair done in both lists on disk, and the next boot, finding
      // no excluded row, would never send the Hub its forget.
      // Applied to EVERY marker, not only a migrated one, because it is a
      // no-op in steady state: a completed forget removed every archived row
      // of the pair whose key the store excludes (#375), and the archive only
      // ever receives the store's admitted rows, which never carry an
      // excluded key. An excluded key can reappear in a done pair's archive
      // only when a row's classification changed later: an attribution-rule
      // change (v0.7.1's Owner-record-only split, ADR-0109), a restart that
      // lost the in-process `invalidate`, or a new copy that now holds the
      // key (#374). Each is a repair owed. Nothing is excluded when nothing is
      // foreign, so the check is skipped then. Dormant rows are never
      // excluded keys, so `dormantHubDone` is untouched: the evidence half's
      // Hub forget covers the pair for that half too.
      let struck = false;
      for (const s of deps.archivedExcludedPairs()) {
        const fromArchive = archiveDone.delete(pairKey(s));
        const fromHub = hubDone.delete(pairKey(s));
        if (fromArchive || fromHub) struck = true;
      }
      const pendingInvalidations = [...invalidated];
      for (const key of pendingInvalidations) {
        archiveDone.delete(key);
        hubDone.delete(key);
      }
      if (struck || pendingInvalidations.length > 0) {
        await persist(snapshot(), generation);
        for (const key of pendingInvalidations) invalidated.delete(key);
      }
      if (hubTarget !== null) {
        const pendingHub = sessions.filter((s) => !hubDone.has(pairKey(s)));
        if (pendingHub.length > 0) {
          for (const s of pendingHub) evidenceAttempted.add(pairKey(s));
          const result = await deps.forgetOnHub(pendingHub, hubTarget);
          if (result.ok) {
            // fleet.forget removed the pairs' excluded keys from the local
            // archive (#375) and resynced the engine too. It also deleted
            // every own row of each pair on the Hub, and the resync never
            // re-pushes a dormant row, so each pair is done for the dormant
            // half as well.
            for (const s of pendingHub) {
              hubDone.add(pairKey(s));
              archiveDone.add(pairKey(s));
              dormantHubDone.add(pairKey(s));
            }
            changed = true;
          } else {
            // Transient: retried by the timer. Permanent: only on a later run.
            if (transient(result)) hubPending = true;
            console.warn(
              `[sidecar] organization repair: hub forget deferred (${result.reason}: ${result.detail})`,
            );
          }
        }
      }
      const pendingArchive = sessions.filter((s) => !archiveDone.has(pairKey(s)));
      if (pendingArchive.length > 0) {
        await deps.forgetExcludedFromLocalArchive(pendingArchive);
        for (const s of pendingArchive) archiveDone.add(pairKey(s));
        changed = true;
        await deps.rebuild();
      }
    }

    // 2. The dormant half (#311, ADR-0107 §12): the Hub only, losslessly, with
    //    no archive work and no rebuild. It skips only the pairs this run's
    //    evidence forget attempted, succeeded or not. That forget deletes
    //    every own row of each pair on the Hub, and while its durable intent
    //    is pending any other forget answers `busy`, whether its scope differs
    //    or only its mode does (fleet.ts `forgetInner`). So requesting the
    //    pair here too would only add a redundant forget or a busy-and-retry;
    //    a pair whose evidence forget failed is retried by a later run. A
    //    pair the evidence half finished on an EARLIER run is not skipped:
    //    that forget's resync re-pushed the owner-less rows a later assertion
    //    made dormant, so only this half can take them off the Hub.
    if (hubTarget !== null) {
      const pending = deps
        .dormantPairs()
        .filter((s) => !dormantHubDone.has(pairKey(s)) && !evidenceAttempted.has(pairKey(s)));
      if (pending.length > 0) {
        const result = await deps.forgetDormantOnHub(pending, hubTarget);
        if (result.ok) {
          for (const s of pending) dormantHubDone.add(pairKey(s));
          changed = true;
        } else {
          if (transient(result)) hubPending = true;
          console.warn(
            `[sidecar] organization repair: dormant hub forget deferred (${result.reason}: ${result.detail})`,
          );
        }
      }
    }

    if (changed) await persist(snapshot(), generation);
    if (hubPending) armRetry();
    else disarmRetry();
  }

  function run(): Promise<void> {
    if (inflight !== null) {
      // A request arrived mid-run: its state (foreignSessions/trackedOrganizations)
      // was not read by the run already in flight, so schedule one more pass
      // once it settles rather than serving this caller a stale answer.
      rerun = true;
      return inflight;
    }
    inflight = operations
      .then(async () => {
        do {
          rerun = false;
          await runInner().catch((err: unknown) =>
            console.error("[sidecar] organization repair failed:", err),
          );
        } while (rerun && !stopped);
      })
      .finally(() => {
        inflight = null;
      });
    operations = inflight;
    return inflight;
  }

  // The wipe with no run behind it (#276). Keyed to whatever sets are live now
  // (the dormant key is the live store's construction-time snapshot, #311) —
  // the key is free to choose, because the lists are EMPTY: the next `run()`
  // under any set either matches this key and finds nothing done, or differs
  // and rekeys. So it reads no store verdict, calls no forget, and triggers no
  // rebuild, which is what makes it safe on the one path that must not act: a
  // change whose tracked set moved out from under its walk.
  function reset(): Promise<void> {
    // Synchronous, at the call: every save an in-flight run has not made yet is
    // now stale, including the one it is about to make.
    markerGeneration += 1;
    const generation = markerGeneration;
    operations = operations.then(async () => {
      try {
        // Earlier runs have settled; later runs wait for this wipe to publish.
        const tracked = deps.trackedOrganizations();
        const hubTarget = deps.hubTarget()?.replace(/\/+$/, "") ?? null;
        await saveMarker(
          freshMarker(
            tracked === null ? [] : trackedKey(tracked),
            dormantDigest(deps.dormantSessions()),
            hubTarget,
          ),
        );
        diskGeneration = generation;
      } catch (err: unknown) {
        // Never rejects: the settings driver awaits this in place of a repair.
        // A failed wipe leaves `diskGeneration` behind, so every later run
        // distrusts the file and repairs the whole classification again
        // (redundant re-forgets, ADR-0100) until a wipe does land — a forget
        // is never missed to it.
        console.error("[sidecar] organization repair reset failed:", err);
      }
    });
    return operations;
  }

  return {
    run,
    invalidate: (sessions) => {
      for (const session of sessions) invalidated.add(pairKey(session));
      return run();
    },
    reset,
    stop: () => {
      stopped = true;
      disarmRetry();
    },
  };
}
