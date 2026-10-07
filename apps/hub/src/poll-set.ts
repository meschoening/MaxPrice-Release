import type { ListOrgsResult, UsagePoller } from "@maxprice/usage-core";
import type { OrganizationRoster } from "./organization-roster";

// What the Hub polls (#283, #284, ADR-0104): every Organization its key lists.
// The Hub has no Home and no tracked set, so the poll set is the listing's and
// the poller observes each one's Limits answer (a forbidden Organization is
// kept and re-probed hourly by the poller). The last successful listing is
// persisted (organization-roster.json): boot installs it at once and lists in
// the background, so a Hub whose discovery fails at boot still polls. A
// credential arrival — boot, console POST, a client's heal — lists again, and
// so does one timer: each minute while nothing is polled, hourly otherwise
// (#264 item 8's re-probe cadence). A listing that refuses the key expires the
// credential exactly as a 401 on a read would. A listing that names nothing is
// treated exactly as a transient failure: it changes no roster row, installs
// nothing, and the persisted set keeps being polled. Either raises
// `discoveryFailed`, which the Hub's status reads as `error` while nothing
// answers (#267 item 2). The flag belongs to the key that failed: a new key
// starts with it lowered, pending its own first answer, while the retry timer
// and a same-key refresh keep it raised.
// A generation fences every await: a refresh, clear or stop that supersedes an
// in-flight listing makes its late answer a no-op — no roster write, no set.
//
// INVARIANT: `expireCredential()` names no key — it expires whatever the poller
// holds when the refusal lands. That is correct only because every Hub
// `poller.setCredential` is paired synchronously (no await between) with
// `boot`, `refresh` or `clear` — the boot seed and a keying POST
// /api/credential call it after the key, a clearing one before — whose
// generation bump fences the listing that belonged to the previous key. A new
// credential path must keep that pair.
export type HubPollSetOptions = {
  list: (sessionKey: string) => Promise<ListOrgsResult>;
  poller: Pick<UsagePoller, "setOrganizations" | "expireCredential">;
  roster: Pick<OrganizationRoster, "ids" | "replace">;
  onDiscoveryFailed?: (failed: boolean) => void;
  retryMs?: number;
  rediscoverMs?: number;
  setTimeoutImpl?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (handle: ReturnType<typeof setTimeout>) => void;
};

export type HubPollSet = {
  boot: (sessionKey: string) => Promise<void>;
  refresh: (sessionKey: string) => Promise<void>;
  clear: () => void;
  stop: () => void;
  discoveryFailed: () => boolean;
};

export function createHubPollSet(opts: HubPollSetOptions): HubPollSet {
  const retryMs = opts.retryMs ?? 60_000;
  const rediscoverMs = opts.rediscoverMs ?? 60 * 60_000;
  const setTimer = opts.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = opts.clearTimeoutImpl ?? ((handle) => clearTimeout(handle));
  let generation = 0;
  let stopped = false;
  let next: ReturnType<typeof setTimeout> | null = null;
  let installed: readonly string[] = [];
  let failed = false;
  // The key whose discovery `failed` describes.
  let keyed: string | null = null;

  function cancelNext(): void {
    if (next !== null) clearTimer(next);
    next = null;
  }
  function setFailed(value: boolean): void {
    if (failed === value) return;
    failed = value;
    opts.onDiscoveryFailed?.(value);
  }
  function install(ids: readonly string[]): void {
    installed = ids;
    opts.poller.setOrganizations(ids, null);
  }

  async function refresh(sessionKey: string): Promise<void> {
    if (stopped) return;
    // A new key has not been asked yet: it starts pending, not failed. The
    // timer and a same-key refresh keep the flag — that key's discovery did
    // fail.
    if (sessionKey !== keyed) {
      keyed = sessionKey;
      setFailed(false);
    }
    const mine = ++generation;
    cancelNext();
    let result: ListOrgsResult;
    try {
      result = await opts.list(sessionKey);
    } catch {
      result = { ok: false, kind: "error" };
    }
    if (mine !== generation || stopped) return;
    if (result.ok && result.orgs.length > 0) {
      try {
        opts.roster.replace(result.orgs);
      } catch (err) {
        console.warn("[hub] organization roster write failed:", err);
      }
      setFailed(false);
      install(result.orgs.map((o) => o.id));
    } else if (!result.ok && result.kind === "expired") {
      setFailed(false);
      opts.poller.expireCredential();
      return;
    } else {
      // A transient failure, or a listing that named nothing.
      setFailed(true);
    }
    next = setTimer(
      () => {
        next = null;
        void refresh(sessionKey);
      },
      installed.length === 0 ? retryMs : rediscoverMs,
    );
  }

  return {
    boot: (sessionKey) => {
      if (stopped) return Promise.resolve();
      install(opts.roster.ids());
      return refresh(sessionKey);
    },
    refresh,
    clear: () => {
      generation += 1;
      cancelNext();
      keyed = null;
      // The flag first: the empty install publishes, and a still-raised flag
      // would read that frame as `error`.
      setFailed(false);
      install([]);
    },
    stop: () => {
      stopped = true;
      generation += 1;
      cancelNext();
    },
    discoveryFailed: () => failed,
  };
}
