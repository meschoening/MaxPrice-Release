import type { DiscoveredOrg } from "@maxprice/shared";
import type { DiscoverOrgResult } from "@maxprice/usage-core";

// The key listing (#366, #360 items 4–5). A client with no Hub configured runs
// exactly Connect's discovery (the listing plus one usage probe per
// Organization) with its stored key, on every key arrival (the boot push,
// Connect, a key edit) and hourly, the Hub's own rhythm. Each answer is
// recorded whole, as Connect records it (`recordDiscovery`), so an
// Organization the key no longer lists is marked off the account and kept, and
// a live poll answer still outranks the recorded one (`listOrganizations`). A
// Hub-configured client never lists, even while it has fallen back to polling
// for itself: it learns the Hub's roster when its Hub returns (fleet.ts), and
// until then its roster waits (named residual). The Hub check runs as each
// listing starts, so one queued before a Hub was configured never asks
// claude.ai; one already in flight still records its answer, since the request
// was made and the registry never deletes.
//
// Listings run one at a time, in arrival order: each waits for the one before
// it to settle. A failed or empty listing changes nothing, and none ever
// rejects, even when a callback throws (warned like a failed listing), so a
// claude.ai failure or hang never reaches the credential push's ack, which
// does not wait for it anyway.

export const KEY_LISTING_INTERVAL_MS = 3_600_000;

export type KeyListing = {
  // A key arrived (POST /api/usage/credential). Lists with it unless a Hub is
  // configured. Resolves when that listing has settled; never rejects.
  keyArrived: (sessionKey: string) => Promise<void>;
  start: () => void; // the hourly repeat, with currentKey()
  stop: () => void;
};

export function createKeyListing(opts: {
  hubConfigured: () => boolean;
  currentKey: () => string | null;
  discover: (sessionKey: string) => Promise<DiscoverOrgResult>;
  record: (orgs: readonly DiscoveredOrg[]) => Promise<boolean>;
  changed: () => void; // organizations:changed, when record() moved something
  intervalMs?: number;
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
}): KeyListing {
  const intervalMs = opts.intervalMs ?? KEY_LISTING_INTERVAL_MS;
  const setIntervalImpl =
    opts.setIntervalImpl ?? ((cb: () => void, ms: number): unknown => setInterval(cb, ms));
  const clearIntervalImpl =
    opts.clearIntervalImpl ??
    ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

  const warn = (cause: unknown): void =>
    console.warn(`[sidecar] organization listing failed: ${String(cause)}`);

  async function listOnce(sessionKey: string): Promise<void> {
    if (opts.hubConfigured()) return;
    let result: DiscoverOrgResult;
    try {
      result = await opts.discover(sessionKey);
    } catch (err) {
      warn(err);
      return;
    }
    if (!result.ok) {
      warn(result.kind);
      return;
    }
    if (result.orgs.length === 0) return;
    let changed: boolean;
    try {
      changed = await opts.record(result.orgs);
    } catch (err) {
      warn(err);
      // The registry updates its memory before its write, so the roster may
      // already show what this record rejected on: announce it anyway.
      changed = true;
    }
    if (changed) opts.changed();
  }

  // The catch makes "never rejects" hold on its own: a throw from
  // `hubConfigured` or `changed` is warned, and the next listing still runs.
  let chain: Promise<void> = Promise.resolve();
  function enqueue(sessionKey: string): Promise<void> {
    chain = chain.then(() => listOnce(sessionKey)).catch(warn);
    return chain;
  }

  let timer: unknown = null;
  return {
    keyArrived: enqueue,
    start: () => {
      timer ??= setIntervalImpl(() => {
        const sessionKey = opts.currentKey();
        if (sessionKey !== null) void enqueue(sessionKey);
      }, intervalMs);
    },
    stop: () => {
      if (timer === null) return;
      clearIntervalImpl(timer);
      timer = null;
    },
  };
}
