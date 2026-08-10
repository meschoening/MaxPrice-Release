import {
  SSE_EVENT,
  type BlockTickEvent,
  type EmittedStatusSnapshot,
  type StatusSnapshot,
  type UsageEvent,
  type UsageSample,
} from "@maxprice/shared";

// Transport-agnostic messages the hub fans out. The SSE route translates each
// into a wire frame; the hub itself knows nothing about Hono or HTTP. The
// `type` discriminants come from the shared SSE_EVENT constant so they can't
// drift from the renderer's listeners.
export type LiveMessage =
  | { type: typeof SSE_EVENT.usageNew; data: UsageEvent }
  | { type: typeof SSE_EVENT.blockTick; data: BlockTickEvent }
  | { type: typeof SSE_EVENT.statusChanged; data: StatusSnapshot }
  | { type: typeof SSE_EVENT.usageSample; data: UsageSample | null }
  // Fleet machine-directory poke (ADR-0041 M5) — empty data, a pure refetch
  // signal for GET /api/machines. Broadcast on every hub:machines poke and on
  // this machine's own directory-cache refresh.
  | { type: typeof SSE_EVENT.machinesChanged; data: Record<string, never> }
  // Identity-directory poke (ADR-0062) — empty data, a pure refetch signal for
  // GET /api/project-identity. Broadcast whenever the directory's rows change:
  // a local probe recording something new, or a hub pull adopting the union.
  | { type: typeof SSE_EVENT.identityChanged; data: Record<string, never> }
  | { type: typeof SSE_EVENT.heartbeat };

export type LiveSubscriber = (message: LiveMessage) => void;

export type LiveHub = {
  // Register a subscriber. It synchronously receives the current status as a
  // status:changed message, then every subsequent broadcast. Returns an
  // unsubscribe function.
  subscribe: (subscriber: LiveSubscriber) => () => void;
  emitUsage: (event: UsageEvent) => void;
  emitUsageSample: (sample: UsageSample | null) => void;
  // Broadcast a machines:changed poke (empty payload) so subscribers refetch
  // GET /api/machines (ADR-0041 M5).
  emitMachinesChanged: () => void;
  // Broadcast an identity:changed poke (empty payload) so subscribers refetch
  // GET /api/project-identity and refold (ADR-0062).
  emitIdentityChanged: () => void;
  getStatus: () => StatusSnapshot;
  setStatus: (status: StatusSnapshot) => void;
  // Merge a partial update into the current status and broadcast it. Unlike a
  // `setStatus({ ...getStatus(), ... })` from the caller, the read-merge-write
  // happens synchronously inside the hub, so two concurrent partial updaters
  // can't clobber each other's fields by spreading a stale snapshot.
  patchStatus: (partial: Partial<StatusSnapshot>) => void;
  subscriberCount: () => number;
  close: () => void;
};

export type CreateLiveHubOptions = {
  // `EmittedStatusSnapshot`, not `StatusSnapshot`: this is the ONLY production
  // site that mints a whole snapshot — everything after it is a `patchStatus`
  // of a Partial, and both wire exits read the one object the hub holds. The
  // shared type's `pricing?` is consumer parse tolerance for a skewed producer
  // (ADR-0053); the producer's obligation is discharged here, so dropping
  // `pricing` from the boot literal in index.ts is a compile error rather than
  // a silent em dash in Settings' App info row.
  initialStatus: EmittedStatusSnapshot;
  // block:tick cadence — refreshes the active block's burn rate / projection
  // even with no file activity. Default 30s.
  blockTickMs?: number;
  // SSE heartbeat cadence — a comment line keeps proxies / WebView2 from
  // dropping an idle connection. Default 15s.
  heartbeatMs?: number;
  // Injectable timer seam (additive; defaults to the global setInterval /
  // clearInterval). Tests pass a controllable fake clock so the block:tick /
  // heartbeat intervals can be advanced deterministically instead of waiting on
  // real wall-clock time. Production passes neither and keeps the real timers.
  // The handle is opaque to the hub: whatever `setIntervalImpl` returns is only
  // ever handed straight back to `clearIntervalImpl`.
  setIntervalImpl?: (callback: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
};

// Pub/sub hub between the file watcher and the SSE clients. The block:tick and
// heartbeat intervals are ref-counted on subscribers — they only run while at
// least one client is connected, so an idle app does no periodic work.
export function createLiveHub(opts: CreateLiveHubOptions): LiveHub {
  const blockTickMs = opts.blockTickMs ?? 30_000;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const setIntervalImpl =
    opts.setIntervalImpl ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
  const clearIntervalImpl =
    opts.clearIntervalImpl ??
    ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  const subscribers = new Set<LiveSubscriber>();
  let status: StatusSnapshot = opts.initialStatus;
  // undefined until the first authoritative poll. Afterwards retain sample OR
  // null so a reconnect cannot miss a reset between first paint and SSE.
  let usageCurrent: UsageSample | null | undefined;
  let blockTickTimer: unknown = null;
  let heartbeatTimer: unknown = null;

  // A subscriber's transport (a closed SSE stream) must not break hub
  // operations — the SSE route unsubscribes on close, but until it does a
  // throwing subscriber stays isolated from the rest.
  function deliver(subscriber: LiveSubscriber, message: LiveMessage): void {
    try {
      subscriber(message);
    } catch {
      // swallowed — see above
    }
  }

  function broadcast(message: LiveMessage): void {
    for (const subscriber of subscribers) deliver(subscriber, message);
  }

  function startTimers(): void {
    blockTickTimer ??= setIntervalImpl(() => {
      broadcast({ type: SSE_EVENT.blockTick, data: { timestamp: new Date().toISOString() } });
    }, blockTickMs);
    heartbeatTimer ??= setIntervalImpl(() => {
      broadcast({ type: SSE_EVENT.heartbeat });
    }, heartbeatMs);
  }

  function stopTimers(): void {
    if (blockTickTimer !== null) {
      clearIntervalImpl(blockTickTimer);
      blockTickTimer = null;
    }
    if (heartbeatTimer !== null) {
      clearIntervalImpl(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function subscribe(subscriber: LiveSubscriber): () => void {
    deliver(subscriber, { type: SSE_EVENT.statusChanged, data: status });
    if (usageCurrent !== undefined) {
      deliver(subscriber, { type: SSE_EVENT.usageSample, data: usageCurrent });
    }
    subscribers.add(subscriber);
    if (subscribers.size === 1) startTimers();
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) stopTimers();
    };
  }

  return {
    subscribe,
    emitUsage: (event) => broadcast({ type: SSE_EVENT.usageNew, data: event }),
    emitUsageSample: (sample) => {
      usageCurrent = sample;
      broadcast({ type: SSE_EVENT.usageSample, data: sample });
    },
    emitMachinesChanged: () => broadcast({ type: SSE_EVENT.machinesChanged, data: {} }),
    emitIdentityChanged: () => broadcast({ type: SSE_EVENT.identityChanged, data: {} }),
    getStatus: () => status,
    setStatus: (next) => {
      status = next;
      broadcast({ type: SSE_EVENT.statusChanged, data: next });
    },
    patchStatus: (partial) => {
      status = { ...status, ...partial };
      broadcast({ type: SSE_EVENT.statusChanged, data: status });
    },
    subscriberCount: () => subscribers.size,
    // `close` only empties the subscriber set and stops the timers — it does
    // NOT tear down live SSE connections. Each `/api/stream` handler stays
    // parked on its outer promise until `server.stop(true)` (in `shutdown()`)
    // severs the socket, which fires `stream.onAbort` → the handler's teardown.
    close: () => {
      stopTimers();
      subscribers.clear();
    },
  };
}
