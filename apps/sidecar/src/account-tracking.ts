import {
  accountLabel,
  accountUuidSchema,
  checkLabel,
  labelTaken,
  membershipReadability,
  isPendingAccountKey,
  pendingAccountKey,
  pendingHashOf,
  type AccountEntry,
  type AccountsResponse,
  type AccountsSeed,
  type HomeMembership,
  type HubAccount,
  type OrgLimitsAnswer,
  type PendingFold,
  type UsageConnection,
  type UsageReading,
} from "@maxprice/shared";
import { labelUnionFull, type LabelStore, type LabelUnionLock } from "./organization-labels";
import type { CurrentLogin } from "./organizations";

// Which Accounts this machine tracks, decided where settings.json cannot say
// (#631 T5): ADR-0136 §8's upgrade set, §4's first-launch set, and ADR-0137
// §1's Pending account folds. Pure functions over what the boot walk and the
// pair table know; bootSidecar() holds their answers in memory and announces
// them for its host to persist, because the sidecar never writes settings.json
// (ADR-0014). Also the Account roster's composer, GET /api/accounts.

// What this machine knows of Accounts, as one read of it: the live store's
// evidence (`accountMemberships`, `accountEvidenceSeen` on engine/store.ts),
// every root's current login, and the pair table.
export type AccountKnowledge = {
  // Account key -> the Organizations it was seen under, keyed through the
  // store's own pair snapshot (so possibly a stale `pending:<hash>`).
  memberships: ReadonlyMap<string, ReadonlySet<string>>;
  // The evidence as read: Owner-record uuids, Email-record hashes.
  evidence: { uuids: ReadonlySet<string>; hashes: ReadonlySet<string> };
  logins: readonly CurrentLogin[];
  // The live pair table (account-pairs.ts's `snapshot()`).
  pairs: ReadonlyMap<string, string>;
};

// A key as the live pair table resolves it: a Pending account whose hash a
// pair now maps is that Account; every other key is itself.
export function liveAccountKey(key: string, pairs: ReadonlyMap<string, string>): string {
  const hash = pendingHashOf(key);
  return hash === null ? key : (pairs.get(hash) ?? key);
}

// The account uuid of the first watched root's current login (the boot's
// `bootLogin`), or null when it names none.
function firstLoginAccount(logins: readonly CurrentLogin[]): string | null {
  return logins[0]?.accounts[0]?.accountUuid ?? null;
}

// THE one reading of which Accounts this machine knows, keyed through the
// live pair table: each Account the evidence names (an Owner record's uuid, an
// Email record's hash as its pair maps it, else as its Pending key), Excluded
// rows' included, each root's current login, and every Account the pair table
// pairs. `apartFrom`, an email hash, leaves out what names an Account only
// through that address: its own Email records, a login under it and its own
// pair. So `accountsNamed(k, hash)` is what made a Pending account's Account
// known before its fold (`decidePendingFolds`), and `accountsNamed(k, null)`
// is every Account known (`knownAccounts`). The evidence is read raw, not
// through `memberships`, whose keys went through the store's own pair
// snapshot and so cannot say which address named them.
function accountsNamed(k: AccountKnowledge, apartFrom: string | null): Set<string> {
  const keys = new Set<string>(k.evidence.uuids);
  for (const hash of k.evidence.hashes) {
    if (hash !== apartFrom) keys.add(liveAccountKey(pendingAccountKey(hash), k.pairs));
  }
  for (const login of k.logins) {
    for (const account of login.accounts) {
      if (apartFrom === null || account.emailHash !== apartFrom) keys.add(account.accountUuid);
    }
  }
  for (const [hash, accountUuid] of k.pairs) if (hash !== apartFrom) keys.add(accountUuid);
  return keys;
}

// Every Account this machine knows, sorted, each once (ADR-0136 §8's "every
// Account known"): `accountsNamed`'s, and every held key's Account (#633):
// a pushed Account's key, and the legacy key once its `/api/account`
// resolved it. An unresolved legacy key names none.
export function knownAccounts(k: AccountKnowledge, keyAccounts: readonly string[]): string[] {
  const keys = accountsNamed(k, null);
  for (const account of keyAccounts) keys.add(account);
  return [...keys].sort();
}

// ADR-0136 §8's first step (#633): the Account of the held key that reads
// Home, its listing naming the Home organization. Only when exactly one held
// key's listing names it; with none (no key, no listing yet, the network
// down) or several, the step decides nothing and the next one does.
export function keyHomeAccount(
  held: readonly { accountUuid: string; listing: readonly string[] | null }[],
  homeOrganizationUuid: string,
): string | null {
  const readers = held.filter((k) => k.listing?.includes(homeOrganizationUuid) === true);
  return readers.length === 1 ? readers[0]!.accountUuid : null;
}

// ADR-0136 §8's (and §4's) Account for the Home membership: the key's Account
// when the key reads Home (`keyHomeAccount`, #633); else the Account owning
// most of Home's sessions (`counts`, the store's `accountSessionCounts(home)`,
// resolved through the live table), ties to the first root's login and then
// by key; else, with no session naming an Account, the first root's current
// login; else none. A Pending account cannot be the Home membership's Account:
// that Account is published per machine (ADR-0136 §5) and a Pending key never
// leaves the machine (ADR-0137 §1). So a Pending winner falls through to §8's
// next step, the first root's current login, else none, and is returned as
// `pendingKey` too, for the first-launch seed to track by key.
export function homeAccountChoice(
  counts: ReadonlyMap<string, number>,
  pairs: ReadonlyMap<string, string>,
  logins: readonly CurrentLogin[],
  keyAccount: string | null = null,
): { accountUuid: string | null; pendingKey: string | null } {
  if (keyAccount !== null) return { accountUuid: keyAccount, pendingKey: null };
  const live = new Map<string, number>();
  for (const [key, count] of counts) {
    const resolved = liveAccountKey(key, pairs);
    live.set(resolved, (live.get(resolved) ?? 0) + count);
  }
  const login = firstLoginAccount(logins);
  const ranked = [...live.entries()].sort(([a, countA], [b, countB]) => {
    if (countB !== countA) return countB - countA;
    const loginFirst = (b === login ? 1 : 0) - (a === login ? 1 : 0);
    if (loginFirst !== 0) return loginFirst;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const winner = ranked[0]?.[0];
  if (winner === undefined) return { accountUuid: login, pendingKey: null };
  return isPendingAccountKey(winner)
    ? { accountUuid: login, pendingKey: winner }
    : { accountUuid: winner, pendingKey: null };
}

// ADR-0136 §8: the upgrade opts into nothing new. A settings file with a Home
// membership and no `trackedAccounts` (every v0.9.2 file) tracks every
// Account known now (`knownAccounts`, held keys' included), Pending ones
// included, so the set admits every row the walk read, exactly as v0.9.2
// did. The Home membership's Account is the persisted one, else
// `homeAccountChoice`'s (the key reading Home first), else unknown.
export function upgradeAccounts(opts: {
  home: HomeMembership;
  knowledge: AccountKnowledge;
  homeSessionCounts: ReadonlyMap<string, number>;
  keyAccounts: readonly string[];
  keyHomeAccount: string | null;
}): AccountsSeed {
  const homeAccountUuid =
    opts.home.accountUuid ??
    homeAccountChoice(
      opts.homeSessionCounts,
      opts.knowledge.pairs,
      opts.knowledge.logins,
      opts.keyHomeAccount,
    ).accountUuid;
  return {
    homeOrganizationUuid: opts.home.organizationUuid,
    homeAccountUuid,
    trackedAccounts: knownAccounts(opts.knowledge, opts.keyAccounts),
  };
}

// ADR-0136 §4: a first launch (a boot whose walk seeded the Home, so also the
// first launch after a Reset) tracks the Home membership's Account alone, so
// every other Account its corpus names is Excluded. The list is empty when
// most of Home's sessions belong to a uuid Account (the Home membership's
// Account is always tracked), and names the Pending account when they belong
// to one (`homeAccountChoice`), so Home's own usage is never excluded. That
// Home membership's Account is then the first root's login, else unknown.
export function firstLaunchAccounts(opts: {
  homeOrganizationUuid: string;
  pairs: ReadonlyMap<string, string>;
  logins: readonly CurrentLogin[];
  homeSessionCounts: ReadonlyMap<string, number>;
  keyHomeAccount: string | null;
}): AccountsSeed {
  const choice = homeAccountChoice(
    opts.homeSessionCounts,
    opts.pairs,
    opts.logins,
    opts.keyHomeAccount,
  );
  return {
    homeOrganizationUuid: opts.homeOrganizationUuid,
    homeAccountUuid: choice.accountUuid,
    trackedAccounts: choice.pendingKey === null ? [] : [choice.pendingKey],
  };
}

// ADR-0137 §1's fold, decided: each listed Pending key a pair now maps, not
// already in `decided`. Its Account was KNOWN when something other than that
// Pending account's own hash names it: the tracked list (by uuid), the Home
// membership, or `accountsNamed` apart from that hash (an Owner record,
// another email hash the evidence carries that pairs to it, a root's login
// under another address, or another pair in the table). Known, its own state
// wins and the Pending choice is dropped; not known, it takes the Pending
// account's state. Only a listed (so Tracked) Pending key folds into a list
// change: an Excluded one is absent from the list, and an Account that takes
// its state is Excluded too, which the list already says.
//
// Decided once and held (bootSidecar()'s memo, then the host's write): judged
// later, an Owner record naming the Account after the fold would make it look
// known before the fold, and flip a choice the user never made.
export function decidePendingFolds(opts: {
  list: readonly string[];
  homeAccount: string | null;
  knowledge: AccountKnowledge;
  decided: ReadonlyMap<string, PendingFold>;
}): PendingFold[] {
  const listed = new Set(opts.list);
  const folds: PendingFold[] = [];
  for (const key of opts.list) {
    const hash = pendingHashOf(key);
    if (hash === null || opts.decided.has(key)) continue;
    const accountUuid = opts.knowledge.pairs.get(hash);
    if (accountUuid === undefined) continue;
    const known =
      listed.has(accountUuid) ||
      opts.homeAccount === accountUuid ||
      accountsNamed(opts.knowledge, hash).has(accountUuid);
    folds.push({ pendingKey: key, accountUuid, takesPendingState: !known });
  }
  return folds;
}

// One Membership's live state, as the poller (or, hub-connected, the Hub)
// holds it (ADR-0138 §8, #633).
export type LiveMembership = {
  limits: OrgLimitsAnswer | null;
  stale: boolean;
  current: UsageReading | null;
  lastReadAt: string | null;
};

// What the held keys say (#633): each held key's resolved Account and its
// listing, its connection, and each Membership's live state (null: none).
export type KeyKnowledge = {
  held: readonly { accountUuid: string; listing: readonly string[] | null }[];
  connection: (accountUuid: string) => UsageConnection;
  membership: (accountUuid: string, organizationUuid: string) => LiveMembership | null;
  // The poller's stale Organizations (`UsagePoller.staleOrganizations`).
  staleOrganizations: readonly string[];
  // `UsagePoller.expiredReaderOrganizations`.
  expiredReaderOrganizations: readonly string[];
};

// GET /api/accounts' key half while hub-connected (#634, ADR-0138 §7–§8,
// ADR-0139 §1): the Hub owns live state, so every Account its status lists
// (keyed, removed or named only by an event tag; the unmoved legacy key names
// none) takes its connection there and each Membership's state as the Hub read
// it, stale while its key is expired. An Account held here that the Hub does
// not list is `disconnected` there, with no Membership state, its listing
// still naming its Memberships.
export function hubKeyKnowledge(opts: {
  hubAccounts: readonly HubAccount[];
  held: KeyKnowledge["held"];
  staleOrganizations: readonly string[];
  expiredReaderOrganizations: readonly string[];
}): KeyKnowledge {
  const listed = opts.hubAccounts.filter(
    (account): account is HubAccount & { accountUuid: string } =>
      account.provider === "anthropic" && account.accountUuid !== null,
  );
  const entryOf = (accountUuid: string) =>
    listed.find((account) => account.accountUuid === accountUuid);
  return {
    held: [
      ...listed.map((account) => ({
        accountUuid: account.accountUuid,
        listing: account.memberships.map((m) => m.organizationUuid),
      })),
      ...opts.held.filter((key) => entryOf(key.accountUuid) === undefined),
    ],
    connection: (account) => entryOf(account)?.connection ?? "disconnected",
    membership: (account, organization) => {
      const entry = entryOf(account);
      const m = entry?.memberships.find((e) => e.organizationUuid === organization);
      if (entry === undefined || m === undefined) return null;
      return {
        limits: m.limits,
        stale: entry.connection === "expired",
        current: m.current ?? null,
        lastReadAt: m.lastReadAt,
      };
    },
    staleOrganizations: opts.staleOrganizations,
    expiredReaderOrganizations: opts.expiredReaderOrganizations,
  };
}

const NO_LIVE_STATE: LiveMembership = {
  limits: null,
  stale: false,
  current: null,
  lastReadAt: null,
};

// GET /api/accounts' entries (ADR-0136 §7; #631, #633): every known Account
// (`knownAccounts`, held keys' included, plus the tracked list and the Home
// membership's Account), each keyed through the live pair table. `tracked`
// reads the resolved set (every Account while it is null). `email` is the
// address a root's login file names for the Account, read live by the caller
// (`readLoginEmails`) and kept nowhere; a Pending account has none, since its
// address exists only hashed. `connection` is its key's (`disconnected` for a
// Pending account, which no key names). `memberships` are the Organizations
// it is known under, each once, sorted, each marked when it is the Home
// membership: those the evidence names it under, the Organization each
// root's current login names it in, each Organization its key's listing
// names, and the Home membership's own; each carries its live state and its
// readability (`membershipReadability`). `label` is `accountLabel` of the
// user's own label (account-labels.json, #635), else the email, else
// `Account <first 8>`; a Pending account has no user label.
export function composeAccounts(opts: {
  knowledge: AccountKnowledge;
  keys: KeyKnowledge;
  list: readonly string[] | null;
  tracked: ReadonlySet<string> | null;
  home: HomeMembership | null;
  emails: ReadonlyMap<string, string>;
  labels: Pick<LabelStore, "get">;
  seed: AccountsSeed | null;
  folds: readonly PendingFold[];
}): AccountsResponse {
  const { knowledge, home } = opts;
  const keys = new Set(
    knownAccounts(
      knowledge,
      opts.keys.held.map((k) => k.accountUuid),
    ),
  );
  for (const key of opts.list ?? []) keys.add(liveAccountKey(key, knowledge.pairs));
  if (home !== null && home.accountUuid !== null) keys.add(home.accountUuid);
  const memberships = new Map<string, Set<string>>();
  const hold = (key: string, organizations: Iterable<string>): void => {
    let held = memberships.get(key);
    if (held === undefined) {
      held = new Set();
      memberships.set(key, held);
    }
    for (const organization of organizations) held.add(organization);
  };
  for (const [key, organizations] of knowledge.memberships) {
    hold(liveAccountKey(key, knowledge.pairs), organizations);
  }
  for (const login of knowledge.logins) {
    for (const account of login.accounts) hold(account.accountUuid, [login.organizationUuid]);
  }
  for (const held of opts.keys.held) hold(held.accountUuid, held.listing ?? []);
  if (home !== null && home.accountUuid !== null) hold(home.accountUuid, [home.organizationUuid]);
  const accounts: AccountEntry[] = [...keys].sort().map((key) => {
    const pending = isPendingAccountKey(key);
    const email = pending ? null : (opts.emails.get(key) ?? null);
    const isHome = home !== null && home.accountUuid === key;
    const connection: UsageConnection = pending ? "disconnected" : opts.keys.connection(key);
    return {
      key,
      accountUuid: pending ? null : key,
      pending,
      tracked: opts.tracked === null || opts.tracked.has(key),
      home: isHome,
      email,
      label: accountLabel(key, email, pending ? null : opts.labels.get(key)),
      connection,
      memberships: [...(memberships.get(key) ?? [])].sort().map((organizationUuid) => {
        const live =
          (pending ? null : opts.keys.membership(key, organizationUuid)) ?? NO_LIVE_STATE;
        return {
          organizationUuid,
          home: isHome && organizationUuid === home?.organizationUuid,
          limits: live.limits,
          readability: membershipReadability(connection, live.limits),
          stale: live.stale,
          current: live.current,
          lastReadAt: live.lastReadAt,
        };
      }),
    };
  });
  return {
    accounts,
    seed: opts.seed,
    folds: [...opts.folds],
    staleOrganizations: [...opts.keys.staleOrganizations],
    expiredReaderOrganizations: [...opts.keys.expiredReaderOrganizations],
  };
}

// The rows a pair-table change moves between Accounts (ADR-0137 §1): for each
// email hash the engine holds evidence of, its Account key under `before` and
// under `after` (`pending:<hash>` where neither maps it), wherever they
// differ. A pair for an address no row names moves nothing.
export function pairMoves(
  hashes: Iterable<string>,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): { from: string; to: string }[] {
  const moves: { from: string; to: string }[] = [];
  for (const hash of hashes) {
    const pending = pendingAccountKey(hash);
    const from = before.get(hash) ?? pending;
    const to = after.get(hash) ?? pending;
    if (from !== to) moves.push({ from, to });
  }
  return moves;
}

// One read of what the store and the logins know (`AccountKnowledge`).
export function accountKnowledgeOf(
  store: {
    accountMemberships: () => ReadonlyMap<string, ReadonlySet<string>>;
    accountEvidenceSeen: () => { uuids: ReadonlySet<string>; hashes: ReadonlySet<string> };
  },
  logins: readonly CurrentLogin[],
  pairs: ReadonlyMap<string, string>,
): AccountKnowledge {
  return {
    memberships: store.accountMemberships(),
    evidence: store.accountEvidenceSeen(),
    logins,
    pairs,
  };
}

// What PUT /api/accounts/:uuid/label answers, before HTTP (#635): the fresh
// Account roster, or which refusal (400 / 409 in the pinned error envelope).
export type AccountRenameResult =
  | { kind: "ok"; body: AccountsResponse }
  | { kind: "invalid-account" }
  | { kind: "invalid"; reason: "empty" | "too-long" }
  | { kind: "duplicate" }
  | { kind: "full" };

// The Account label rules (#635, ADR-0136 §7). The target must be an account
// uuid (`accountUuidSchema`): a Pending key or an address is refused, as
// the Label directory refuses it, so neither is ever stored or pushed. `label:
// null` clears the label back to the email as read here, else `Account
// <first 8>`; otherwise it is trimmed and 1 to 40 code points (`checkLabel`,
// the Organization label's rule), and unique case-insensitively against every
// OTHER Account's resolved label in this machine's roster (GET /api/accounts:
// user labels, emails as read here and `Account <first 8>` defaults, Pending
// accounts' included), as the Organization rename and the Hub's account PUT
// check theirs (`labelTaken`), so relabelling an Account to the label it
// already shows is allowed. The target itself need not be in the roster: an
// Account the Hub or another machine names is a legitimate target, and its
// label is dormant text until something lists it. A new entry that would
// pass the union cap is refused, checked and written under the union lock
// the Organization rename shares. A rename that changes the stored label emits the wholesale
// invalidation and `accounts:changed`, then `labelsWritten` (the push to the
// Hub's Label directory); one that changes nothing writes nothing, emits
// nothing, and still answers the roster. Renames run one at a time, each
// after `ready`, the label stores' loads (bootSidecar()'s `labelsReady`).
export function createAccountRename(deps: {
  ready: Promise<void>;
  list: () => Promise<AccountsResponse>;
  labels: Pick<LabelStore, "set" | "entries">;
  organizationLabels: Pick<LabelStore, "entries">;
  // The lock the cap check and the write share with the Organization rename
  // and the fleet's adoption (`createLabelUnionLock`).
  unionLock: LabelUnionLock;
  invalidateReports: () => void;
  accountsChanged: () => void;
  labelsWritten: () => void;
}): (uuid: string, label: string | null) => Promise<AccountRenameResult> {
  async function apply(uuid: string, raw: string | null): Promise<AccountRenameResult> {
    if (!accountUuidSchema.safeParse(uuid).success) return { kind: "invalid-account" };
    let label: string | null = null;
    if (raw !== null) {
      const check = checkLabel(raw);
      if (!check.ok) return { kind: "invalid", reason: check.reason };
      label = check.label;
    }
    await deps.ready;
    if (label !== null) {
      const roster = await deps.list();
      const rows = roster.accounts.map((a) => [a.key, a.label] as const);
      if (labelTaken(rows, uuid, label)) return { kind: "duplicate" };
    }
    const wrote = await deps.unionLock(async () => {
      const adds = label !== null && !deps.labels.entries().has(uuid);
      if (labelUnionFull(deps.organizationLabels, deps.labels, adds)) return null;
      return deps.labels.set(uuid, label);
    });
    if (wrote === null) return { kind: "full" };
    if (wrote) {
      deps.invalidateReports();
      deps.accountsChanged();
      deps.labelsWritten();
    }
    return { kind: "ok", body: await deps.list() };
  }

  let chain: Promise<unknown> = Promise.resolve();
  return (uuid, label) => {
    const run = chain.then(() => apply(uuid, label));
    // A failed rename rejects its own caller and never stalls the next.
    chain = run.catch(() => {});
    return run;
  };
}
