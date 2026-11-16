// Relative imports only, not `@/`: the Connect acceptance test
// (scripts/acceptance/connect-flow.test.ts) runs this flow against a real
// sidecar, as the v0.9.2 upgrade rig runs credential-ops.ts.
import {
  isPendingAccountKey,
  accountLabel,
  displayOrganizationLabels,
  isClaudeCodeToken,
  legacyReplacedBy,
  membershipReadability,
  organizationLabel,
  organizationPlan,
  sessionKeyListingFailure,
  trackAccountPatch,
  type AccountEntry,
  type AccountsResponse,
  type DiscoveredOrg,
  type MembershipReadability,
  type OrganizationsResponse,
  type Settings,
  type UsageKeysResponse,
} from "@maxprice/shared";
import { accountTitle } from "./accounts-view";
import { connectKey, connectOutcome, type CredentialIo } from "./credential-ops";
import { isNewOrganization } from "./organization-new";

// Settings › Accounts' Connect flow (#639; #621's "The Connect flow";
// ADR-0138 §2–§4, §7): the words of its paste step and the run behind its
// Connect button, which ends on the result step's content. The flow opens
// inline: in an Account's card for Connect or Reconnect, under the Provider
// header for "+ Add account", under the legacy strip for the legacy key.

// --- Targets -------------------------------------------------------------------

export type ConnectTarget =
  | { kind: "add" }
  | { kind: "account"; accountKey: string }
  | { kind: "legacy" };

// --- The paste step --------------------------------------------------------------

export const CONNECT_COPY = {
  placeholder: "Paste the sessionKey cookie value",
  inputLabel: "claude.ai session key",
  connect: "Connect",
  checking: "Checking…",
  cancel: "Cancel",
  done: "Done",
  // `sessionKey` is code-styled where it is rendered.
  helper:
    "In a browser signed in to claude.ai, open the site's cookies and copy the value named sessionKey. It lasts a few weeks; MaxPrice keeps it in the OS keychain.",
  hubHealOn: "If the Hub holds no working key for this Account, MaxPrice sends it this one too.",
  hubHealOff: "Sending keys to the Hub is off, so this key stays on this machine.",
} as const;

export const CONNECT_LEAD = {
  add: "One key per Account. MaxPrice reads which Account it is from the key.",
  reconnect: "The new key replaces the one saved for this Account.",
  pending: (name: string) =>
    `MaxPrice has seen ${name} in your logs but not which Account it is. Paste a key from a browser signed in to that Account.`,
  legacy:
    "The key saved before this version has expired. Paste a new one: MaxPrice files it under the Account it belongs to.",
} as const;

export const CONNECT_ERRORS = {
  empty: "Paste the sessionKey cookie value first.",
  oauth:
    "This is a Claude Code token, not a claude.ai session key. Paste the value of the sessionKey cookie from your browser instead.",
  dead: "claude.ai didn't accept this key. Copy the sessionKey cookie again: it may have expired or been cut short.",
} as const;

// The name a Pending account goes by in the copy: its card's title,
// `Pending account ‹first 8 of the hash›` (#672), or its address were one ever
// known here.
export function pendingName(entry: AccountEntry): string {
  return accountTitle(entry).title;
}

// The lead line (#621's four): a new key, a Reconnect (this machine holds a
// key for the Account), a Pending account, the legacy key. Connect on a known
// Account this machine holds no key for reads as a new key.
export function connectLead(
  target: ConnectTarget,
  accounts: readonly AccountEntry[] | undefined,
  keys: UsageKeysResponse | undefined,
): string {
  if (target.kind === "legacy") return CONNECT_LEAD.legacy;
  if (target.kind === "add") return CONNECT_LEAD.add;
  const entry = accounts?.find((a) => a.key === target.accountKey);
  if (entry?.pending) return CONNECT_LEAD.pending(pendingName(entry));
  // A key held for it: its own entry, or the legacy key resolved to it.
  const held =
    (keys?.keys ?? []).some((k) => k.accountUuid === target.accountKey) ||
    (keys?.legacy?.accountUuid ?? null) === target.accountKey;
  return held ? CONNECT_LEAD.reconnect : CONNECT_LEAD.add;
}

// The helper line, and on a hub-connected client whether the key also goes to
// the Hub (`hubAutoHeal`, ADR-0138 §7).
export function connectHelper(hub: { hubSourced: boolean; autoHeal: boolean }): string {
  if (!hub.hubSourced) return CONNECT_COPY.helper;
  return `${CONNECT_COPY.helper} ${hub.autoHeal ? CONNECT_COPY.hubHealOn : CONNECT_COPY.hubHealOff}`;
}

// --- The run -------------------------------------------------------------------------

export interface ConnectDeps {
  // POST /api/usage/discover-orgs (`discoverOrgsViaSidecar`): the key's
  // Organizations and its Account, or `error` with none.
  discover: (sessionKey: string) => Promise<{
    orgs: DiscoveredOrg[];
    error: string | null;
    account: string | null;
  }>;
  // The keychain and the keyset push (`tauriCredentialIo`).
  io: CredentialIo;
  // The settings write chain (`useUpdateSettings`).
  updateSettings: (update: (current: Settings) => Partial<Settings> | null) => Promise<void>;
  // GET /api/accounts and GET /api/organizations once the key is in, for the
  // result step's names, labels and tracking.
  accounts: () => Promise<AccountsResponse>;
  organizations: () => Promise<OrganizationsResponse>;
}

export interface ConnectInput {
  target: ConnectTarget;
  sessionKey: string;
  // What the flow opened on: the held keys (GET /api/usage/keys) and the
  // Accounts (GET /api/accounts).
  keys: UsageKeysResponse | undefined;
  accounts: readonly AccountEntry[] | undefined;
  hub: { hubSourced: boolean; hubHost: string | null; autoHeal: boolean };
  // The previous Settings visit, for the New pills.
  lastOpenedAt: string | null;
}

export interface ConnectOrganizationView {
  organizationUuid: string;
  label: string;
  plan: string | null;
  // The key's own answer for it (ADR-0138 §8): readable, unreadable, or null
  // when it answered neither.
  readability: MembershipReadability | null;
  isNew: boolean;
  tracked: boolean;
  home: boolean;
}

export interface ConnectMismatchView {
  lead: string;
  text: string;
}

export type ConnectResult =
  | { ok: false; error: string }
  | {
      ok: true;
      accountUuid: string;
      // "Connected ‹label›", after the dot.
      title: string;
      // Each sentence that applies, in #621's order.
      sentences: string[];
      // The key named another Account than the one the flow started from;
      // the prototype shows it in place of `sentences`.
      mismatch: ConnectMismatchView | null;
      organizationsHeading: string;
      organizationsNote: string;
      organizations: ConnectOrganizationView[];
    };

export const RESULT_COPY = {
  title: (label: string) => `Connected ${label}`,
  replaced: "Its earlier key is replaced.",
  tracks: "Connecting tracks this Account.",
  healed: (hubHost: string) =>
    `The Hub held no working key for it, so this key went to ${hubHost} too.`,
  heading: (n: number) => (n === 1 ? "Its Organization" : `Its ${n} Organizations`),
  newNote: "A new Organization starts not tracked: its usage counts only once you turn it on.",
  keptNote: "Each keeps the tracking it had.",
  mismatchLead: "This key is for another Account:",
  mismatchTracked: "That Account is connected and tracked.",
  pendingStays: (name: string) => `${name} stays as it was, known by email only.`,
  stillNeedsKey: (label: string) => `${label} still needs a key of its own.`,
} as const;

// Connect (ADR-0138 §2–§4): refuse a Claude Code token before any request;
// discover the key's Organizations and Account through the sidecar, refusing
// a dead key and a key whose Account cannot be read; store it in its
// Account's entry, replacing that Account's earlier key and the legacy key
// where `legacyReplacedBy` says, and push the keyset (`connectKey`); track
// the Account (`trackAccountPatch`, ADR-0136 §4, leaving its Organizations as
// they were); then build the result step from the fresh Accounts and roster.
// A key stored but a settings write failed still connects: the result then
// claims no tracking it did not write.
// A Pending account connected with its own key: the key's address taught the
// pair (ADR-0137 §1), so its Pending key now folds into the key's Account.
// The fresh GET /api/accounts says so by a fold naming both, or by the Pending
// account no longer being listed at all (a fold is reported only while the
// settings still name the Pending key). Not "another Account" then.
export function pendingResolvedTo(
  targetKey: string,
  accountUuid: string,
  before: readonly AccountEntry[] | undefined,
  after: AccountsResponse,
): boolean {
  if (!isPendingAccountKey(targetKey)) return false;
  if (after.folds.some((f) => f.pendingKey === targetKey && f.accountUuid === accountUuid)) {
    return true;
  }
  const wasListed = before?.some((a) => a.key === targetKey) ?? false;
  return wasListed && !after.accounts.some((a) => a.key === targetKey);
}

export async function runConnect(deps: ConnectDeps, input: ConnectInput): Promise<ConnectResult> {
  const sessionKey = input.sessionKey.trim();
  if (sessionKey === "") return { ok: false, error: CONNECT_ERRORS.empty };
  if (isClaudeCodeToken(sessionKey)) return { ok: false, error: CONNECT_ERRORS.oauth };

  const { orgs, error, account } = await deps.discover(sessionKey);
  if (orgs.length === 0) {
    return {
      ok: false,
      error: error === "expired" ? CONNECT_ERRORS.dead : sessionKeyListingFailure(error),
    };
  }
  // A key whose `/api/account` read failed has no entry to go in (ADR-0138
  // §2's note): refused in the words of a claude.ai that did not answer.
  if (account === null) return { ok: false, error: sessionKeyListingFailure("error") };

  const before = input.accounts?.find((a) => a.key === account);
  const replaceLegacy = legacyReplacedBy(input.keys, account);
  const replaced = replaceLegacy || (input.keys?.keys ?? []).some((k) => k.accountUuid === account);
  await connectKey({ accountUuid: account, sessionKey, replaceLegacy }, deps.io);

  let tracked = false;
  await deps
    .updateSettings((current) => {
      const patch = trackAccountPatch(current, account);
      tracked = patch !== null;
      return patch;
    })
    .catch(() => {
      // The settings writer reports its own failure; the key is stored.
      tracked = false;
    });

  const [accounts, roster] = await Promise.all([deps.accounts(), deps.organizations()]);
  const entry = accounts.accounts.find((a) => a.key === account);
  const label = entry === undefined ? accountLabel(account, null) : accountTitle(entry).title;

  const sentences: string[] = [];
  if (replaced) sentences.push(RESULT_COPY.replaced);
  if (tracked) sentences.push(RESULT_COPY.tracks);
  // Auto-heal sends the key itself (hub-client.ts) when `hubWantsKey` says
  // the Hub wants it: it holds no key for the Account, or an expired one. A
  // Hub key in `error`, or one still connected, is not replaced, so the
  // sentence is not said then. (A removal time never blocks a fresh paste,
  // which is newer than any removal.)
  if (
    input.hub.hubSourced &&
    input.hub.autoHeal &&
    input.hub.hubHost !== null &&
    (before === undefined ||
      before.connection === "disconnected" ||
      before.connection === "expired")
  ) {
    sentences.push(RESULT_COPY.healed(input.hub.hubHost));
  }

  // ADR-0138 §3: the flow started from one Account and the key is another's.
  // That Account is connected and tracked; the one it started from stays as
  // it was.
  let mismatch: ConnectMismatchView | null = null;
  const target = input.target;
  if (
    target.kind === "account" &&
    !pendingResolvedTo(target.accountKey, account, input.accounts, accounts) &&
    connectOutcome(target.accountKey, account).kind === "another-account"
  ) {
    const from = input.accounts?.find((a) => a.key === target.accountKey);
    const last = from?.pending
      ? RESULT_COPY.pendingStays(pendingName(from))
      : RESULT_COPY.stillNeedsKey(
          from === undefined ? accountLabel(target.accountKey, null) : accountTitle(from).title,
        );
    mismatch = {
      lead: RESULT_COPY.mismatchLead,
      text: `${mismatchName(entry, label)}. ${RESULT_COPY.mismatchTracked} ${last}`,
    };
  }

  const labels = displayOrganizationLabels(roster.organizations);
  const rosterBy = new Map(roster.organizations.map((o) => [o.uuid, o]));
  const organizations = orgs.map((org): ConnectOrganizationView => {
    const r = rosterBy.get(org.id);
    return {
      organizationUuid: org.id,
      label: organizationLabel(labels, org.id),
      plan: r?.plan ?? organizationPlan({ organizationType: null, hints: org.hints }),
      readability: membershipReadability("connected", org.limits),
      isNew: r === undefined ? true : isNewOrganization(r, input.lastOpenedAt),
      tracked: r?.tracked ?? false,
      // The Home membership is this Account's in this Organization.
      home: entry?.memberships.some((m) => m.organizationUuid === org.id && m.home) ?? false,
    };
  });

  return {
    ok: true,
    accountUuid: account,
    title: RESULT_COPY.title(label),
    sentences,
    mismatch,
    organizationsHeading: RESULT_COPY.heading(organizations.length),
    organizationsNote: organizations.some((o) => o.isNew)
      ? RESULT_COPY.newNote
      : RESULT_COPY.keptNote,
    organizations,
  };
}

// "‹label› (‹email›)" with a user label and an address, else the title alone,
// which already is the address when there is no label.
function mismatchName(entry: AccountEntry | undefined, label: string): string {
  if (entry === undefined) return label;
  const { userLabel, title } = accountTitle(entry);
  return userLabel !== null && entry.email !== null && entry.email !== ""
    ? `${userLabel} (${entry.email})`
    : title;
}

// --- The deep link (#638's D3) -------------------------------------------------

// Settings › Accounts' anchor: `settingsSectionId("Accounts")`
// (settings-sections.ts), the cluster's id.
export const SETTINGS_ACCOUNTS_ANCHOR = "settings-accounts";
export const SETTINGS_CONNECT_PARAM = "connect";

// Where Live's limit-area Reconnect goes: Settings, scrolled to Accounts, with
// that Account's Connect open (`/settings?connect=<key>#settings-accounts`).
export function settingsConnectPath(accountKey: string): string {
  return `/settings?${SETTINGS_CONNECT_PARAM}=${encodeURIComponent(accountKey)}#${SETTINGS_ACCOUNTS_ANCHOR}`;
}

// The Account key a Settings URL's search asks to connect (`?connect=…`, with
// or without the `?`), or null when it names none.
export function parseSettingsConnect(search: string): string | null {
  const value = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get(
    SETTINGS_CONNECT_PARAM,
  );
  return value === null || value.trim() === "" ? null : value;
}

// Where the tiles' expired-key hint goes (usage-expired-hint.tsx): with one
// dead key and its Account known, that Account's Connect; otherwise Settings
// › Accounts, whose strips name each Account that needs a key (and the legacy
// key, whose Account is not known).
export function reconnectHintPath(keys: UsageKeysResponse | undefined): string {
  const expired = (keys?.keys ?? []).filter((k) => k.connection === "expired");
  const legacyExpired = keys?.legacy?.connection === "expired";
  if (expired.length === 1 && !legacyExpired) return settingsConnectPath(expired[0]!.accountUuid);
  return `/settings#${SETTINGS_ACCOUNTS_ANCHOR}`;
}
