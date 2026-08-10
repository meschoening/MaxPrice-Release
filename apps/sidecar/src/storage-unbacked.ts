import { type FleetEvent, sessionPairKey } from "@maxprice/shared";
import { fleetRowBytes } from "@maxprice/usage-core";
import { identityFromPath } from "./identity";

// The unbacked-row classifier and its four guards (map #124, ticket #130).
//
// WHAT IT DECIDES. Which of THIS machine's rows in the fleet replica no
// surviving local transcript backs — the population the Settings › Storage
// section's destructive "Forget unbacked history" action would drop, from the
// client's replica AND from the hub archive (#128's machine-scoped route).
//
// The attribution unit is `(projectSlug, sessionId)` — the pair the engine
// already tags every event with. `identityFromPath` maps BOTH a flat
// `<root>/<slug>/<session>.jsonl` and a nested
// `<root>/<slug>/<session>/subagents/agent-*.jsonl` onto the SAME pair, so a
// session is backed if its flat transcript OR any of its subagent transcripts
// survives. Nothing here re-derives that rule; it calls the one function the
// scan and the watcher both call.
//
// WHY IT IS PURE. Detection runs on the client but its consequence lands on the
// shared archive, so the failure this module exists to prevent is irreversible.
// It takes already-loaded state and does no IO of its own: that is what makes
// every guard unit-testable, and it keeps the classification off the storage
// walk's critical path (ADR-0056 — the sidecar's saturation detector trips at
// 30% `blockedPct`, and this runs inside the same request).
//
// WHERE `backed` COMES FROM — and why NOT the engine store. The obvious source
// is the event store's scan, which already builds exactly this identity set.
// It cannot be used: the store's event set "never shrinks for the process
// lifetime" (engine/store.ts) — an `unlink` resets a tail-reader offset and
// evicts nothing — so its identities answer "was this ever seen?", not "does a
// transcript exist NOW?". Claude Code's 30-day `cleanupPeriodDays` deletes
// transcripts under a long-running app, and a set that never shrinks would call
// those sessions backed forever, quietly reducing the feature to a no-op. The
// set therefore comes from the storage report's OWN corpus enumeration — the
// fresh async walk #126 §5 already mandates for the corpus context line — via
// `backedSessionsFromPaths` below. Guard 1's `fileErrors` is that walk's error
// count for the same reason: the guard has to vouch for the enumeration that
// produced the set it is guarding, not for an unrelated earlier one.

// The guard reasons, exactly as #126 locked them on the wire. Guard 4 (the
// typed confirm) is deliberately absent: it is a UI gate fed by `unbackedRows`
// + `sampleSessions`, never a `block`.
export type UnbackedBlockReason = "scan-incomplete" | "roots-missing" | "ratio-tripwire";

export type UnbackedBlock = { reason: UnbackedBlockReason; detail: string };

// One session's worth of unbacked rows. Doubles as the wire's `sampleSessions`
// element and as the unit #128's `POST /api/events/forget` body carries.
export type UnbackedSession = { projectSlug: string; sessionId: string; rows: number };

// Structurally the `forget` object of the `GET /api/storage` payload (#126).
// The Zod schema itself lands with the endpoint (#131); assigning this to it
// there is what proves the two agree.
export type UnbackedReport = {
  unbackedRows: number;
  // The on-disk bytes of those rows, measured through the archive's own line
  // layout (`fleetRowBytes`). APPROXIMATE in one direction only, and stated so:
  // it counts LIVE rows, so the bytes a forget actually frees are >= this — the
  // rewrite drops each row's superseded predecessors too.
  unbackedBytes: number;
  // This machine's total rows in the replica: the ratio tripwire's denominator
  // and the "N of M" the confirm copy needs.
  selfRows: number;
  // Every distinct unbacked session, counted in full. `sampleSessions` is
  // capped, so the confirm's "N sessions" and its "…and N more" tail both need
  // this: without it a 5-row sample of 147 sessions reads as the whole list.
  sessionCount: number;
  sampleSessions: UnbackedSession[];
  // null = enabled. Non-null = the action renders present but DISABLED with
  // `detail` stated inline (a control that silently vanishes reads as a bug).
  block: UnbackedBlock | null;
};

export type UnbackedClassification = {
  // null = no hub configured, or the fleet replica is off. The action is ABSENT
  // from the UI, not disabled — a hub-less client has no replica, so nothing it
  // shows can be unbacked, and that is permanent rather than a tripped guard.
  // Keeping this separate from `block` is what stops the two from collapsing
  // into each other.
  forget: UnbackedReport | null;
  // EVERY unbacked session, not just the sample — the payload the forget route
  // takes. Empty whenever `forget` is null OR `forget.block` is non-null, so a
  // caller cannot reach past a tripped guard to the rows it refused.
  sessions: readonly UnbackedSession[];
};

// The ratio tripwire (guard 3). Loose on purpose: it is not trying to model a
// plausible orphan rate, only to catch the shape of a bad enumeration, where
// nearly everything looks unbacked at once. No minimum-row floor — on a tiny
// corpus a single unbacked row trips it, and refusing is the safe direction.
export const UNBACKED_RATIO_LIMIT = 0.5;

// How many sessions the wire carries as evidence. Enough for a human to see
// whether the list looks like their own history; the typed confirm states the
// full count beside it.
export const UNBACKED_SAMPLE_LIMIT = 5;

// Build the backed-session set from a corpus enumeration's file paths. Pure —
// the caller does the walking. Non-`.jsonl` paths are ignored: they are part of
// the corpus's byte total but they are not transcripts and back nothing.
export function backedSessionsFromPaths(
  paths: Iterable<string>,
  roots: readonly string[],
): Set<string> {
  const backed = new Set<string>();
  for (const path of paths) {
    if (!path.endsWith(".jsonl")) continue;
    const { projectSlug, sessionId } = identityFromPath(path, [...roots]);
    backed.add(sessionPairKey(projectSlug, sessionId));
  }
  return backed;
}

export type UnbackedInput = {
  // Whether the replica exists at all: hub configured AND `hubFleetReplica` on.
  // False ⇒ `forget: null`.
  replicaAttached: boolean;
  // The replica's live rows — `fleetEventStore.all()` verbatim. Read-only.
  rows: readonly FleetEvent[];
  // This machine's id. Compared BYTE-EQUAL and never alias-resolved, matching
  // the scoping rule #128 locked for the hub route: a merged-away alias is a
  // display concern, and resolving it here would let one machine's forget reach
  // another machine's rows.
  selfMachineId: string;
  // Every `(projectSlug, sessionId)` a surviving transcript backs, keyed by
  // `sessionPairKey` — build it with `backedSessionsFromPaths`.
  backed: ReadonlySet<string>;
  // Guard 1. `ready` = the engine store's initial scan has resolved; the app is
  // not mid-boot with a half-filled picture. `fileErrors` = per-file read
  // failures from the enumeration that produced `backed`.
  scan: { ready: boolean; fileErrors: number };
  // Guard 2. `roots` = the configured Claude paths; `missingRoots` = those that
  // do not exist or hold no transcripts (#126's `corpus.missingRoots`). This is
  // the unmounted-drive / edited-`claudePaths` case — the one that goes
  // catastrophic, because a vanished root makes every session under it look
  // unbacked at once.
  roots: readonly string[];
  missingRoots: readonly string[];
  // The subset of `missingRoots` that listed FINE and simply held no
  // transcripts. Wording only: the block and its `roots-missing` reason are
  // identical either way, but "that drive is not mounted" and "that folder is
  // there and has nothing in it" have different remedies, and a user reading the
  // first sentence about the second one will go looking for a fault that is not
  // there. Optional so every existing caller and test keeps the unlistable-root
  // wording by default.
  emptyRoots?: readonly string[];
  // Test seams. `rowBytes` defaults to the archive's real line layout.
  rowBytes?: (row: FleetEvent) => number;
  sampleLimit?: number;
  ratioLimit?: number;
};

export function classifyUnbacked(input: UnbackedInput): UnbackedClassification {
  if (!input.replicaAttached) return { forget: null, sessions: [] };

  const rowBytes = input.rowBytes ?? fleetRowBytes;
  const sampleLimit = input.sampleLimit ?? UNBACKED_SAMPLE_LIMIT;
  const ratioLimit = input.ratioLimit ?? UNBACKED_RATIO_LIMIT;

  // One pass over the replica. Rows belonging to other machines are not merely
  // excluded from the unbacked set — they never enter the arithmetic at all,
  // including the tripwire's denominator, because this machine cannot forget
  // them and a peer's history must not dilute a ratio computed about ours.
  let selfRows = 0;
  let unbackedRows = 0;
  let unbackedBytes = 0;
  const perSession = new Map<string, UnbackedSession>();

  for (const row of input.rows) {
    if (row.machineId !== input.selfMachineId) continue;
    selfRows += 1;
    const key = sessionPairKey(row.projectSlug, row.sessionId);
    if (input.backed.has(key)) continue;
    unbackedRows += 1;
    unbackedBytes += rowBytes(row);
    const seen = perSession.get(key);
    if (seen === undefined) {
      perSession.set(key, { projectSlug: row.projectSlug, sessionId: row.sessionId, rows: 1 });
    } else {
      seen.rows += 1;
    }
  }

  // Biggest sessions first — they are the ones a human recognises. Ties break
  // lexicographically so the sample is stable across calls rather than riding
  // the replica's seq order.
  const sessions = [...perSession.values()].sort(
    (a, b) =>
      b.rows - a.rows ||
      (a.projectSlug < b.projectSlug ? -1 : a.projectSlug > b.projectSlug ? 1 : 0) ||
      (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
  );

  const block = evaluateGuards({ input, selfRows, unbackedRows, ratioLimit });

  // The counts and the sample are reported even when a guard trips: the schema
  // carries them unconditionally, and on the roots-missing case they are the
  // evidence that makes the refusal legible ("these look unbacked because that
  // drive is not mounted"). What a block withholds is the ACTIONABLE list.
  return {
    forget: {
      unbackedRows,
      unbackedBytes,
      selfRows,
      sessionCount: sessions.length,
      sampleSessions: sessions.slice(0, sampleLimit),
      block,
    },
    sessions: block === null ? sessions : [],
  };
}

// Guards 1-3, in a fixed order, first match winning. The order is by
// specificity, and it matters most in the catastrophic case: roots edited away
// trips guard 2 AND guard 3 at once, and "a configured Claude path is missing"
// tells the user what to fix, where "more than half your history looks
// unbacked" only tells them something is wrong.
function evaluateGuards(args: {
  input: UnbackedInput;
  selfRows: number;
  unbackedRows: number;
  ratioLimit: number;
}): UnbackedBlock | null {
  const { input, selfRows, unbackedRows, ratioLimit } = args;

  if (!input.scan.ready) {
    return {
      reason: "scan-incomplete",
      detail: "The usage engine is still reading your Claude Code history.",
    };
  }
  if (input.scan.fileErrors > 0) {
    return {
      reason: "scan-incomplete",
      detail: `${input.scan.fileErrors} transcript${input.scan.fileErrors === 1 ? "" : "s"} could not be read, so some history may look missing when it is not.`,
    };
  }

  if (input.roots.length === 0) {
    return {
      reason: "roots-missing",
      detail: "No Claude Code path is configured, so nothing can be matched to a transcript.",
    };
  }
  if (input.missingRoots.length > 0) {
    // One reason, two sentences. A root that could not be listed at all is a
    // mount or permissions problem; a root that listed fine and held no
    // transcripts is a path pointed at the wrong folder. Both block, because a
    // readable-but-empty root is indistinguishable from a wiped drive and
    // refusing is the conservative direction — but the remedy differs, so the
    // wording does too.
    const empty = new Set(input.emptyRoots ?? []);
    const unreadable = input.missingRoots.filter((r) => !empty.has(r));
    const emptied = input.missingRoots.filter((r) => empty.has(r));
    const parts: string[] = [];
    if (unreadable.length > 0) {
      parts.push(
        `${unreadable.length === input.roots.length ? "Every" : "A"} configured Claude Code path is missing: ${unreadable.join(", ")}. Check Settings › Data › Claude paths.`,
      );
    }
    if (emptied.length > 0) {
      parts.push(
        `${emptied.join(", ")} ${emptied.length === 1 ? "exists but holds" : "exist but hold"} no transcripts — remove ${emptied.length === 1 ? "it" : "them"} in Settings › Data › Claude paths, or add the folder that does.`,
      );
    }
    return { reason: "roots-missing", detail: parts.join(" ") };
  }

  // selfRows === 0 leaves the ratio undefined — and with nothing to forget
  // there is nothing to guard, so it is not a trip.
  if (selfRows > 0 && unbackedRows / selfRows > ratioLimit) {
    return {
      reason: "ratio-tripwire",
      detail: `${unbackedRows} of this machine's ${selfRows} stored rows look unbacked — more than ${Math.round(ratioLimit * 100)}%. That usually means a transcript folder moved rather than that the history is gone. Check Settings › Data › Claude paths.`,
    };
  }

  return null;
}
