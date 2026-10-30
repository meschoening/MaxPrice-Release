import {
  clientFacingHost,
  displayOrganizationLabels,
  formatRelativeTime,
  hasNonLoopbackBind,
  hubDaemonLabel,
  noFreshReading,
  resolveMergeTarget,
  resolveOrganizationLabel,
  usageConnectionShortLabel,
  type FirewallVerdict,
  type HubClient,
  type HubDaemonState,
  type HubMachine,
  type HubOrganization,
  type OrganizationUsageStatus,
  type UsageConnection,
} from "@maxprice/shared";

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
// Its key clause is the popout row's short label (@maxprice/shared's
// usageConnectionShortLabel) lowercased, so the row and the tooltip share one
// vocabulary and can never drift apart.
export function trayTooltip(state: HubDaemonState, conn: UsageConnection | undefined): string {
  const head = `MaxPrice Hub — ${hubDaemonLabel(state).toLowerCase()}`;
  if (noFreshReading(state)) return head;
  if (conn === undefined || conn === "connected") return head;
  return `${head} · ${usageConnectionShortLabel(conn).toLowerCase()}`;
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

// What the Hub's key discovered: the listed rows, in roster order. Nothing
// while no key is set — a key clear keeps the roster file, so its rows would
// otherwise outlive the key.
export function discoveredOrganizations(
  rows: readonly HubOrganization[] | undefined,
  connection: UsageConnection,
): HubOrganization[] {
  if (rows === undefined || connection === "disconnected") return [];
  return rows.filter((row) => row.listed);
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

// The Limits answer in words, with the dot tones of the client's Settings list
// (apps/desktop/src/lib/organization-list-view.ts). Glass `.dot` variants.
// `windows` covers an idle limit too, and `none` is an Organization that
// reports no limit at all (#384).
export function limitsAnswerText(limits: OrganizationUsageStatus | null): {
  dot: "good" | "warn" | "soft";
  text: string;
} {
  if (limits === null) return { dot: "soft", text: "Not read yet" };
  switch (limits.limits) {
    case "windows":
      return { dot: "good", text: "Reading limits" };
    case "none":
      return { dot: "good", text: "No limits" };
    case "forbidden":
      return { dot: "soft", text: "Can't read limits" };
    case "error":
      return { dot: "warn", text: "Error" };
  }
}

// "Last read 5m ago · last sample 2h ago". The roster's persisted answer
// carries no times, so either side can be an em dash.
export function organizationSubline(row: HubOrganization, now: number): string {
  const read = formatRelativeTime(row.limits?.lastReadAt ?? null, now);
  const sample = formatRelativeTime(row.limits?.lastSampleAt ?? null, now);
  return `Last read ${read} · last sample ${sample}`;
}

// The Home line's gate counts what the console knows: every row's uuid, listed
// or directory-only, joined with every machine's published Home. The Hub's
// directory holds renames only, so counting it alone would hide every Home.
export function knownOrganizationCount(
  rows: readonly HubOrganization[] | undefined,
  machines: readonly HubMachine[],
): number {
  const known = new Set((rows ?? []).map((row) => row.uuid));
  for (const machine of machines) {
    const home = machine.homeOrganization ?? null;
    if (home !== null) known.add(home);
  }
  return known.size;
}

// A machine's published Home organization, as the Machines card's "Home: …"
// line. A Home no row holds resolves the way an unlabelled Organization does.
export function machineHomeLine(machine: HubMachine, labels: Map<string, string>): string | null {
  const uuid = machine.homeOrganization ?? null;
  if (uuid === null) return null;
  const label =
    labels.get(uuid) ??
    resolveOrganizationLabel({ uuid, rename: null, organizationType: null, hints: null }).label;
  return `Home: ${label}`;
}

// The Machines card's Home lines, gated once for the whole card: null (no line
// anywhere) until the console knows more than one Organization, else the
// labels over every row, so a collision suffix reads as it does on the other cards.
export function homeLineLabels(
  rows: readonly HubOrganization[] | undefined,
  machines: readonly HubMachine[],
): Map<string, string> | null {
  if (knownOrganizationCount(rows, machines) <= 1) return null;
  return organizationLabels(rows ?? []);
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
