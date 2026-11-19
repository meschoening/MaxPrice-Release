// Relative imports only, not `@/`: the v0.9.2 upgrade rig
// (scripts/acceptance/upgrade-v0-9-2) builds Settings › Accounts with this
// module under the scripts' own tsconfig, as it built the key rows before.
import {
  accountLabel,
  byCodeUnit,
  normalizeHubUrl,
  displayOrganizationLabels,
  formatWallDayMonth,
  GATEWAY_STATE_TONE,
  GATEWAY_STATE_WORDS,
  homeMembershipOf,
  mostUsedWindow,
  organizationLabel,
  pendingHashOf,
  ACCOUNT_NOT_KNOWN,
  type AccountEntry,
  type AccountMembership,
  type AccountSourcesResponse,
  type AccountsResponse,
  type GatewayState,
  type LocalGatewaysResponse,
  type OrganizationAssertionsResponse,
  type OrganizationEntry,
  type OrganizationsResponse,
  type Settings,
  type TimeDisplay,
  type UsageConnection,
  type UsageKeysResponse,
} from "@maxprice/shared";
import {
  accountMark,
  accountUse,
  providerOf,
  rankAccounts,
  PROVIDER_NAMES,
  type ProviderId,
} from "./account-menu";
import type { DisconnectTarget } from "./credential-ops";
import { SEND_KEYS_COPY } from "./hub-auto-heal";
import { isNewOrganization } from "./organization-new";

// Settings › Accounts (#639; layout, states and copy from #621's resolution;
// ADR-0136 §3–§7, ADR-0138 §3–§8 and §12, ADR-0141 §8) as pure data: every
// word and every state the cluster renders, so its components only render.
// `accountsView` builds it from the sidecar's answers and the settings; the
// Connect flow is connect-flow.ts's.
//
// Ranking: a Provider's tracked cards are ranked by most used (ADR-0141 §8),
// by the Account menu's own use and order (`accountUse`, `rankAccounts`
// "used"), so one ordering serves both: an expired key ranks by its last
// reading (ADR-0138 §8's 2026-11-10 note), an Account with no readable limit
// sorts last, and ties go by title in code-unit order. A card can move as
// readings arrive while the page is open, as a menu row does. The Not tracked
// group is by title (case-insensitive, then by code unit, then by key).

// --- Words -------------------------------------------------------------------

export const ACCOUNTS_EYEBROW = { one: "Account", many: "Accounts" } as const;

export const LEGACY_STRIP = {
  lead: "Your saved session key has expired.",
  rest: "It was saved before MaxPrice followed several Accounts, so it isn't filed under one yet.",
  action: "Reconnect",
} as const;

// "1 Account needs reconnecting" / "N Accounts need reconnecting" (#621's
// strip; ADR-0138 §8's prompt, counted).
export function reconnectHeadline(n: number): string {
  return n === 1 ? "1 Account needs reconnecting" : `${n} Accounts need reconnecting`;
}
export const RECONNECT_STRIP_TAIL = "Their limits show the last reading until then.";

export const HUB_STRIP = {
  lead: "Limits come from the Hub, ",
  tail: ". Keys you connect here stay on this machine too, for when the Hub can't read.",
  sendKeysLabel: SEND_KEYS_COPY.label,
  sendKeysTitle: SEND_KEYS_COPY.title,
} as const;

export const HOME_SECTION = {
  title: "Home membership",
  description: "The default Scope, and where usage with no attribution evidence counts.",
} as const;
export const HOME_BADGE = {
  text: "⌂ Home",
  title: "Home membership: the default Scope, and where usage with no evidence counts",
} as const;

export const PROVIDER_SECTION = {
  addAccount: "+ Add account",
  description:
    "An Account's usage counts while it is tracked, in each Organization that is tracked too. A connected key reads its limits.",
} as const;

export const NOT_TRACKED = {
  title: (n: number) => `Not tracked · ${n}`,
  hint: "Seen in your logs; nothing of theirs counts.",
} as const;
// The Not tracked group folds past this many Accounts.
export const NOT_TRACKED_FOLD_PAST = 2;
// Past this many Accounts per Provider, cards fold to one line and the filter
// appears.
export const CARDS_FOLD_PAST = 6;
export function filterPlaceholder(n: number): string {
  return `Filter ${n} accounts or their Organizations`;
}

export const PENDING_SUB = "Known by email only";
// A Pending account's name on its card and in Connect's copy (#672,
// answering #639's question 1): GET /api/accounts never carries its address
// (the parser keeps only its hash, ADR-0137 §1), so it goes by the hash's first
// 8. Once connected it folds into the key's Account, whose email replaces it.
export function pendingAccountTitle(key: string): string {
  return `Pending account ${shortId(key)}`;
}
export const PENDING_AVATAR = "@";

export const CONNECTION_WORDS = {
  connected: "Connected",
  expired: "Key expired",
  disconnected: "No key",
  error: "Can't reach claude.ai",
} as const satisfies Record<UsageConnection, string>;
export const HUB_CONNECTION_WORDS = {
  connected: "Connected through the Hub",
  expired: "Key expired at the Hub",
  disconnected: "No key at the Hub",
  error: "Can't reach claude.ai",
} as const satisfies Record<UsageConnection, string>;
// Hub-connected, the local key's fact is only whether one is held: there GET
// /api/usage/keys answers the Hub's connection for every Account's key held
// here, so this machine's own key's health is not known (residual: #621's
// "This machine's key expired too" is not shown until the sidecar reports the
// local key's own health beside the Hub's). The unresolved legacy key alone
// reports its own (#702), which the legacy strip reads.
export const LOCAL_KEY_WORDS = {
  held: "This machine also holds a key",
  none: "No key on this machine",
} as const;

export const HOME_LOCK =
  "Part of the Home membership, so always tracked. Choose another Home to change it.";
export const ACCOUNT_TRACK_TITLE = {
  on: "Tracked: its usage counts",
  off: "Not tracked: nothing of this Account's counts",
  noHome: "Every Account is counted until MaxPrice has a Home.",
} as const;
export const ORGANIZATION_TRACK_TITLE = {
  on: "Counted. Turn off to stop counting this Organization's usage",
  off: "Not counted. Turn on to count this Organization's usage",
  accountExcluded: "Its Account isn't tracked, so nothing here counts either way",
  noHome: "Every Organization is counted until MaxPrice has a Home.",
} as const;

export const UNREADABLE_PILL = "Limits not readable";
export const UNREADABLE_TITLE =
  'claude.ai answers "forbidden" when asked for this Organization\'s limits through this Account now. MaxPrice asks again every hour. Its usage still counts while it is tracked.';
export const STALE_NONE = "Not read since the key expired";
export const STALE_RECONNECT = "Reconnect";
export const NEW_PILL = "New";
// A Membership row's assigned sessions (#672): every session assigned to its
// Organization, through any Account, and Unassign, which clears them all.
export function assignedWords(n: number): string {
  return `${n} session${n === 1 ? "" : "s"} assigned`;
}
export const UNASSIGN = {
  label: "Unassign",
  title:
    "Clear these assignments on every machine: each session counts under its Presumed membership again, and Unattributed usage lists it",
} as const;

export function disconnectNote(hubHost: string): string {
  return `Removed this machine's key. The Hub still holds a key for this Account; remove it at ${hubHost}.`;
}

export const SEEN_THROUGH = {
  login: "Seen through this machine's login",
  gateway: (hosts: readonly string[]) => `Seen through a Gateway (${hosts.join(", ")})`,
  both: (hosts: readonly string[]) =>
    `Seen through this machine's login and a Gateway (${hosts.join(", ")})`,
} as const;

export const GATEWAYS_SECTION = {
  title: "Gateways",
  description:
    "A Gateway, such as CLIProxyAPI, serves Claude Code on accounts it holds itself, and records which one served each request. Connect one, and its records attribute the sessions it served. It is one way to use an Account, as logging in directly is.",
  connect: "Connect a Gateway",
  // The form's own button.
  submit: "Connect",
  remove: "Remove",
  urlLabel: "Gateway URL",
  urlPlaceholder: "http://gateway.example:8317",
  keyLabel: "Management key",
  keyPlaceholder: "The Gateway's management key",
  checking: "Checking…",
  cancel: "Cancel",
  done: "Done",
  connected: (host: string) => `Connected ${host}`,
  // Connecting tracks nothing (ADR-0141 §7).
  tracksNothing:
    "Connecting tracks nothing: an Account first seen through it starts not tracked, as any newly seen Account does.",
  helper:
    "MaxPrice reads only the Gateway's credential list and its usage queue, never its tokens. The management key stays in the OS keychain.",
  // ADR-0141 §7: a joined client sends a Gateway up once, and keeps its own.
  hubHelper: (hubHost: string) =>
    `Joined to ${hubHost}, this machine also sends the Gateway to the Hub, once, and the Hub drains it from then on. Removing it here leaves the Hub's copy: remove that at the Hub.`,
  removedHere: (gatewayHost: string, hubHost: string) =>
    `Removed ${gatewayHost} from this machine. The Hub still holds this Gateway; remove it at ${hubHost}.`,
} as const;
// The state, warning and check-failure words are packages/shared's
// (`gateway-words.ts`, #673), which every Gateway surface reads.
export const GATEWAY_DRAINED_BY_HUB = "Drained by the Hub";

// The name the copy gives the Hub: its URL's host (#639), null with no Hub
// URL or one that does not parse.
export function hubHostOf(hubUrl: string): string | null {
  try {
    const normalized = normalizeHubUrl(hubUrl);
    if (normalized === "") return null;
    const host = new URL(normalized).hostname.replace(/^\[|\]$/g, "");
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

// An Account card's element id, which the deep link scrolls to.
export function accountCardId(key: string): string {
  return `account-card-${key.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

// --- Time --------------------------------------------------------------------

// "just now", "1 minute ago", "3 hours ago", "2 days ago" (#621's "Last
// reading 71% · 2 days ago"); null for a time that does not parse.
export function agoWords(iso: string | null, nowMs: number): string | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const age = Math.max(0, nowMs - at);
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (age < 60_000) return "just now";
  if (age < 3_600_000) return unit(Math.floor(age / 60_000), "minute");
  if (age < 86_400_000) return unit(Math.floor(age / 3_600_000), "hour");
  return unit(Math.floor(age / 86_400_000), "day");
}

// --- The view ----------------------------------------------------------------

export type Tone = "good" | "warn" | "bad" | "soft";

export interface AccountsViewInput {
  // GET /api/accounts.
  accounts: AccountsResponse;
  // GET /api/usage/keys: the keys this machine holds and the legacy key.
  keys: UsageKeysResponse | undefined;
  // GET /api/organizations: labels, plan words, tracking, first-seen times.
  roster: OrganizationsResponse | undefined;
  // The persisted Home membership and tracked lists, which alone decide
  // what a switch can write; null while the settings load.
  settings: Pick<Settings, "homeMemberships" | "trackedOrganizations" | "trackedAccounts"> | null;
  // GET /api/account-sources.
  sources: AccountSourcesResponse | undefined;
  // GET /api/organization-assertions: the sessions assigned to each
  // Organization, for its rows' Unassign.
  assertions?: OrganizationAssertionsResponse;
  // GET /api/gateways.
  gateways: LocalGatewaysResponse | undefined;
  // Each held key's `setAt` by account uuid (credential-ops `loadCredentials`);
  // absent outside Tauri, where the keychain cannot be read.
  keySetAt?: ReadonlyMap<string, string>;
  hub: {
    // The Hub is connected: limits and connections are its (ADR-0138 §7).
    hubSourced: boolean;
    // The Hub URL's host, the name the copy gives it.
    hubHost: string | null;
    // `hubAutoHeal`, "Send keys to the Hub".
    autoHeal: boolean;
  };
  // The previous Settings visit (ISO), for the New pills.
  lastOpenedAt: string | null;
  display: TimeDisplay;
  nowMs: number;
}

export type StripView =
  | { kind: "legacy"; lead: string; rest: string; action: string }
  | {
      kind: "reconnect";
      headline: string;
      // Each name opens that Account's Connect.
      accounts: Array<{ key: string; label: string }>;
      tail: string;
    }
  | {
      kind: "hub";
      lead: string;
      host: string;
      tail: string;
      sendKeys: { label: string; title: string; on: boolean };
    };

export interface HomeOptionView {
  // `organizationUuid` and `accountUuid` are what `homeMembershipPatch` takes.
  organizationUuid: string;
  accountUuid: string | null;
  // "‹Organization› · ‹Account› (‹plan›)".
  label: string;
  // The option is the Home membership now. A current Home no tracked
  // Account's Memberships list is still an option, so the select shows it.
  selected: boolean;
}

export interface HomeSelectView {
  provider: ProviderId;
  providerName: string;
  // The Provider's mark shows once there are two Providers.
  showMark: boolean;
  options: HomeOptionView[];
}

export interface HomeView {
  title: string;
  description: string;
  selects: HomeSelectView[];
}

export interface ReadNoteView {
  kind: "unreadable" | "stale";
  text: string;
  // The pill's tooltip (Unreadable).
  title: string | null;
  // A stale reading's "Reconnect" link opens its Account's Connect.
  reconnect: boolean;
}

export interface MembershipRowView {
  organizationUuid: string;
  // The Organization label, collision-suffixed across the roster.
  label: string;
  // What its rename edits, and whether it is the user's (ADR-0105).
  bareLabel: string;
  renamed: boolean;
  // What the label falls back to without a rename: the rename's placeholder.
  defaultLabel: string;
  plan: string | null;
  isNew: boolean;
  // "also ‹other Accounts›", null when no other Account reaches it.
  also: string | null;
  // "N sessions assigned", beside Unassign; null when none is.
  assigned: string | null;
  read: ReadNoteView | null;
  home: boolean;
  // The Organization's own Track switch, shared across Accounts (ADR-0136 §3).
  track: { on: boolean; canToggle: boolean; title: string };
}

export interface AccountCardView {
  key: string;
  accountUuid: string | null;
  provider: ProviderId;
  pending: boolean;
  avatar: { letter: string; dashed: boolean };
  title: string;
  sub: string | null;
  // The user's label, which Rename edits; null when there is none.
  userLabel: string | null;
  // As read on this machine, for the filter and the folded line.
  email: string | null;
  // Null for a Pending account, which shows no connection state.
  connection: { state: UsageConnection; text: string; tone: Tone } | null;
  action: "Connect" | "Reconnect" | null;
  track: { on: boolean; canToggle: boolean; title: string };
  tools: {
    // "Rename" with a user label, "Label" without; null for a Pending account
    // (PUT /api/accounts/:uuid/label refuses one).
    rename: "Rename" | "Label" | null;
    // What Disconnect removes: this machine's key for the Account, or the
    // legacy key that resolved to it; null when this machine holds none.
    disconnect: DisconnectTarget | null;
    // "key set Oct 14".
    keySet: string | null;
    // Hub-connected only: what this machine holds beside the Hub.
    localKey: string | null;
  };
  // The Account menu's use (`accountUse`), which ranks the tracked cards.
  usePct: number | null;
  // "Seen through …", null when neither source names it.
  seenThrough: string | null;
  // The Hub holds a key for this Account, working or expired: Disconnect
  // then shows `disconnectNote`.
  hubHoldsKey: boolean;
  disconnectNote: string | null;
  memberships: MembershipRowView[];
  holdsHome: boolean;
  holdsNew: boolean;
  // Folding past CARDS_FOLD_PAST: the card's one line, and whether it starts
  // open (it needs a key, holds a New Organization, or holds Home).
  fold: { foldable: boolean; openByDefault: boolean; line: string };
}

export interface ProviderSectionView {
  provider: ProviderId;
  name: string;
  showMark: boolean;
  addAccount: string;
  description: string;
  // Past CARDS_FOLD_PAST Accounts: the filter's placeholder; else null.
  filterPlaceholder: string | null;
  cards: AccountCardView[];
  notTracked: {
    title: string;
    hint: string;
    hasNew: boolean;
    foldedByDefault: boolean;
    cards: AccountCardView[];
  } | null;
}

export interface GatewayRowView {
  id: string;
  host: string;
  state: GatewayState;
  stateText: string;
  tone: Tone;
  // "last record 2 hours ago", null before the first.
  lastRecord: string | null;
  drainedByHub: string | null;
  // The labels of the Accounts its credential list names, as known here.
  accounts: string[];
}

export interface GatewaysView {
  title: string;
  connect: string;
  remove: string;
  rows: GatewayRowView[];
}

export interface AccountsView {
  eyebrow: string;
  strips: StripView[];
  // Hidden (null) at one Account.
  home: HomeView | null;
  providers: ProviderSectionView[];
  gateways: GatewaysView;
}

// --- Building ----------------------------------------------------------------

type ViewSettings = AccountsViewInput["settings"];

function shortId(key: string): string {
  return (pendingHashOf(key) ?? key).slice(0, 8);
}

function emailOf(entry: AccountEntry): string | null {
  return entry.email === null || entry.email === "" ? null : entry.email;
}

// ADR-0136 §7 / #621's Account label: a user label is the title with the
// email under it (else `Account ‹first 8›`); no label, the email is the title
// with `Account ‹first 8›` under it; neither, `Account ‹first 8›` alone. A
// Pending account carries no email here (the parser hashed it, and GET
// /api/accounts never carries one for it), so its title is
// `pendingAccountTitle` and "Known by email only" sits under it.
export function accountTitle(entry: AccountEntry): {
  title: string;
  sub: string | null;
  userLabel: string | null;
} {
  const fallback = `Account ${shortId(entry.key)}`;
  const email = emailOf(entry);
  if (entry.pending) {
    return { title: email ?? pendingAccountTitle(entry.key), sub: PENDING_SUB, userLabel: null };
  }
  const userLabel = entry.label !== accountLabel(entry.key, email) ? entry.label : null;
  if (userLabel !== null) return { title: userLabel, sub: email ?? fallback, userLabel };
  if (email !== null) return { title: email, sub: fallback, userLabel: null };
  return { title: fallback, sub: null, userLabel: null };
}

// The connection a card shows (ADR-0138 §7–§8): this machine's key's, or on a
// hub-connected client the Hub's. #621 read a working local key as connected
// there while auto-heal is on; but hub-connected, GET /api/usage/keys reports
// the Hub's connection for each key held here, so the local key's health is
// not known and the card says what the Hub holds (residual, named in
// LOCAL_KEY_WORDS).
function effectiveConnection(entry: AccountEntry): UsageConnection {
  return entry.connection;
}

function connectionTone(state: UsageConnection): Tone {
  switch (state) {
    case "connected":
      return "good";
    case "expired":
      return "warn";
    case "error":
      return "bad";
    case "disconnected":
      return "soft";
  }
}

function keyAction(entry: AccountEntry, state: UsageConnection): "Connect" | "Reconnect" | null {
  if (entry.pending || state === "disconnected") return "Connect";
  if (state === "expired") return "Reconnect";
  return null;
}

// The Account's tracking as the settings decide it (the sidecar's resolution:
// the list UNION the Home's Account; no Home or no list excludes nothing),
// else as GET /api/accounts last resolved it.
function accountTracked(entry: AccountEntry, settings: ViewSettings): boolean {
  if (settings === null) return entry.tracked;
  const home = homeMembershipOf(settings);
  if (home === null || settings.trackedAccounts === null) return true;
  return home.accountUuid === entry.key || settings.trackedAccounts.includes(entry.key);
}

function organizationTracked(
  uuid: string,
  entry: OrganizationEntry | undefined,
  settings: ViewSettings,
): boolean {
  if (settings === null) return entry?.tracked ?? true;
  const home = homeMembershipOf(settings);
  if (home === null) return true;
  return home.organizationUuid === uuid || settings.trackedOrganizations.includes(uuid);
}

// An Organization's own Track switch (ADR-0136 §3), wherever it shows: a
// Membership row, or the Connect result's list, whose Account Connect has just
// tracked. The Home membership's Organization is locked on; with no Home every
// switch is on and none acts.
export function organizationTrack(
  uuid: string,
  entry: OrganizationEntry | undefined,
  settings: ViewSettings,
  accountOn: boolean,
): MembershipRowView["track"] {
  const on = organizationTracked(uuid, entry, settings);
  const home = settings === null ? null : homeMembershipOf(settings);
  const isHomeOrg = home !== null && home.organizationUuid === uuid;
  return {
    on,
    canToggle: settings !== null && home !== null && !isHomeOrg,
    title: isHomeOrg
      ? HOME_LOCK
      : settings !== null && home === null
        ? ORGANIZATION_TRACK_TITLE.noHome
        : !accountOn
          ? ORGANIZATION_TRACK_TITLE.accountExcluded
          : on
            ? ORGANIZATION_TRACK_TITLE.on
            : ORGANIZATION_TRACK_TITLE.off,
  };
}

function byTitle(a: AccountCardView, b: AccountCardView): number {
  const x = a.title.toLowerCase();
  const y = b.title.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return byCodeUnit(a.title, b.title) || byCodeUnit(a.key, b.key);
}

// #621's matcher: the Account's title, its user label, its email and its
// Organizations' labels, case-insensitive; an empty query matches every card.
export function matchAccountCard(card: AccountCardView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const fields = [card.title, card.userLabel ?? "", card.email ?? ""];
  if (fields.some((f) => f.toLowerCase().includes(q))) return true;
  return card.memberships.some((m) => m.label.toLowerCase().includes(q));
}

export function filterAccountCards(
  cards: readonly AccountCardView[],
  query: string,
): AccountCardView[] {
  return cards.filter((card) => matchAccountCard(card, query));
}

export function accountsView(input: AccountsViewInput): AccountsView {
  const { accounts, keys, roster, settings, hub, nowMs } = input;
  const entries = accounts.accounts;
  const rosterBy = new Map((roster?.organizations ?? []).map((o) => [o.uuid, o]));
  const labels = displayOrganizationLabels(roster?.organizations ?? []);
  const home = settings === null ? null : homeMembershipOf(settings);
  const heldKeys = new Map((keys?.keys ?? []).map((k) => [k.accountUuid, k.connection]));
  const legacy = keys?.legacy ?? null;
  const sourceBy = new Map((input.sources?.accounts ?? []).map((s) => [s.key, s]));
  const gatewayHost = new Map((input.gateways?.gateways ?? []).map((g) => [g.id, g.urlHost]));
  const titles = new Map(entries.map((e) => [e.key, accountTitle(e).title]));
  const assignedBy = new Map<string, number>();
  for (const uuid of Object.values(input.assertions?.assertions ?? {})) {
    assignedBy.set(uuid, (assignedBy.get(uuid) ?? 0) + 1);
  }

  const cardOf = (entry: AccountEntry, foldable: boolean): AccountCardView => {
    const { title, sub, userLabel } = accountTitle(entry);
    const email = emailOf(entry);
    const accountUuid = entry.accountUuid;
    const local = accountUuid === null ? null : (heldKeys.get(accountUuid) ?? null);
    const legacyHere =
      accountUuid !== null &&
      local === null &&
      legacy !== null &&
      legacy.accountUuid === accountUuid;
    const state = effectiveConnection(entry);
    const tracked = accountTracked(entry, settings);
    const isHomeAccount = home !== null && home.accountUuid === entry.key;
    const canToggleAccount =
      settings !== null && home !== null && settings.trackedAccounts !== null && !isHomeAccount;
    const action = keyAction(entry, state);
    const memberships = entry.memberships.map((m) =>
      membershipRow(m, entry, tracked, action === "Reconnect"),
    );
    const holdsHome = memberships.some((m) => m.home);
    const holdsNew = memberships.some((m) => m.isNew);
    const source = sourceBy.get(entry.key);
    const hubHoldsKey = hub.hubSourced && !entry.pending && entry.connection !== "disconnected";
    const setAt = accountUuid === null ? undefined : input.keySetAt?.get(accountUuid);
    const orgPart =
      memberships.length === 1
        ? memberships[0]!.label
        : `${memberships.length} Organizations, ${memberships.filter((m) => m.track.on).length} tracked`;
    return {
      key: entry.key,
      accountUuid,
      provider: providerOf(entry),
      pending: entry.pending,
      avatar: entry.pending
        ? { letter: PENDING_AVATAR, dashed: true }
        : { letter: accountMark(entry), dashed: false },
      title,
      sub,
      userLabel,
      email,
      connection: entry.pending
        ? null
        : {
            state,
            text: (hub.hubSourced ? HUB_CONNECTION_WORDS : CONNECTION_WORDS)[state],
            tone: connectionTone(state),
          },
      action,
      track: {
        on: tracked,
        canToggle: canToggleAccount,
        title: isHomeAccount
          ? HOME_LOCK
          : settings !== null && home === null
            ? ACCOUNT_TRACK_TITLE.noHome
            : tracked
              ? ACCOUNT_TRACK_TITLE.on
              : ACCOUNT_TRACK_TITLE.off,
      },
      tools: {
        rename: entry.pending ? null : userLabel !== null ? "Rename" : "Label",
        disconnect:
          local !== null && accountUuid !== null
            ? { kind: "account", accountUuid }
            : legacyHere
              ? { kind: "legacy" }
              : null,
        keySet:
          local !== null && setAt !== undefined
            ? `key set ${formatWallDayMonth(setAt, input.display)}`
            : null,
        localKey:
          !hub.hubSourced || entry.pending
            ? null
            : local === null && !legacyHere
              ? LOCAL_KEY_WORDS.none
              : LOCAL_KEY_WORDS.held,
      },
      usePct: accountUse(entry, nowMs),
      seenThrough: seenThrough(source, gatewayHost),
      hubHoldsKey,
      disconnectNote: hubHoldsKey && hub.hubHost !== null ? disconnectNote(hub.hubHost) : null,
      memberships,
      holdsHome,
      holdsNew,
      fold: {
        foldable,
        openByDefault: !foldable || action !== null || holdsNew || holdsHome,
        line: `${email ?? title} · ${orgPart}`,
      },
    };
  };

  const membershipRow = (
    m: AccountMembership,
    entry: AccountEntry,
    accountOn: boolean,
    reconnect: boolean,
  ): MembershipRowView => {
    const rosterEntry = rosterBy.get(m.organizationUuid);
    const others = entries
      .filter((e) => e.key !== entry.key)
      .filter((e) => e.memberships.some((x) => x.organizationUuid === m.organizationUuid))
      .map((e) => titles.get(e.key)!);
    return {
      organizationUuid: m.organizationUuid,
      label: organizationLabel(labels, m.organizationUuid),
      bareLabel: rosterEntry?.label ?? organizationLabel(new Map(), m.organizationUuid),
      renamed: rosterEntry?.renamed ?? false,
      defaultLabel: rosterEntry?.plan ?? `Organization ${m.organizationUuid.slice(0, 8)}`,
      plan: rosterEntry?.plan ?? null,
      isNew: rosterEntry !== undefined && isNewOrganization(rosterEntry, input.lastOpenedAt),
      also: others.length === 0 ? null : `also ${others.join(", ")}`,
      assigned: assignedWordsOrNull(assignedBy.get(m.organizationUuid) ?? 0),
      read: readNote(m, reconnect, nowMs),
      home: m.home,
      track: organizationTrack(m.organizationUuid, rosterEntry, settings, accountOn),
    };
  };

  // Providers, in first-seen order; Claude alone today (`providerOf`). With
  // no Account at all, Claude's section still shows, to add the first.
  const providerIds: ProviderId[] = entries.length === 0 ? ["anthropic"] : [];
  for (const e of entries) {
    const p = providerOf(e);
    if (!providerIds.includes(p)) providerIds.push(p);
  }
  const two = providerIds.length > 1;

  const providers = providerIds.map((provider): ProviderSectionView => {
    const all = entries.filter((e) => providerOf(e) === provider);
    const foldable = all.length > CARDS_FOLD_PAST;
    const cards = all.map((e) => cardOf(e, foldable));
    const tracked = cards.filter((c) => c.track.on);
    const off = cards.filter((c) => !c.track.on).map((c) => unfoldable(c));
    const ranked = rankAccounts(
      tracked.map((card) => ({ card, usePct: card.usePct, label: card.title, key: card.key })),
      "used",
    ).map((r) => r.card);
    off.sort(byTitle);
    return {
      provider,
      name: PROVIDER_NAMES[provider],
      showMark: two,
      addAccount: PROVIDER_SECTION.addAccount,
      description: PROVIDER_SECTION.description,
      filterPlaceholder: foldable ? filterPlaceholder(all.length) : null,
      cards: ranked,
      notTracked:
        off.length === 0
          ? null
          : {
              title: NOT_TRACKED.title(off.length),
              hint: NOT_TRACKED.hint,
              hasNew: off.some((c) => c.holdsNew),
              foldedByDefault: off.length > NOT_TRACKED_FOLD_PAST,
              cards: off,
            },
    };
  });

  return {
    eyebrow: entries.length > 1 ? ACCOUNTS_EYEBROW.many : ACCOUNTS_EYEBROW.one,
    strips: strips(input, providers),
    // No Home membership: the sidecar excludes nothing, and a pick would
    // narrow every set (`homeMembershipPatch` refuses it), so no select.
    home:
      entries.length <= 1 || home === null
        ? null
        : {
            title: HOME_SECTION.title,
            description: HOME_SECTION.description,
            selects: providers.map((p) => homeSelect(p, two, home, labels, rosterBy)),
          },
    providers,
    gateways: gatewaysView(input, titles),
  };
}

function assignedWordsOrNull(n: number): string | null {
  return n === 0 ? null : assignedWords(n);
}

// A Not tracked row is compact and never folds.
function unfoldable(card: AccountCardView): AccountCardView {
  return { ...card, fold: { ...card.fold, foldable: false, openByDefault: false } };
}

function readNote(m: AccountMembership, reconnect: boolean, nowMs: number): ReadNoteView | null {
  if (m.stale) {
    const pct = m.current === null ? null : mostUsedWindow(m.current, nowMs)?.utilizationPct;
    const age = agoWords(m.lastReadAt ?? m.current?.capturedAt ?? null, nowMs);
    const text =
      m.current === null
        ? STALE_NONE
        : ["Last reading", pct == null ? null : `${Math.round(pct)}%`]
            .filter((x) => x !== null)
            .join(" ") + (age === null ? "" : ` · ${age}`);
    return { kind: "stale", text, title: null, reconnect };
  }
  if (m.readability === "unreadable") {
    return { kind: "unreadable", text: UNREADABLE_PILL, title: UNREADABLE_TITLE, reconnect: false };
  }
  return null;
}

function seenThrough(
  source: AccountSourcesResponse["accounts"][number] | undefined,
  hosts: ReadonlyMap<string, string>,
): string | null {
  if (source === undefined) return null;
  const via = source.gateways.flatMap((id) => {
    const host = hosts.get(id);
    return host === undefined ? [] : [host];
  });
  if (source.login && via.length > 0) return SEEN_THROUGH.both(via);
  if (source.login) return SEEN_THROUGH.login;
  if (via.length > 0) return SEEN_THROUGH.gateway(via);
  return null;
}

function strips(input: AccountsViewInput, providers: readonly ProviderSectionView[]): StripView[] {
  const out: StripView[] = [];
  const keys = input.keys;
  const legacy = keys?.legacy ?? null;
  // ADR-0138 §12: an expired legacy key not yet filed under an Account it
  // holds a key for is one unnamed Reconnect.
  if (
    legacy !== null &&
    legacy.connection === "expired" &&
    !(keys?.keys ?? []).some((k) => k.accountUuid === legacy.accountUuid)
  ) {
    out.push({ kind: "legacy", ...LEGACY_STRIP });
  }
  const expired = providers
    .flatMap((p) => [...p.cards, ...(p.notTracked?.cards ?? [])])
    .filter((c) => c.action === "Reconnect");
  if (expired.length > 0) {
    out.push({
      kind: "reconnect",
      headline: reconnectHeadline(expired.length),
      accounts: expired.map((c) => ({ key: c.key, label: c.title })),
      tail: RECONNECT_STRIP_TAIL,
    });
  }
  if (input.hub.hubSourced && input.hub.hubHost !== null) {
    out.push({
      kind: "hub",
      lead: HUB_STRIP.lead,
      host: input.hub.hubHost,
      tail: HUB_STRIP.tail,
      sendKeys: {
        label: HUB_STRIP.sendKeysLabel,
        title: HUB_STRIP.sendKeysTitle,
        on: input.hub.autoHeal,
      },
    });
  }
  return out;
}

function homeSelect(
  provider: ProviderSectionView,
  two: boolean,
  home: ReturnType<typeof homeMembershipOf>,
  labels: ReadonlyMap<string, string>,
  rosterBy: ReadonlyMap<string, OrganizationEntry>,
): HomeSelectView {
  // The Memberships of tracked Accounts that are not Pending, in card order.
  const options: HomeOptionView[] = provider.cards
    .filter((c) => !c.pending && c.accountUuid !== null)
    .flatMap((c) =>
      c.memberships.map((m) => ({
        organizationUuid: m.organizationUuid,
        accountUuid: c.accountUuid,
        label: homeOptionLabel(m.label, c.title, m.plan),
        selected:
          home !== null &&
          home.organizationUuid === m.organizationUuid &&
          home.accountUuid === c.accountUuid,
      })),
    );
  if (home !== null && !options.some((o) => o.selected)) {
    const holder = provider.cards.find((c) => c.key === home.accountUuid);
    options.unshift({
      organizationUuid: home.organizationUuid,
      accountUuid: home.accountUuid,
      label: homeOptionLabel(
        organizationLabel(labels, home.organizationUuid),
        holder?.title ?? ACCOUNT_NOT_KNOWN,
        rosterBy.get(home.organizationUuid)?.plan ?? null,
      ),
      selected: true,
    });
  }
  return {
    provider: provider.provider,
    providerName: provider.name,
    showMark: two,
    options,
  };
}

// "‹Organization› · ‹Account› (‹plan›)"; no plan word, no parenthesis. A label
// that already is its plan word does not repeat it.
export function homeOptionLabel(
  organization: string,
  account: string,
  plan: string | null,
): string {
  const head = `${organization} · ${account}`;
  return plan === null || plan === organization ? head : `${head} (${plan})`;
}

function gatewaysView(input: AccountsViewInput, titles: ReadonlyMap<string, string>): GatewaysView {
  const held = new Map<string, string[]>();
  for (const source of input.sources?.accounts ?? []) {
    const title = titles.get(source.key);
    if (title === undefined) continue;
    for (const id of source.gateways) held.set(id, [...(held.get(id) ?? []), title]);
  }
  return {
    title: GATEWAYS_SECTION.title,
    connect: GATEWAYS_SECTION.connect,
    remove: GATEWAYS_SECTION.remove,
    rows: (input.gateways?.gateways ?? []).map((g) => {
      const age = agoWords(g.lastRecordAt, input.nowMs);
      return {
        id: g.id,
        host: g.urlHost,
        state: g.state,
        stateText: GATEWAY_STATE_WORDS[g.state],
        // The shared tone (#676): a Gateway that cannot be drained is red, as
        // on the hub tray app's card and both terminals' `status`.
        tone: GATEWAY_STATE_TONE[g.state],
        lastRecord: age === null ? null : `last record ${age}`,
        drainedByHub: g.drainedBy === "hub" ? GATEWAY_DRAINED_BY_HUB : null,
        accounts: [...(held.get(g.id) ?? [])].sort((a, b) =>
          a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0,
        ),
      };
    }),
  };
}
