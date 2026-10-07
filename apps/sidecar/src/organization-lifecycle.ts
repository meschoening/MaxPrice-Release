// The live driver of an Organization settings edit (#276, extending #277's D8).
// Extracted from main() — like `wireIdentityProbe` — so every verdict is
// drivable by a test holding a real fleet and a real store, which is the only
// way to observe that one of them rebuilds nothing.

// Set equality BY VALUE — size, then membership. `resolveTrackedOrganizations`
// builds a fresh `Set` on every call, so identity says nothing about whether
// the set moved. `null` (nothing excluded) is a state of its own: it equals
// only `null`, so the first Home a machine ever gets, and any loss of one, both
// read as a change. The dormant sets (#311), never null, are compared with it
// too.
function trackedSetsEqual(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.size !== b.size) return false;
  for (const uuid of a) if (!b.has(uuid)) return false;
  return true;
}

// What an edit did to the RESOLVED tracked set, which is what decides the work:
//
// - "same": nothing moved. The corpus the engine admits is untouched.
// - "additive": both sides name a set and `next` ⊋ `previous`, so every row
//   admitted under the old set is still admitted. Tracking an Organization is
//   purely a re-walk that ADDS — nothing already in the engine can become
//   inadmissible, which is exactly what makes the retained report view safe to
//   keep across it.
// - "restrictive": everything else — an Organization left the set, or either
//   side is `null`. Rows admitted under the old set may be inadmissible now, so
//   the retained view must go with them.
export type TrackedChange =
  | { kind: "same" }
  | { kind: "additive"; added: readonly string[] }
  | { kind: "restrictive" };

export function classifyTrackedChange(
  previous: ReadonlySet<string> | null,
  next: ReadonlySet<string> | null,
): TrackedChange {
  if (trackedSetsEqual(previous, next)) return { kind: "same" };
  if (previous === null || next === null) return { kind: "restrictive" };
  for (const uuid of previous) if (!next.has(uuid)) return { kind: "restrictive" };
  return { kind: "additive", added: [...next].filter((uuid) => !previous.has(uuid)) };
}

// Which Organizations are being re-walked into the engine RIGHT NOW (#276).
// A tracked-set change re-reads the whole corpus, so the rows of a
// newly-tracked Organization appear over the walk rather than at once; this is
// the observable that lets a caller say so (#287's roster reads it).
//
// Refcounted per Organization, because two edits can overlap: tracking B, then
// tracking C before B's walk has settled, leaves B marked until ITS OWN walk
// ends — never until whichever walk finishes first.
export type ReingestState = {
  // Marks each uuid as re-ingesting; the returned function ends THIS mark
  // (idempotent), never another's.
  begin: (uuids: Iterable<string>) => () => void;
  current: () => ReadonlySet<string>;
};

export function createReingestState(): ReingestState {
  const counts = new Map<string, number>();
  return {
    begin: (uuids) => {
      // Snapshot the caller's iterable: `end` must decrement exactly what this
      // call incremented, and an iterable may be single-pass or mutated after.
      const mine = [...uuids];
      for (const uuid of mine) counts.set(uuid, (counts.get(uuid) ?? 0) + 1);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        for (const uuid of mine) {
          const left = (counts.get(uuid) ?? 0) - 1;
          if (left > 0) counts.set(uuid, left);
          else counts.delete(uuid);
        }
      };
    },
    // A snapshot, not a live view: a caller may hold it across the walk it is
    // describing.
    current: () => new Set(counts.keys()),
  };
}

// What ONE admission change did. A settings edit moves the two Organization
// inputs (and the dormant set with the tracked one); since #311 an assertion
// install can move the dormant set alone (`dormantChange`, below). Its producer
// computes all six synchronously, as the change arrives: `previousTracked` is
// the set the change replaces and `nextTracked` the one it installs, and the
// dormant sides likewise, so a queued change's `previous` is its predecessor's
// `next` however long the queue is.
export type OrganizationSettingsChange = {
  // The Home just installed — the new presumption's `selfHome`.
  home: string | null;
  // Whether this edit moved Home at all. The presumption is a function of Home
  // and the Machine directory's published Homes (#281), and this edit moves
  // only the Home half — so an edit that left Home where it was must not mint
  // a new identity: that would clear every report-cache entry for nothing.
  homeChanged: boolean;
  // The resolved tracked sets either side of this edit (`null` = nothing
  // excluded), compared by value.
  previousTracked: ReadonlySet<string> | null;
  nextTracked: ReadonlySet<string> | null;
  // #311 (ADR-0107 §12): the dormant sets either side of this change
  // (`dormantSessions`, engine/presumption.ts), compared by value. The engine's
  // admission is the PAIR (tracked, dormant): an assertion install that moved
  // only the dormant set queues a change whose two tracked sides are equal.
  previousDormant: ReadonlySet<string>;
  nextDormant: ReadonlySet<string>;
};

export type OrganizationSettingsDriverDeps = {
  // Synchronous arrival fence: an excluded in-flight read cannot append while a walk queues.
  setPollingOrganizations: (ids: ReadonlySet<string> | null, home: string | null) => void;
  // Install a Home into main()'s one presumption cell (`withSelfHome`), keeping
  // the published Homes the Machine directory supplied (#281). The driver owns
  // WHEN a Home change takes effect — in queue order — but not the peer half,
  // which the fleet replaces on its own schedule. Every store reads that one
  // cell through the `getPresumption` thunk it was built with, so a single
  // write reaches the live engine, the retained report view, and both caches.
  installHome: (home: string | null) => void;
  // Release at arrival, ahead of any queued walk.
  releaseRetainedView: () => void;
  rebuild: (o: { keepRetainedView: boolean }) => Promise<void>;
  repair: () => Promise<void>;
  // `organizationRepair.reset` — the marker wipe with no repair behind it, run
  // in place of `repair()` whenever the tracked set moved under a change's
  // walk. A skipped repair is also a skipped REKEY, and the rekey is what stops
  // a set returning to a previously repaired key from meeting that key's stale
  // done lists.
  resetRepair: () => Promise<void>;
  invalidateReports: () => void;
  reingest: ReingestState;
  // main()'s `liveHub.emitOrganizationsChanged` — the roster's own refetch poke
  // (#287, ADR-0105). A narrow invalidation, never a round (ADR-0058): it asks
  // the renderer for GET /api/organizations and nothing else.
  rosterChanged: () => void;
  // The tracked set RIGHT NOW — main()'s `trackedNow`. Read between the rebuild
  // and the repair to see whether a later edit moved the set out from under
  // this one's walk; see `createOrganizationSettingsDriver`.
  trackedNow: () => ReadonlySet<string> | null;
  // The dormant set RIGHT NOW — main()'s live `dormantNow` (#311). Read beside
  // `trackedNow`, so a change overtaken by a later edit OR a later assertion
  // install skips its repair.
  dormantNow: () => ReadonlySet<string>;
};

// The verdict over the whole admission pair (#311). "same" when neither set
// moved. "additive" when the tracked set is same-or-additive AND no session
// became dormant (`nextDormant ⊆ previousDormant`): every row the old admission
// kept is still kept, so the retained view may stay. "restrictive" otherwise.
// A dormant-only shrink is additive with nothing to mark re-ingesting.
export function classifyAdmissionChange(
  change: Pick<
    OrganizationSettingsChange,
    "previousTracked" | "nextTracked" | "previousDormant" | "nextDormant"
  >,
): TrackedChange {
  const tracked = classifyTrackedChange(change.previousTracked, change.nextTracked);
  if (tracked.kind === "restrictive") return tracked;
  for (const sessionId of change.nextDormant) {
    if (!change.previousDormant.has(sessionId)) return { kind: "restrictive" };
  }
  if (tracked.kind === "same" && change.nextDormant.size !== change.previousDormant.size) {
    return { kind: "additive", added: [] };
  }
  return tracked;
}

// main()'s one producer of a DORMANT-ONLY change (#311): after an assertion
// install (the PUT, the fleet's adoption) or at the boot seed, the dormant set
// recomputed against the one last queued. null when it did not move, which is
// what keeps a machine with no Excluded claim rebuilding nothing new.
export function dormantChange(opts: {
  home: string | null;
  tracked: ReadonlySet<string> | null;
  previousDormant: ReadonlySet<string>;
  nextDormant: ReadonlySet<string>;
}): OrganizationSettingsChange | null {
  if (trackedSetsEqual(opts.previousDormant, opts.nextDormant)) return null;
  return {
    home: opts.home,
    homeChanged: false,
    previousTracked: opts.tracked,
    nextTracked: opts.tracked,
    previousDormant: opts.previousDormant,
    nextDormant: opts.nextDormant,
  };
}

export type OrganizationSettingsDriver = {
  // Settles when THIS change has been applied. Never rejects; main() `void`s it
  // and the tests await it.
  apply: (change: OrganizationSettingsChange) => Promise<void>;
};

/**
 * The process's one driver of Organization settings edits — Home and the
 * tracked list, applied together, because one edit can move both and only the
 * whole comparison can see the two cancel.
 *
 * Home used to BE the exclusion rule, so every Home change rebuilt the engine
 * and released the retained report view (ADR-0099). Under the tracked set
 * (#275) it is not: the SET decides which rows the engine admits, and Home is
 * only the anchor of that set plus the Presumed organization's fallback
 * (`engine/presumption.ts`). So the trigger is the resolved set, and its three
 * verdicts are three different amounts of work:
 *
 * - "same" ⇒ no rebuild, no release, no repair, no walk. A Home change moves no
 *   row; it only re-answers `eventOrganization` for owner-less rows, at query
 *   time. The new presumption identity drops every report-cache entry (THE
 *   PRESUMPTION RULE) and the wholesale invalidation tells every renderer to
 *   refetch what it holds.
 * - "additive" (tracking) ⇒ a cache-hit re-walk that only ADDS. The retained
 *   report view (ADR-0099) is KEPT: every row it holds was admitted under a
 *   SUBSET of the new set, so nothing it shows is WRONG — only incomplete, and
 *   only until its owner (the reseed) releases it. It does NOT gain the newly
 *   tracked history in the meantime — `appendFleet` refuses any row whose key
 *   that store's own walk excluded — so the new Organization appears at the
 *   release, when reports fall through to the live store. Dropping the view
 *   instead would trade that incompleteness for a half-seeded store, which is
 *   the worse of the two. The newly tracked Organizations are marked
 *   re-ingesting meanwhile, which is what lets the app say so.
 * - "restrictive" (excluding) ⇒ a scoped repair. The walk under the new set
 *   fills `foreignSessions()`, and the repair forgets those on the Hub
 *   (ADR-0100's scoped forget: this machine's raw id + session pairs) and in
 *   the Local archive. The retained view is released: rows admitted under the
 *   old set must never mask the new one.
 *
 * The repair runs on both changing verdicts because it rekeys its marker to the
 * new set (#276). On an additive change that re-forgets whatever is STILL
 * excluded — an accepted cost, and an idempotent one.
 *
 * The engine's admission is really the PAIR (tracked, dormant) (#311, ADR-0107
 * §12): a session asserted to an Organization outside the tracked set has its
 * owner-less own rows refused, and an assertion install can move that set with
 * no settings edit at all. So main() queues a dormant-only change here too
 * (`dormantChange`), and `classifyAdmissionChange` judges the pair: a session
 * becoming dormant is restrictive, one leaving is additive. A dormant-only
 * change installs no Home and marks nothing re-ingesting (no Organization is
 * re-walked in), but pokes the roster like any changing verdict. The repair
 * after its rebuild is also what runs the lossless forget of the dormant
 * sessions on the Hub.
 *
 * A Home change installs its Home into the presumption on EVERY verdict, ahead
 * of the work: a rebuild that kept the preceding Home would go on presuming
 * this machine's owner-less rows under an organization it no longer calls home.
 *
 * The roster hears of an edit through `rosterChanged` (#287, ADR-0105). A
 * changing verdict fires it twice: once as the change starts applying — after
 * `begin` has marked the Organizations it re-walks, so the renderer's first
 * read already shows them re-ingesting and shows the new `tracked` — and once
 * right after `end()`. The second is the only "done" signal there is: the
 * rebuild's own wholesale poke fires before the mark ends. A Home-only edit
 * fires it once, beside its invalidation. A change queued behind another's
 * walk needs no poke at arrival: main()'s tracked cell moved then, so the
 * predecessor's done signal already reads the new `tracked`.
 *
 * ONE CHANGE AT A TIME, in arrival order. A walk takes seconds, and the hook
 * that produces a change moves `currentTracked` synchronously, so two Settings
 * edits in quick succession would otherwise interleave: edit 1 excludes B and
 * awaits its walk, edit 2 re-tracks B, and edit 1 then repairs — reading the
 * tracked set LIVE ({A,B}) but `foreignSessions()` from the store ITS OWN walk
 * built under {A}, which forgets on the Hub exactly the rows the user just
 * asked to keep. Queueing alone does not close that, because the repair reads
 * the set live either way; so each change ALSO checks, after its rebuild and
 * before its repair, that the live set is still the one it is applying, and
 * skips the repair when it is not. The queued successor rebuilds under the set
 * that moved and repairs against a store that agrees with it. Each queued
 * change keeps the six values it was created with — change N+1's `previous` is
 * change N's `next`, whenever it runs.
 *
 * No exclusion goes missing to that skip. Let S be the set after the last edit
 * of the burst. The last change cannot skip — nothing arrives after it, so the
 * live set is its own `next`. If it is the "same" verdict (the hook fires on
 * EVERY settings write, Home-only and hub-toggle edits included), then its
 * `previous` is S too, and walking back through that run of "same" edits, the
 * FIRST change whose `next` is S — the only witness that holds, not the last —
 * has a `previous` that differs, so it is a real change, it does not skip, and
 * it rebuilds and repairs under S. And the repair is a full reconciliation
 * against the current store's `foreignSessions()`, not a delta, so that one run
 * covers everything every skipped predecessor would have done. What the skip
 * genuinely would lose is the marker REKEY, which is why it calls `resetRepair`
 * rather than simply returning.
 *
 * `apply` returns that change's settlement so tests can await a verdict
 * deterministically; main() `void`s it. It never rejects — a failed walk must
 * not reach the process `unhandledRejection` handler — which is also what keeps
 * the queue intact: a rejected tail would strand every later edit behind it.
 */
export function createOrganizationSettingsDriver(
  deps: OrganizationSettingsDriverDeps,
): OrganizationSettingsDriver {
  // The queue, as the tail of a promise chain. `applyChange` never rejects, so
  // this is only ever a fulfilled or pending promise.
  let tail: Promise<void> = Promise.resolve();
  return {
    apply: (change) => {
      try {
        deps.setPollingOrganizations(change.nextTracked, change.home);
        if (classifyAdmissionChange(change).kind === "restrictive") {
          deps.releaseRetainedView();
        }
      } catch (err: unknown) {
        console.error("[sidecar] organization settings change failed:", err);
      }
      tail = tail.then(() => applyChange(deps, change));
      return tail;
    },
  };
}

// One change, start to finish. Private: the driver is the only caller, because
// the serialization above is part of the contract, not an option.
async function applyChange(
  deps: OrganizationSettingsDriverDeps,
  opts: OrganizationSettingsChange,
): Promise<void> {
  // EVERYTHING is inside the try, including the Home install and the
  // classification: main() `void`s this promise, so a rejection — even a
  // synchronous throw from a collaborator — would land on the process
  // `unhandledRejection` handler. "Never rejects" has to be unconditional
  // rather than true only of the statements that happen to be awaited.
  let end: (() => void) | undefined;
  try {
    if (opts.homeChanged) deps.installHome(opts.home);
    const change = classifyAdmissionChange(opts);
    if (change.kind === "same") {
      if (opts.homeChanged) {
        deps.invalidateReports();
        pokeRoster(deps);
      }
      return;
    }
    // Marked BEFORE the walk and ended in `finally`, so a rejecting rebuild can
    // never leave an Organization marked re-ingesting for the life of the
    // process. A restrictive change marks nothing: `begin([])` is the empty mark.
    end = deps.reingest.begin(change.kind === "additive" ? change.added : []);
    // After the mark, so the read it asks for already shows it.
    pokeRoster(deps);
    await deps.rebuild({ keepRetainedView: change.kind === "additive" });
    // The store this walk installed answers for `nextTracked`; the repair reads
    // the tracked set live. If another edit moved the set while the walk ran,
    // those two disagree and the repair would act on the difference. Hand the
    // FORGETTING to the successor already queued behind this one — it rebuilds
    // under the set that moved, so its own repair sees a store that agrees with
    // it. The marker wipe cannot wait for that successor, though: the repair is
    // also what REKEYS the marker, and a set that leaves a repaired key and
    // comes back to it would meet that key's old done lists and forget nothing.
    // `resetRepair` is the rekey alone — no store read, no forget, no rebuild.
    // The same holds of the dormant set (#311): an assertion install queued
    // behind this walk moved what the store should refuse.
    if (
      !trackedSetsEqual(deps.trackedNow(), opts.nextTracked) ||
      !trackedSetsEqual(deps.dormantNow(), opts.nextDormant)
    ) {
      await deps.resetRepair();
      return;
    }
    await deps.repair();
  } catch (err: unknown) {
    console.error("[sidecar] organization settings change failed:", err);
  } finally {
    // Undefined on every path that never got as far as marking one.
    if (end !== undefined) {
      end();
      // The done signal, after the mark has ended.
      pokeRoster(deps);
    }
  }
}

// The roster poke is a notification: a throw from it is logged, and never
// costs a change its walk or rejects the settlement main() `void`s — the
// `finally` above calls it too.
function pokeRoster(deps: OrganizationSettingsDriverDeps): void {
  try {
    deps.rosterChanged();
  } catch (err: unknown) {
    console.error("[sidecar] organization roster poke failed:", err);
  }
}
