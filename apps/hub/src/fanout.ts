// Exported via a package.json subpath solely for the sidecar fleet test rig (apps/sidecar/src/test-hub.ts) — keep signatures stable, a cross-app test contract.
import { HUB_SSE_EVENT, type HubStatus, type UsageSample } from "@maxprice/shared";

// The hub's pub/sub between the poller and SSE clients — the LiveHub pattern
// (apps/sidecar/src/live-hub.ts) with the hub's message set: samples + status
// + heartbeat. Heartbeat is ref-counted on subscribers, like LiveHub's.
export type HubMessage =
  | { type: typeof HUB_SSE_EVENT.sample; data: UsageSample }
  | { type: typeof HUB_SSE_EVENT.status; data: HubStatus }
  // ADR-0041: pokes, never data. hub:events = post-fsync durable watermark;
  // hub:machines = the directory changed (registration or rename).
  | { type: typeof HUB_SSE_EVENT.events; data: { seq: number } }
  | { type: typeof HUB_SSE_EVENT.machines; data: Record<string, never> }
  | { type: typeof HUB_SSE_EVENT.heartbeat };

export type HubSubscriber = (message: HubMessage) => void;

export type HubFanout = {
  subscribe: (subscriber: HubSubscriber) => () => void;
  emitSample: (sample: UsageSample) => void;
  emitEventsPoke: (seq: number) => void;
  emitMachinesPoke: () => void;
  getStatus: () => HubStatus;
  patchStatus: (partial: Partial<HubStatus>) => void;
  subscriberCount: () => number;
  close: () => void;
};

export type CreateHubFanoutOptions = {
  initialStatus: HubStatus;
  heartbeatMs?: number;
  setIntervalImpl?: (callback: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
};

export function createHubFanout(opts: CreateHubFanoutOptions): HubFanout {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const setIntervalImpl =
    opts.setIntervalImpl ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
  const clearIntervalImpl =
    opts.clearIntervalImpl ??
    ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  const subscribers = new Set<HubSubscriber>();
  let status: HubStatus = opts.initialStatus;
  let heartbeatTimer: unknown = null;

  function deliver(subscriber: HubSubscriber, message: HubMessage): void {
    try {
      subscriber(message);
    } catch {
      // a broken transport must not break the rest — see LiveHub
    }
  }

  function broadcast(message: HubMessage): void {
    for (const subscriber of subscribers) deliver(subscriber, message);
  }

  return {
    subscribe: (subscriber) => {
      deliver(subscriber, { type: HUB_SSE_EVENT.status, data: status });
      subscribers.add(subscriber);
      if (subscribers.size === 1) {
        heartbeatTimer ??= setIntervalImpl(() => {
          broadcast({ type: HUB_SSE_EVENT.heartbeat });
        }, heartbeatMs);
      }
      return () => {
        subscribers.delete(subscriber);
        if (subscribers.size === 0 && heartbeatTimer !== null) {
          clearIntervalImpl(heartbeatTimer);
          heartbeatTimer = null;
        }
      };
    },
    emitSample: (sample) => broadcast({ type: HUB_SSE_EVENT.sample, data: sample }),
    emitEventsPoke: (seq) => broadcast({ type: HUB_SSE_EVENT.events, data: { seq } }),
    emitMachinesPoke: () => broadcast({ type: HUB_SSE_EVENT.machines, data: {} }),
    getStatus: () => status,
    patchStatus: (partial) => {
      status = { ...status, ...partial };
      broadcast({ type: HUB_SSE_EVENT.status, data: status });
    },
    subscriberCount: () => subscribers.size,
    close: () => {
      if (heartbeatTimer !== null) {
        clearIntervalImpl(heartbeatTimer);
        heartbeatTimer = null;
      }
      subscribers.clear();
    },
  };
}
