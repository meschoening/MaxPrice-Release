import { formatRelativeTime } from "./relative-time";
import { isLoopbackHost } from "./tailnet";
import type { HubClient, HubRowStatus, HubStatus } from "./hub";
import type { UsageConnection } from "./usage-limits";

// The Hub rows (ADR-0124 §4/§7, route #458 Q9): the pure derivation from a Hub
// status to the hub Popout's three rows (Hub, claude.ai, Access) and its
// clients line, so the hub tray app's Popout, the Hub page
// (apps/hub-desktop/src/page/) and `maxprice-hub status` (apps/hub/src/
// status.ts, #498) derive them once. The console's cards read the same
// helpers, and the console's Key row (`hubKeyLabel`) is `status`'s too. The
// dot helpers keep their load-bearing `bg-*` class names (see
// usage-status.ts's header); `status` reads them as its glyphs. No React
// here: the rows' one markup is the hub tray app's HubStatusRows component.

// The three firewall verdicts the check_firewall Tauri command can return
// (ADR-0038). Shared here so hubDaemonState, the console's firewall-warning
// gate and the use-firewall query narrow to the same union.
export type FirewallVerdict = "allowed" | "blocked" | "unsupported";

// The address clients reach the daemon at: the first bound host that is not
// loopback, in the daemon's order, or undefined when it bound none or does
// not say (a pre-0038 daemon). One rule for the hub Popout's Listening row
// (ADR-0038) and the Headless Hub setup's join address (ADR-0128 §5). The
// loopback rule is tailnet.ts's `isLoopbackHost`, the same one the daemon's
// bind warning uses — a hand-edited `bind: "localhost"` must not read as
// reachable here.
export function clientFacingHost(bindHosts: string[] | undefined): string | undefined {
  return (bindHosts ?? []).find((host) => !isLoopbackHost(host));
}

// True when the daemon reports a bound address remote clients can actually
// target (ADR-0038): a client-facing host. Absent bindHosts (a pre-0038
// daemon) reads as false — no firewall warning on a hub that can't tell us
// what it bound.
export function hasNonLoopbackBind(bindHosts: string[] | undefined): boolean {
  return clientFacingHost(bindHosts) !== undefined;
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
  | "stopped" // ...because it exited: the shell's record (ADR-0112 §6)
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
// `bindHosts === undefined` (a pre-0038 daemon) falling into local-only. The
// Hub page is served by the Hub it describes, which reloads it on a
// version change (ADR-0124 §6), so the reasoning carries to it; a reader that
// can meet a Hub of another version cannot lean on it. `maxprice-hub status`
// can (#498): a binary updated under a daemon not yet restarted. It leans on
// it anyway, and soundly: it reads only a Headless Hub, on Linux, whose
// protocol version its probe has matched, and every Headless Hub speaks event
// sync, so there too a missing `events` is an archive that failed to load.
export function eventsDown(status: HubRowStatus | undefined): boolean {
  return status !== undefined && status.events === undefined;
}

// Precedence is transport-before-capability: if nothing can reach the hub,
// event-sync health is moot (clients couldn't push either way). Concurrent
// faults stay visible — the card's insets stack independently of the chip.
//
// `exited` is the shell's own record that the daemon process exited
// (`hubDaemonExited`, ADR-0112 §6). It explains why the console can't reach
// its daemon and never stands alone: an unreachable daemon the shell still
// holds as running stays "not-responding", as it always was. And it is a stop
// only once the daemon has answered this webview (a status was fetched, which
// the failing query keeps): one that never came up — a port conflict, a spawn
// failure — failed to start, and Restart hub is no answer to that.
export function hubDaemonState(
  isError: boolean,
  status: HubRowStatus | undefined,
  firewall: FirewallVerdict | undefined,
  exited: boolean,
): HubDaemonState {
  if (isError) return exited && status !== undefined ? "stopped" : "not-responding";
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
export function isDeliberateLoopback(status: HubRowStatus | undefined): boolean {
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
    case "stopped":
      return "Stopped";
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
    case "stopped":
      return "bg-bad";
    case "local-only":
      return deliberateLoopback ? "bg-soft" : "bg-warn";
    case "events-down":
      return "bg-warn";
    case "online":
      return "bg-good";
  }
}

// An unhealthy key's clause in the tray tooltip's lowercase words. The popout
// row capitalizes it (usageConnectionShortLabel below) and the hub tray app's
// trayTooltip lowercases that label again, so the row and the tooltip share one
// vocabulary.
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
  return state === "starting" || state === "not-responding" || state === "stopped";
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

// The clients line's noun, by the live count: "1 connected client",
// "3 connected clients", and "— connected clients" while there is no count to
// show (null: the roster has not been fetched, or the daemon gave no fresh
// reading). The Popout read "1 connected clients" until ADR-0124 §7.
export function connectedClientsNoun(count: number | null): string {
  return count === 1 ? "connected client" : "connected clients";
}

// The clients line, or null where it gives way: a stopped daemon has no
// clients to count (ADR-0112 §6). `count` is the figure the line leads with,
// null for the dimmed em dash: while the daemon gives no fresh reading the
// count would be stale, and an unfetched roster has none. Read as text it is
// `${count ?? "—"} ${noun}`.
export function hubClientsLine(
  daemon: HubDaemonState,
  liveClients: number | null,
): { count: number | null; noun: string } | null {
  if (daemon === "stopped") return null;
  const count = noFreshReading(daemon) ? null : liveClients;
  return { count, noun: connectedClientsNoun(count) };
}

// ── The Key row (ADR-0036, ADR-0126 §3) ──────────────────────────────────────

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

// The console's Key row and `maxprice-hub status`'s (ADR-0127 §8): what a Hub
// reveals about its key, set or not, when and by whom (ADR-0126 §3), and
// never any part of the value. A status that has not arrived reads as no
// key, as the console's card always read it.
export function hubKeyLabel(
  status:
    | Pick<HubStatus, "credentialPresent" | "credentialUpdatedAt" | "credentialSource">
    | undefined,
  now: number,
): string {
  return status?.credentialPresent === true
    ? formatProvenance(status.credentialUpdatedAt, status.credentialSource, now)
    : "No key set";
}
