import {
  formatRelativeTime,
  isLoopbackHost,
  resolveMergeTarget,
  type HubClient,
  type HubMachine,
  type HubStatus,
  type UsageConnection,
} from "@maxprice/shared";

// The three firewall verdicts the check_firewall Tauri command can return
// (ADR-0038). Shared here (the lib layer) so both the presentation gate and the
// use-firewall query narrow to the same union.
export type FirewallVerdict = "allowed" | "blocked" | "unsupported";

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

// True when the daemon reports a bound address remote clients can actually
// target (ADR-0038). Absent bindHosts (a pre-0038 daemon) reads as false — no
// firewall warning on a hub that can't tell us what it bound. The loopback rule
// is @maxprice/shared's `isLoopbackHost`, the same one the daemon's bind warning
// uses — a hand-edited `bind: "localhost"` must not read as reachable here.
export function hasNonLoopbackBind(bindHosts: string[] | undefined): boolean {
  return (bindHosts ?? []).some((host) => !isLoopbackHost(host));
}

// The Listening row (ADR-0038): the CLIENT-FACING address — what other
// machines type into Settings — not the console's own loopback URL. Every
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
  const host = hosts.find((h) => !isLoopbackHost(h)) ?? first;
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
// firewall verdict above, the union is declared here so the query and the
// presentation narrow to the same one.
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

// ── Hub status chip (ADR-0049) ───────────────────────────────────────────────
//
// The Hub status card answers ONE question: can the fleet reach this daemon,
// and is it serving both its jobs. It used to render the hub's claude.ai
// connection instead — the same value the Claude account card carries a few
// pixels below — so the two chips said the same thing and neither said whether
// the daemon was actually reachable. claude.ai health now lives only on the
// Claude account card (ADR-0039 split the analogous overload client-side).
//
// Derived here rather than reported by the daemon: `isError` (the webview
// can't reach its own daemon) and the firewall verdict are console-local facts
// the daemon cannot know — ADR-0038 made the firewall check a Tauri host read
// precisely because a blocked daemon couldn't serve the answer anyway.
export type HubDaemonState =
  | "starting" // no answer yet — the LISTENING handshake can lag window creation
  | "not-responding" // the console can't reach its own daemon
  | "local-only" // alive, but nothing off this machine can reach it
  | "events-down" // reachable, but the fleet-event archive failed to load
  | "online"; // serving both jobs to the fleet

// The events-down rule, stated ONCE: the archive failed to load, so the daemon
// never patched `events` onto its status. Two call sites read it — the chip's
// precedence ladder below and the card's warning inset — and ADR-0049 lets
// those two DISAGREE on the outcome (insets stack independently of the chip, so
// a `local-only` chip can coexist with an events-down inset). They must not
// disagree on the RULE, hence one predicate. A status that hasn't arrived is
// not events-down — that's `starting`.
//
// NOTE `events === undefined` means "this daemon doesn't speak event sync",
// which for a REMOTE client could mean a pre-M4 hub. Reading it as a fault is
// sound only because the tray app ships the console and the daemon in one
// installer, so version skew is impossible here. Same reasoning licenses
// `bindHosts === undefined` (a pre-0038 daemon) falling into local-only.
export function eventsDown(status: HubStatus | undefined): boolean {
  return status !== undefined && status.events === undefined;
}

// Precedence is transport-before-capability: if nothing can reach the hub,
// event-sync health is moot (clients couldn't push either way). Concurrent
// faults stay visible — the card's insets stack independently of the chip.
export function hubDaemonState(
  isError: boolean,
  status: HubStatus | undefined,
  firewall: FirewallVerdict | undefined,
): HubDaemonState {
  if (isError) return "not-responding";
  // Pending, not broken: treating the first load as a fault would flash red on
  // every window open, which is how an operator learns to ignore the chip.
  if (status === undefined) return "starting";
  if (!hasNonLoopbackBind(status.bindHosts) || firewall === "blocked") return "local-only";
  if (eventsDown(status)) return "events-down";
  return "online";
}

// True when a loopback-only bind is what the operator ASKED for — `bind:
// "loopback"` resolves cleanly, while a `bind: "tailnet"` that found no
// interface carries a warning (ADR-0049). Both bind ["127.0.0.1"], so the
// warning is the only thing that tells them apart. A chosen state must not
// wear a fault color it can never clear.
export function isDeliberateLoopback(status: HubStatus | undefined): boolean {
  return (
    status !== undefined &&
    !hasNonLoopbackBind(status.bindHosts) &&
    (status.bindWarning ?? null) === null
  );
}

export function hubDaemonLabel(state: HubDaemonState): string {
  switch (state) {
    case "starting":
      return "Starting…";
    case "not-responding":
      return "Not responding";
    case "local-only":
      return "Local only";
    case "events-down":
      return "Event sync down";
    case "online":
      return "Online";
  }
}

// Same load-bearing `bg-*` class names as usage-status.ts — see its header.
export function hubDaemonDot(state: HubDaemonState, deliberateLoopback: boolean): string {
  switch (state) {
    case "starting":
      return "bg-soft";
    case "not-responding":
      return "bg-bad";
    case "local-only":
      return deliberateLoopback ? "bg-soft" : "bg-warn";
    case "events-down":
      return "bg-warn";
    case "online":
      return "bg-good";
  }
}

// The tray tooltip, composed whole and passed verbatim to the Rust
// `set_tray_tooltip` (ADR-0049) — which takes a finished string and sets it, no
// longer interpreting a status token through a four-arm match that held a
// second copy of this vocabulary in another language. The words now live in one
// language, covered by this module's tests. The tray is the only hub UI while
// the window is hidden — and the tray app autostarts — so it must carry BOTH
// facts, not just one.
const KEY_CLAUSE: Record<Exclude<UsageConnection, "connected">, string> = {
  expired: "key expired",
  error: "poll failing",
  disconnected: "no key",
};

// No FRESH reading of anything beyond the daemon itself exists while it isn't
// answering. Stated once because THREE surfaces apply it: the tooltip drops
// its key clause, and the popout dims its Claude account / Access / clients
// rows to a soft dot + em-dash (ADR-0050) — a stale claim beside a dead-daemon
// row would read as a second, unrelated fault.
export function noFreshReading(state: HubDaemonState): boolean {
  return state === "starting" || state === "not-responding";
}

export function trayTooltip(state: HubDaemonState, conn: UsageConnection | undefined): string {
  const head = `MaxPrice Hub — ${hubDaemonLabel(state).toLowerCase()}`;
  if (noFreshReading(state)) return head;
  if (conn === undefined || conn === "connected") return head;
  return `${head} · ${KEY_CLAUSE[conn]}`;
}

// ── Tray popout rows (ADR-0050, map #89) ─────────────────────────────────────

// The popout's Hub dot breathes only while the state is expected to change on
// its own — starting resolves, online samples tick; fault states hold still
// (T1: a pulsing fault reads as "working on it", which a fault is not).
export function hubDotPulse(state: HubDaemonState): boolean {
  return state === "starting" || state === "online";
}

// The popout's compressed Claude-account vocabulary: KEY_CLAUSE capitalized,
// so the row and the tooltip clause can never drift apart. The console card
// keeps the shared usageConnectionLabel ("Session expired" …) — the popout is
// a glance surface and wears the tooltip's shorter words.
export function usageConnectionShortLabel(conn: UsageConnection): string {
  if (conn === "connected") return "Connected";
  const clause = KEY_CLAUSE[conn];
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}

// The Access chip's vocabulary, extracted from AccessCard's JSX so the popout
// consumes the same source (the map's single-sourcing constraint). Same
// load-bearing `bg-*` names as every other dot helper.
export function accessDot(passwordProtected: boolean): string {
  return passwordProtected ? "bg-good" : "bg-warn";
}
export function accessLabel(passwordProtected: boolean): string {
  return passwordProtected ? "Password set" : "No password — open on the tailnet";
}
// The T1 compression for the popout row's right-aligned state. The unset arm
// says "No password" rather than the card's reachability clause: it mirrors
// "Password set" — one subject, two states — so the amber dot explains itself
// at a glance. A scope word ("Open on tailnet", "Tailnet only") reads as
// reassurance beside that dot, and is true of BOTH arms anyway.
export function accessShortLabel(passwordProtected: boolean): string {
  return passwordProtected ? "Password set" : "No password";
}

// The popout's clients count is LIVE-ONLY — deliberately not the roster card's
// since-start length: a bare count in a glance surface must mean "connected
// now" or it reads as a lie (T3, ADR-0050).
export function liveClientCount(clients: HubClient[]): number {
  return clients.filter((c) => c.live).length;
}

// Credential provenance line (ADR-0036). Never includes the key. `source`
// "local" is the console's own write; any other value is the machine that
// auto-healed the fleet's key.
export function formatProvenance(
  updatedAt: string | null | undefined,
  source: string | null | undefined,
  now: number,
): string {
  if (updatedAt === null || updatedAt === undefined) return "Key set (time unknown)";
  const rel = formatRelativeTime(updatedAt, now);
  if (source === "local" || source === null || source === undefined)
    return `Key set ${rel} locally`;
  return `Key set ${rel}, healed by ${source}`;
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

// unreadable lines are ACKED rows lost to corruption — amber, real loss;
// garbage lines are replaced/duplicate rows replay converges over — panel
// tint, compactable housekeeping. (ADR-0041 §hub console.)
export type HygieneState = "clean" | "garbage" | "unreadable";
export function hygieneState(events: HubStatus["events"]): HygieneState {
  if ((events?.unreadableLines ?? 0) > 0) return "unreadable";
  if ((events?.garbageLines ?? 0) > 0) return "garbage";
  return "clean";
}
