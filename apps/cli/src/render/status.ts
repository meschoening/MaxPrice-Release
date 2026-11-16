import {
  accountFilterVisible,
  type AccountsResponse,
  displayOrganizationLabels,
  formatRelativeTime,
  gatewayUrlHost,
  GATEWAY_STATE_TONE,
  type GatewayStateTone,
  type HomeMembership,
  hubConnectionLabel,
  LIMIT_STATE_WORDS,
  type LocalGatewaysResponse,
  membershipWindows,
  organizationLabelMap,
  trackedScopeMemberships,
  usageConnectionLabel,
  type BootProgress,
  type HubConnection,
  type OrganizationUsageStatus,
  type OrganizationsResponse,
  type PricingStatus,
  type StatusSnapshot,
  type UsageConnection,
  type UsageKeysResponse,
  type UsageOrganizations,
  type WindowState,
} from "@maxprice/shared";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { type UpdateCheckRead, updateRow } from "@maxprice/usage-core/update-check";
import { doubleJoinWarning } from "../double-join";
import { type SecretsHealth, sessionKeyCount, sessionKeySetAts } from "../secrets";
import type { RejectedField, SettingsHealth } from "../settings";
import { count, plural } from "./count";
import { gatewayRows, gatewayStatusDetail, lastRecordText } from "./gateways";
import { type KeyRow, keyRows, setAtText } from "./keys";
import { type MembershipRow, rankedMembershipRows } from "./membership-limits";
import type { Paint, Style } from "./style";

// `maxprice status`'s checklist (#445's Variant B): one row per part of the
// daemon, each marked and, where the user has a fix, naming the command for
// it. Pure: the command does the reads, and every mark comes from the one
// status snapshot it hands in.
//
//   ✓ Daemon   running 0.8.4 · ~/.local/share/maxprice/daemon.sock
//   ✗ Hub      Hub version mismatch — update both apps; polling locally   → maxprice update
//              Pro plan (Home): 5h active, wk active
//   ! Update   0.9.0 available   → maxprice update
//
// A row is its glyph, its label padded to the longest label plus two, its
// detail, then `   → <remedy>` when it has one. An Organization row has no
// glyph and no label, so its detail starts in the detail column. Nothing is
// truncated.
//
// No row shows any part of a session key, a Gateway's management key or the
// Hub password, not even its last four characters (ADR-0121 §9): only
// whether each is set, and when a key was.

export type Mark = "ok" | "warn" | "bad" | "off";

type Row = { mark: Mark | null; label: string; detail: string; remedy?: string };

// A daemon answer `status` reads beside `/api/status`, or why it could not
// be read: an `{error}` envelope, an answer that does not parse, or no answer
// within the probe's 3 s. Each such read costs only its own lines.
export type Unavailable = { unavailable: string };
export type Read<T> = T | Unavailable;

function readable<T extends object>(read: Read<T> | null): T | null {
  return read === null || "unavailable" in read ? null : read;
}

// The daemon's Organization roster; why it could not be read, which shows
// as one warning in place of the Organization lines; or null for none.
export type Roster = Read<OrganizationsResponse> | null;

export type StatusInput = {
  status: StatusSnapshot;
  // Already as a message shows it, `~` for the home.
  socket: string;
  roster: Roster;
  // `/api/accounts`, read once the scan is done where two or more Accounts
  // are tracked or two or more keys stored: the keys' labels, and the
  // Membership lines while two or more Accounts are tracked. Null when not
  // read.
  accounts?: Read<AccountsResponse> | null;
  // `/api/usage/keys`, read while secrets.json holds two or more session
  // keys or the unfiled one: each key's connection. Null when not read.
  keys?: Read<UsageKeysResponse> | null;
  // `/api/gateways`, read while secrets.json holds a Gateway. Null when not
  // read.
  gateways?: Read<LocalGatewaysResponse> | null;
  // The daemon's update-check.json (`readUpdateCheck`): its last check of the
  // channel, why the file cannot be used, or null for none yet.
  update: UpdateCheckRead;
  // What the Headless client's own settings.json holds that the schema
  // rejects, or why it cannot be read (`settingsHealth`).
  settings: SettingsHealth;
  // The Hub that settings.json names, its URL safe to show (`displayHubUrl`),
  // or null when it names none or cannot be read.
  hub: { url: string; autoHeal: boolean } | null;
  // secrets.json as `secretsHealth` reads it, and its path as a message
  // shows it.
  secrets: SecretsHealth;
  secretsPath: string;
  // The Desktop client's Hub (`desktopHubUrl`), or null.
  desktopHubUrl: string | null;
  now: number;
  style: Style;
};

// Each mark's glyph and the paint it takes when colour is on.
const MARKS: Record<Mark, { glyph: string; paint: (s: Style) => Paint }> = {
  ok: { glyph: "✓", paint: (s) => s.green },
  warn: { glyph: "!", paint: (s) => s.yellow },
  bad: { glyph: "✗", paint: (s) => s.red },
  off: { glyph: "–", paint: (s) => s.dim },
};

// A state's mark, and the command that fixes it when the user has one.
type Verdict = { mark: Mark; remedy?: string };

function daemonRow(status: StatusSnapshot, socket: string): Row {
  return { mark: "ok", label: "Daemon", detail: `running ${status.engineVersion} · ${socket}` };
}

// What a daemon still booting is doing (ADR-0067). `filesTotal: 0` is no
// denominator yet.
function bootPhrase(progress: BootProgress | undefined): string {
  if (progress?.phase === "merging") return "merging the fleet replica";
  if (progress === undefined || progress.filesTotal === 0) return "scanning";
  return `scanning · ${count(progress.filesParsed)} of ${plural(progress.filesTotal, "file")}`;
}

// Absent saturation means unknown, never healthy (ADR-0056).
function engineRow(status: StatusSnapshot): Row {
  const progress = status.bootProgress;
  const parts = status.ready
    ? [
        "ready",
        ...(progress === undefined ? [] : [plural(progress.filesTotal, "file")]),
        `watching ${plural(status.watchedPaths.length, "path")}`,
      ]
    : [bootPhrase(progress)];
  const degraded = [
    status.saturation === undefined
      ? "saturation not reported"
      : status.saturation.saturated
        ? "event loop saturated"
        : null,
    status.watcherDegraded ? "watcher stalled" : null,
    status.localArchiveDegraded ? "archive not writable" : null,
  ].filter((part) => part !== null);
  return {
    mark: status.ready && degraded.length === 0 ? "ok" : "warn",
    label: "Engine",
    detail: [...parts, ...degraded].join(" · "),
  };
}

// The Desktop client's usage dot (`usageConnectionDot`): an expired key is
// amber, "re-auth needed", not red.
const LIMITS: Record<UsageConnection, Verdict> = {
  connected: { mark: "ok" },
  expired: { mark: "warn", remedy: "maxprice key set" },
  error: { mark: "bad" },
  disconnected: { mark: "off", remedy: "maxprice key set" },
};

// `setAt`'s calendar date in this process's zone, as the Pricing line's
// capture date reads.
function localDate(iso: string): string {
  const date = new Date(Date.parse(iso));
  return date.toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
}

// ADR-0121 §9: when the session key was set, or that it is not. Several keys
// (one per Account, #633) are counted, with when the newest was set. A file
// that cannot be used gives no fact, rather than a guessed `not set`: its
// Secrets row says why.
function keyFact(health: SecretsHealth, now: number): string | null {
  if ("problem" in health) return null;
  const setAts = sessionKeySetAts(health.secrets);
  const newest = setAts.at(-1);
  if (newest === undefined) return "key not set";
  const when = `${localDate(newest)} (${formatRelativeTime(newest, now)})`;
  return setAts.length === 1 ? `key set ${when}` : `${setAts.length} keys set, newest ${when}`;
}

function limitsRow(status: StatusSnapshot, health: SecretsHealth, now: number): Row {
  const conn = status.usageConnection;
  const parts = [usageConnectionLabel(conn)];
  if (conn === "connected" && status.usageLastSampleAt !== null) {
    parts.push(`sampled ${formatRelativeTime(status.usageLastSampleAt, now)}`);
  }
  const key = keyFact(health, now);
  if (key !== null) parts.push(key);
  return { ...LIMITS[conn], label: "Limits", detail: parts.join(" · ") };
}

// ADR-0140 §6: the unfiled legacy key, expired.
export const UNFILED_EXPIRED = "Your saved key has expired; maxprice key set replaces it";

// ADR-0140 §4's header over the key lines while some Account's key is dead.
export function needReconnecting(dead: number): string {
  return dead === 1 ? "1 Account needs reconnecting" : `${dead} Accounts need reconnecting`;
}

// One key's line: its Account's label, the key's connection as the daemon
// holds it, and when it was set, with the command that reconnects a dead
// one. A key the daemon does not hold (the file changed since it read it)
// is not in use until it restarts.
function keyLine(row: KeyRow, now: number): Row {
  const set = `key set ${setAtText(row.setAt, now)}`;
  if (row.account === null && row.connection === "expired") {
    return { mark: "warn", label: "", detail: UNFILED_EXPIRED };
  }
  if (row.connection === null) {
    return {
      mark: "warn",
      label: "",
      detail: `${row.label}: not in use until the daemon restarts · ${set}`,
    };
  }
  const detail = `${row.label}: ${usageConnectionLabel(row.connection)} · ${set}`;
  return { ...LIMITS[row.connection], label: "", detail };
}

// ADR-0140 §4: one line per stored key, under a header while some Account's
// key is dead. With no key, or one, the Limits line is as it was: one line,
// the Limits connection, its sample's age and the key's fact; but the one
// key being the unfiled key, expired, which says so. The key lines need the
// keys' connections, so with none read the Limits line is as it was.
function limitsRows(input: StatusInput): Row[] {
  const { status, secrets: health, now } = input;
  const single = [limitsRow(status, health, now)];
  if ("problem" in health) return single;
  const keys = readable(input.keys ?? null);
  if (keys === null) return single;
  const accounts = readable(input.accounts ?? null)?.accounts ?? [];
  const rows = keyRows({ secrets: health.secrets, keys, accounts, hub: null });
  if (sessionKeyCount(health.secrets) <= 1) {
    const only = rows[0];
    if (only?.account === null && only.connection === "expired") {
      return [{ mark: "warn", label: "Limits", detail: UNFILED_EXPIRED }];
    }
    return single;
  }
  const dead = rows.filter((row) => row.account !== null && row.connection === "expired").length;
  const lines = rows.map((row) => keyLine(row, now));
  if (dead > 0) {
    return [{ mark: "warn", label: "Limits", detail: needReconnecting(dead) }, ...lines];
  }
  return lines.map((row, i) => (i === 0 ? { ...row, label: "Limits" } : row));
}

// #445's marks. `connecting` is not yet confirmed, so it warns; the wording
// is the Desktop client's own label, with the CLI's command beside it.
const HUB: Record<HubConnection, Verdict> = {
  off: { mark: "off", remedy: "maxprice hub join <url>" },
  connecting: { mark: "warn" },
  connected: { mark: "ok" },
  fallback: { mark: "warn" },
  keyless: { mark: "warn" },
  mismatch: { mark: "bad", remedy: "maxprice update" },
  unauthorized: { mark: "bad", remedy: "maxprice hub join <url> --password" },
};

// ADR-0121 §9: while settings.json names a Hub, its URL, whether a Hub
// password is set (left off while secrets.json cannot be used, as the key's
// fact is) and auto-heal follow the daemon's state. With none named, a stored
// password is ignored (ADR-0121 §3), so the row says nothing of it.
function hubRow(status: StatusSnapshot, hub: StatusInput["hub"], health: SecretsHealth): Row {
  const parts = [hubConnectionLabel(status.hubConnection)];
  if (hub !== null) {
    parts.push(hub.url);
    if (!("problem" in health)) {
      parts.push(health.secrets.hubPassword === undefined ? "no password" : "password set");
    }
    parts.push(`auto-heal ${hub.autoHeal ? "on" : "off"}`);
  }
  return { ...HUB[status.hubConnection], label: "Hub", detail: parts.join(" · ") };
}

// The vendored snapshot's capture is a fixed fact of the build, so it reads
// as a date in this process's zone; a fetch is recent by construction and
// reads as an age (the Desktop client's `app-info.ts`). An unparseable stamp
// reads as the em dash, as `formatRelativeTime` gives.
function captured(pricing: PricingStatus, now: number): string {
  if (pricing.source === "fetched") return formatRelativeTime(pricing.capturedAt, now);
  const ms = Date.parse(pricing.capturedAt);
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function pricingRow(pricing: PricingStatus | undefined, now: number): Row {
  // Absent means unknown, never healthy (ADR-0053).
  if (pricing === undefined) return { mark: "warn", label: "Pricing", detail: "not reported" };
  const parts = [
    pricing.source,
    plural(pricing.modelCount, "model"),
    `captured ${captured(pricing, now)}`,
  ];
  const failure = pricing.lastAttempt?.failure ?? null;
  if (failure !== null) parts.push(`last refresh failed (${failure.kind})`);
  const unpriced = pricing.unpricedModels;
  if (unpriced.length > 0) parts.push(`${count(unpriced.length)} unpriced: ${unpriced.join(", ")}`);
  return {
    mark: failure === null && unpriced.length === 0 ? "ok" : "warn",
    label: "Pricing",
    detail: parts.join(" · "),
  };
}

const WINDOW: Record<WindowState, string> = { active: "active", idle: "idle", absent: "none" };

// The words the Desktop client's Organizations list used before Settings ›
// Accounts replaced it (#639), shortened for a line.
function limitsPhrase(answer: OrganizationUsageStatus | undefined): string {
  if (answer === undefined) return "no read yet";
  switch (answer.limits) {
    case "windows": {
      const windows = answer.windowStates;
      if (windows === null) return "limits readable";
      return `5h ${WINDOW[windows.fiveHour]}, wk ${WINDOW[windows.weekly]}`;
    }
    case "none":
      return "no limit window";
    case "forbidden":
      return "limits not readable with this key";
    case "error":
      return "couldn't read limits";
  }
}

// One row per Tracked organization, the Home organization first, each by its
// Organization label (collision-suffixed across the whole roster, as the
// Desktop client's are) and read from the status's own `organizations`.
function organizationRows(roster: OrganizationsResponse, answers: UsageOrganizations): Row[] {
  const labels = displayOrganizationLabels(roster.organizations);
  const tracked = roster.organizations.filter((entry) => entry.tracked);
  const ordered = [
    ...tracked.filter((entry) => entry.uuid === roster.home),
    ...tracked.filter((entry) => entry.uuid !== roster.home),
  ];
  return ordered.map((entry) => {
    const label = labels.get(entry.uuid) ?? entry.label;
    const home = entry.uuid === roster.home ? " (Home)" : "";
    const answer = Object.hasOwn(answers, entry.uuid) ? answers[entry.uuid] : undefined;
    return { mark: null, label: "", detail: `${label}${home}: ${limitsPhrase(answer)}` };
  });
}

// The Home membership and the tracked Organizations as the daemon resolves
// them: its listing's Home membership, else the roster's Home with no
// Account, and the roster's tracked Organizations (none excluded with no
// Home, as the daemon's null set excludes none).
function daemonScopeState(roster: OrganizationsResponse, accounts: AccountsResponse) {
  let home: HomeMembership | null =
    roster.home === null ? null : { organizationUuid: roster.home, accountUuid: null };
  for (const account of accounts.accounts) {
    const membership = account.memberships.find((m) => m.home);
    if (membership !== undefined) {
      home = { organizationUuid: membership.organizationUuid, accountUuid: account.key };
    }
  }
  const trackedOrganizations =
    roster.home === null
      ? null
      : new Set(roster.organizations.filter((o) => o.tracked).map((o) => o.uuid));
  return { home, trackedOrganizations };
}

// A Membership's limits answer in the Organization lines' words: a key not
// connected or expired first (`LIMIT_STATE_WORDS`, live's Limits list's),
// then its own last Limits answer, its windows read off its own reading.
function membershipPhrase(row: MembershipRow, roster: OrganizationsResponse, now: number): string {
  if (row.state === "not-connected" || row.state === "stale") return LIMIT_STATE_WORDS[row.state];
  if (row.limits === null) return "no read yet";
  if (row.limits !== "windows" || row.reading === null) {
    return limitsPhrase({
      limits: row.limits,
      windowStates: null,
      lastReadAt: null,
      lastSampleAt: null,
    });
  }
  const windowState = (uuid: string, window: "fiveHour" | "weekly") =>
    roster.organizations.find((o) => o.uuid === uuid)?.limits?.windowStates?.[window];
  const windows = membershipWindows(row.reading, row.organizationUuid, windowState, now);
  const word = (kind: "fiveHour" | "weekly"): string => {
    const window = windows.find((w) => w.kind === kind);
    return window === undefined ? WINDOW.absent : window.pct === null ? WINDOW.idle : WINDOW.active;
  };
  return `5h ${word("fiveHour")}, wk ${word("weekly")}`;
}

// ADR-0140 §4: one line per tracked Membership, most used first
// (`rankMemberships`, live's Limits list's order), none folded, each named
// as the set names it (`Org · Account` while it spans Accounts) and marked
// Home.
function membershipRows(
  roster: OrganizationsResponse,
  accounts: AccountsResponse,
  now: number,
): Row[] {
  const memberships = trackedScopeMemberships(
    accounts.accounts,
    daemonScopeState(roster, accounts),
  );
  const labels = organizationLabelMap(roster.organizations);
  return rankedMembershipRows(memberships, accounts.accounts, labels, now).map((row) => {
    const home = row.home ? " (Home)" : "";
    return {
      mark: null,
      label: "",
      detail: `${row.label}${home}: ${membershipPhrase(row, roster, now)}`,
    };
  });
}

// The Organization lines, or, while two or more Accounts are tracked, the
// Membership lines (the multi-Membership gate, `accountFilterVisible`). A
// one-Account install's lines are the Organization lines, as before.
function rosterRows(input: StatusInput): Row[] {
  const { roster, now } = input;
  if (roster === null) return [];
  if ("unavailable" in roster) {
    const detail = `the Organization lines are unavailable: ${roster.unavailable}`;
    return [{ mark: "warn", label: "", detail }];
  }
  const accounts = input.accounts ?? null;
  if (accounts !== null && "unavailable" in accounts) {
    const detail = `the Membership lines are unavailable: ${accounts.unavailable}`;
    return [{ mark: "warn", label: "", detail }];
  }
  if (accounts !== null && accountFilterVisible(accounts.accounts)) {
    return membershipRows(roster, accounts, now);
  }
  return organizationRows(roster, input.status.organizations);
}

// Each Gateway's mark, by its shared tone (`GATEWAY_STATE_TONE`): draining
// is fine, statistics off a warning, and a Gateway that cannot be drained bad.
const GATEWAY_MARKS: Record<GatewayStateTone, Mark> = { good: "ok", warn: "warn", bad: "bad" };

// ADR-0141 §8: one line per Gateway secrets.json holds, its state and the
// age of its last record, with the remedy where one applies; one warning when
// the daemon's listing cannot be read. No Gateway, no line.
function gatewayLines(input: StatusInput): Row[] {
  const read = input.gateways ?? null;
  if (read === null || "problem" in input.secrets) return [];
  let rows: Row[];
  if ("unavailable" in read) {
    rows = [
      { mark: "warn", label: "", detail: `the Gateway lines are unavailable: ${read.unavailable}` },
    ];
  } else {
    rows = gatewayRows(input.secrets.secrets, read).map((g): Row => {
      const host = gatewayUrlHost(g.url);
      if (g.state === null) {
        return {
          mark: "warn",
          label: "",
          detail: `${host} · not in use until the daemon restarts`,
        };
      }
      const { words, remedy } = gatewayStatusDetail(g.state, g.url);
      const parts = [host, words, `last record ${lastRecordText(g.lastRecordAt, input.now)}`];
      if (g.drainedBy === "hub") parts.push("drained by the Hub");
      return {
        mark: GATEWAY_MARKS[GATEWAY_STATE_TONE[g.state]],
        label: "",
        detail: parts.join(" · "),
        ...(remedy === undefined ? {} : { remedy }),
      };
    });
  }
  return rows.map((row, i) => (i === 0 ? { ...row, label: "Gateways" } : row));
}

// ADR-0122 §7. A rejected setting, or a Hub key, has the schema's fallback
// applying and a command that writes it again. A rejected Home or tracked
// list has none: no command repairs it, and `serve` refuses to boot on it
// (exit 6), so the running daemon is the last one until the file is fixed.
function rejectedRow(field: RejectedField): Row {
  const applying = `stored value rejected, using ${field.effective}`;
  if (field.key !== null) {
    const name = field.key.name;
    const remedy = `maxprice settings unset ${name}`;
    return { mark: "warn", label: "", detail: `${name}: ${applying}`, remedy };
  }
  if (field.file === "hubUrl" || field.file === "hubAutoHeal") {
    const remedy = "maxprice hub join <url>";
    return { mark: "warn", label: "", detail: `${field.file}: ${applying}`, remedy };
  }
  const detail = `${field.file}: stored value rejected; the daemon will not start again until it is fixed`;
  return { mark: "bad", label: "", detail };
}

// One row per rejected field, or one for a file that cannot be read; the
// first carries the label.
function settingsRows(health: SettingsHealth): Row[] {
  const rows: Row[] =
    "unreadable" in health
      ? [
          {
            mark: "bad",
            label: "",
            detail: `${health.unreadable}; the daemon will not start again on it`,
          },
        ]
      : health.rejected.map(rejectedRow);
  return rows.map((row, i) => (i === 0 ? { ...row, label: "Settings" } : row));
}

function octal(mode: number): string {
  return "0" + mode.toString(8).padStart(3, "0");
}

// ADR-0121 §9: secrets.json itself, only while something is wrong with it
// now. A loose file still works, and the next `serve` tightens it (§5); one
// that cannot be used, the next `serve` skips. A tightening a `serve` already
// did is in the journal, not here.
function secretsRows(path: string, health: SecretsHealth): Row[] {
  if ("problem" in health) {
    const detail = `${path} cannot be used: ${health.problem}; the daemon starts without its secrets`;
    return [{ mark: "bad", label: "Secrets", detail }];
  }
  if (health.loose === null) return [];
  const detail = `${path} is ${octal(health.loose)}; the next serve tightens it to 0600`;
  return [{ mark: "warn", label: "Secrets", detail, remedy: `chmod 600 ${path}` }];
}

// ADR-0123 §8: `! Update` naming the command, `✓ Update current`, or a failed
// check, which is off, never bad, since an air-gapped server is not broken.
// `latest` is compared with the daemon's version, which connect() has already
// required to be this maxprice's: the binary `status` runs, so a stale file
// never announces an update already installed.
function updateCheckRow(update: UpdateCheckRead, status: StatusSnapshot): Row {
  return { ...updateRow(update, status.engineVersion, "maxprice update"), label: "Update" };
}

// ADR-0120 §6: a warning, never a block.
function doubleJoinRow(url: string): Row {
  return { mark: "warn", label: "", detail: doubleJoinWarning(url) };
}

// Pad the plain label, so an escape code never counts toward the width. A
// detail or remedy can carry outside text (a label, a model name, a path, a
// URL), so each goes through `terminalText` before it is painted; the labels
// are this module's own.
function line(row: Row, width: number, s: Style): string {
  const detail = terminalText(row.detail);
  if (row.mark === null) return `  ${" ".repeat(width)}${s.dim(detail)}`;
  const label = row.label === "" ? "" : s.bold(row.label);
  const remedy = row.remedy === undefined ? "" : `   ${s.dim(`→ ${terminalText(row.remedy)}`)}`;
  const { glyph, paint } = MARKS[row.mark];
  const painted = paint(s)(glyph);
  return `${painted} ${label}${" ".repeat(width - row.label.length)}${detail}${remedy}`;
}

export function renderStatus(input: StatusInput): string {
  const { status, now } = input;
  const rows: Row[] = [
    daemonRow(status, input.socket),
    engineRow(status),
    ...limitsRows(input),
    hubRow(status, input.hub, input.secrets),
    pricingRow(status.pricing, now),
    ...rosterRows(input),
    ...gatewayLines(input),
    updateCheckRow(input.update, status),
    ...settingsRows(input.settings),
    ...secretsRows(input.secretsPath, input.secrets),
    ...(input.desktopHubUrl === null ? [] : [doubleJoinRow(input.desktopHubUrl)]),
  ];
  const width = Math.max(...rows.map((row) => row.label.length)) + 2;
  return rows.map((row) => line(row, width, input.style)).join("\n") + "\n";
}
