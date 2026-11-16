import type { DiscoveredOrg } from "@maxprice/shared";
import type { DiscoverOrgResult, FetchAccountResult } from "@maxprice/usage-core";
import type { LearnedOrg } from "./organizations";

// The key listing (#366, #360 items 4–5; per key since #633). A client with no
// Hub configured runs exactly Connect's discovery (the listing plus one usage
// probe per Organization) with each key it holds, on that key's arrival (the
// boot push, Connect, a key edit) and hourly on that key's own clock (ADR-0138
// §11), the Hub's own rhythm. Each answer is recorded with every other held
// key's latest listing (`recordDiscovery`), complete once every held key has
// listed, so an Organization no held key lists any more is marked off the
// account and kept, one another Account's key still lists is not (#646), and
// a live poll answer still outranks the recorded one (`listOrganizations`);
// and its Organizations go to the poller as that key's listing (`onListed`,
// the poller's `setListing`). A Hub-configured client never lists, even
// while it has fallen back to polling for itself: it learns the Hub's roster
// when its Hub returns (fleet.ts), and until then its roster waits (named
// residual). A Hub turned off lists every held key at once (`listAll`, #646):
// without it a key held while a Hub was configured had no listing, so nothing
// polled it and its Account read `No key` until the next hourly tick. The Hub
// check runs as each listing starts, so one queued before a Hub was configured never asks
// claude.ai; one already in flight still records its answer, since the request
// was made and the registry never deletes.
//
// Each listing, and each arrival on a Hub-configured client, first reads the
// key's `/api/account` (#633, ADR-0137 §1, ADR-0138 §12) through
// `fetchAccount`, the keyset's `readAccount`, which learns the pair and
// resolves a legacy key's Account. That is the one request this adds: one
// `/api/account` read per key arrival and per listing. `readAccount` alone is
// the legacy key's retry after a successful read (usage-keyset.ts).
//
// Listings and reads run one at a time, in arrival order: each waits for the
// one before it to settle. A key no longer held when its turn comes is
// skipped. A failed or empty listing changes nothing, and none ever rejects,
// even when a callback throws (warned like a failed listing), so a claude.ai
// failure or hang never reaches the credential push's ack, which does not
// wait for it anyway. No address and no key is ever logged.

export const KEY_LISTING_INTERVAL_MS = 3_600_000;

export type KeyListing = {
  // The held keys (POST /api/usage/credential): each keeps its own hourly
  // clock, armed when it is first held and cleared when it leaves.
  hold: (sessionKeys: readonly string[]) => void;
  // A key arrived: it lists (with no Hub) or reads its Account (with one).
  // Resolves when that has settled; never rejects.
  keyArrived: (sessionKey: string) => Promise<void>;
  // One `/api/account` read with a held key, Hub or not. Never rejects.
  readAccount: (sessionKey: string) => Promise<void>;
  // Every held key lists now, in order: the Hub was turned off, and a key
  // held while one was configured never listed (#646). Resolves when all
  // have settled; never rejects.
  listAll: () => Promise<void>;
  stop: () => void; // every clock, for good
};

export function createKeyListing(opts: {
  hubConfigured: () => boolean;
  discover: (sessionKey: string) => Promise<DiscoverOrgResult>;
  fetchAccount: (sessionKey: string) => Promise<FetchAccountResult>;
  onListed: (sessionKey: string, organizations: readonly string[]) => void;
  record: (orgs: readonly LearnedOrg[], opts: { readonly complete: boolean }) => Promise<boolean>;
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

  // Each held key's hourly clock.
  const clocks = new Map<string, unknown>();
  // Each held key's latest listing, recorded together (#646).
  const listings = new Map<string, readonly DiscoveredOrg[]>();
  let stopped = false;

  async function accountOnce(sessionKey: string): Promise<void> {
    let result: FetchAccountResult;
    try {
      result = await opts.fetchAccount(sessionKey);
    } catch (err) {
      console.warn(`[sidecar] account read failed: ${String(err)}`);
      return;
    }
    if (!result.ok) console.warn(`[sidecar] account read failed: ${result.kind}`);
  }

  async function listOnce(sessionKey: string): Promise<void> {
    if (opts.hubConfigured()) return;
    await accountOnce(sessionKey);
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
    opts.onListed(
      sessionKey,
      result.orgs.map((org) => org.id),
    );
    // A key let go while it listed keeps no cached listing (Sol, #646).
    if (heldKeys.has(sessionKey)) listings.set(sessionKey, result.orgs);
    // This key's answers first; the other held keys' latest follow without
    // their Limits answers, which may be an hour old: a null answer leaves the
    // recorded one in place, so they only keep their Organizations listed.
    const seen = new Set(result.orgs.map((org) => org.id));
    const orgs: LearnedOrg[] = [...result.orgs];
    for (const list of listings.values()) {
      for (const org of list) {
        if (seen.has(org.id)) continue;
        seen.add(org.id);
        orgs.push({ ...org, limits: null });
      }
    }
    const complete = [...heldKeys].every((key) => listings.has(key));
    let changed: boolean;
    try {
      changed = await opts.record(orgs, { complete });
    } catch (err) {
      warn(err);
      // The registry updates its memory before its write, so the roster may
      // already show what this record rejected on: announce it anyway.
      changed = true;
    }
    if (changed) opts.changed();
  }

  // An arrival: the listing with no Hub, else the Account read alone.
  async function arrive(sessionKey: string): Promise<void> {
    if (opts.hubConfigured()) await accountOnce(sessionKey);
    else await listOnce(sessionKey);
  }

  // The catch makes "never rejects" hold on its own: a throw from
  // `hubConfigured`, `fetchAccount`, `onListed` or `changed` is warned, and the
  // next task still runs.
  let heldKeys = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  function enqueue(sessionKey: string, task: (sessionKey: string) => Promise<void>): Promise<void> {
    chain = chain.then(() => (heldKeys.has(sessionKey) ? task(sessionKey) : undefined)).catch(warn);
    return chain;
  }

  return {
    hold: (sessionKeys) => {
      heldKeys = new Set(sessionKeys);
      for (const sessionKey of listings.keys()) {
        if (!heldKeys.has(sessionKey)) listings.delete(sessionKey);
      }
      for (const [sessionKey, handle] of clocks) {
        if (heldKeys.has(sessionKey)) continue;
        clearIntervalImpl(handle);
        clocks.delete(sessionKey);
      }
      if (stopped) return;
      for (const sessionKey of heldKeys) {
        if (clocks.has(sessionKey)) continue;
        clocks.set(
          sessionKey,
          setIntervalImpl(() => void enqueue(sessionKey, listOnce), intervalMs),
        );
      }
    },
    keyArrived: (sessionKey) => enqueue(sessionKey, arrive),
    readAccount: (sessionKey) => enqueue(sessionKey, accountOnce),
    listAll: async () => {
      for (const sessionKey of heldKeys) await enqueue(sessionKey, listOnce);
    },
    stop: () => {
      stopped = true;
      for (const handle of clocks.values()) clearIntervalImpl(handle);
      clocks.clear();
    },
  };
}
