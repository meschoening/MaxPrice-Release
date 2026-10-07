import {
  completeUsageSample,
  type HubStatus,
  type OrganizationUsageStatus,
  type UsageConnection,
  type UsageCredential,
  type UsageOrganizations,
  type UsageReading,
} from "@maxprice/shared";
import { fetchUsage, type FetchUsageResult } from "./usage-client";
import type { SampleStore } from "./sample-store";

export type PollerStatus = {
  usageConnection: UsageConnection;
  usageLastSampleAt: string | null;
  organizations: UsageOrganizations;
};

export type PollerHub = {
  // Even null carries its Organization at this internal adapter seam.
  emitUsageSample: (organization: string, sample: UsageReading | null) => void;
  patchStatus: (partial: PollerStatus) => void;
};

export type UsagePollerCurrent = {
  connection: UsageConnection;
  sample: UsageReading | null;
  lastSampleAt: string | null;
  weeklyResetAt: string | null;
};

type RemoteState = Pick<
  HubStatus,
  "usageConnection" | "organizations" | "usageCurrent" | "usageWeeklyResetAt"
>;

export type UsagePoller = {
  setCredential: (cred: UsageCredential | null) => void;
  // The key refused outside a read (the Hub's listing): reads stop until it changes.
  expireCredential: () => void;
  getCredential: () => UsageCredential | null;
  // Home is getCurrent()'s default and owns unstamped history; set equality
  // alone controls re-polling.
  setOrganizations: (organizations: readonly string[], home: string | null) => void;
  // The current poll set, as `setOrganizations` last gave it, sorted — the
  // Organizations this poller answers for, whoever owns polling. Never the
  // Hub's map.
  getOrganizations: () => readonly string[];
  pollOnce: () => Promise<void>;
  getCurrent: (organization?: string | null) => UsagePollerCurrent;
  // A remote snapshot owns live state while the Hub owns polling. History
  // replication is independent and never makes an absent entry an answer.
  setRemoteState: (state: RemoteState | null) => void;
  start: (intervalMs?: number) => void;
  stop: () => Promise<void>;
};

export type CreateUsagePollerOptions = {
  store: SampleStore;
  liveHub: PollerHub;
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
  status?: OrganizationUsageStatus;
  // undefined: never answered; null: successfully read no window.
  current?: UsageReading | null;
  weeklyResetAt?: string;
  nextAt: number;
};
type Flight = { epoch: number; abort: AbortController; promise: Promise<void> };
const FORBIDDEN_RETRY_MS = 60 * 60_000;

// One key, one scheduler, independent Organization reads (ADR-0104). Each
// ordinary pass takes a minute, evenly staggered. Explicit refreshes fan out
// concurrently, then establish a fresh stagger. No timer depends on viewers.
export function createUsagePoller(opts: CreateUsagePollerOptions): UsagePoller {
  const fetchUsageImpl =
    opts.fetchUsageImpl ?? ((c, signal) => fetchUsage({ ...c, baseUrl: opts.baseUrl, signal }));
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = opts.clearTimeoutImpl ?? ((handle) => clearTimeout(handle));
  let credential: UsageCredential | null = null;
  let home: string | null = null;
  let entries = new Map<string, Entry>();
  let remote: RemoteState | null = null;
  const remoteWeekly = new Map<string, string>();
  let expired = false;
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
  function organizations(): UsageOrganizations {
    if (remote !== null) return remote.organizations;
    return Object.fromEntries(
      [...entries].flatMap(([id, entry]) =>
        entry.status === undefined ? [] : [[id, entry.status]],
      ),
    );
  }
  // The key's state, from which getCurrent derives one Organization's. The Hub
  // composes a failed or empty discovery on top of this: with no answer it
  // reads `error`, not `disconnected` (apps/hub/src/usage-status.ts).
  function keyConnection(): UsageConnection {
    if (remote !== null) return remote.usageConnection;
    if (credential === null) return "disconnected";
    if (expired) return "expired";
    const answers = Object.values(organizations());
    if (answers.some((s) => s.limits === "windows" || s.limits === "none")) return "connected";
    return answers.length === 0 ? "disconnected" : "error";
  }
  function publishStatus(): void {
    opts.liveHub.patchStatus({
      usageConnection: keyConnection(),
      usageLastSampleAt: opts.store.latest()?.capturedAt ?? null,
      organizations: organizations(),
    });
  }
  function getCurrent(organization = home): UsagePollerCurrent {
    const latest = organization === null ? null : opts.store.latest({ organization, home });
    const entry = organization === null ? undefined : entries.get(organization);
    const status = organization === null ? undefined : organizations()[organization];
    const remoteCurrent = organization === null ? undefined : remote?.usageCurrent[organization];
    // Omission is not a new answer. Retain even an authoritative null/partial
    // from local polling or an earlier remote snapshot before using history.
    const current = remoteCurrent === undefined ? entry?.current : remoteCurrent;
    const remoteReset = organization === null ? undefined : remoteWeekly.get(organization);
    const sample = current === undefined ? latest : current;
    const key = keyConnection();
    const connection =
      key === "expired" || key === "disconnected"
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
        latest?.weekly.resetAt ??
        null,
    };
  }
  function canPoll(): boolean {
    return !suspended && remote === null && credential !== null && !expired;
  }
  function stagger(preserveSingleton = false): void {
    const readable = [...entries.values()].filter((e) => e.status?.limits !== "forbidden");
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
    if (!running || !canPoll() || batch !== null || entries.size === 0) return;
    const at = Math.min(...[...entries.values()].map((e) => e.nextAt));
    timer = setTimer(
      () => {
        timer = null;
        const due = now();
        for (const [id, entry] of entries) {
          if (entry.nextAt > due) continue;
          entry.nextAt =
            due + (entry.status?.limits === "forbidden" ? FORBIDDEN_RETRY_MS : intervalMs);
          void pollOrganization(id);
        }
        schedule();
      },
      Math.max(0, at - now()),
    );
  }

  async function runPoll(id: string, myEpoch: number, abort: AbortController): Promise<void> {
    const polled = credential!;
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
        fetchUsageImpl({ sessionKey: polled.sessionKey, orgId: id }, abort.signal),
        cancelled,
      ]);
    } catch {
      result = { ok: false, kind: "error" };
    } finally {
      abort.signal.removeEventListener("abort", onAbort);
    }
    const entry = entries.get(id);
    if (result === null || myEpoch !== epoch || abort.signal.aborted || entry === undefined) return;
    if (!result.ok && result.kind === "expired") {
      expired = true;
      fence();
      publishStatus();
      return;
    }
    const previousLimits = entry.status?.limits;
    const latest = opts.store.latest({ organization: id, home });
    if (result.ok) {
      const reading = result.sample === null ? null : { ...result.sample, organizationUuid: id };
      entry.current = reading;
      entry.weeklyResetAt = reading?.weekly?.resetAt ?? entry.weeklyResetAt;
      const historical = completeUsageSample(reading);
      if (historical !== null) opts.store.append(historical);
      entry.status = {
        limits: reading === null ? "none" : "windows",
        lastReadAt: new Date(now()).toISOString(),
        lastSampleAt: opts.store.latest({ organization: id, home })?.capturedAt ?? null,
      };
      opts.liveHub.emitUsageSample(id, reading);
    } else {
      entry.status = {
        limits: result.kind === "forbidden" ? "forbidden" : "error",
        lastReadAt: entry.status?.lastReadAt ?? null,
        lastSampleAt: latest?.capturedAt ?? null,
      };
      if (result.kind === "forbidden") entry.nextAt = now() + FORBIDDEN_RETRY_MS;
    }
    // A readability change changes the number of minute slots. Keep the
    // hourly deadlines independent; re-space only the ordinary readers.
    if ((previousLimits === "forbidden") !== (entry.status?.limits === "forbidden")) stagger();
    publishStatus();
    schedule();
  }

  function pollOrganization(id: string): Promise<void> {
    if (!canPoll()) return Promise.resolve();
    const held = flights.get(id);
    if (held?.epoch === epoch) return held.promise;
    const abort = new AbortController();
    const myEpoch = epoch;
    const promise = runPoll(id, myEpoch, abort).finally(() => {
      if (flights.get(id)?.promise === promise) flights.delete(id);
      draining.delete(promise);
    });
    flights.set(id, { epoch: myEpoch, abort, promise });
    draining.add(promise);
    return promise;
  }
  function pollOnce(): Promise<void> {
    if (!canPoll()) return Promise.resolve();
    if (batch?.epoch === epoch) return batch.promise;
    clearSchedule();
    const myEpoch = epoch;
    const promise = Promise.all([...entries.keys()].map(pollOrganization)).then(() => {
      if (myEpoch !== epoch) return;
      batch = null;
      stagger(true);
      schedule();
    });
    batch = { epoch: myEpoch, promise };
    return promise;
  }

  return {
    setCredential: (cred) => {
      fence();
      credential = cred;
      expired = false;
      stagger(true);
      publishStatus();
      schedule();
    },
    // The key was refused outside a read — the Hub's listing answered 401/403
    // (ADR-0104). The same state a 401 on a read leaves: every read stops until
    // the credential changes.
    expireCredential: () => {
      if (credential === null || expired) return;
      expired = true;
      fence();
      publishStatus();
    },
    getCredential: () => credential,
    setOrganizations: (ids, nextHome) => {
      const unique = [...new Set(ids)].sort();
      const changed = unique.length !== entries.size || unique.some((id) => !entries.has(id));
      const homeChanged = home !== nextHome;
      home = nextHome;
      if (changed) {
        fence();
        entries = new Map(
          unique.map((id) => [id, { ...entries.get(id), nextAt: now() + intervalMs }]),
        );
        if (canPoll()) void pollOnce();
      }
      if (changed || homeChanged) publishStatus();
    },
    getOrganizations: () => [...entries.keys()],
    pollOnce,
    getCurrent,
    setRemoteState: (state) => {
      // A Home/set edit can add an Organization after the last remote frame;
      // copy its authoritative value before relinquishing Hub ownership too.
      const held = state ?? remote;
      if (held !== null) {
        for (const [id, entry] of entries) {
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
