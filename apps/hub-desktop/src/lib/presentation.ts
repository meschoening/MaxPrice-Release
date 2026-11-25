import {
  GATEWAY_STATE_TONE,
  GATEWAY_STATE_WORDS,
  type GatewayStateTone,
  byCodeUnit,
  clientFacingHost,
  displayOrganizationLabels,
  formatRelativeTime,
  hasNonLoopbackBind,
  hubAccountLabel,
  hubDaemonDot,
  hubDaemonLabel,
  hubKeyClause,
  hubKeyPending,
  hubMembershipState,
  isDeliberateLoopback,
  mostUsedWindow,
  noFreshReading,
  rankMemberships,
  resolveMergeTarget,
  resolveOrganizationLabel,
  usageConnectionDot,
  usageConnectionShortLabel,
  type FirewallVerdict,
  type GatewayState,
  type HubAccount,
  type HubClient,
  type HubDaemonState,
  type HubKeyRow,
  type HubMachine,
  type HubMembershipState,
  type HubOrganization,
  type HubRowStatus,
  type LabelEntry,
} from "@maxprice/shared";
import { dotVariant } from "./dot-variant";

// An IPv6 host (the Tailscale ULA, fd7a:…) must be bracketed so a `host:port`
// render is unambiguous AND paste-able back into Settings (`new URL` rejects an
// unbracketed v6 authority). A v4 host or a hostname passes through untouched.
function bracketHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

export function formatListenAddr(hubUrl: string): string {
  try {
    const u = new URL(hubUrl);
    const host = bracketHost(u.hostname);
    return u.port ? `${host}:${u.port}` : host;
  } catch {
    return "—";
  }
}

// The Listening row (ADR-0038): the CLIENT-FACING address — what other
// machines type into Settings — not the console's own loopback URL. Its host
// is clientFacingHost's, the rule the Headless Hub setup's join address
// shares (ADR-0128 §5), and a loopback-only bind shows its first host. Every
// bind shares one port (the daemon serves all hosts on config.port), so the
// port comes from the loopback hub URL. Falls back to the old URL-only render
// for a pre-0038 daemon.
export function formatListening(
  bindHosts: string[] | undefined,
  hubUrl: string | undefined,
): string {
  const hosts = bindHosts ?? [];
  const [first] = hosts;
  if (first === undefined) return hubUrl !== undefined ? formatListenAddr(hubUrl) : "—";
  const host = clientFacingHost(hosts) ?? first;
  let port = "";
  if (hubUrl !== undefined) {
    try {
      port = new URL(hubUrl).port;
    } catch {
      // fall through — host alone
    }
  }
  const shown = bracketHost(host);
  return port !== "" ? `${shown}:${port}` : shown;
}

// The Windows-firewall warning gate (ADR-0038): only a hub that WANTS inbound
// (non-loopback bind) with a positively-blocked verdict warns. "unsupported"
// (non-Windows) and an unavailable check (pending/errored) stay silent — the
// warning must never train the operator to ignore it.
export function showFirewallWarning(
  bindHosts: string[] | undefined,
  check: FirewallVerdict | undefined,
): boolean {
  return hasNonLoopbackBind(bindHosts) && check === "blocked";
}

// ── Starts at login (ADR-0051) ───────────────────────────────────────────────
//
// The five states the `autostart_status` Tauri command can report. Like the
// firewall verdict (`FirewallVerdict`, @maxprice/shared), the union is declared
// once so the query and the presentation narrow to the same one.
export type AutostartState =
  | "on" // a Run value naming THIS exe
  | "disabled-by-user" // switched off in Task Manager's Startup tab
  | "not-registered" // no entry, or one naming some other exe
  | "dev-build" // running out of the build tree, which owns no entry by design
  | "unsupported"; // not Windows / no Tauri host

// The row's text, and whether it reads as a warning. `null` ⇒ render no row at
// all: on a platform where we don't manage the login entry, and in the
// standalone-Vite debug renderer, an autostart row would be inventing a fact.
//
// The hub is an ALWAYS-ON daemon whose whole job assumes it survives a reboot,
// so "no" is worth a colour — but only where it contradicts intent. A Task
// Manager opt-out is the operator's own decision (ADR-0051 honours it rather
// than silently overriding it, as every launch used to), and a dev build owns
// no entry on purpose; neither is a problem, so neither is tinted.
export function autostartRow(state: AutostartState): { value: string; warn: boolean } | null {
  switch (state) {
    case "on":
      return { value: "Yes", warn: false };
    case "disabled-by-user":
      return { value: "No — disabled in Task Manager", warn: false };
    case "not-registered":
      return { value: "No — not registered", warn: true };
    case "dev-build":
      return { value: "No — dev build", warn: false };
    case "unsupported":
      return null;
  }
}

// ── Tray tooltip (ADR-0049) ──────────────────────────────────────────────────

// The tray tooltip, composed whole and passed verbatim to the Rust
// `set_tray_tooltip` (ADR-0049) — which takes a finished string and sets it, no
// longer interpreting a status token through a four-arm match that held a
// second copy of this vocabulary in another language. The words now live in one
// language, covered by this module's tests. The tray is the only hub UI while
// the window is hidden — and the tray app autostarts — so it must carry BOTH
// facts, not just one.
//
// Its key clauses are the key rows' (@maxprice/shared's hubKeyClause, #614
// §11): one per Provider whose row is not good, so the rows and the tooltip
// share one vocabulary. One key keeps today's clause (`· key expired`);
// several are named by host (`· claude.ai: 1 key expired`). Windows shows a
// tray tooltip whole up to 63 characters (tray-icon sets no cbSize, #646);
// the words stay within it (the test measures the longest).
export function trayTooltip(state: HubDaemonState, rows: readonly HubKeyRow[] | undefined): string {
  const head = `MaxPrice Hub — ${hubDaemonLabel(state).toLowerCase()}`;
  if (noFreshReading(state) || rows === undefined) return head;
  const clauses = rows.map(hubKeyClause).filter((clause) => clause !== null);
  return [head, ...clauses].join(" · ");
}

// ── Tray icon tone (ADR-0148 §3) ─────────────────────────────────────────────

// The tray icon's tone, which the macOS menu-bar icon carries (Map 9, #755):
// the popout's Hub row dot, by the same two helpers HubStatusRows calls, so the
// icon and the row never disagree. A deliberate loopback bind is soft there and
// here. Rust's `set_tray_tone` reads these four words; Windows keeps its orb.
export type TrayTone = ReturnType<typeof dotVariant>;

export function trayTone(state: HubDaemonState, status: HubRowStatus | undefined): TrayTone {
  return dotVariant(hubDaemonDot(state, isDeliberateLoopback(status)));
}

// Live first, then most-recently-seen. ISO-8601 strings compare lexicographi-
// cally in time order, so localeCompare is order-equivalent. Non-mutating.
export function sortClients(clients: HubClient[]): HubClient[] {
  return [...clients].sort(
    (a, b) => Number(b.live) - Number(a.live) || b.lastSeenAt.localeCompare(a.lastSeenAt),
  );
}

export function shortMachineId(id: string): string {
  return id.slice(0, 8);
}

export function clientPrimaryLabel(client: HubClient): string {
  if (client.hostname !== null && client.hostname.length > 0) return client.hostname;
  return shortMachineId(client.machineId);
}

export function clientStateDot(live: boolean): string {
  return live ? "bg-good" : "bg-soft";
}

// ── Machines card (ADR-0041 M7) ──────────────────────────────────────────────

// Live first, then most-recently-seen (nulls last), then name — the roster's
// sort generalized to nullable lastSeenAt.
export function sortMachines(machines: HubMachine[]): HubMachine[] {
  return [...machines].sort(
    (a, b) =>
      Number(b.live ?? false) - Number(a.live ?? false) ||
      (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "") ||
      a.name.localeCompare(b.name),
  );
}

export function machineStateDot(m: HubMachine): string {
  return (m.live ?? false) ? "bg-good" : "bg-soft";
}

// Share posture, derived — never on the wire (the hub is never told toggle
// state; ADR-0041). lastPushAt is since-daemon-start (in-memory, like the
// roster): after a hub restart an idle-but-synced sharer reads "not sharing"
// until its next push — accepted, the roster's documented posture.
export function machinePosture(m: HubMachine): string | null {
  if ((m.eventCount ?? 0) === 0) return "never shared";
  if ((m.lastPushAt ?? null) === null) return "not sharing";
  return null;
}

// The purge inset's "recent events will return unless sharing is off" gate.
export function stillSharing(m: HubMachine): boolean {
  return (m.live ?? false) && (m.lastPushAt ?? null) !== null;
}

// Transitive mergedInto resolution (cycle-guarded), delegating to the shared
// resolver (ADR-0041). Null when unmerged or the chain dangles (its target was
// purged — the row renders standalone again). Resolves from m.mergedInto (not
// m's own id) so a self-referential cycle a→b→a still names b, the historical
// behavior. The shared resolver returns the terminal ID; we map it to a NAME,
// null when that machine isn't in the directory (dangling).
export function resolveMergeTargetName(m: HubMachine, all: HubMachine[]): string | null {
  if (m.mergedInto === null) return null;
  const targetId = resolveMergeTarget(all, m.mergedInto);
  const target = all.find((x) => x.machineId === targetId);
  return target?.name ?? null;
}

// "live · pushed 2m ago" / "seen 1h ago · not sharing" / "not seen since hub
// start · never shared". Merged rows show the alias instead of posture.
export function machineSubline(m: HubMachine, now: number, all: HubMachine[] = []): string {
  const liveness =
    (m.live ?? false)
      ? "live"
      : (m.lastSeenAt ?? null) !== null
        ? `seen ${formatRelativeTime(m.lastSeenAt ?? null, now)}`
        : "not seen since hub start";
  const merged = m.mergedInto !== null ? resolveMergeTargetName(m, all) : null;
  if (merged !== null) return `${liveness} · merged into ${merged}`;
  const parts = [liveness];
  if ((m.lastPushAt ?? null) !== null)
    parts.push(`pushed ${formatRelativeTime(m.lastPushAt ?? null, now)}`);
  const posture = machinePosture(m);
  if (posture !== null) parts.push(posture);
  return parts.join(" · ");
}

// ── Organizations (#294) ─────────────────────────────────────────────────────

// uuid → the Organization label to render, by the shared rule: labels that
// match case-insensitively all carry their uuid's first 8.
export function organizationLabels(rows: readonly HubOrganization[]): Map<string, string> {
  return displayOrganizationLabels(rows);
}

// Whether one held key's last listing names a row (ADR-0139 §9): an
// Account's key by the row's `listedBy`; the unmoved legacy key, which
// `listedBy` never names, by its own entry's Memberships, which are its
// listing's Organizations (and only those: no event tag names a legacy key).
function listedByKey(row: HubOrganization, key: HubAccount): boolean {
  if (key.accountUuid === null) return key.memberships.some((m) => m.organizationUuid === row.uuid);
  return row.listedBy.includes(key.accountUuid);
}

// What one held key discovered: the rows its listing names, in roster order.
// Nothing while the key has no answer (`disconnected`), as the single key's
// card always read it.
export function keyOrganizations(
  rows: readonly HubOrganization[] | undefined,
  key: HubAccount,
): HubOrganization[] {
  if (rows === undefined || key.connection === "disconnected") return [];
  return rows.filter((row) => listedByKey(row, key));
}

// The account card's Organization row: none → an em dash, one → its label,
// more → a count.
export function accountOrganizationValue(
  discovered: readonly HubOrganization[],
  labels: Map<string, string>,
): string {
  const [first] = discovered;
  if (first === undefined) return "—";
  if (discovered.length === 1) return labels.get(first.uuid) ?? first.label;
  return `${formatCount(discovered.length)} organizations`;
}

// An Organization's label on the console: the roster's display label (a
// collision suffix included), else the default an unlabelled Organization
// resolves to.
export function organizationLabelOf(uuid: string, labels: Map<string, string>): string {
  return (
    labels.get(uuid) ??
    resolveOrganizationLabel({ uuid, rename: null, login: null, hints: null }).label
  );
}

// ── The Accounts card (#614 §1–§7) ───────────────────────────────────────────

// Whether the console keeps today's Claude account card (#614 §7): a Hub
// that knows no Account yet, or a single Account with at most one
// Membership. Anything more gets the Accounts card.
export function todayAccountLook(accounts: readonly HubAccount[] | undefined): boolean {
  const all = accounts ?? [];
  return all.length === 0 || (all.length === 1 && all[0]!.memberships.length <= 1);
}

// An Account's state on its row: today's short words (Connected, Key expired,
// Poll failing, No key), and `Not read yet` for a key held but not yet read
// (`hubKeyPending`), which is no missing key.
export function accountState(account: HubAccount): { text: string; dot: string | null } {
  if (hubKeyPending(account)) return { text: "Not read yet", dot: null };
  return {
    text: usageConnectionShortLabel(account.connection),
    dot: usageConnectionDot(account.connection),
  };
}

// Whether an Account needs a key (#614 §1, §5): one whose key does not work,
// or that has none. A key pending its first read does not.
export function accountNeedsKey(account: HubAccount): boolean {
  return account.connection !== "connected" && !hubKeyPending(account);
}

// The card head's count (#614 §1): `5`, or `5 · 2 need a key`.
export function accountsHead(accounts: readonly HubAccount[]): string {
  const need = accounts.filter(accountNeedsKey).length;
  const count = formatCount(accounts.length);
  if (need === 0) return count;
  return `${count} · ${formatCount(need)} ${need === 1 ? "needs" : "need"} a key`;
}

// One Membership line of an Account row: its Organization, label and state.
export type AccountMembershipLine = {
  organizationUuid: string;
  label: string;
  state: HubMembershipState;
  // The highest live percent, for the fold's `none above X%`.
  peak: number | null;
};

// An Account's Memberships, ranked by the one most used ordering (#610,
// `rankMemberships`), each with its line's words.
export function accountMembershipLines(
  account: HubAccount,
  labels: Map<string, string>,
  nowMs: number,
): AccountMembershipLine[] {
  const ranked = rankMemberships(
    account.memberships.map((membership) => ({
      membership,
      key: membership.organizationUuid,
      label: organizationLabelOf(membership.organizationUuid, labels),
      connection: account.connection,
      limits: membership.limits,
      reading: membership.current ?? null,
    })),
    nowMs,
  );
  return ranked.map((m) => ({
    organizationUuid: m.key,
    label: m.label,
    state: hubMembershipState(account.connection, m.membership, nowMs),
    peak: mostUsedWindow(m.reading, nowMs)?.utilizationPct ?? null,
  }));
}

// The Accounts in the card's order (#614 §2): those needing a key first, then
// by their most used Membership, then by label.
export function rankHubAccounts(
  accounts: readonly HubAccount[],
  accountLabels: Readonly<Record<string, LabelEntry>> | undefined,
  nowMs: number,
): HubAccount[] {
  const keyed = accounts.map((account) => ({
    account,
    need: accountNeedsKey(account),
    peak: Math.max(
      Number.NEGATIVE_INFINITY,
      ...account.memberships.map(
        (m) => mostUsedWindow(m.current ?? null, nowMs)?.utilizationPct ?? Number.NEGATIVE_INFINITY,
      ),
    ),
    label: hubAccountLabel(account.accountUuid, accountLabels),
  }));
  keyed.sort(
    (a, b) =>
      Number(b.need) - Number(a.need) ||
      (b.peak === a.peak ? 0 : b.peak > a.peak ? 1 : -1) ||
      byCodeUnit(a.label, b.label) ||
      byCodeUnit(a.account.accountUuid ?? "", b.account.accountUuid ?? ""),
  );
  return keyed.map((k) => k.account);
}

// The fold past the first lines (#614 §3): `4 more, none above 30%`, or
// `4 more` when none of them holds a live window.
export function membershipFold(rest: readonly AccountMembershipLine[]): string {
  const peaks = rest.map((m) => m.peak).filter((p): p is number => p !== null);
  const head = `${formatCount(rest.length)} more`;
  return peaks.length === 0 ? head : `${head}, none above ${Math.round(Math.max(...peaks))}%`;
}

// ── The Machines card's Home lines (#614 §6) ─────────────────────────────────

// What the Home lines need: the Organization labels, the Account labels, and
// whether the Provider has several Accounts (then the Account is named).
export type HomeLineContext = {
  organizations: Map<string, string>;
  accountLabels: Readonly<Record<string, LabelEntry>> | undefined;
  severalAccounts: boolean;
};

// The Home lines are shown once the console knows more than one Organization
// or more than one Account (#614 §6); with one of each there is nothing to
// tell apart, and today's card shows no line. Null hides every line.
export function homeLineContext(
  rows: readonly HubOrganization[] | undefined,
  machines: readonly HubMachine[],
  accounts: readonly HubAccount[] | undefined,
  accountLabels: Readonly<Record<string, LabelEntry>> | undefined,
): HomeLineContext | null {
  const severalAccounts = (accounts ?? []).length > 1;
  if (knownOrganizationCount(rows, machines) <= 1 && !severalAccounts) return null;
  return { organizations: organizationLabels(rows ?? []), accountLabels, severalAccounts };
}

// The Home line count is what the console knows: every row's uuid, listed
// or directory-only, joined with every machine's published Home membership's
// Organization (ADR-0139 §6). The Hub's directory holds renames only, so
// counting it alone would hide every Home.
export function knownOrganizationCount(
  rows: readonly HubOrganization[] | undefined,
  machines: readonly HubMachine[],
): number {
  const known = new Set((rows ?? []).map((row) => row.uuid));
  for (const machine of machines) {
    const home = machine.homeMemberships?.anthropic?.organizationUuid ?? null;
    if (home !== null) known.add(home);
  }
  return known.size;
}

// A machine's Home line per Provider (#614 §6), `Home: Acme Team`, or with
// several Accounts `Home: Work · Acme Team`; a machine that published none
// reads `Home: not set`. v7 carries one Provider, so one line.
export function machineHomeLines(machine: HubMachine, context: HomeLineContext): string[] {
  const home = machine.homeMemberships?.anthropic ?? null;
  if (home === null) return ["Home: not set"];
  const organization = organizationLabelOf(home.organizationUuid, context.organizations);
  if (!context.severalAccounts || home.accountUuid === null) return [`Home: ${organization}`];
  return [`Home: ${hubAccountLabel(home.accountUuid, context.accountLabels)} · ${organization}`];
}

// ── The Gateways card (ADR-0141 §8) ─────────────────────────────────────────

// A Gateway's state as its drainer last found it, in the shared words and
// glass dot variant (packages/shared's `gateway-words.ts`, #673).
export function gatewayState(state: GatewayState): { text: string; dot: GatewayStateTone } {
  return { text: GATEWAY_STATE_WORDS[state], dot: GATEWAY_STATE_TONE[state] };
}

// The row's subline: the age of the Gateway's newest drained record.
export function gatewayLastRecord(lastRecordAt: string | null, now: number): string {
  return lastRecordAt === null
    ? "No record yet"
    : `Last record ${formatRelativeTime(lastRecordAt, now)}`;
}

// ── Archive rows + hygiene (M7, #41) ─────────────────────────────────────────

// Grouped integer render (the mock's `12,847` / `8,921` — en-US so the
// grouping is stable regardless of host locale, like every other formatter).
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  let value = n;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
