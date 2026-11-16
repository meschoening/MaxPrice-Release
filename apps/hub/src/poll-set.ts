import type { ListOrgsResult, PollerKey, UsagePoller } from "@maxprice/usage-core";
import type { OrganizationRoster } from "./organization-roster";

// What the Hub polls (#283, #284, ADR-0104, ADR-0139 §4): every Organization
// any of its keys lists. The Hub has no Home and no tracked set, so the poll
// set is the union of the listings, each key reads the Organizations its own
// listing names (`poller.setListing`), and the poller observes each
// Membership's Limits answer (a forbidden one is kept and re-probed hourly).
// Each key's last successful listing is persisted (organization-roster.json):
// boot installs them at once and lists in the background, so a Hub whose
// discovery fails at boot still polls.
//
// Each key lists on its own clock: when it arrives (boot, a console POST, a
// client's heal, a replaced key), then each minute while its own listing
// names nothing, hourly otherwise (#264 item 8's re-probe cadence). A listing
// that refuses the key expires that key alone (`poller.expireKey(account)`),
// exactly as a 401 on its read would, and schedules nothing more for it. A
// listing that names nothing is treated exactly as a transient failure: it
// changes no roster row, installs nothing, and the persisted listing keeps
// being polled. Either raises that key's `discoveryFailed`, which the Hub's
// status reads as `error` while that key has no answer (hub-accounts.ts). The
// flag belongs to the key that failed: a new or replaced key starts with it
// lowered, pending its own first answer.
//
// A generation per key fences every await: a replacement, a removal, a move
// or stop that supersedes a key's in-flight listing makes its late answer a
// no-op — no roster write, no set, no expiry.
//
// INVARIANT: every Hub `poller.setKeys` is followed synchronously (no await
// between) by `setKeys` here, since the poller's push drops the listing of a
// key it does not keep and re-arms the ones it does; this reinstalls every
// held key's listing and the union over them.
export type HubPollSetOptions = {
  list: (sessionKey: string) => Promise<ListOrgsResult>;
  poller: Pick<UsagePoller, "setOrganizations" | "setListing" | "expireKey">;
  roster: Pick<OrganizationRoster, "ids" | "listing" | "replace" | "forget" | "move">;
  // A key's discovery flag changed: the status reads it.
  onDiscoveryChange?: () => void;
  now?: () => number;
  retryMs?: number;
  rediscoverMs?: number;
  setTimeoutImpl?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (handle: ReturnType<typeof setTimeout>) => void;
};

export type HubPollSet = {
  // The held keyset, as the poller was just given it. A key new to the set,
  // or whose session key changed, lists now; a key that left loses its
  // timer, its in-flight listing and its roster listing. Every held key's
  // persisted listing and the union over them are installed synchronously.
  // `relist` names held keys that list again even though unchanged: every
  // push re-lists what its key can see (#283), the same key healed back
  // included. Resolves once the new and relisted keys' listings have landed.
  setKeys: (keys: readonly PollerKey[], relist?: readonly string[]) => Promise<void>;
  // ADR-0138 §12's move, after `poller.rekey(from, to)`: the key's clock,
  // flag and roster listing follow it.
  rekey: (from: string, to: string) => void;
  stop: () => void;
  discoveryFailed: (account: string) => boolean;
};

type KeyClock = {
  // The Account key it lists for; a move changes it in place, so a listing
  // in flight lands under the new one.
  account: string;
  sessionKey: string;
  generation: number;
  failed: boolean;
  next: ReturnType<typeof setTimeout> | null;
};

export function createHubPollSet(opts: HubPollSetOptions): HubPollSet {
  const retryMs = opts.retryMs ?? 60_000;
  const rediscoverMs = opts.rediscoverMs ?? 60 * 60_000;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = opts.clearTimeoutImpl ?? ((handle) => clearTimeout(handle));
  const clocks = new Map<string, KeyClock>();
  let stopped = false;

  function cancel(clock: KeyClock): void {
    if (clock.next !== null) clearTimer(clock.next);
    clock.next = null;
  }
  function setFailed(clock: KeyClock, value: boolean): void {
    if (clock.failed === value) return;
    clock.failed = value;
    opts.onDiscoveryChange?.();
  }
  // Every held key's persisted listing to the poller, then the union.
  function install(): void {
    const union = new Set<string>();
    for (const account of [...clocks.keys()].sort()) {
      const ids = opts.roster.listing(account);
      opts.poller.setListing(account, ids);
      for (const id of ids ?? []) union.add(id);
    }
    opts.poller.setOrganizations([...union].sort(), null);
  }

  async function refresh(clock: KeyClock): Promise<void> {
    if (stopped || clocks.get(clock.account) !== clock) return;
    const mine = ++clock.generation;
    cancel(clock);
    let result: ListOrgsResult;
    try {
      result = await opts.list(clock.sessionKey);
    } catch {
      result = { ok: false, kind: "error" };
    }
    const account = clock.account;
    if (stopped || clocks.get(account) !== clock || clock.generation !== mine) return;
    if (result.ok && result.orgs.length > 0) {
      try {
        opts.roster.replace(account, result.orgs, new Date(now()).toISOString());
      } catch (err) {
        console.warn("[hub] organization roster write failed:", err);
      }
      setFailed(clock, false);
      install();
    } else if (!result.ok && result.kind === "expired") {
      setFailed(clock, false);
      opts.poller.expireKey(account);
      return;
    } else {
      // A transient failure, or a listing that named nothing.
      setFailed(clock, true);
    }
    const listed = opts.roster.listing(account) ?? [];
    clock.next = setTimer(
      () => {
        clock.next = null;
        void refresh(clock);
      },
      listed.length === 0 ? retryMs : rediscoverMs,
    );
  }

  return {
    setKeys: (keys, relist = []) => {
      if (stopped) return Promise.resolve();
      const given = new Map(keys.map((k) => [k.account, k.sessionKey]));
      for (const [account, clock] of [...clocks]) {
        if (given.get(account) === clock.sessionKey) continue;
        cancel(clock);
        clock.generation += 1;
        clocks.delete(account);
        if (!given.has(account)) {
          try {
            opts.roster.forget(account);
          } catch (err) {
            console.warn("[hub] organization roster write failed:", err);
          }
        }
        if (clock.failed) opts.onDiscoveryChange?.();
      }
      const fresh: KeyClock[] = [];
      for (const [account, sessionKey] of given) {
        const held = clocks.get(account);
        if (held !== undefined) {
          if (relist.includes(account)) fresh.push(held);
          continue;
        }
        const clock: KeyClock = { account, sessionKey, generation: 0, failed: false, next: null };
        clocks.set(account, clock);
        fresh.push(clock);
      }
      install();
      return Promise.all(fresh.map(refresh)).then(() => {});
    },
    rekey: (from, to) => {
      const clock = clocks.get(from);
      if (clock === undefined || clocks.has(to)) return;
      clocks.delete(from);
      clock.account = to;
      clocks.set(to, clock);
      try {
        opts.roster.move(from, to);
      } catch (err) {
        console.warn("[hub] organization roster write failed:", err);
      }
      install();
    },
    stop: () => {
      stopped = true;
      for (const clock of clocks.values()) {
        cancel(clock);
        clock.generation += 1;
      }
    },
    discoveryFailed: (account) => clocks.get(account)?.failed ?? false,
  };
}
