import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCOUNT_CREDENTIAL_KIND,
  ACCOUNT_UUID_PATTERN,
  GATEWAY_ID_PATTERN,
  byCodeUnit,
  isAccountUuid,
  storedUsageCredentialSchema,
} from "@maxprice/shared";
import { z } from "zod";

// The Hub's keys (ADR-0138 §6, §9, §12; ADR-0139 §3–§5): one session key per
// Account, the one legacy key ADR-0138 §12 has not yet moved into its
// Account's entry, and each removed Account's removal time, kept until a new
// key for that Account arrives. One interface, three stores, chosen by
// platform in `openKeyStore` (credstore.ts): on Linux `secrets.json` in the
// data dir (secrets.ts, ADR-0126), elsewhere the OS keychain through the
// keyring helper (`createHelperKeyStore`, below), else memory.
//
// No store, and no line or error from one, ever carries any part of a key,
// and none ever holds an email: the Hub drops the one `/api/account` sends
// (ADR-0138 §9) before it reaches a store.

// What an Account's entry holds (ADR-0138 §6): the key, its kind, when it was
// set, and by whom: "local" for the console's or the terminal's push, else
// the healing machine's id (`x-maxprice-machine`).
export const hubKeyEntrySchema = z
  .object({
    sessionKey: z.string().min(1),
    kind: z.literal(ACCOUNT_CREDENTIAL_KIND),
    setAt: z.string().datetime({ offset: true }),
    source: z.string().min(1),
  })
  .strict();
export type HubKeyEntry = z.infer<typeof hubKeyEntrySchema>;

// The unmoved legacy key (ADR-0138 §12): its provenance where the store kept
// one (secrets.json does; a keychain entry never did), and a pre-#283
// keychain entry's `orgId`, the boot stamp's evidence (ADR-0104).
export type HubLegacyKey = {
  sessionKey: string;
  setAt: string | null;
  source: string | null;
  orgId?: string;
};

// Everything a store holds, as `list` reads it. `accounts` sorted by uuid.
export type HubKeyListing = {
  accounts: Array<HubKeyEntry & { accountUuid: string }>;
  legacy: HubLegacyKey | null;
  // Each removed Account's removal time (ADR-0139 §5), by uuid.
  removed: Record<string, string>;
};

export const EMPTY_KEY_LISTING: HubKeyListing = { accounts: [], legacy: null, removed: {} };

export type HubKeyStore = {
  list: () => Promise<HubKeyListing>;
  // Stores `uuid`'s key, replacing any earlier one, and forgets its removal
  // time: a new key for a removed Account brings it back (ADR-0139 §5).
  set: (uuid: string, entry: HubKeyEntry) => Promise<void>;
  // Removes `uuid`'s key and records `removedAt` for it.
  remove: (uuid: string, removedAt: string) => Promise<void>;
  // Removes the legacy key; it has no Account to record a removal for.
  removeLegacy: () => Promise<void>;
  // ADR-0138 §12's move: `uuid`'s entry is written first, then the legacy key
  // is deleted, so a failure between the two leaves the key in both places,
  // never in neither. An Account that already has an entry keeps its own key,
  // and the legacy one is deleted all the same.
  moveLegacy: (uuid: string, entry: HubKeyEntry) => Promise<void>;
  // The pre-#283 stamp landed (ADR-0104): the legacy entry loses its orgId.
  // Nothing for a store whose legacy entry never carries one.
  dropLegacyOrgId: () => Promise<void>;
};

// The Gateways' management keys (ADR-0141 §7), one per Gateway id, beside
// the session keys in the same store: `secrets.json`'s `gateways` on Linux
// (secrets.ts), the keychain entry `gateway-credential/<id>` elsewhere
// (below), else memory. Which Gateways the Hub holds is `gateways.json`'s
// list (gateway-registry.ts), so this store is asked by id and never listed.
// Write-only outward: nothing serves a key back, and no line names one.
export type HubGatewayKeyStore = {
  // The Gateway's key, or null when the store holds none for it.
  get: (id: string) => Promise<string | null>;
  set: (id: string, managementKey: string, setAt: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

export function createMemoryGatewayKeyStore(
  initial: Record<string, string> = {},
): HubGatewayKeyStore {
  const held = new Map(Object.entries(initial));
  return {
    get: async (id) => held.get(id) ?? null,
    set: async (id, managementKey) => {
      held.set(id, managementKey);
    },
    remove: async (id) => {
      held.delete(id);
    },
  };
}

// A listing's `accounts` from (uuid, entry) pairs, sorted by uuid.
export function sortedAccounts(
  accounts: Iterable<[string, HubKeyEntry]>,
): Array<HubKeyEntry & { accountUuid: string }> {
  return [...accounts]
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([accountUuid, entry]) => ({ accountUuid, ...entry }));
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

// ── Memory (tests, and the degraded off-Linux fallback, ADR-0035) ───────────

export function createMemoryKeyStore(initial: Partial<HubKeyListing> = {}): HubKeyStore {
  const accounts = new Map<string, HubKeyEntry>(
    (initial.accounts ?? []).map(({ accountUuid, ...entry }) => [accountUuid, entry]),
  );
  let legacy: HubLegacyKey | null = initial.legacy ?? null;
  let removed: Record<string, string> = { ...initial.removed };
  return {
    list: async () => ({
      accounts: sortedAccounts(accounts),
      legacy: legacy === null ? null : { ...legacy },
      removed: { ...removed },
    }),
    set: async (uuid, entry) => {
      accounts.set(uuid, { ...entry });
      removed = withoutKey(removed, uuid);
    },
    remove: async (uuid, removedAt) => {
      accounts.delete(uuid);
      removed = { ...removed, [uuid]: removedAt };
    },
    removeLegacy: async () => {
      legacy = null;
    },
    moveLegacy: async (uuid, entry) => {
      if (!accounts.has(uuid)) {
        accounts.set(uuid, { ...entry });
        removed = withoutKey(removed, uuid);
      }
      legacy = null;
    },
    dropLegacyOrgId: async () => {
      if (legacy === null) return;
      const { sessionKey, setAt, source } = legacy;
      legacy = { sessionKey, setAt, source };
    },
  };
}

// ── The keyring helper (the hub tray app, off Linux) ────────────────────────
//
// One keychain entry per Account, `maxprice-hub` / `usage-credential/<uuid>`,
// holding the JSON entry (ADR-0138 §6: one entry for every key would reach
// Windows' 2560-byte cap at a handful of keys), and the legacy entry
// `usage-credential`, as v6 wrote it (`{ sessionKey, orgId? }`). The keyring
// cannot list its entries on every platform, so the uuid list and the removal
// times, which are not secret, are kept in `usage-credentials.json` beside
// `hub.json`, `{ version: 1, accounts, removedAt }`, written atomically.

export const LEGACY_KEYCHAIN_ACCOUNT = "usage-credential";
export function keychainAccount(uuid: string): string {
  if (!isAccountUuid(uuid)) throw new Error("refusing a keychain entry for an invalid account");
  return `${LEGACY_KEYCHAIN_ACCOUNT}/${uuid}`;
}

// A Gateway's keychain entry (ADR-0141 §7): `gateway-credential/<id>`, the
// helper's third form (credstore/src/main.rs), holding the key alone. Its
// list is `gateways.json`'s, so it needs no index of its own.
export const GATEWAY_KEYCHAIN_PREFIX = "gateway-credential";
export function gatewayKeychainAccount(id: string): string {
  if (!GATEWAY_ID_PATTERN.test(id)) throw new Error("refusing a keychain entry for an invalid id");
  return `${GATEWAY_KEYCHAIN_PREFIX}/${id}`;
}

export function createHelperGatewayKeyStore(keychain: KeychainEntries): HubGatewayKeyStore {
  return {
    get: (id) => keychain.get(gatewayKeychainAccount(id)),
    set: (id, managementKey) => keychain.set(gatewayKeychainAccount(id), managementKey),
    remove: (id) => keychain.delete(gatewayKeychainAccount(id)),
  };
}

export const KEY_INDEX_FILE = "usage-credentials.json";

const keyIndexSchema = z.object({
  version: z.literal(1),
  accounts: z.array(z.string().regex(ACCOUNT_UUID_PATTERN)),
  removedAt: z.record(z.string().regex(ACCOUNT_UUID_PATTERN), z.string()),
});
type KeyIndex = z.infer<typeof keyIndexSchema>;

// The helper's three verbs over one keychain entry, by its account name. `get`
// answers null for no entry; any other failure throws, naming the verb and
// the exit code alone.
export type KeychainEntries = {
  get: (account: string) => Promise<string | null>;
  set: (account: string, secret: string) => Promise<void>;
  delete: (account: string) => Promise<void>;
};

export function createHelperKeyStore(opts: {
  keychain: KeychainEntries;
  // The data dir: the index lives beside hub.json.
  dataDir: string;
  warn?: (line: string) => void;
}): HubKeyStore {
  const indexPath = join(opts.dataDir, KEY_INDEX_FILE);
  const warn = opts.warn ?? ((line: string) => console.warn(line));

  function readIndex(): KeyIndex {
    let text: string;
    try {
      text = readFileSync(indexPath, "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") {
        return { version: 1, accounts: [], removedAt: {} };
      }
      throw error;
    }
    try {
      const parsed = keyIndexSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through
    }
    warn(`[hub] ${KEY_INDEX_FILE} was unreadable; starting from no listed keys`);
    return { version: 1, accounts: [], removedAt: {} };
  }

  function writeIndex(index: KeyIndex): void {
    const next: KeyIndex = {
      version: 1,
      accounts: [...new Set(index.accounts)].sort(),
      removedAt: Object.fromEntries(Object.entries(index.removedAt).sort()),
    };
    const tmp = `${indexPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, indexPath);
  }

  async function writeEntry(uuid: string, entry: HubKeyEntry): Promise<void> {
    // The entry first, then the list (ADR-0138 §6, the Desktop client's
    // order): a failure between leaves an unlisted entry, never a listed uuid
    // with no key.
    await opts.keychain.set(keychainAccount(uuid), JSON.stringify(entry));
    const index = readIndex();
    writeIndex({
      ...index,
      accounts: [...index.accounts, uuid],
      removedAt: withoutKey(index.removedAt, uuid),
    });
  }

  return {
    async list() {
      const index = readIndex();
      const accounts: Array<[string, HubKeyEntry]> = [];
      for (const uuid of index.accounts) {
        const raw = await opts.keychain.get(keychainAccount(uuid));
        // A listed uuid with no entry is dropped from the listing.
        if (raw === null) continue;
        let parsed: ReturnType<typeof hubKeyEntrySchema.safeParse> | null = null;
        try {
          parsed = hubKeyEntrySchema.safeParse(JSON.parse(raw));
        } catch {
          parsed = null;
        }
        if (parsed?.success) accounts.push([uuid, parsed.data]);
        else warn("[hub] skipped a keychain entry that is not a session key entry");
      }
      let legacy: HubLegacyKey | null = null;
      const raw = await opts.keychain.get(LEGACY_KEYCHAIN_ACCOUNT);
      if (raw !== null) {
        try {
          const parsed = storedUsageCredentialSchema.safeParse(JSON.parse(raw));
          if (parsed.success) {
            legacy = {
              sessionKey: parsed.data.sessionKey,
              setAt: null,
              source: null,
              ...(parsed.data.orgId === undefined ? {} : { orgId: parsed.data.orgId }),
            };
          }
        } catch {
          // A corrupt legacy value reads as no key, as v6's did.
        }
      }
      return { accounts: sortedAccounts(accounts), legacy, removed: { ...index.removedAt } };
    },
    set: (uuid, entry) => writeEntry(uuid, entry),
    async remove(uuid, removedAt) {
      // Unlist first, then delete (the Desktop client's order): a failure
      // between leaves an unlisted entry, which no listing reads.
      const index = readIndex();
      writeIndex({
        ...index,
        accounts: index.accounts.filter((a) => a !== uuid),
        removedAt: { ...index.removedAt, [uuid]: removedAt },
      });
      await opts.keychain.delete(keychainAccount(uuid));
    },
    removeLegacy: () => opts.keychain.delete(LEGACY_KEYCHAIN_ACCOUNT),
    async moveLegacy(uuid, entry) {
      const index = readIndex();
      const held =
        index.accounts.includes(uuid) && (await opts.keychain.get(keychainAccount(uuid))) !== null;
      if (!held) await writeEntry(uuid, entry);
      await opts.keychain.delete(LEGACY_KEYCHAIN_ACCOUNT);
    },
    async dropLegacyOrgId() {
      const raw = await opts.keychain.get(LEGACY_KEYCHAIN_ACCOUNT);
      if (raw === null) return;
      const parsed = storedUsageCredentialSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.orgId === undefined) return;
      await opts.keychain.set(
        LEGACY_KEYCHAIN_ACCOUNT,
        JSON.stringify({ sessionKey: parsed.data.sessionKey }),
      );
    },
  };
}
