import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  fleetDedupKey,
  forgetRowRef,
  type ForgetRequestSession,
  type ForgetRowRef,
  type ForgetSessionRef,
} from "@maxprice/shared";
import type { ExcludedRow } from "./engine/store";
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
// with `hubDone`, and `reset()` wipes it with everything.
//
// The hub target is a Hub's URL AND its events epoch (#515, ADR-0098 §5): a
// Hub restored from a backup (ADR-0130) answers at the same URL with a new
// epoch and none of the forgets made after the backup, so a different epoch
// wipes `hubDone` and `dormantHubDone` exactly as a different URL does, and
// leaves `archiveDone` alone. Only an archive's creation or a restore changes
// the epoch; the repair's own forgets raise the Deletion generation, so they
// never reset what they completed. The epoch is the live connection's
// (`hubEpoch`): while it is unknown (disconnected, or a Hub with no event
// archive) the Hub halves neither run nor record anything, and a marker of the
// same URL keeps the lists and epoch it has until a run can compare them. A
// marker written before #515 has no epoch, which is unknown, so it meets a
// connected Hub as a different one once and repeats its Hub forgets, each an
// empty deletion where it already ran (ADR-0100). A marker written
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
//
// Since #631 the classification is the PAIR of tracked sets (ADR-0136 §3):
// the Organizations and the Accounts. Excluding an Account repairs this
// machine's history for it exactly as excluding an Organization does, because
// the store lists the pairs either level excluded (`foreignSessions`) and holds
// their keys (`isExcludedDedupKey`). The marker (version 4) is keyed by both:
// `tracked`, as before, and `trackedAccounts`, the sorted tracked Account set,
// `null` while no Account is excluded (an absent `trackedAccounts` in
// settings, or no Home). A v3 marker is MIGRATED, as v2's was (#368): v3 knew
// no Account and excluded none, so whatever Account set is resolved when it is
// first read is taken as the one its done lists were made under. The run that
// reads it compares Organizations alone, keeps the lists when they match, and
// persists the v4 body at once. An upgrade therefore re-runs no forget: its
// first boot resolves the Accounts known at upgrade (ADR-0136 §8), every one
// tracked, so no pair is newly excluded, and when the host persists that set
// it is the same set, the same key. A v2 marker migrates through v3 the same
// way.
//
// LIVE EVIDENCE IS ROW-SCOPED (#777, ADR-0149). A Gateway record that arrives
// while the machine runs (ADR-0141 §3) excludes one line of a session whose
// other rows stay admitted, and a long session meets one every few seconds.
// The repair once forgot the whole session on the Hub for each, and the
// re-push sent its admitted rows back unchanged, a loop as long as the
// session. Now the store names every own row an exclusion evicted, and
// whether a Hub may hold it (`ExcludedRow.reachedHub`): only a line read
// after the walk and never pushed is known not to. `reclassify` queues that
// evidence, and the next run, before anything else, takes every evicted row
// out of the Local archive by key, then forgets on the Hub only the rows that
// reached it (`forgetRowsOnHub`, ADR-0149 §3), and nothing at all when none
// did. A pair the evidence listed for the first time holds no other excluded
// row, so once its rows are handled it is done in both lists, and the boot
// one-shot never forgets it whole. A pair already done stays done: it is
// struck durably only while its row forget is in flight, so a process that
// dies then repairs it whole at the next boot, as before. A pair already
// listed and not done is left to the ordinary forget, which covers its rows.
// Live evidence is dropped when the marker was rekeyed or reset (the whole
// repair of the new classification covers it), and a row is dropped when the
// live store no longer excludes its key.

const markerSchema = z.object({
  version: z.literal(4),
  tracked: z.array(z.string()),
  trackedAccounts: z.array(z.string()).nullable(),
  hubTarget: z.string().nullable(),
  hubEpoch: z.string().nullable(),
  archiveDone: z.array(z.string()),
  hubDone: z.array(z.string()),
  dormant: z.string(),
  dormantHubDone: z.array(z.string()),
});
type Marker = z.infer<typeof markerSchema>;

// v0.9.2's marker (version 3, #276/#311/#515), keyed by the Organizations alone.
const markerV3Schema = z.object({
  version: z.literal(3),
  tracked: z.array(z.string()),
  hubTarget: z.string().nullable(),
  hubEpoch: z.string().nullable().default(null),
  archiveDone: z.array(z.string()),
  hubDone: z.array(z.string()),
  dormant: z.string().default(""),
  dormantHubDone: z.array(z.string()).default([]),
});

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

// The on-disk document as a v4 marker, or null when it is none of the three
// versions. `migrated` is true for a v2 or v3 body: the file must be
// rewritten even when the comparison keeps everything. An older body takes
// `trackedAccounts`, the Account set resolved at the run that reads it, as its
// own key (see the header): it excluded no Account, so its done lists hold
// under whichever set this machine now resolves.
function parseMarker(
  raw: unknown,
  trackedAccounts: string[] | null,
): { data: Marker; migrated: boolean } | null {
  const v4 = markerSchema.safeParse(raw);
  if (v4.success) return { data: v4.data, migrated: false };
  const v3 = markerV3Schema.safeParse(raw);
  if (v3.success) {
    return { data: { ...v3.data, version: 4, trackedAccounts }, migrated: true };
  }
  const v2 = markerV2Schema.safeParse(raw);
  if (!v2.success) return null;
  const { home, hubTarget, archiveDone, hubDone } = v2.data;
  const v3Body = markerV3Schema.parse({
    version: 3,
    tracked: home === null ? [] : [home],
    hubTarget,
    archiveDone,
    hubDone,
  });
  return { data: { ...v3Body, version: 4, trackedAccounts }, migrated: true };
}

const DEFAULT_RETRY_MS = 300_000;

// A row forget with nothing left to forget (#777).
const OK_NOTHING: FleetForgetResult = {
  ok: true,
  sessionsRequested: 0,
  sessionsMatched: 0,
  rowsRemoved: 0,
};

const trackedKey = (set: ReadonlySet<string>): string[] => [...set].sort();

// The Account half of the key: sorted, or null for no Account excluded. A
// non-null set may be empty (a Home membership whose Account is unknown and an
// empty list), so null and [] are different keys.
const trackedAccountsKey = (set: ReadonlySet<string> | null): string[] | null =>
  set === null ? null : trackedKey(set);

function sameKey(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameAccountsKey(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return sameKey(a, b);
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
  // #631: the tracked Account set (ADR-0136 §3), the key's other half; `null`
  // excludes no Account.
  trackedAccounts: () => ReadonlySet<string> | null;
  foreignSessions: () => ForgetSessionRef[];
  hubTarget: () => string | null;
  // The connected Hub's events epoch at that target, or null when it is not
  // known (fleet.hubEpoch, #515).
  hubEpoch: (target: string) => string | null;
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
  // The dormant half (#311), read from bootSidecar()'s live engine store: its
  // dormant session snapshot (the marker's `dormant` key), the locally backed
  // pairs it refused as dormant, and the lossless Hub forget of those pairs,
  // which never rewrites the Local archive. Within one run the two reads can
  // come from different stores: the digest is read before the evidence half's
  // awaits (its forget and its `rebuild()`, which swaps the store, or any
  // rebuild that lands meanwhile), and the pairs after. That is safe: the pairs
  // are marked under the older digest, so if the newer store's set differs, the
  // next run meets a different digest, wipes the list and forgets again.
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
  // #777 (ADR-0149): live evidence's halves. Whether the live store excludes
  // a dedup key now; the Local archive's key-scoped forget of the named rows
  // (each pair's `rows`), which drops a row only while the live store
  // excludes its key; and the Hub's row-scoped forget of them.
  isExcludedKey: (key: string) => boolean;
  forgetExcludedRowsFromLocalArchive: (rows: readonly ForgetRequestSession[]) => Promise<void>;
  forgetRowsOnHub: (
    rows: readonly ForgetRequestSession[],
    target: string,
  ) => Promise<FleetForgetResult>;
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
  // Live evidence (ADR-0141 §3, ADR-0149): the pairs a store listed for the
  // first time and the own rows its exclusions evicted. Queued, then served
  // by a run (`run()`'s coalescing), row by row.
  reclassify: (evidence: {
    listed: readonly ForgetSessionRef[];
    evicted: readonly ExcludedRow[];
  }) => Promise<void>;
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

// Live evidence waiting for a run (#777), by `pairKey`: whether a store listed
// the pair for the first time, and its evicted rows by dedup key, each with
// whether a Hub may hold it.
type LivePair = {
  pair: ForgetSessionRef;
  // A store listed the pair for the first time: it held no excluded row
  // before this evidence, on any Hub.
  listed: boolean;
  // The Hub (`hubKey`) on which the pair was done when its evidence came, or
  // null. On that Hub, as on any for a listed pair, every excluded row it may
  // hold is among `rows`: the pair is complete (`isComplete`). Another Hub,
  // or the same URL restored to another epoch, may hold older ones.
  doneOn: string | null;
  rows: Map<string, ForgetRowRef & { reachedHub: boolean }>;
};

// A Hub as the marker knows it: its URL and events epoch (#515).
const hubKey = (target: string | null, epoch: string | null): string =>
  JSON.stringify([target, epoch]);

const isComplete = (entry: LivePair, hub: string): boolean => entry.listed || entry.doneOn === hub;

export function createOrganizationRepair(deps: OrganizationRepairDeps): OrganizationRepair {
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;
  const setIntervalImpl = deps.setIntervalImpl ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalImpl =
    deps.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  let inflight: Promise<void> | null = null;
  let retry: unknown = null;
  let stopped = false;
  let rerun = false;
  // #777: live evidence no run has taken yet.
  let live = new Map<string, LivePair>();
  function livePair(pair: ForgetSessionRef, into: Map<string, LivePair> = live): LivePair {
    const key = pairKey(pair);
    let entry = into.get(key);
    if (entry === undefined) {
      entry = {
        pair: { projectSlug: pair.projectSlug, sessionId: pair.sessionId },
        listed: false,
        doneOn: null,
        rows: new Map(),
      };
      into.set(key, entry);
    }
    return entry;
  }
  // A row reached a Hub if any report of it says so.
  function addRow(entry: LivePair, key: string, row: ForgetRowRef & { reachedHub: boolean }): void {
    const held = entry.rows.get(key);
    entry.rows.set(key, {
      ...forgetRowRef(row),
      reachedHub: row.reachedHub || held?.reachedHub === true,
    });
  }
  // Merges live pairs into `into` (the queue, by default): a later listing,
  // done Hub or row only adds.
  function merge(pairs: Iterable<LivePair>, into: Map<string, LivePair> = live): void {
    for (const back of pairs) {
      const entry = livePair(back.pair, into);
      entry.listed ||= back.listed;
      entry.doneOn ??= back.doneOn;
      for (const [key, row] of back.rows) addRow(entry, key, row);
    }
  }
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

  function freshMarker(
    tracked: string[],
    trackedAccounts: string[] | null,
    dormant: string,
    hubTarget: string | null,
    hubEpoch: string | null,
  ): Marker {
    return {
      version: 4,
      tracked,
      trackedAccounts,
      hubTarget,
      hubEpoch,
      archiveDone: [],
      hubDone: [],
      dormant,
      dormantHubDone: [],
    };
  }

  // `persistNow` is true when a REAL, readable marker exists for a different
  // tracked set, tracked Account set or dormant set (a rekey) — never for an
  // absent or corrupt file, which carries no prior classification to wipe — or
  // when the file is a v0.7.1 or v0.9.2 marker, which is rewritten as v4
  // whatever the comparison keeps (#368, #631).
  async function loadMarker(
    tracked: string[],
    trackedAccounts: string[] | null,
    dormant: string,
    hubTarget: string | null,
    hubEpoch: string | null,
  ): Promise<{ marker: Marker; persistNow: boolean; rekeyed: boolean }> {
    try {
      const parsed = parseMarker(
        JSON.parse(await readFile(deps.markerPath, "utf8")),
        trackedAccounts,
      );
      if (parsed !== null) {
        const { data, migrated } = parsed;
        if (
          sameKey(data.tracked, tracked) &&
          sameAccountsKey(data.trackedAccounts, trackedAccounts)
        ) {
          // #515: an unknown epoch at the marker's own URL judges nothing, so
          // the marker keeps its epoch and lists; the Hub halves skip this run.
          const epochUnknown = hubTarget !== null && hubEpoch === null;
          const sameHub =
            data.hubTarget === hubTarget &&
            (hubTarget === null || epochUnknown || data.hubEpoch === hubEpoch);
          // #311: a different dormant set wipes only its own done list, and,
          // like a tracked rekey, is persisted at once, before any return.
          const sameDormant = data.dormant === dormant;
          return {
            marker: {
              ...data,
              hubTarget,
              hubEpoch: sameHub && epochUnknown ? data.hubEpoch : hubEpoch,
              hubDone: sameHub ? data.hubDone : [],
              dormant,
              dormantHubDone: sameHub && sameDormant ? data.dormantHubDone : [],
            },
            persistNow: migrated || !sameDormant,
            rekeyed: false,
          };
        }
        return {
          marker: freshMarker(tracked, trackedAccounts, dormant, hubTarget, hubEpoch),
          persistNow: true,
          rekeyed: true,
        };
      }
    } catch {
      // Absent or unreadable: nothing has been repaired under this tracked set.
    }
    return {
      marker: freshMarker(tracked, trackedAccounts, dormant, hubTarget, hubEpoch),
      persistNow: false,
      rekeyed: false,
    };
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
    const accountsKeyArr = trackedAccountsKey(deps.trackedAccounts());
    const dormant = dormantDigest(deps.dormantSessions());
    const hubTarget = deps.hubTarget()?.replace(/\/+$/, "") ?? null;
    const hubEpoch = hubTarget === null ? null : deps.hubEpoch(hubTarget);
    // The Hub halves run only against a Hub known by URL and epoch (#515).
    const hubKnown = hubTarget !== null && hubEpoch !== null;
    // #777: the live evidence this pass serves, taken before any await.
    const taken = live;
    live = new Map();
    const { marker, persistNow, rekeyed } =
      generation === diskGeneration
        ? await loadMarker(trackedKeyArr, accountsKeyArr, dormant, hubTarget, hubEpoch)
        : // A reset has been called whose wipe has not landed yet (or failed):
          // the file still carries the done lists it discarded. Start from an
          // empty marker instead of reading them — the wipe, when it lands,
          // only ever wipes, so nothing this run writes is trusted more than
          // it should be.
          {
            marker: freshMarker(trackedKeyArr, accountsKeyArr, dormant, hubTarget, hubEpoch),
            persistNow: false,
            rekeyed: true,
          };
    if (persistNow) {
      // A real marker exists for a different tracked set or dormant set: its
      // done lists (or, for the dormant set, its dormant list) don't apply to
      // this classification. Persist the wipe now, BEFORE either half can
      // return early, so a set that is excluded, re-tracked, and excluded
      // again (or cleared to null and restored, or asserted, cleared and
      // asserted again) can never meet a done list the prior exclusion wrote
      // under the same key. A migrated v0.7.1 or v0.9.2 marker (#368, #631) is
      // persisted here too, as the v4 body its comparison produced.
      await persist(marker, generation);
    }
    if (tracked === null && accountsKeyArr === null) {
      // Nothing is excluded on either level, so nothing is dormant either: no
      // forget, no rebuild — just the rekey above, if any. Live evidence is
      // moot too.
      disarmRetry();
      return;
    }
    // #777: live evidence a rekey or a reset outdates is the whole repair's.
    // What this pass does not serve goes back on the queue (`finally`).
    const owed = rekeyed ? new Map<string, LivePair>() : taken;
    try {
      await runHalves(owed, {
        generation,
        trackedKeyArr,
        accountsKeyArr,
        dormant,
        hubTarget,
        hubKnown,
        marker,
      });
    } finally {
      merge(owed.values());
    }
  }

  async function runHalves(
    owed: Map<string, LivePair>,
    ctx: {
      generation: number;
      trackedKeyArr: string[];
      accountsKeyArr: string[] | null;
      dormant: string;
      hubTarget: string | null;
      hubKnown: boolean;
      marker: Marker;
    },
  ): Promise<void> {
    const { generation, trackedKeyArr, accountsKeyArr, dormant, hubTarget, hubKnown, marker } = ctx;
    const archiveDone = new Set(marker.archiveDone);
    const hubDone = new Set(marker.hubDone);
    const dormantHubDone = new Set(marker.dormantHubDone);
    const snapshot = (): Marker => ({
      version: 4,
      tracked: trackedKeyArr,
      trackedAccounts: accountsKeyArr,
      hubTarget,
      hubEpoch: marker.hubEpoch,
      archiveDone: [...archiveDone],
      hubDone: [...hubDone],
      dormant,
      dormantHubDone: [...dormantHubDone],
    });
    let changed = false;
    let hubPending = false;
    // The pairs THIS run's evidence forget attempted, whatever its answer.
    const evidenceAttempted = new Set<string>();
    // #777: the pairs whose live rows this run forgets on the Hub, or defers.
    // The whole-pair forget below leaves them alone, as it does a pair whose
    // live evidence arrived during this run (`live`): the next run serves it.
    const liveHubPairs = new Set<string>();
    const servedByLivePath = (key: string): boolean => liveHubPairs.has(key) || live.has(key);

    // 1. The evidence half (#276). An empty list no longer returns: the
    //    dormant half below must run whether or not anything is foreign.
    const sessions = deps.foreignSessions();
    if (sessions.length === 0) owed.clear();
    if (sessions.length > 0) {
      // 1a. Live evidence's Local archive half (#777, ADR-0149 §2): every
      //     evicted row leaves the archive by key, whether or not it reached
      //     a Hub, before the strike below reads the archive. A row whose key
      //     the live store no longer excludes is dropped: no forget is owed.
      //     A failed forget leaves the rows archived, so the strike lists
      //     their pairs and the whole forget repairs them, as before #777.
      //     Evidence that arrives during these awaits joins this pass, and
      //     its rows leave the archive too, before the strike reads it: an
      //     archived row its own queued evidence will drop is no repair owed.
      const hub = hubKey(hubTarget, marker.hubEpoch);
      let absorbed = true;
      while (absorbed) {
        for (const entry of owed.values())
          for (const key of [...entry.rows.keys()])
            if (!deps.isExcludedKey(key)) entry.rows.delete(key);
        // A done pair with rows that reached a Hub is struck durably BEFORE
        // the archive forget below, whether or not the Hub is reachable now:
        // once those rows leave the archive, the strike is the only durable
        // record that the Hub still owes their forget, so a process that dies
        // or quits before it lands repairs the pair whole at the next boot. In
        // memory it stays complete on this Hub, and is forgotten row by row
        // (1c).
        let struckForRows = false;
        if (hubTarget !== null)
          for (const [key, entry] of owed)
            if (hubDone.has(key) && [...entry.rows.values()].some((row) => row.reachedHub)) {
              entry.doneOn = hub;
              hubDone.delete(key);
              struckForRows = true;
            }
        if (struckForRows) await persist(snapshot(), generation);
        const archiveRows: ForgetRequestSession[] = [];
        for (const entry of owed.values())
          if (entry.rows.size > 0)
            archiveRows.push({ ...entry.pair, rows: [...entry.rows.values()].map(forgetRowRef) });
        if (archiveRows.length > 0) {
          try {
            await deps.forgetExcludedRowsFromLocalArchive(archiveRows);
          } catch (err: unknown) {
            console.warn("[sidecar] organization repair: local archive row forget failed:", err);
          }
        }
        absorbed = live.size > 0;
        if (absorbed) {
          merge(live.values(), owed);
          live = new Map();
        }
      }
      // A done pair whose Local archive rows still include a key the store
      // excludes is not done (#368 review). A done list records that a forget
      // RAN, under the attribution rule of the build that ran it; the archive
      // says whether its rows are still owed. So such a pair re-enters both
      // halves: the Hub forget deletes its own rows there and the resync
      // re-pushes the admitted ones tagged, or, with no Hub, the archive
      // forget drops them. When it removes anything it is persisted at once,
      // before either forget: the archive stops being durable evidence the
      // moment the Local archive forget below erases those very rows. A Hub
      // forget that fails transiently, then a rebuild that throws or a process
      // that dies mid-walk, would otherwise leave the pair done in both lists
      // on disk, and the next boot, finding no excluded row, would never send
      // the Hub its forget.
      // Applied to EVERY marker, not only a migrated one, because it is a
      // no-op in steady state: a completed forget removed every archived row
      // of the pair whose key the store excludes (#375), live evidence's rows
      // left the archive above (#777), and the archive only ever receives the
      // store's admitted rows, which never carry an excluded key. An excluded
      // key can reappear in a done pair's archive only when a row's
      // classification changed later: an attribution-rule change (v0.7.1's
      // Owner-record-only split, ADR-0109), a restart that lost queued live
      // evidence, a failed live archive forget, or a new copy that now holds
      // the key (#374). Each is a repair owed. Nothing is excluded when
      // nothing is foreign, so the check is skipped then. Dormant rows are
      // never excluded keys, so `dormantHubDone` is untouched: the evidence
      // half's Hub forget covers the pair for that half too.
      let struck = false;
      const struckPairs = new Set<string>();
      for (const s of deps.archivedExcludedPairs()) {
        const fromArchive = archiveDone.delete(pairKey(s));
        const fromHub = hubDone.delete(pairKey(s));
        if (fromArchive || fromHub) struck = true;
        struckPairs.add(pairKey(s));
      }
      if (struck) await persist(snapshot(), generation);

      // 1b. Live evidence's verdicts (#777, ADR-0149 §1). A pair the archive
      //     strike just listed is the whole forget's, as is a pair listed
      //     before and not done: the ordinary forget covers its rows. A
      //     complete pair (listed by this evidence, or done when it came)
      //     with no row that reached a Hub, or with no Hub, is done in both
      //     lists now: no Hub holds an excluded row of it. One with rows that
      //     reached a Hub is done for the archive, and its rows are forgotten
      //     on the Hub below.
      const liveHub: ForgetRequestSession[] = [];
      for (const [key, entry] of owed) {
        const done = hubTarget === null ? archiveDone.has(key) : hubDone.has(key);
        if (struckPairs.has(key) || !(isComplete(entry, hub) || done)) {
          owed.delete(key);
          continue;
        }
        if (done) entry.doneOn = hub;
        const reached = [...entry.rows.values()].filter((row) => row.reachedHub);
        if (!archiveDone.has(key)) {
          archiveDone.add(key);
          changed = true;
        }
        if (hubTarget === null || reached.length === 0) {
          if (hubTarget !== null && !hubDone.has(key)) {
            hubDone.add(key);
            changed = true;
          }
          owed.delete(key);
          continue;
        }
        liveHub.push({ ...entry.pair, rows: reached.map(forgetRowRef) });
        liveHubPairs.add(key);
      }

      // 1c. Live evidence's Hub half (ADR-0149 §3): only the rows that reached
      //     a Hub, by key, never their pairs' admitted rows. A failed or
      //     deferred forget is retried row by row; the pair is done again once
      //     it lands.
      if (hubTarget !== null && liveHub.length > 0) {
        if (!hubKnown) {
          hubPending = true;
          console.warn(
            "[sidecar] organization repair: hub row forget deferred (the hub's events epoch is not known)",
          );
        } else {
          // The marker and archive awaits may have let a fuller admitted copy
          // take a key back; its row is no longer owed a forget.
          const owedRows = liveHub
            .map((ref) => ({
              ...ref,
              rows: (ref.rows ?? []).filter((row) =>
                deps.isExcludedKey(fleetDedupKey(row.messageId, row.requestId)),
              ),
            }))
            .filter((ref) => ref.rows.length > 0);
          const result =
            owedRows.length === 0 ? OK_NOTHING : await deps.forgetRowsOnHub(owedRows, hubTarget);
          if (result.ok) {
            for (const key of liveHubPairs) {
              hubDone.add(key);
              owed.delete(key);
            }
            changed = true;
          } else {
            if (transient(result)) hubPending = true;
            console.warn(
              `[sidecar] organization repair: hub row forget deferred (${result.reason}: ${result.detail})`,
            );
          }
        }
      }

      if (hubTarget !== null) {
        const pendingHub = sessions.filter(
          (s) => !hubDone.has(pairKey(s)) && !servedByLivePath(pairKey(s)),
        );
        if (pendingHub.length > 0 && !hubKnown) {
          // #515: the Hub's epoch is not known yet, so its completion cannot be
          // recorded; retried as an unreachable Hub is, and on the next connect.
          hubPending = true;
          console.warn(
            "[sidecar] organization repair: hub forget deferred (the hub's events epoch is not known)",
          );
        } else if (pendingHub.length > 0) {
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
      const pendingArchive = sessions.filter(
        (s) => !archiveDone.has(pairKey(s)) && !live.has(pairKey(s)),
      );
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
      if (pending.length > 0 && !hubKnown) {
        hubPending = true;
        console.warn(
          "[sidecar] organization repair: dormant hub forget deferred (the hub's events epoch is not known)",
        );
      } else if (pending.length > 0) {
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
    inflight = operations.then(async () => {
      try {
        do {
          rerun = false;
          await runInner().catch((err: unknown) =>
            console.error("[sidecar] organization repair failed:", err),
          );
        } while (rerun && !stopped);
      } finally {
        // In the same synchronous step as the last `rerun` read, as fleet's
        // serialized refresh clears its flags. A chained `.finally` cleared it
        // microtasks later, and a call landing in between set a flag nothing
        // read again: its request waited for the next run(), the retry timer's
        // if this pass had armed it (found under #304).
        inflight = null;
      }
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
            trackedAccountsKey(deps.trackedAccounts()),
            dormantDigest(deps.dormantSessions()),
            hubTarget,
            hubTarget === null ? null : deps.hubEpoch(hubTarget),
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
    reclassify: ({ listed, evicted }) => {
      for (const pair of listed) livePair(pair).listed = true;
      for (const row of evicted)
        addRow(livePair(row), fleetDedupKey(row.messageId, row.requestId), row);
      return run();
    },
    reset,
    stop: () => {
      stopped = true;
      disarmRetry();
    },
  };
}
