import {
  ACCOUNT_CREDENTIAL_KIND,
  byCodeUnit,
  emailHash,
  legacyReplacedBy,
  type HubAccount,
  type HubStatus,
} from "@maxprice/shared";
import {
  LEGACY_KEY,
  type FetchAccountResult,
  type PollerKey,
  type SampleStore,
  type UsagePoller,
} from "@maxprice/usage-core";
import type { HubFanout } from "./fanout";
import { hubAccounts, hubUsageConnection } from "./hub-accounts";
import {
  EMPTY_KEY_LISTING,
  type HubKeyListing,
  type HubKeyStore,
  type HubLegacyKey,
} from "./key-store";
import type { OrganizationRoster } from "./organization-roster";
import type { HubPollSet } from "./poll-set";

// The Hub's keys at run time (ADR-0138 §9, §12; ADR-0139 §1–§5): the one
// place that changes them, so the store, the poller, the poll set and the
// status's `accounts` move together. The daemon is its store's only writer
// while it runs, so the listing is read once, at boot, and kept here.
//
// Every key change is persist-first: a store write that fails throws before
// the poller is armed or the status names the key, so the route answers 500
// and nothing runs on a key that did not persist. Memory follows the store
// write by write: a paste whose key is stored but whose legacy key's delete
// then fails keeps both, as the store does, and still succeeds.
//
// The Hub never keeps an email (ADR-0138 §9): `/api/account` answers one,
// and this module reads its `accountUuid` at once and its email only as the
// email's hash (`emailHash`), dropping the address in the same step. The
// hashes live in memory only, never persisted and never sent: they resolve a
// Gateway record's credential to the Account whose key the Hub holds
// (ADR-0141 §5, `accountForEmailHash`).

export type AddKeyResult =
  | { ok: true; accountUuid: string }
  // `expired`: `/api/account` refused the key. `error`: claude.ai did not
  // answer. Neither stores anything.
  | { ok: false; kind: "expired" | "error" };

export type HubKeys = {
  // The boot's step (runReadySequence): read the store, stamp a pre-#283
  // legacy entry's history (ADR-0104), arm the poller and the poll set with
  // every key, and start the legacy key's move in the background.
  boot: () => Promise<void>;
  // POST /api/credentials.
  add: (sessionKey: string, source: string) => Promise<AddKeyResult>;
  // DELETE /api/credentials/:accountUuid; false when the Hub holds no key
  // for that Account.
  remove: (accountUuid: string) => Promise<boolean>;
  // DELETE /api/credentials/legacy; false when there is no legacy key.
  removeLegacy: () => Promise<boolean>;
  // Re-derives the status's `accounts` and patches it when it changed: on
  // every poller publish, discovery change, tag growth, published Home change
  // and Label directory change.
  publish: () => void;
  // The poller's status hook: publishes, and retries the move after a
  // successful read of the legacy key.
  pollerPublished: () => void;
  // The move in flight, or settled (tests).
  settled: () => Promise<void>;
  // ADR-0141 §5: the Account uuid whose held key's `/api/account` named the
  // email with this hash, or undefined. Learned from every `/api/account`
  // answer this module already reads (a paste, a heal, the legacy move) and
  // from `resolveEmailHashes`; forgotten when the key is removed.
  accountForEmailHash: (hash: string) => string | undefined;
  // Reads `/api/account` for each held Account key whose email hash is not
  // yet known, at most once per EMAIL_RETRY_MS per key, so a key whose read
  // fails is not asked again on every call. Only the Gateway drainer calls
  // it, so a Hub holding no Gateway makes no extra claude.ai call.
  resolveEmailHashes: () => Promise<void>;
};

// The least time between two `/api/account` reads of one key for its email
// hash (`resolveEmailHashes`): the Gateway drainer's credential refresh.
export const EMAIL_RETRY_MS = 5 * 60_000;

export type HubKeysOptions = {
  store: HubKeyStore;
  poller: Pick<UsagePoller, "setKeys" | "rekey" | "keyConnection" | "memberships" | "pollOnce">;
  pollSet: Pick<HubPollSet, "setKeys" | "rekey" | "discoveryFailed">;
  roster: Pick<OrganizationRoster, "listing" | "remember">;
  sampleStore: Pick<SampleStore, "stampUnstamped" | "stampAccountless">;
  // The move's Account stamp gave held samples their Account: the Hub's
  // `samplesStampedAt` moves (ADR-0139 §8, sample-stamps.ts).
  samplesStamped: () => void;
  fanout: Pick<HubFanout, "getStatus" | "patchStatus">;
  fetchAccount: (sessionKey: string) => Promise<FetchAccountResult>;
  // The archive's Account tags (the Hub store's `accountTags`), or none.
  tags?: () => ReadonlyMap<string, ReadonlySet<string>>;
  // The Accounts the published Homes and the Label directory name
  // (`fleetAccountNames`), or none.
  named?: () => ReadonlyMap<string, ReadonlySet<string>>;
  now?: () => number;
  // The least time between two move attempts after reads (the poller's
  // interval).
  retryMs?: number;
};

const NO_TAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map();

export function createHubKeys(opts: HubKeysOptions): HubKeys {
  const now = opts.now ?? Date.now;
  const retryMs = opts.retryMs ?? 60_000;
  let keys: HubKeyListing = EMPTY_KEY_LISTING;
  // The legacy key's Account once `/api/account` answered and the move has
  // not landed (its store write failed): what a paste for that Account reads.
  let legacyAccount: string | null = null;
  let moving: Promise<void> | null = null;
  let attemptedAt: number | null = null;
  // The legacy key's newest read as it stood when the last attempt began. A
  // read is newer than the attempt when it differs from this one, not when its
  // time is larger: a read can land in the attempt's own millisecond.
  let readAtAttempt: string | null = null;
  let published: string | null = null;
  // ADR-0141 §5: each held Account key's email hash (uuid → hash), and when
  // `resolveEmailHashes` last asked for one it lacks. Memory only.
  const emailHashes = new Map<string, string>();
  const emailAskedAt = new Map<string, number>();
  function learnEmail(uuid: string, email: string | null): void {
    // The address is hashed and dropped here; only the hash is kept.
    if (email === null || email.trim() === "") emailHashes.delete(uuid);
    else emailHashes.set(uuid, emailHash(email));
  }

  const iso = (): string => new Date(now()).toISOString();

  function pollerKeys(): PollerKey[] {
    return [
      ...(keys.legacy === null
        ? []
        : [{ account: LEGACY_KEY, sessionKey: keys.legacy.sessionKey }]),
      ...keys.accounts.map((k) => ({ account: k.accountUuid, sessionKey: k.sessionKey })),
    ];
  }
  // The poller and the poll set get the whole keyset together (poll-set.ts's
  // invariant); resolves once the new keys' listings have landed.
  function arm(relist: readonly string[] = []): Promise<void> {
    const held = pollerKeys();
    opts.poller.setKeys(held);
    return opts.pollSet.setKeys(held, relist);
  }

  function accountsNow(): HubAccount[] {
    return hubAccounts({
      keys,
      connection: (account) =>
        hubUsageConnection(
          opts.poller.keyConnection(account),
          opts.pollSet.discoveryFailed(account),
        ),
      memberships: opts.poller.memberships(),
      listing: (account) => opts.roster.listing(account),
      tags: tagsNow(),
      named: opts.named?.(),
    });
  }
  // The archive's tags, or none when it cannot answer (it failed to load:
  // the event surface is down, and the key status must not go with it, F20).
  function tagsNow(): ReadonlyMap<string, ReadonlySet<string>> {
    try {
      return opts.tags?.() ?? NO_TAGS;
    } catch {
      return NO_TAGS;
    }
  }
  function publish(): void {
    const accounts = accountsNow();
    const text = JSON.stringify(accounts);
    if (text === published) return;
    published = text;
    opts.fanout.patchStatus({ accounts } satisfies Partial<HubStatus>);
  }

  // ADR-0138 §12: the legacy key's Account, then its entry. Nothing moves
  // while `/api/account` refuses the key (it stays, and polls) or claude.ai
  // does not answer; the next boot, or the next successful read, tries again.
  async function move(): Promise<void> {
    const legacy = keys.legacy;
    if (legacy === null) return;
    attemptedAt = now();
    readAtAttempt = newestLegacyRead();
    let answer: FetchAccountResult;
    try {
      answer = await opts.fetchAccount(legacy.sessionKey);
    } catch {
      return;
    }
    // The email leaves this answer only as its hash (ADR-0141 §5).
    if (!answer.ok || keys.legacy !== legacy) return;
    const uuid = answer.accountUuid;
    learnEmail(uuid, answer.email);
    legacyAccount = uuid;
    if (removedSince(uuid, legacy.setAt)) {
      await dropRemoved(legacy, uuid);
      return;
    }
    const held = keys.accounts.some((k) => k.accountUuid === uuid);
    // Provenance kept: the legacy entry's own, where its store kept one.
    const entry = {
      sessionKey: legacy.sessionKey,
      kind: ACCOUNT_CREDENTIAL_KIND,
      setAt: legacy.setAt ?? iso(),
      source: legacy.source ?? "local",
    } as const;
    try {
      await opts.store.moveLegacy(uuid, entry);
    } catch (err) {
      console.warn("[hub] session key move failed; it stays the legacy key:", err);
      return;
    }
    if (keys.legacy !== legacy) return;
    legacyAccount = null;
    keys = {
      accounts: held
        ? keys.accounts
        : [...keys.accounts, { accountUuid: uuid, ...entry }].sort((a, b) =>
            byCodeUnit(a.accountUuid, b.accountUuid),
          ),
      legacy: null,
      removed: Object.fromEntries(Object.entries(keys.removed).filter(([k]) => k !== uuid)),
    };
    if (held) {
      // The Account kept its own key: the legacy one simply goes.
      void arm();
    } else {
      // Neither re-armed nor re-read: the key, its listing and its readings
      // move to the Account.
      opts.poller.rekey(LEGACY_KEY, uuid);
      opts.pollSet.rekey(LEGACY_KEY, uuid);
    }
    await stampAccountless(uuid);
    publish();
  }
  // ADR-0139 §5: the Hub keeps an Account's removal time until a new key for
  // it arrives, and a key set no later than the removal (or with no setAt, as
  // a v6 keychain entry) is not one. Such a legacy key is the removed key
  // itself, or older: moving it would bring back what the user removed.
  function removedSince(uuid: string, setAt: string | null): boolean {
    const removedAt = keys.removed[uuid];
    if (removedAt === undefined) return false;
    return setAt === null || Date.parse(setAt) <= Date.parse(removedAt);
  }
  // The move's other end for such a key: the legacy key is deleted, the
  // removal kept, and the Account stays removed. Its history is still that
  // Account's, so its Account-less samples are stamped all the same.
  async function dropRemoved(legacy: HubLegacyKey, uuid: string): Promise<void> {
    try {
      await opts.store.removeLegacy();
    } catch (err) {
      console.warn("[hub] removed Account's legacy session key could not be deleted:", err);
      return;
    }
    if (keys.legacy !== legacy) return;
    legacyAccount = null;
    keys = { ...keys, legacy: null };
    void arm();
    await stampAccountless(uuid);
    publish();
  }
  async function stampAccountless(uuid: string): Promise<void> {
    try {
      if ((await opts.sampleStore.stampAccountless(uuid)) > 0) opts.samplesStamped();
    } catch (err) {
      console.warn("[hub] usage-history Account stamp failed:", err);
    }
  }
  function startMove(): void {
    if (moving !== null || keys.legacy === null) return;
    moving = move().finally(() => {
      moving = null;
      // A successful read that published while this attempt was in flight
      // was turned away (`retryAfterRead` waits for `moving`); ask again now,
      // or the retry would wait for the next read, a poll interval later.
      retryAfterRead();
    });
  }
  // ADR-0138 §12: "retried … after each successful read" while a legacy key
  // is held: once a read newer than the last attempt has landed, at most once
  // per `retryMs`.
  function retryAfterRead(): void {
    if (keys.legacy === null || keys.legacy.orgId !== undefined || moving !== null) return;
    const newest = newestLegacyRead();
    if (newest === null) return;
    if (attemptedAt !== null && (newest === readAtAttempt || now() - attemptedAt < retryMs)) return;
    startMove();
  }
  // The legacy key's newest successful read across its Memberships, as the
  // poller stamped it (ISO, so string order is time order), or null.
  function newestLegacyRead(): string | null {
    let newest: string | null = null;
    for (const m of opts.poller.memberships()) {
      if (m.account !== LEGACY_KEY || m.lastReadAt === null) continue;
      if (newest === null || m.lastReadAt > newest) newest = m.lastReadAt;
    }
    return newest;
  }

  return {
    async boot() {
      keys = await opts.store.list();
      const orgId = keys.legacy?.orgId;
      if (orgId !== undefined) {
        // A pre-#283 entry: its orgId is what this Hub polled with. It stamps
        // the legacy lines (#279) and enters the legacy key's listing (#284)
        // before the key is armed, so boot polls it even if the listing fails
        // — whatever the stamp's outcome; only when both landed may the entry
        // lose that evidence. Each in its own try (F20).
        let stamped = false;
        try {
          await opts.sampleStore.stampUnstamped(orgId);
          stamped = true;
        } catch (err) {
          console.warn("[hub] usage-history stamp failed:", err);
        }
        let remembered = false;
        try {
          opts.roster.remember(LEGACY_KEY, orgId);
          remembered = true;
        } catch (err) {
          console.warn("[hub] organization roster write failed:", err);
        }
        if (stamped && remembered) {
          try {
            await opts.store.dropLegacyOrgId();
            const { sessionKey, setAt, source } = keys.legacy!;
            keys = { ...keys, legacy: { sessionKey, setAt, source } };
          } catch (err) {
            console.warn("[hub] credstore rewrite failed:", err);
          }
        }
      }
      // Not awaited: neither `ready` nor poller.start() waits on the network.
      void arm();
      publish();
      // The move waits for the stamp evidence: an orgId not yet dropped
      // keeps the legacy entry where the next boot finds it.
      if (keys.legacy?.orgId === undefined) startMove();
    },
    async add(sessionKey, source) {
      let answer: FetchAccountResult;
      try {
        answer = await opts.fetchAccount(sessionKey);
      } catch {
        answer = { ok: false, kind: "error" };
      }
      if (!answer.ok) return { ok: false, kind: answer.kind };
      // The email leaves this answer only as its hash (ADR-0141 §5).
      const uuid = answer.accountUuid;
      learnEmail(uuid, answer.email);
      const entry = { sessionKey, kind: ACCOUNT_CREDENTIAL_KIND, setAt: iso(), source } as const;
      await opts.store.set(uuid, entry);
      const legacy = keys.legacy;
      // The legacy key goes when this paste replaces it (ADR-0138 §12's
      // "the next paste replaces it", the clients' `legacyReplacedBy`): its
      // Account resolved to this one, it is this very key, or it is expired
      // and its Account was never learned.
      let replaces =
        legacy !== null &&
        (legacy.sessionKey === sessionKey ||
          legacyReplacedBy(
            {
              keys: [],
              legacy: {
                accountUuid: legacyAccount,
                connection: opts.poller.keyConnection(LEGACY_KEY),
              },
            },
            uuid,
          ));
      if (replaces) {
        // The Account's key is stored: memory follows it whatever comes next.
        // A legacy key that cannot be deleted is still on disk, so it stays
        // in memory too, polled and listed, and the paste still succeeds.
        try {
          await opts.store.removeLegacy();
        } catch (err) {
          console.warn("[hub] legacy session key could not be deleted; it stays:", err);
          replaces = false;
        }
      }
      keys = {
        accounts: [
          ...keys.accounts.filter((k) => k.accountUuid !== uuid),
          { accountUuid: uuid, ...entry },
        ].sort((a, b) => byCodeUnit(a.accountUuid, b.accountUuid)),
        legacy: replaces ? null : keys.legacy,
        removed: Object.fromEntries(Object.entries(keys.removed).filter(([k]) => k !== uuid)),
      };
      // A replaced legacy key whose Account this paste establishes (the same
      // key, or one already resolved to it) completes ADR-0139 §8's move: its
      // history is stamped as the move would have stamped it, so a heal that
      // lands before the boot move cannot leave it Account-less for good. An
      // expired legacy key whose Account was never learned names none.
      const stampAs =
        replaces && legacy !== null && (legacy.sessionKey === sessionKey || legacyAccount === uuid)
          ? uuid
          : null;
      if (replaces) legacyAccount = null;
      // Every push re-lists what its key can see (#283), a key healed back
      // unchanged included.
      const listed = arm([uuid]);
      // After `arm`, as the move stamps after its own: the poller no longer
      // holds the legacy key, so a read of it still in flight is fenced and
      // cannot append an Account-less sample behind the stamp.
      if (stampAs !== null) await stampAccountless(stampAs);
      publish();
      // A changed set is polled as the listing installs it; the explicit poll
      // then covers an unchanged one (a new key for the same Organizations)
      // and coalesces with the former.
      await listed;
      await opts.poller.pollOnce();
      return { ok: true, accountUuid: uuid };
    },
    async remove(accountUuid) {
      if (!keys.accounts.some((k) => k.accountUuid === accountUuid)) return false;
      const removedAt = iso();
      await opts.store.remove(accountUuid, removedAt);
      keys = {
        ...keys,
        accounts: keys.accounts.filter((k) => k.accountUuid !== accountUuid),
        removed: { ...keys.removed, [accountUuid]: removedAt },
      };
      emailHashes.delete(accountUuid);
      emailAskedAt.delete(accountUuid);
      void arm();
      publish();
      return true;
    },
    async removeLegacy() {
      if (keys.legacy === null) return false;
      await opts.store.removeLegacy();
      keys = { ...keys, legacy: null };
      legacyAccount = null;
      void arm();
      publish();
      return true;
    },
    publish,
    pollerPublished: () => {
      publish();
      retryAfterRead();
    },
    settled: () => moving ?? Promise.resolve(),
    accountForEmailHash: (hash) => {
      for (const [uuid, held] of emailHashes) {
        if (held === hash && keys.accounts.some((k) => k.accountUuid === uuid)) return uuid;
      }
      return undefined;
    },
    async resolveEmailHashes() {
      const at = now();
      const asks = keys.accounts.filter((k) => {
        if (emailHashes.has(k.accountUuid)) return false;
        const asked = emailAskedAt.get(k.accountUuid);
        return asked === undefined || at - asked >= EMAIL_RETRY_MS;
      });
      await Promise.all(
        asks.map(async ({ accountUuid, sessionKey }) => {
          emailAskedAt.set(accountUuid, at);
          let answer: FetchAccountResult;
          try {
            answer = await opts.fetchAccount(sessionKey);
          } catch {
            return;
          }
          // A key that now names another Account, or one replaced or removed
          // meanwhile, teaches nothing.
          if (!answer.ok || answer.accountUuid !== accountUuid) return;
          if (
            !keys.accounts.some((k) => k.accountUuid === accountUuid && k.sessionKey === sessionKey)
          )
            return;
          learnEmail(accountUuid, answer.email);
        }),
      );
    },
  };
}
