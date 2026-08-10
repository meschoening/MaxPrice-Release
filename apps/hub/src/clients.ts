import type { HubClient } from "@maxprice/shared";

// In-memory connected-client registry (ADR-0036). Keyed by machineId; resets on
// hub restart (a roster is a live/recently-seen view, not a durable audit log).
// `nowImpl` is injected so pure-logic tests run on a fake clock — the codebase
// forbids ambient Date.now() here.
export type ClientRegistry = {
  // Called by the /api/* middleware for every authenticated request that
  // identifies its machine. The server filters out header-less (non-fleet)
  // requests upstream, so this only ever sees a real machineId; hostname /
  // remoteAddr remain best-effort (either may be null).
  recordRequest: (machineId: string, hostname: string | null, remoteAddr: string | null) => void;
  // Called by /api/stream on subscribe / unsubscribe.
  markLive: (machineId: string) => void;
  markOffline: (machineId: string) => void;
  // Live first, then by lastSeenAt desc. Returns copies so callers can't mutate
  // the internal rows.
  list: () => HubClient[];
};

export function createClientRegistry(opts?: { nowImpl?: () => string }): ClientRegistry {
  const now = opts?.nowImpl ?? (() => new Date().toISOString());
  const clients = new Map<string, HubClient>();
  // Per-machine count of open live subscriptions. Two streams for one machineId
  // can overlap — a client reconnects while the hub's old half-open socket
  // lingers for minutes until a heartbeat write finally fails — so a boolean
  // that the stale stream's finally unconditionally clears would flip a
  // still-connected client offline indefinitely. The exported row's boolean
  // `live` is `count > 0`; the wire shape (HubClient) is unchanged.
  const liveCount = new Map<string, number>();

  function ensure(machineId: string): HubClient {
    let entry = clients.get(machineId);
    if (entry === undefined) {
      const ts = now();
      entry = {
        machineId,
        hostname: null,
        connectedAt: ts,
        lastSeenAt: ts,
        live: false,
        remoteAddr: null,
      };
      clients.set(machineId, entry);
    }
    return entry;
  }

  return {
    recordRequest: (machineId, hostname, remoteAddr) => {
      const ts = now();
      const existing = clients.get(machineId);
      if (existing === undefined) {
        // New entry: one clock tick covers both connectedAt and lastSeenAt.
        clients.set(machineId, {
          machineId,
          hostname,
          connectedAt: ts,
          lastSeenAt: ts,
          live: false,
          remoteAddr,
        });
        return;
      }
      existing.lastSeenAt = ts;
      // A self-reported value refreshes the label; a header-less request (null)
      // must NOT erase a previously-learned hostname / remote IP.
      if (hostname !== null) existing.hostname = hostname;
      if (remoteAddr !== null) existing.remoteAddr = remoteAddr;
    },
    markLive: (machineId) => {
      const entry = ensure(machineId);
      const ts = now();
      const count = (liveCount.get(machineId) ?? 0) + 1;
      liveCount.set(machineId, count);
      // The connection window opens on the 0→1 transition only; overlapping
      // subscriptions (a reconnect over a lingering half-open stream) share it,
      // so a redundant markLive doesn't reset the start.
      if (count === 1) entry.connectedAt = ts;
      entry.live = true; // count > 0
      entry.lastSeenAt = ts;
    },
    markOffline: (machineId) => {
      const entry = clients.get(machineId);
      if (entry === undefined) return; // an unsubscribe we never recorded — no-op
      // Decrement with a floor of 0 — a stale stream's finally may fire after
      // the count already reached 0, and must not drive it negative.
      const count = Math.max(0, (liveCount.get(machineId) ?? 0) - 1);
      liveCount.set(machineId, count);
      entry.live = count > 0;
      entry.lastSeenAt = now();
    },
    list: () =>
      [...clients.values()]
        .map((e) => ({ ...e }))
        .sort((a, b) => {
          if (a.live !== b.live) return a.live ? -1 : 1; // live first
          // then lastSeenAt desc — ISO-8601 strings sort lexicographically
          return a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0;
        }),
  };
}
