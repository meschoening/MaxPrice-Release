import {
  headLastReadAt,
  usageSampleOf,
  sampleAsReading,
  type HubMembershipProjection,
  type OrganizationUsageStatus,
  type UsageConnection,
  type UsageCredential,
  type UsageOrganizations,
  type UsageReading,
  type UsageSample,
} from "@maxprice/shared";
import { rankMemberships } from "@maxprice/shared";
import { fetchUsage, limitsAnswer, type FetchUsageResult } from "./usage-client";
import type { SampleScope, SampleStore } from "./sample-store";

export type PollerStatus = {
  usageConnection: UsageConnection;
  usageLastSampleAt: string | null;
  organizations: UsageOrganizations;
};

export type PollerHub = {
  // An Organization's live reading: its projected Membership's. Even null
  // carries its Organization at this internal adapter seam.
  emitUsageSample: (organization: string, sample: UsageReading | null) => void;
  // Each sample a read appended to history, whichever Membership read it,
  // projected or not (#732): the Hub streams every line its store kept, so a
  // client's since-cursor never moves past one it was not sent. The poller
  // decides history once: a reading with a window in flight (ADR-0145 §2).
  emitHistory: (sample: UsageSample) => void;
  patchStatus: (partial: PollerStatus) => void;
};

export type UsagePollerCurrent = {
  connection: UsageConnection;
  sample: UsageReading | null;
  lastSampleAt: string | null;
  weeklyResetAt: string | null;
};

// The Hub's state as this poller shows it while the Hub owns polling: the
// per-Organization projection of its Memberships (ADR-0139 §10).
type RemoteState = HubMembershipProjection;

// The Account key a session key is held by (#633): its Account's uuid, or
// LEGACY_KEY for a key whose Account is not yet known (ADR-0138 §12's one key
// before the move, the Hub's single v6 key). Never a uuid: `/api/account`
// names Accounts by uuid, which holds no parentheses.
export const LEGACY_KEY = "(legacy)";

export type PollerKey = { account: string; sessionKey: string };

// One Membership's local state (ADR-0136, ADR-0138 §8): `status` is its last
// Limits answer (null before any), `current` its last reading (null: none held
// or none read), `answered` whether a read has answered `current` at all (so a
// null is an authoritative "no window in flight", the Hub status's present
// null, ADR-0139 §1), `weeklyResetAt` the retained weekly cadence (null: none
// seen), `stale` whether its key has expired — the reading is kept and no
// longer refreshed — and `lastReadAt` its last successful read.
export type MembershipState = {
  account: string;
  organization: string;
  status: OrganizationUsageStatus | null;
  current: UsageReading | null;
  answered: boolean;
  weeklyResetAt: string | null;
  stale: boolean;
  lastReadAt: string | null;
};

export type UsagePoller = {
  // Replaces the keyset (ADR-0138 §6: the host pushes the whole of it). Every
  // key it carries is armed again, a dead one included: the hosts push on a
  // change or at boot, so a dead key is asked once more per push and its 401
  // expires it again — one key behaves exactly as `setCredential` did. A key
  // left out is dropped with its listing and its Memberships.
  setKeys: (keys: readonly PollerKey[]) => void;
  // The keyset, sorted by Account key.
  getKeys: () => readonly PollerKey[];
  // One held key's Account became known (ADR-0138 §12's move): the key, its
  // listing and its Memberships move from `from` to `to` with every reading
  // and answer they hold, the key neither re-armed nor re-read. Nothing when
  // `from` is not held or `to` already is.
  rekey: (from: string, to: string) => void;
  // One key refused outside a read (the Hub's listing): that key's reads stop
  // until a push carries it again; every other key keeps polling.
  expireKey: (account: string) => void;
  // A key's connection: `disconnected` when it is not held. While a remote
  // snapshot owns live state it is the Hub's connection, for every key.
  keyConnection: (account: string) => UsageConnection;
  // A key's own connection, whoever owns polling: what this poller's own
  // reads and `expireKey` left it (`disconnected` when it is not held or has
  // no answer yet). The legacy key's report reads it (#702): its Account is
  // not known, so no Hub connection is its.
  ownKeyConnection: (account: string) => UsageConnection;
  // The Organizations a key's last listing named (null: no listing yet, or
  // forgotten). It chooses which keys read each polled Organization (below).
  setListing: (account: string, organizations: readonly string[] | null) => void;
  // The Home membership's Account (null: unknown, or no Home). Kept apart from
  // setOrganizations' Home because the hosts learn the two from different
  // places — the Hub has neither, and the sidecar's Organization settings
  // driver knows only the Organization — and because it decides only which key
  // reads an Organization no listing names, which Membership an Organization
  // read by several projects, and which Account its Account-less samples
  // presume.
  setHomeAccount: (account: string | null) => void;
  // Home is getCurrent()'s default and owns unstamped history; set equality
  // alone controls re-polling. `null` is a tracked set that excludes nothing
  // (the sidecar's with no Home, ADR-0098): every Organization a held key's
  // last listing names is polled, and the set follows the listings (#673).
  setOrganizations: (organizations: readonly string[] | null, home: string | null) => void;
  // The current poll set, sorted: as `setOrganizations` last gave it, or under
  // `null` the Organizations the held keys' listings name — the Organizations
  // this poller answers for, whoever owns polling. Never the Hub's map.
  getOrganizations: () => readonly string[];
  // Every Membership polled, by Organization then Account key; local state,
  // whoever owns polling.
  memberships: () => MembershipState[];
  // The polled Organizations whose shown reading is stale (ADR-0138 §8): every
  // key that reads one has expired, so its last answer is kept and no longer
  // refreshed. A live key reading it, the legacy key's included, keeps it
  // fresh; one whose reader never answered is not stale, just unread. Sorted;
  // local state, whoever owns polling.
  staleOrganizations: () => string[];
  // The Organizations, polled or named by a key's listing, whose every reader
  // (the keys that read it now, or would once tracked) has expired: what
  // tracking one now would leave unread (ADR-0138 §8). Sorted; local state.
  expiredReaderOrganizations: () => string[];
  pollOnce: () => Promise<void>;
  getCurrent: (organization?: string | null) => UsagePollerCurrent;
  // The Organization's last successful read, as the status map holds it
  // (`headLastReadAt`): the freshness copy's time (ADR-0145 §6). With no
  // Organization, the newest read of any.
  lastReadAt: (organization: string | null) => string | null;
  // A remote snapshot owns live state while the Hub owns polling. History
  // replication is independent and never makes an absent entry an answer.
  setRemoteState: (state: RemoteState | null) => void;
  start: (intervalMs?: number) => void;
  stop: () => Promise<void>;
};

// The keyset a host holding one key pushes (the sidecar's single-credential
// route, the Hub): that key under LEGACY_KEY, or none.
export function legacyKeyset(cred: UsageCredential | null): PollerKey[] {
  return cred === null ? [] : [{ account: LEGACY_KEY, sessionKey: cred.sessionKey }];
}

// The one key such a host holds, as it held it.
export function legacyCredential(keys: readonly PollerKey[]): UsageCredential | null {
  const key = keys.find((k) => k.account === LEGACY_KEY);
  return key === undefined ? null : { sessionKey: key.sessionKey };
}

export type CreateUsagePollerOptions = {
  store: SampleStore;
  liveHub: PollerHub;
  // What `memberships()` shows moved — a reading, a Limits answer, a read time
  // or a key's staleness — whichever Membership it was, projected or not
  // (#637: GET /api/accounts carries every one). Heard after the status
  // publish that carries the move; an identical read calls nothing.
  membershipsChanged?: () => void;
  fetchUsageImpl?: (
    opts: { sessionKey: string; orgId: string },
    signal: AbortSignal,
  ) => Promise<FetchUsageResult>;
  baseUrl?: string;
  now?: () => number;
  setTimeoutImpl?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (handle: ReturnType<typeof setTimeout>) => void;
};

type Entry = {
  account: string;
  organization: string;
  status?: OrganizationUsageStatus;
  // undefined: never answered; null: successfully read no window.
  current?: UsageReading | null;
  weeklyResetAt?: string;
  nextAt: number;
};
type KeyState = { sessionKey: string; expired: boolean; generation: number };
type Flight = {
  epoch: number;
  generation: number;
  abort: AbortController;
  promise: Promise<void>;
};
const FORBIDDEN_RETRY_MS = 60 * 60_000;

// A Membership's id: Organization, then Account key, so the sorted ids order
// the poll set by Organization as one key's always was. NUL sorts first, so a
// shorter Organization id sorts before one it prefixes.
const membershipId = (organization: string, account: string): string =>
  `${organization}\u0000${account}`;

// Several keys, one scheduler, independent Membership reads (ADR-0104,
// ADR-0138 §11). Which Memberships: every polled Organization O is read by
// each key whose last listing names O; an O no listing names by the Home
// membership's Account's key, else the LEGACY_KEY key, else the first key by
// Account key — so one key reads exactly the poll set, as before. With no key
// at all an Organization still holds one entry, under LEGACY_KEY, unpolled, so
// its last answer outlives a disconnect as it always did. Each ordinary pass
// takes a minute, evenly staggered across every Membership of every live key;
// forbidden ones are read hourly. A dead key (a 401) stops its own reads only:
// its Memberships keep their last reading, stale, until a push re-arms it.
// Explicit refreshes fan out concurrently, then establish a fresh stagger. No
// timer depends on viewers.
//
// Status keeps the per-Organization projection today's renderer and the v6
// Hub read (`organizations`, getCurrent(org), emitUsageSample(org, …)): an
// Organization read by one Membership projects it; read by several, the one
// whose Account is the Home membership's Account, else the first by
// `rankMemberships`. Only the projected Membership's reading is emitted live;
// every Membership's reading with a window in flight enters history (ADR-0145
// §2), Account-stamped when its key's Account is known, and is emitted as
// history (#732).
export function createUsagePoller(opts: CreateUsagePollerOptions): UsagePoller {
  const fetchUsageImpl =
    opts.fetchUsageImpl ?? ((c, signal) => fetchUsage({ ...c, baseUrl: opts.baseUrl, signal }));
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = opts.clearTimeoutImpl ?? ((handle) => clearTimeout(handle));
  const keys = new Map<string, KeyState>();
  const listings = new Map<string, ReadonlySet<string>>();
  let home: string | null = null;
  let homeAccount: string | null = null;
  // The poll set setOrganizations last gave (null: every listed one), and the
  // poll set it makes, sorted, which rebuild() derives.
  let asked: readonly string[] | null = [];
  let polled: readonly string[] = [];
  let entries = new Map<string, Entry>();
  let remote: RemoteState | null = null;
  const remoteWeekly = new Map<string, string>();
  let running = false;
  // Initial explicit polls are allowed before start (Hub boot). stop fences
  // even explicit polls until start returns ownership to this poller.
  let suspended = false;
  let intervalMs = 60_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let epoch = 0;
  const flights = new Map<string, Flight>();
  const draining = new Set<Promise<void>>();
  let batch: { epoch: number; promise: Promise<void> } | null = null;
  // What `membershipsChanged` last announced: none held.
  let membershipsShown = "[]";

  function clearSchedule(): void {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function fence(): void {
    epoch += 1;
    clearSchedule();
    for (const f of flights.values()) f.abort.abort();
    flights.clear();
    batch = null;
  }
  // One key's half of a fence: its in-flight reads abort and their late
  // answers are dropped; every other key's reads, and a batch, carry on.
  function fenceKey(account: string): void {
    const key = keys.get(account);
    if (key !== undefined) key.generation += 1;
    for (const [id, f] of flights) {
      if (entries.get(id)?.account !== account) continue;
      f.abort.abort();
      flights.delete(id);
    }
  }
  const sortedAccounts = (): string[] => [...keys.keys()].sort();
  const live = (account: string): boolean => {
    const key = keys.get(account);
    return key !== undefined && !key.expired;
  };
  const anyLive = (): boolean => [...keys.values()].some((k) => !k.expired);

  // The keys that read one Organization (the selection rule above).
  function readers(organization: string): string[] {
    const named = sortedAccounts().filter((a) => listings.get(a)?.has(organization));
    if (named.length > 0) return named;
    if (homeAccount !== null && keys.has(homeAccount)) return [homeAccount];
    if (keys.has(LEGACY_KEY)) return [LEGACY_KEY];
    return [sortedAccounts()[0] ?? LEGACY_KEY];
  }
  // Re-derives the poll set (under a null set, from the listings) and the
  // Memberships from it, the keys and the listings,
  // keeping each surviving one's state, its next read included (a forbidden
  // one keeps its hour). Returns the ids of the Memberships that are new, or
  // null when the set did not change; a change fences every read, and a new
  // Membership waits an interval unless the caller polls.
  function rebuild(): string[] | null {
    polled = [
      ...new Set(asked ?? [...listings.values()].flatMap((listing) => [...listing])),
    ].sort();
    const ids = polled
      .flatMap((organization) =>
        readers(organization).map((account) => ({ organization, account })),
      )
      .map((m) => ({ ...m, id: membershipId(m.organization, m.account) }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const changed = ids.length !== entries.size || ids.some((m) => !entries.has(m.id));
    if (!changed) return null;
    fence();
    const added = ids.filter((m) => !entries.has(m.id)).map((m) => m.id);
    entries = new Map(
      ids.map((m) => [
        m.id,
        {
          ...entries.get(m.id),
          account: m.account,
          organization: m.organization,
          nextAt: entries.get(m.id)?.nextAt ?? now() + intervalMs,
        },
      ]),
    );
    return added;
  }

  function connectionOf(account: string): UsageConnection {
    const key = keys.get(account);
    if (key === undefined) return "disconnected";
    if (key.expired) return "expired";
    const answers = [...entries.values()].flatMap((e) =>
      e.account === account && e.status !== undefined ? [e.status] : [],
    );
    if (answers.some((s) => s.limits === "windows" || s.limits === "none")) return "connected";
    return answers.length === 0 ? "disconnected" : "error";
  }
  // The Membership whose state one Organization shows (the projection above).
  function projected(organization: string): Entry | undefined {
    const candidates = [...entries.values()].filter((e) => e.organization === organization);
    if (candidates.length <= 1) return candidates[0];
    // A dead key's last reading is never projected over a live key's reading
    // of the same Organization (ADR-0138 §8), not even the Home Account's: the
    // rank keeps a stale one in place by its reading, so live keys'
    // Memberships are chosen among alone while any is held. With every reader
    // dead, the Home Account's, else the most used stale one, shows.
    const liveOnes = candidates.filter((e) => live(e.account));
    const pool = liveOnes.length > 0 ? liveOnes : candidates;
    const homes = pool.find((e) => e.account === homeAccount);
    if (homes !== undefined) return homes;
    return rankMemberships(
      pool.map((e) => ({
        entry: e,
        key: membershipId(e.organization, e.account),
        label: e.account,
        connection: connectionOf(e.account),
        limits: e.status?.limits ?? null,
        reading: e.current ?? null,
      })),
      now(),
    )[0]!.entry;
  }
  function organizations(): UsageOrganizations {
    if (remote !== null) return remote.organizations;
    return Object.fromEntries(
      polled.flatMap((id) => {
        const status = projected(id)?.status;
        return status === undefined ? [] : [[id, status]];
      }),
    );
  }
  // Every key's state, folded: connected when any key is, else error when any
  // is, else expired when any is, else disconnected — for one key exactly its
  // own. The Hub composes a failed or empty discovery on top of this: with no
  // answer it reads `error`, not `disconnected` (`hubUsageConnection`, apps/hub/src/hub-accounts.ts).
  function aggregateConnection(): UsageConnection {
    if (remote !== null) return remote.usageConnection;
    const each = sortedAccounts().map(connectionOf);
    for (const state of ["connected", "error", "expired"] as const) {
      if (each.includes(state)) return state;
    }
    return "disconnected";
  }
  function publishStatus(): void {
    opts.liveHub.patchStatus({
      usageConnection: aggregateConnection(),
      usageLastSampleAt: opts.store.latest()?.capturedAt ?? null,
      organizations: organizations(),
    });
    if (opts.membershipsChanged === undefined) return;
    const shown = JSON.stringify(
      membershipStates().map((m) => [
        m.account,
        m.organization,
        m.status?.limits ?? null,
        m.stale,
        m.current,
        m.lastReadAt,
      ]),
    );
    if (shown === membershipsShown) return;
    membershipsShown = shown;
    opts.membershipsChanged();
  }
  function membershipStates(): MembershipState[] {
    return [...entries.values()].map((e) => ({
      account: e.account,
      organization: e.organization,
      status: e.status ?? null,
      current: e.current ?? null,
      answered: e.current !== undefined,
      weeklyResetAt: e.weeklyResetAt ?? null,
      stale: keys.get(e.account)?.expired ?? false,
      lastReadAt: e.status?.lastReadAt ?? null,
    }));
  }
  // The store scope one Membership's history answers: a known Account reads
  // its own samples plus the Account-less ones presumed to it; a LEGACY_KEY
  // one reads the Organization's, as one key always did.
  function scopeOf(organization: string, account: string | undefined): SampleScope {
    return account === undefined || account === LEGACY_KEY
      ? { organization, home }
      : { organization, home, membership: { account, homeAccount } };
  }
  function getCurrent(organization = home): UsagePollerCurrent {
    const entry = organization === null ? undefined : projected(organization);
    const latest =
      organization === null ? null : opts.store.latest(scopeOf(organization, entry?.account));
    const status = organization === null ? undefined : organizations()[organization];
    const remoteCurrent = organization === null ? undefined : remote?.usageCurrent[organization];
    // Omission is not a new answer. Retain even an authoritative null/partial
    // from local polling or an earlier remote snapshot before using history.
    const current = remoteCurrent === undefined ? entry?.current : remoteCurrent;
    const remoteReset = organization === null ? undefined : remoteWeekly.get(organization);
    const sample =
      current === undefined ? (latest === null ? null : sampleAsReading(latest)) : current;
    const key =
      remote !== null || entry === undefined ? aggregateConnection() : connectionOf(entry.account);
    // With no Organization (no Home, so no Quota organization) the keys'
    // state is the whole answer: there is no Organization's read to fail.
    const connection =
      organization === null || key === "expired" || key === "disconnected"
        ? key
        : status?.limits === "windows" || status?.limits === "none"
          ? "connected"
          : "error";
    return {
      connection,
      sample,
      lastSampleAt: latest?.capturedAt ?? null,
      weeklyResetAt:
        sample?.weekly?.resetAt ??
        (remoteCurrent === undefined
          ? entry?.weeklyResetAt
          : (remoteReset ?? entry?.weeklyResetAt)) ??
        // The newest line's weekly reset, when it holds one (ADR-0145 §2).
        latest?.weekly?.resetAt ??
        null,
    };
  }
  function canPoll(): boolean {
    return !suspended && remote === null && anyLive();
  }
  function pollable(): Entry[] {
    return [...entries.values()].filter((e) => live(e.account));
  }
  function stagger(preserveSingleton = false): void {
    // Every live key's ordinary readers share the minute. With no live key
    // (none held, or the one key dead) every entry keeps its slot, as one key's
    // did across a disconnect or an expiry, so a key's return keeps its phase.
    const slotted = anyLive() ? pollable() : [...entries.values()];
    const readable = slotted.filter((e) => e.status?.limits !== "forbidden");
    const at = now();
    if (preserveSingleton && readable.length === 1) {
      const entry = readable[0]!;
      if (entry.nextAt <= at)
        entry.nextAt += (Math.floor((at - entry.nextAt) / intervalMs) + 1) * intervalMs;
      return;
    }
    readable.forEach((entry, i) => {
      entry.nextAt = at + (intervalMs * (i + 1)) / readable.length;
    });
  }
  function schedule(): void {
    clearSchedule();
    const due = pollable();
    if (!running || !canPoll() || batch !== null || due.length === 0) return;
    const at = Math.min(...due.map((e) => e.nextAt));
    timer = setTimer(
      () => {
        timer = null;
        const t = now();
        for (const [id, entry] of entries) {
          if (entry.nextAt > t || !live(entry.account)) continue;
          entry.nextAt =
            t + (entry.status?.limits === "forbidden" ? FORBIDDEN_RETRY_MS : intervalMs);
          void pollMembership(id);
        }
        schedule();
      },
      Math.max(0, at - now()),
    );
  }
  // A key died (a read's 401, or expireKey): its reads stop. The last live key
  // dying fences everything, exactly as one key's expiry always did.
  function expire(account: string): void {
    const shown = new Map(polled.map((id) => [id, projected(id)]));
    keys.get(account)!.expired = true;
    // An Organization this key's Membership projected moves to a live key's,
    // or, with this the last live key, back to Home's or the most used stale one.
    for (const id of polled) {
      const showing = projected(id);
      if (showing !== shown.get(id)) emitProjection(id, showing);
    }
    if (!anyLive()) {
      fence();
      publishStatus();
      return;
    }
    fenceKey(account);
    stagger();
    publishStatus();
    schedule();
  }

  // An Organization's live reading after its projection moved without a read
  // of the newly projected Membership: that one's last reading, when it has
  // answered at all. Never history: nothing was appended.
  function emitProjection(organization: string, showing: Entry | undefined): void {
    if (remote !== null || showing?.current === undefined) return;
    opts.liveHub.emitUsageSample(organization, showing.current);
  }

  async function runPoll(
    id: string,
    myEpoch: number,
    generation: number,
    abort: AbortController,
  ): Promise<void> {
    const reader = entries.get(id)!;
    const account = reader.account;
    const organization = reader.organization;
    const polledKey = keys.get(account)!;
    // Resolve the wrapper on abort even if a test/upstream ignores the signal.
    // The actual fetch has no side effects here and its late result is fenced.
    let onAbort!: () => void;
    const cancelled = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      abort.signal.addEventListener("abort", onAbort, { once: true });
    });
    let result: FetchUsageResult | null;
    try {
      result = await Promise.race([
        fetchUsageImpl({ sessionKey: polledKey.sessionKey, orgId: organization }, abort.signal),
        cancelled,
      ]);
    } catch {
      result = { ok: false, kind: "error" };
    } finally {
      abort.signal.removeEventListener("abort", onAbort);
    }
    const entry = entries.get(id);
    if (
      result === null ||
      myEpoch !== epoch ||
      keys.get(account) !== polledKey ||
      polledKey.generation !== generation ||
      abort.signal.aborted ||
      entry === undefined
    )
      return;
    if (!result.ok && result.kind === "expired") {
      expire(account);
      return;
    }
    const previousLimits = entry.status?.limits;
    const shown = projected(organization);
    const scope = scopeOf(organization, account);
    const latest = opts.store.latest(scope);
    const accountUuid = account === LEGACY_KEY ? {} : { accountUuid: account };
    if (result.ok) {
      const reading =
        result.sample === null
          ? null
          : { ...result.sample, organizationUuid: organization, ...accountUuid };
      entry.current = reading;
      entry.weeklyResetAt = reading?.weekly?.resetAt ?? entry.weeklyResetAt;
      const historical = usageSampleOf(reading);
      if (historical !== null) opts.store.append(historical);
      entry.status = {
        limits: limitsAnswer(result),
        windowStates: result.windowStates,
        lastReadAt: new Date(now()).toISOString(),
        lastSampleAt: opts.store.latest(scope)?.capturedAt ?? null,
      };
      if (historical !== null) opts.liveHub.emitHistory(historical);
      if (projected(organization) === entry) opts.liveHub.emitUsageSample(organization, reading);
    } else {
      entry.status = {
        limits: limitsAnswer(result),
        // The last successful read's, as `lastReadAt` is.
        windowStates: entry.status?.windowStates ?? null,
        lastReadAt: entry.status?.lastReadAt ?? null,
        lastSampleAt: latest?.capturedAt ?? null,
      };
      if (result.kind === "forbidden") entry.nextAt = now() + FORBIDDEN_RETRY_MS;
    }
    // The read moved the projection to another Membership (it fell behind,
    // or failed): the Organization's live reading becomes that one's.
    const showing = projected(organization);
    if (showing !== shown && showing !== entry) emitProjection(organization, showing);
    // A readability change changes the number of minute slots. Keep the
    // hourly deadlines independent; re-space only the ordinary readers.
    if ((previousLimits === "forbidden") !== (entry.status?.limits === "forbidden")) stagger();
    publishStatus();
    schedule();
  }

  function pollMembership(id: string): Promise<void> {
    const entry = entries.get(id);
    if (!canPoll() || entry === undefined || !live(entry.account)) return Promise.resolve();
    const held = flights.get(id);
    const generation = keys.get(entry.account)!.generation;
    if (held?.epoch === epoch && held.generation === generation) return held.promise;
    const abort = new AbortController();
    const myEpoch = epoch;
    const promise = runPoll(id, myEpoch, generation, abort).finally(() => {
      if (flights.get(id)?.promise === promise) flights.delete(id);
      draining.delete(promise);
    });
    flights.set(id, { epoch: myEpoch, generation, abort, promise });
    draining.add(promise);
    return promise;
  }
  // A reader moved (another key's listing, the Home Account, a re-key): only
  // the Memberships it moved are new, and only those are read now. The rest
  // keep their slots, a forbidden one its hour (ADR-0138 §11: "as one key's
  // does today"; one key's re-probe is on its key or the polled set changing,
  // ADR-0104, which setKeys and setOrganizations keep).
  function pollMoved(ids: readonly string[]): Promise<void> {
    if (!canPoll()) return Promise.resolve();
    // rebuild() fenced the reads and cleared the timer: with nothing new to
    // read (a listing that only removed a Membership), the survivors are
    // re-spaced and scheduled at once, or polling would stop.
    if (ids.length === 0) {
      if (batch?.epoch !== epoch) {
        stagger(true);
        schedule();
      }
      return Promise.resolve();
    }
    clearSchedule();
    const myEpoch = epoch;
    return Promise.all(ids.map(pollMembership)).then(() => {
      if (myEpoch !== epoch || batch?.epoch === epoch) return;
      stagger(true);
      schedule();
    });
  }
  // A reader move: rebuild, hand each Organization whose shown Membership
  // changed to a survivor that survivor's last reading at once (a moved one
  // emits its own when its read lands), and read only the moved ones.
  // `shown`: the projections from before whatever moved the readers (the
  // caller's, when it changed the projection's inputs before calling).
  function moveReaders(
    shown: ReadonlyMap<string, Entry | undefined> = new Map(
      polled.map((id) => [id, projected(id)]),
    ),
  ): boolean {
    const moved = rebuild();
    if (moved === null) return false;
    // By Membership id: rebuild() makes new entry objects, so identity would
    // see every Organization as moved.
    const idOf = (e: Entry | undefined) =>
      e === undefined ? null : membershipId(e.organization, e.account);
    const fresh = new Set(moved);
    for (const id of polled) {
      const showing = projected(id);
      const showingId = idOf(showing);
      if (showingId === null || showingId === idOf(shown.get(id)) || fresh.has(showingId)) continue;
      emitProjection(id, showing);
    }
    void pollMoved(moved);
    return true;
  }
  function pollOnce(): Promise<void> {
    if (!canPoll()) return Promise.resolve();
    if (batch?.epoch === epoch) return batch.promise;
    clearSchedule();
    const myEpoch = epoch;
    const promise = Promise.all(
      pollable().map((e) => pollMembership(membershipId(e.organization, e.account))),
    ).then(() => {
      if (myEpoch !== epoch) return;
      batch = null;
      stagger(true);
      schedule();
    });
    batch = { epoch: myEpoch, promise };
    return promise;
  }

  return {
    setKeys: (next) => {
      fence();
      const given = new Map(next.map((k) => [k.account, k.sessionKey]));
      for (const account of [...keys.keys()]) {
        if (given.has(account)) continue;
        keys.delete(account);
        listings.delete(account);
      }
      for (const [account, sessionKey] of given) {
        // A fresh state object per push: a read in flight under the old one
        // is fenced by identity as well as by the epoch.
        keys.set(account, { sessionKey, expired: false, generation: 0 });
      }
      rebuild();
      stagger(true);
      publishStatus();
      schedule();
    },
    getKeys: () =>
      sortedAccounts().map((account) => ({ account, sessionKey: keys.get(account)!.sessionKey })),
    rekey: (from, to) => {
      const key = keys.get(from);
      if (key === undefined || from === to || keys.has(to)) return;
      // Reads in flight under the old Account key land nowhere: their entry
      // ids are gone. The moved Memberships keep their slots.
      fenceKey(from);
      keys.delete(from);
      keys.set(to, key);
      const listing = listings.get(from);
      listings.delete(from);
      if (listing !== undefined) listings.set(to, listing);
      entries = new Map(
        [...entries.values()]
          .map((entry) => {
            if (entry.account === from) entry.account = to;
            return [membershipId(entry.organization, entry.account), entry] as const;
          })
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      // The readers may differ now (Home's Account holds a key at last).
      moveReaders();
      publishStatus();
      schedule();
    },
    // The key was refused outside a read — the Hub's listing answered 401/403
    // (ADR-0104). The same state a 401 on a read leaves: that key's reads stop
    // until a push carries it again.
    expireKey: (account) => {
      const key = keys.get(account);
      if (key === undefined || key.expired) return;
      expire(account);
    },
    keyConnection: (account) => (remote !== null ? remote.usageConnection : connectionOf(account)),
    ownKeyConnection: connectionOf,
    setListing: (account, organizations) => {
      if (organizations === null) listings.delete(account);
      else listings.set(account, new Set(organizations));
      if (moveReaders()) publishStatus();
    },
    setHomeAccount: (account) => {
      if (homeAccount === account) return;
      const shown = new Map(polled.map((id) => [id, projected(id)]));
      homeAccount = account;
      if (!moveReaders(shown)) {
        // The same Memberships, another projection: each Organization whose
        // projected Membership changed carries that one's reading.
        for (const id of polled) {
          const showing = projected(id);
          if (showing !== shown.get(id)) emitProjection(id, showing);
        }
      }
      publishStatus();
    },
    setOrganizations: (ids, nextHome) => {
      asked = ids;
      const homeChanged = home !== nextHome;
      home = nextHome;
      const changed = rebuild() !== null;
      if (changed && canPoll()) void pollOnce();
      if (changed || homeChanged) publishStatus();
    },
    getOrganizations: () => polled,
    memberships: membershipStates,
    staleOrganizations: () =>
      polled.filter((id) => {
        const showing = projected(id);
        return showing?.status !== undefined && (keys.get(showing.account)?.expired ?? false);
      }),
    expiredReaderOrganizations: () =>
      [...new Set([...polled, ...[...listings.values()].flatMap((l) => [...l])])]
        .sort()
        .filter((id) => {
          const readBy = readers(id).filter((account) => keys.has(account));
          return readBy.length > 0 && readBy.every((account) => keys.get(account)!.expired);
        }),
    pollOnce,
    getCurrent,
    lastReadAt: (organization) => headLastReadAt(organizations(), organization),
    setRemoteState: (state) => {
      // A Home/set edit can add an Organization after the last remote frame;
      // copy its authoritative value before relinquishing Hub ownership too.
      const held = state ?? remote;
      if (held !== null) {
        for (const entry of entries.values()) {
          const id = entry.organization;
          if (Object.hasOwn(held.usageCurrent, id)) {
            entry.current = held.usageCurrent[id]!;
            entry.weeklyResetAt =
              entry.current?.weekly?.resetAt ??
              held.usageWeeklyResetAt[id] ??
              remoteWeekly.get(id) ??
              entry.weeklyResetAt;
          }
        }
      }
      remote = state;
      if (state !== null) {
        fence();
        for (const [id, reset] of Object.entries(state.usageWeeklyResetAt)) {
          remoteWeekly.set(id, reset);
        }
        for (const [id, reading] of Object.entries(state.usageCurrent)) {
          if (reading?.weekly != null) remoteWeekly.set(id, reading.weekly.resetAt);
        }
      }
      publishStatus();
    },
    start: (ms = 60_000) => {
      if (running && !suspended) return;
      intervalMs = ms;
      running = true;
      suspended = false;
      stagger();
      schedule();
    },
    stop: async () => {
      running = false;
      suspended = true;
      fence();
      await Promise.all([...draining]);
    },
  };
}
