import {
  ACCOUNT_CREDENTIAL_KIND,
  accountCredentialSchema,
  type AccountCredential,
  type StoredUsageCredential,
  type UsageKeyset,
} from "@maxprice/shared";

// The keychain operations the Desktop renderer runs (ADR-0023, and since #633
// ADR-0138 §6, §12), over an injected keychain and sidecar (`CredentialIo`):
// the launch push, the upgrade's legacy move, Connect and Disconnect. Every
// read-modify-write runs one at a time (`withCredentials`). The Tauri
// bindings, `tauriCredentialIo`, are usage-credential.ts's; this module
// imports nothing from Tauri or the renderer, so the v0.9.2 upgrade rig
// (scripts/acceptance/upgrade-v0-9-2) drives these same functions over its
// emulated keychain, in the renderer's own order.

// Every Account's entry, parsed. An entry that does not parse is skipped, as
// a corrupt legacy blob is: that Account reads as not connected until its next
// Connect replaces it.
export function parseAccountCredentials(
  raw: ReadonlyArray<{ accountUuid: string; value: string }>,
): HeldAccountKey[] {
  const out: HeldAccountKey[] = [];
  for (const { accountUuid, value } of raw) {
    try {
      const parsed = accountCredentialSchema.safeParse(JSON.parse(value));
      if (parsed.success) out.push({ accountUuid, entry: parsed.data });
    } catch {
      // corrupt entry — skipped
    }
  }
  return out;
}

// One Account's key as the keychain holds it.
export type HeldAccountKey = { accountUuid: string; entry: AccountCredential };

// What the keychain holds: each Account's key, and the legacy key.
export type HeldCredentials = {
  accounts: HeldAccountKey[];
  legacy: StoredUsageCredential | null;
};

// The keychain and the sidecar, injectable for the tests.
export type CredentialIo = {
  listAccounts: () => Promise<HeldAccountKey[]>;
  setAccount: (accountUuid: string, entry: AccountCredential | null) => Promise<void>;
  readLegacy: () => Promise<StoredUsageCredential | null>;
  writeLegacy: (cred: StoredUsageCredential | null) => Promise<void>;
  push: (keyset: UsageKeyset | null) => Promise<void>;
  now: () => Date;
};

// Every credential change runs after the one before it settles: the launch
// push, the legacy move, Connect and Disconnect each read the keychain, write
// it and push, and two interleaved would push a keyset one of them no longer
// holds. A failure rejects its caller and never wedges the chain.
let credentialChain: Promise<unknown> = Promise.resolve();
export function withCredentials<T>(run: () => Promise<T>): Promise<T> {
  const next = credentialChain.then(run);
  credentialChain = next.catch(() => {});
  return next;
}

export async function loadCredentials(io: CredentialIo): Promise<HeldCredentials> {
  const [accounts, legacy] = await Promise.all([io.listAccounts(), io.readLegacy()]);
  return { accounts, legacy };
}

// The keyset the keychain makes (ADR-0138 §6): every Account's entry, its
// `orgId` included, and the legacy key verbatim; null when it holds none,
// which clears the sidecar's.
export function keysetOf(held: HeldCredentials): UsageKeyset | null {
  if (held.accounts.length === 0 && held.legacy === null) return null;
  return {
    keys: held.accounts.map(({ accountUuid, entry }) => ({ accountUuid, ...entry })),
    legacy:
      held.legacy === null
        ? null
        : held.legacy.orgId === undefined
          ? { sessionKey: held.legacy.sessionKey }
          : { sessionKey: held.legacy.sessionKey, orgId: held.legacy.orgId },
  };
}

function withoutOrgId(entry: AccountCredential): AccountCredential {
  return { sessionKey: entry.sessionKey, kind: entry.kind, setAt: entry.setAt };
}

// Hand the keyset to the sidecar. A legacy `orgId`, in whichever entry holds
// it, leaves the keychain only after the sidecar acknowledges the push that
// carried it — the ack means the usage history it names is stamped (#279,
// ADR-0104). A failed push, or a crash between the ack and the rewrite, leaves
// the entry as it was: the next push stamps again, and a stamp with nothing
// unstamped does no I/O. Answers what the keychain holds afterwards.
export async function syncKeyset(
  held: HeldCredentials,
  io: Pick<CredentialIo, "push" | "setAccount" | "writeLegacy">,
): Promise<HeldCredentials> {
  await io.push(keysetOf(held));
  const accounts: HeldAccountKey[] = [];
  for (const key of held.accounts) {
    if (key.entry.orgId === undefined) {
      accounts.push(key);
      continue;
    }
    const entry = withoutOrgId(key.entry);
    await io.setAccount(key.accountUuid, entry);
    accounts.push({ accountUuid: key.accountUuid, entry });
  }
  let legacy = held.legacy;
  if (legacy?.orgId !== undefined) {
    legacy = { sessionKey: legacy.sessionKey };
    await io.writeLegacy(legacy);
  }
  return { accounts, legacy };
}

// The launch push: read the keychain, push it.
export async function syncCredentials(io: CredentialIo): Promise<void> {
  await withCredentials(async () => {
    await syncKeyset(await loadCredentials(io), io);
  });
}

// The upgrade's move (ADR-0138 §12): the sidecar resolved the legacy key's
// Account (`GET /api/usage/keys`' `legacy.accountUuid`). Write that Account's
// entry, set now, carrying any unacknowledged legacy `orgId`; only once that
// write succeeded delete the legacy entry; then push the keyset. An Account
// that already has an entry keeps its own key (the legacy one never overwrites
// it) and only takes an unacknowledged `orgId` it lacks; the legacy entry is
// deleted all the same. A keychain with no legacy entry left (moved already)
// does nothing. Answers whether it moved.
export async function moveLegacy(accountUuid: string, io: CredentialIo): Promise<boolean> {
  return withCredentials(async () => {
    const held = await loadCredentials(io);
    const legacy = held.legacy;
    if (legacy === null) return false;
    const existing = held.accounts.find((k) => k.accountUuid === accountUuid);
    let accounts = held.accounts;
    if (existing === undefined) {
      const entry: AccountCredential = {
        sessionKey: legacy.sessionKey,
        kind: ACCOUNT_CREDENTIAL_KIND,
        setAt: io.now().toISOString(),
        ...(legacy.orgId === undefined ? {} : { orgId: legacy.orgId }),
      };
      await io.setAccount(accountUuid, entry);
      accounts = [...accounts, { accountUuid, entry }];
    } else if (legacy.orgId !== undefined && existing.entry.orgId === undefined) {
      const entry = { ...existing.entry, orgId: legacy.orgId };
      await io.setAccount(accountUuid, entry);
      accounts = accounts.map((k) => (k.accountUuid === accountUuid ? { accountUuid, entry } : k));
    }
    await io.writeLegacy(null);
    await syncKeyset({ accounts, legacy: null }, io);
    return true;
  });
}

// Connect (ADR-0138 §2): the key's Account's entry, replacing an earlier one
// (that is how reconnecting works), set now. It keeps an unacknowledged legacy
// `orgId` the replaced entry carried, so a reconnect after a failed stamp
// still stamps with what the old poller read. `replaceLegacy`: the paste
// replaces the legacy key too (`legacyReplacedBy`), whose unacknowledged
// `orgId` then moves into this entry. Then the keyset is pushed.
export async function connectKey(
  args: { accountUuid: string; sessionKey: string; replaceLegacy: boolean },
  io: CredentialIo,
): Promise<void> {
  await withCredentials(async () => {
    const held = await loadCredentials(io);
    const existing = held.accounts.find((k) => k.accountUuid === args.accountUuid);
    const legacy = args.replaceLegacy ? held.legacy : null;
    const orgId = existing?.entry.orgId ?? legacy?.orgId;
    const entry: AccountCredential = {
      sessionKey: args.sessionKey,
      kind: ACCOUNT_CREDENTIAL_KIND,
      setAt: io.now().toISOString(),
      ...(orgId === undefined ? {} : { orgId }),
    };
    await io.setAccount(args.accountUuid, entry);
    if (legacy !== null) await io.writeLegacy(null);
    const accounts = [
      ...held.accounts.filter((k) => k.accountUuid !== args.accountUuid),
      { accountUuid: args.accountUuid, entry },
    ];
    await syncKeyset({ accounts, legacy: legacy === null ? held.legacy : null }, io);
  });
}

// What Disconnect removes: one Account's key, the legacy key, or every key
// (the one-key section's Disconnect, which removes whatever it holds).
export type DisconnectTarget =
  | { kind: "account"; accountUuid: string }
  | { kind: "legacy" }
  | { kind: "all" };

// Disconnect (ADR-0138 §5): deletes that key only — no tracking, label or
// history changes — and pushes what is left.
export async function disconnectKey(target: DisconnectTarget, io: CredentialIo): Promise<void> {
  await withCredentials(async () => {
    const held = await loadCredentials(io);
    let { accounts, legacy } = held;
    for (const key of held.accounts) {
      if (
        target.kind === "all" ||
        (target.kind === "account" && target.accountUuid === key.accountUuid)
      ) {
        await io.setAccount(key.accountUuid, null);
        accounts = accounts.filter((k) => k.accountUuid !== key.accountUuid);
      }
    }
    if (legacy !== null && target.kind !== "account") {
      await io.writeLegacy(null);
      legacy = null;
    }
    await io.push(keysetOf({ accounts, legacy }));
  });
}

// Connect's outcome (ADR-0138 §3): connecting from a specific Account (a
// Reconnect) with another Account's key keeps the key and connects that
// Account, and Settings says so. `target` is the Account the user connected
// from; null is the paste box alone, or the legacy key's Reconnect, which
// names no Account.
export type ConnectOutcome =
  | { kind: "connected" }
  | { kind: "another-account"; accountUuid: string };
export function connectOutcome(target: string | null, keyAccountUuid: string): ConnectOutcome {
  return target === null || target === keyAccountUuid
    ? { kind: "connected" }
    : { kind: "another-account", accountUuid: keyAccountUuid };
}
