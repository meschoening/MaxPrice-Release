import type { UsageConnection, UsageKeyset, UsageKeysResponse } from "@maxprice/shared";
import {
  LEGACY_KEY,
  type FetchAccountResult,
  type HubHealKey,
  type PollerKey,
  type UsagePoller,
} from "@maxprice/usage-core";
import { emailHash } from "@maxprice/shared";

// The keyset the sidecar holds (#633, ADR-0138 §6, §12), in memory only: what
// the host last pushed through POST /api/usage/credential, each key under the
// Account key the poller holds it by. A pushed `keys` entry is held under its
// account uuid. The pushed legacy key is held under LEGACY_KEY until its
// `/api/account` answers, then under that Account (`readAccount`): the
// poller re-keys it, every Account-less sample is stamped with it once
// (ADR-0139 §8), and GET /api/usage/keys reports the move for the host, which
// writes the Account's entry and deletes the legacy one (Tasks 4 and 5 of the
// #633 plan). While the legacy key is expired or the network is down nothing
// resolves, and it stays the one key, polled under LEGACY_KEY as before.
//
// Also the one reading of which Accounts this machine holds a key for, and
// what each key's listing named (`heldAccounts`): the held keys' roster
// (`sampleAccount`'s, for unstamped readings), ADR-0136 §8's key step, GET /api/accounts' connection and Membership
// state, and auto-heal (`localKeys`) read it. Only resolved Accounts count: the
// legacy key before its Account answers names none.
//
// Never logs, stores or reports a key or an address: an `/api/account`
// answer's address is hashed into the pair table (ADR-0137 §1) and dropped.

export type HeldAccount = {
  accountUuid: string;
  sessionKey: string;
  // The Organizations the key's last listing named; null before any.
  listing: readonly string[] | null;
};

// The roster from the held keys (#633): each Organization a held key's
// listing names, with every resolved Account whose key names it. It answers
// an unstamped usage-limits reading's Account (`sampleAccount`, ADR-0139 §8);
// since #635 it names no usage row's (ADR-0137 §3's current rule).
// A held key counts whatever its connection: an expired key's listing still
// says which Memberships its Account holds.
export function keyRoster(
  held: readonly Pick<HeldAccount, "accountUuid" | "listing">[],
): Map<string, Set<string>> {
  const roster = new Map<string, Set<string>>();
  for (const key of held) {
    for (const organization of key.listing ?? []) {
      let holders = roster.get(organization);
      if (holders === undefined) roster.set(organization, (holders = new Set()));
      holders.add(key.accountUuid);
    }
  }
  return roster;
}

export type UsageKeysetHolder = {
  // Replaces the keyset (`null`: none). Answers every held session key, for
  // the key listing's clocks, and the arrivals among them: each key this push
  // holds that the one before it did not (new, or a changed key for an
  // Account), which alone are listed and read. A re-pushed key is no arrival:
  // the poller re-arms it, so a dead key is still retried, but connecting
  // Account B re-lists nothing of Account A's.
  apply: (keyset: UsageKeyset | null) => { held: string[]; arrived: string[] };
  // One `/api/account` read with a key (the listing's, Connect's discovery's,
  // the legacy retry's): an answer's pair is learned, and a held legacy key's
  // Account resolved. Never rejects.
  readAccount: (sessionKey: string) => Promise<FetchAccountResult>;
  // A held key's listing named these Organizations.
  listed: (sessionKey: string, organizations: readonly string[]) => void;
  report: () => UsageKeysResponse;
  heldAccounts: () => HeldAccount[];
  // Every held key as auto-heal reads it (ADR-0138 §7): its Account, the
  // legacy key's once resolved (null until then), and when it was set (the
  // host's `setAt`; null for the legacy key, whose entry records none).
  localKeys: () => HubHealKey[];
  // After each poller status publish: announces a moved report, and retries an
  // unresolved legacy key's Account after a successful read, at most once per
  // poll pass. Coalesced in a microtask.
  pollerPublished: () => void;
  // Settles once a resolution's stamp and announcement have (tests).
  settled: () => Promise<void>;
};

export function createUsageKeyset(opts: {
  poller: Pick<
    UsagePoller,
    | "setKeys"
    | "rekey"
    | "setListing"
    | "keyConnection"
    | "memberships"
    | "staleOrganizations"
    | "expiredReaderOrganizations"
  >;
  fetchAccount: (sessionKey: string) => Promise<FetchAccountResult>;
  learnPair: (emailHash: string, accountUuid: string) => void;
  stampAccountless: (accountUuid: string) => Promise<number>;
  // usage-keys:changed: the report moved.
  keysChanged: () => void;
  // A held Account or a held Account's listing moved, or the poller's stale
  // or expired-reader Organizations did (ADR-0138 §8: GET /api/accounts carries them, and a
  // listing move or an answer can move them with no report change).
  accountsChanged: () => void;
  // One `/api/account` read with the legacy key, queued behind the key
  // listing (its `readAccount`), which calls back into `readAccount` here.
  retryLegacy: (sessionKey: string) => void;
  // The poll interval: two retries are at least this far apart in read time.
  intervalMs?: number;
  now?: () => number;
}): UsageKeysetHolder {
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? 60_000;
  let keys: ReadonlyArray<{ accountUuid: string; sessionKey: string; setAt: string }> = [];
  let legacy: { sessionKey: string } | null = null;
  // The legacy key's Account once its `/api/account` answered, for that key.
  let legacyAccount: string | null = null;
  // What the report says of it: set once the stamp has settled, so a host
  // never moves the key before its samples carry the Account.
  let legacyAnnounced: string | null = null;
  const listings = new Map<string, readonly string[]>();
  let resolution: Promise<void> = Promise.resolve();
  // The legacy key's Account reads: how many are in flight, when the last one
  // failed (epoch ms; null while none has), and the newest successful poll
  // read the last retry followed. A retry follows only a successful poll read
  // newer than the last failure, with none in flight, at most once a pass: so
  // a boot whose arrival read answers makes no second read.
  let legacyReads = 0;
  let legacyFailedAt: number | null = null;
  let retriedAfter: number | null = null;
  let lastReport = "";
  let lastAccounts = "";
  let publishQueued = false;

  // The Account key each held session key is polled under. A `keys` entry
  // wins its Account over a legacy key resolved to the same Account.
  function pollerKeys(): PollerKey[] {
    const out: PollerKey[] = keys.map((k) => ({
      account: k.accountUuid,
      sessionKey: k.sessionKey,
    }));
    if (legacy !== null) {
      const account = legacyAccount ?? LEGACY_KEY;
      if (!out.some((k) => k.account === account)) {
        out.push({ account, sessionKey: legacy.sessionKey });
      }
    }
    return out;
  }
  function accountOf(sessionKey: string): string | null {
    return pollerKeys().find((k) => k.sessionKey === sessionKey)?.account ?? null;
  }
  function heldAccounts(): HeldAccount[] {
    return pollerKeys()
      .filter((k) => k.account !== LEGACY_KEY)
      .map((k) => ({
        accountUuid: k.account,
        sessionKey: k.sessionKey,
        listing: listings.get(k.sessionKey) ?? null,
      }))
      .sort((a, b) => (a.accountUuid < b.accountUuid ? -1 : a.accountUuid > b.accountUuid ? 1 : 0));
  }
  // The poller's keys and every held listing, as they stand.
  function install(): void {
    opts.poller.setKeys(pollerKeys());
    for (const k of pollerKeys()) {
      const listing = listings.get(k.sessionKey);
      if (listing !== undefined) opts.poller.setListing(k.account, listing);
    }
  }
  function report(): UsageKeysResponse {
    const connection = (account: string): UsageConnection => opts.poller.keyConnection(account);
    return {
      keys: keys.map((k) => ({
        accountUuid: k.accountUuid,
        connection: connection(k.accountUuid),
      })),
      legacy:
        legacy === null
          ? null
          : { accountUuid: legacyAnnounced, connection: connection(legacyAccount ?? LEGACY_KEY) },
    };
  }
  function announce(): void {
    const nextReport = JSON.stringify(report());
    if (nextReport !== lastReport) {
      lastReport = nextReport;
      opts.keysChanged();
    }
    const nextAccounts = JSON.stringify([
      heldAccounts().map((a) => [a.accountUuid, a.listing]),
      opts.poller.staleOrganizations(),
      opts.poller.expiredReaderOrganizations(),
    ]);
    if (nextAccounts !== lastAccounts) {
      lastAccounts = nextAccounts;
      opts.accountsChanged();
    }
  }

  // The legacy key's Account answered: re-key it, its readings kept (a key
  // pushed for that Account already outranks it, and the legacy key leaves
  // the poller), stamp the Account-less history with it once, then report it.
  function resolveLegacy(accountUuid: string): void {
    legacyAccount = accountUuid;
    if (keys.some((k) => k.accountUuid === accountUuid)) install();
    else opts.poller.rekey(LEGACY_KEY, accountUuid);
    resolution = resolution.then(async () => {
      try {
        await opts.stampAccountless(accountUuid);
      } catch (err) {
        // The samples left Account-less resolve at query time (ADR-0139 §8);
        // the move still goes ahead, since the key's Account is known.
        console.error("[sidecar] usage history Account stamp failed:", err);
      }
      if (legacyAccount === accountUuid) legacyAnnounced = accountUuid;
      announce();
    });
  }

  return {
    apply: (next) => {
      const before = new Set(pollerKeys().map((k) => k.sessionKey));
      const nextLegacy = next?.legacy ?? null;
      if (nextLegacy?.sessionKey !== legacy?.sessionKey) {
        legacyAccount = null;
        legacyAnnounced = null;
        legacyFailedAt = null;
        retriedAfter = null;
      }
      keys = (next?.keys ?? []).map((k) => ({
        accountUuid: k.accountUuid,
        sessionKey: k.sessionKey,
        setAt: k.setAt,
      }));
      legacy = nextLegacy === null ? null : { sessionKey: nextLegacy.sessionKey };
      const held = pollerKeys().map((k) => k.sessionKey);
      for (const sessionKey of [...listings.keys()]) {
        if (!held.includes(sessionKey)) listings.delete(sessionKey);
      }
      install();
      announce();
      return { held, arrived: held.filter((sessionKey) => !before.has(sessionKey)) };
    },
    readAccount: async (sessionKey) => {
      const isLegacy = (): boolean => legacy?.sessionKey === sessionKey;
      if (isLegacy()) legacyReads += 1;
      let result: FetchAccountResult;
      try {
        result = await opts.fetchAccount(sessionKey);
      } catch {
        result = { ok: false, kind: "error" };
      } finally {
        if (isLegacy()) legacyReads = Math.max(0, legacyReads - 1);
      }
      if (!result.ok) {
        if (isLegacy()) legacyFailedAt = now();
        return result;
      }
      if (result.email !== null && result.email.trim() !== "") {
        opts.learnPair(emailHash(result.email), result.accountUuid);
      }
      if (isLegacy() && legacyAccount === null) resolveLegacy(result.accountUuid);
      return result;
    },
    listed: (sessionKey, organizations) => {
      const account = accountOf(sessionKey);
      if (account === null) return;
      listings.set(sessionKey, [...organizations].sort());
      opts.poller.setListing(account, organizations);
      announce();
    },
    report,
    heldAccounts,
    localKeys: () => {
      const out: HubHealKey[] = keys.map((k) => ({
        accountUuid: k.accountUuid,
        sessionKey: k.sessionKey,
        setAt: k.setAt,
      }));
      // A pushed key for the legacy key's resolved Account outranks it, as it
      // does in the poller.
      if (legacy !== null && !keys.some((k) => k.accountUuid === legacyAccount)) {
        out.push({ accountUuid: legacyAccount, sessionKey: legacy.sessionKey, setAt: null });
      }
      return out;
    },
    pollerPublished: () => {
      if (publishQueued) return;
      publishQueued = true;
      queueMicrotask(() => {
        publishQueued = false;
        announce();
        if (legacy === null || legacyAccount !== null) return;
        if (legacyReads > 0 || legacyFailedAt === null) return;
        const reads = opts.poller
          .memberships()
          .filter((m) => m.account === LEGACY_KEY && m.lastReadAt !== null)
          .map((m) => Date.parse(m.lastReadAt!));
        if (reads.length === 0) return;
        const newest = Math.max(...reads);
        if (newest <= legacyFailedAt) return;
        if (retriedAfter !== null && newest - retriedAfter < intervalMs) return;
        retriedAfter = newest;
        opts.retryLegacy(legacy.sessionKey);
      });
    },
    settled: () => resolution,
  };
}
