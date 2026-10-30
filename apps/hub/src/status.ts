import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  accessDot,
  accessShortLabel,
  hubClientsLine,
  hubDaemonDot,
  hubDaemonLabel,
  hubDaemonState,
  hubKeyLabel,
  hubPageViewSchema,
  hubStatusReportSchema,
  hubStatusSchema,
  isDeliberateLoopback,
  noFreshReading,
  usageConnectionDot,
  usageConnectionShortLabel,
  type HubStatusReport,
  type UsageConnection,
} from "@maxprice/shared";
import { displayPath, type Env } from "@maxprice/usage-core/home-path";
import { describeHolder, type ServeLockHolder } from "@maxprice/usage-core/serve-lock";
import { defaultUnitPath } from "@maxprice/usage-core/systemd-unit";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import {
  readUpdateCheck,
  type UpdateCheckRead,
  updateRow,
} from "@maxprice/usage-core/update-check";
import { CliError, EXIT, type Io } from "./cli";
import { requireHub } from "./config";
import { HubNoAnswer, reachHub, type ReachOptions, refusal, unreadable } from "./operator-client";
import { readOnlyLockHolder, serveLockPath, UNIT } from "./serve-lock";
import { VERSION } from "./version";

// `maxprice-hub status [--json]` (ADR-0127 §8): the running daemon described
// as the hub tray app's Popout describes its own, the Hub, claude.ai and
// Access rows and the clients line, all from @maxprice/shared's Hub rows
// (hub-rows.ts), then the key's row (ADR-0126 §3, the console's own words),
// the daemon's version, the Update row (ADR-0129 §6), the data dir and the
// pid. `service status` keeps describing the unit (§6). Linux only, as
// serve.lock and the operator token are (§3, ADR-0126 §8).
//
// Once the lock says a Hub runs (below), the daemon is read the way §7's
// commands reach it, through reachHub (operator-client.ts): serve.lock's
// record, the operator token, and the authenticated `GET /api/status`
// within 10 s, whose body carries the key's provenance. Then one
// `GET /page/view`, the Hub page's own data (ADR-0124
// §4), which carries exactly what the rows read, the live clients count and
// the daemon's version, the one ADR-0129 §5's `update` waits on. A view's
// rows are its full status's (#491's tests pin it), and the page and the
// Popout show the same. The Update row reads the data dir's update-check.json
// instead, which a Headless serve writes (ADR-0129 §6), in the text form
// alone.
//
// Exit 0 once the daemon has answered, whatever its rows say; 3 when no
// daemon holds the lock, ADR-0119 §6's "not running" code; 1 when a holder
// that recorded its port sent no whole answer, to the probe or to the page
// view, with the Not responding rows on stdout and the request's line on
// stderr, and with its line alone for a holder that recorded no port, a
// page view that came back with an error, or any of reachHub's other
// failures; 4 on skew; 2 for a data dir with no hub.json, as every command
// that reads a Hub refuses it (§4), or off Linux.
//
// `status` changes no file, and reads the daemon through the lock (§3)
// without writing it. With no serve.lock, no Hub has run here: exit 3, and
// none is made. Otherwise it asks flock on a read-only descriptor for a
// shared lock it lets go at once (serve-lock.ts's readOnlyLockHolder, which
// `restore` asks of its backup). Free is no Hub running, exit 3, whatever
// pid the record names: one that exited, or one the kernel has since given
// another process. Held is reachHub's to reach, whatever pid the record
// names: one in another pid namespace, or hidden from this uid's /proc. A
// free lock would be the operator commands' to take and edit under; `status`
// has nothing to edit. If the holder lets go before reachHub sees a port,
// `refuseFree` gives exit 3; once a port was seen, reachHub preserves §7's
// restart-gap refusal, exit 1 with "run it again". Either refusal precedes
// writing a record, and the open, O_RDWR | O_CREAT with no O_TRUNC, changes
// nothing of the file. The record a Hub that exited left behind, which
// `service status` reads for its Lock row, stays as it was: its content,
// inode, mode, size, mtime and ctime, which the tests pin; its atime may
// move, as any read moves it.
//
// While the lock is free, the probe holds it shared for that instant, and
// reachHub's refused take holds it exclusive for another. A `serve` whose
// take lands in either meets the hold and waits it out: its take asks again
// every 25 ms for 500 ms (serve-lock.ts's takeServeLock, the user's choice
// of 2026-10-24 over a non-acquiring read of /proc/locks). It still exits 5,
// which the unit does not retry (§2), if this process is stopped or stalled
// holding the lock past those 500 ms (no ticket), its line then naming the pid the
// record already held, since `status` writes no record. And a command whose
// take meets the hold over an exited Hub's record reads its port as a Hub
// seen, and exits 1, `run it again`, having changed nothing
// (operator-client.ts, §7).

export type StatusOptions = {
  env?: Env;
  platform?: NodeJS.Platform;
  now?: () => number;
  // reachHub's, for a test: a short bound and poll, a holder's cgroup.
  reach?: Omit<ReachOptions, "refuseFree">;
};

const PAGE_VIEW_PATH = "/page/view";

// ADR-0119 §7's hints, by whether the default unit file exists: no
// subprocess on this path, so a manager with its own config home gets the
// hints for no unit (ADR-0120 §4's residual, the Headless client's too).
function notRunning(env: Env, dataDir: string): CliError {
  return new CliError(
    EXIT.NOT_RUNNING,
    `maxprice-hub is not running for ${displayPath(dataDir, env)}`,
    existsSync(defaultUnitPath(UNIT, env))
      ? [
          { label: "Start it:", command: "systemctl --user start maxprice-hub" },
          { label: "Why it stopped:", command: "maxprice-hub service logs" },
        ]
      : [
          { label: "Install it as a service:", command: "maxprice-hub service install" },
          { label: "Or run it in a terminal:", command: "maxprice-hub serve" },
        ],
  );
}

// A held lock whose record names no pid or port a Hub writes, such as pid 0:
// its digits passed the record's reader (usage-core's serve-lock.ts), but no
// report can name them.
function corruptRecord(env: Env, dataDir: string, holder: ServeLockHolder): CliError {
  return new CliError(
    EXIT.FAILURE,
    `${displayPath(serveLockPath(dataDir), env)} records pid ${holder.pid ?? "none"} and port ${holder.port ?? "none"}, which no Hub writes`,
  );
}

// Where the daemon lives, as serve.lock says. The report's path is absolute
// even for a relative MAXPRICE_HUB_DATA_DIR. The lookup and diagnostics keep
// the configured spelling; only the reported fact needs the absolute path.
function daemonFacts(dataDir: string, holder: ServeLockHolder) {
  return {
    dataDir: resolve(dataDir),
    pid: holder.pid,
    port: holder.port,
    inUnit: holder.service,
  };
}

// ── The rows ────────────────────────────────────────────────────────────────

type Mark = "ok" | "warn" | "bad" | "off";

// A row is its glyph, its label padded to the longest label plus two, its
// detail, then `   → <remedy>` when it has one: the Headless client's
// checklist (apps/cli/src/render/status.ts), uncoloured. A row with no mark
// leaves the glyph's column blank, and the clients line has no label either,
// so it starts in the detail column, flush with the rows' states as it sits
// in the Popout.
type Row = { mark: Mark | null; label: string; detail: string; remedy?: string };

const GLYPH: Record<Mark, string> = { ok: "✓", warn: "!", bad: "✗", off: "–" };

// The shared dot helpers' load-bearing class names (hub-rows.ts,
// usage-status.ts) as marks: the Popout's tint, read off the same verdict.
// No dot, and the soft one, are "off".
function markOf(dot: string | null): Mark {
  switch (dot) {
    case "bg-good":
      return "ok";
    case "bg-warn":
      return "warn";
    case "bg-bad":
      return "bad";
    default:
      return "off";
  }
}

// The fix the operator has for a claude.ai state: a key, when there is none
// or it expired. A poll failing has no command to name.
const KEY_REMEDY: Partial<Record<UsageConnection, string>> = {
  disconnected: "maxprice-hub key set",
  expired: "maxprice-hub key set",
};

type Answered = Exclude<HubStatusReport, { state: "not-responding" }>;

// A row that reads the Hub's answer, or, with none, the same row dimmed to an
// em dash with no remedy, a marked row's mark soft, as the Popout dims its
// rows while the daemon gives no fresh reading (noFreshReading).
function reading(
  label: string,
  marked: boolean,
  answered: Answered | null,
  read: (answered: Answered) => Omit<Row, "label">,
): Row {
  if (answered !== null) return { label, ...read(answered) };
  return { mark: marked ? "off" : null, label, detail: "—" };
}

// Whether the report carries the Hub's answer: only while the Hub gives a
// fresh reading (noFreshReading), which, of the states a report carries, Not
// responding alone does not.
function fresh(report: HubStatusReport): report is Answered {
  return !noFreshReading(report.state);
}

// ADR-0129 §6: the Headless client's Update row (update-check.ts's
// updateRow), read from the update-check.json a Headless serve writes, and
// compared with VERSION, the binary `status` runs, never with the record's
// `current`: a file an older daemon wrote never announces the update this
// binary already is. When the daemon that answered runs another version
// than this binary, `update` has swapped the binary under it (or a Hub was
// started from another one), and the row warns and names what finishes the
// update, the restart `update` itself names (ADR-0127 §10): the unit's, when
// the holder runs in it, else the foreground serve's own, which has no
// command to name. That outranks whatever the file says, since its `latest`
// was compared with a binary the daemon does not run. A Hub that sent no
// whole answer gives no version to compare: the file's row alone.
function updateCheckRow(answered: Answered | null, inUnit: boolean, update: UpdateCheckRead): Row {
  if (answered !== null && answered.version !== VERSION) {
    const detail = `the daemon runs ${answered.version}, this maxprice-hub is ${VERSION}`;
    return inUnit
      ? {
          mark: "warn",
          label: "Update",
          detail,
          remedy: "systemctl --user restart maxprice-hub",
        }
      : { mark: "warn", label: "Update", detail: `${detail}: restart serve to finish the update` };
  }
  return { ...updateRow(update, VERSION, "maxprice-hub update"), label: "Update" };
}

function rows(report: HubStatusReport, update: UpdateCheckRead, env: Env, now: number): Row[] {
  const state = report.state;
  const answered = fresh(report) ? report : null;
  const warning = answered?.bindWarning ?? null;
  // A stopped daemon has no clients line; a report never carries one (it is
  // exit 3), so the line is always there, dimmed with the rows that read.
  const clients = hubClientsLine(state, answered?.liveClients ?? null);
  return [
    {
      mark: markOf(hubDaemonDot(state, answered !== null && isDeliberateLoopback(answered))),
      label: "Hub",
      // The bind's own diagnosis (ADR-0049) says why a Hub is local only,
      // or warns of a public bind.
      detail: hubDaemonLabel(state) + (warning === null ? "" : ` · ${warning}`),
      // The journal holds the log of a Hub run by its unit; a foreground
      // serve's log is its own terminal.
      ...(state === "events-down" && report.inUnit ? { remedy: "maxprice-hub service logs" } : {}),
    },
    reading("claude.ai", true, answered, ({ usageConnection: conn }) => ({
      mark: markOf(usageConnectionDot(conn)),
      detail: usageConnectionShortLabel(conn),
      ...(KEY_REMEDY[conn] === undefined ? {} : { remedy: KEY_REMEDY[conn] }),
    })),
    reading("Access", true, answered, ({ passwordProtected }) => {
      const passworded = passwordProtected ?? false;
      return {
        mark: markOf(accessDot(passworded)),
        detail: accessShortLabel(passworded),
        ...(passworded ? {} : { remedy: "maxprice-hub password set" }),
      };
    }),
    ...(clients === null
      ? []
      : [{ mark: null, label: "", detail: `${clients.count ?? "—"} ${clients.noun}` }]),
    reading("Key", false, answered, ({ key }) => ({
      mark: null,
      detail: hubKeyLabel(
        {
          credentialPresent: key.present,
          credentialUpdatedAt: key.updatedAt,
          credentialSource: key.source,
        },
        now,
      ),
    })),
    reading("Version", false, answered, ({ version }) => ({ mark: null, detail: version })),
    updateCheckRow(answered, report.inUnit, update),
    { mark: null, label: "Data dir", detail: displayPath(report.dataDir, env) },
    {
      mark: null,
      label: "Daemon",
      // describeHolder's words. A report names the lock's holder, which runs:
      // it answered, or the kernel holds the lock for it.
      detail: `${describeHolder({ pid: report.pid, port: report.port, running: true, service: report.inUnit }, UNIT)} · 127.0.0.1:${report.port}`,
    },
  ];
}

// Every detail and remedy goes through `terminalText`: a bind warning, a
// version, a check's error, a path and the machine that healed the key all
// come from outside this process, the last from a client's own header.
export function renderHubStatus(
  report: HubStatusReport,
  update: UpdateCheckRead,
  env: Env,
  now: number,
): string {
  const all = rows(report, update, env, now);
  const width = Math.max(...all.map((row) => row.label.length)) + 2;
  return (
    all
      .map((row) => {
        const glyph = row.mark === null ? " " : GLYPH[row.mark];
        const remedy = row.remedy === undefined ? "" : `   → ${terminalText(row.remedy)}`;
        const pad = " ".repeat(width - row.label.length);
        return `${glyph} ${row.label}${pad}${terminalText(row.detail)}${remedy}`;
      })
      .join("\n") + "\n"
  );
}

// `--json`'s one object, as JSON.stringify writes it, which already escapes
// every C0 control character. DEL, C1 and the two Unicode line separators
// it leaves raw are escaped too, so no value can act on a terminal: JSON
// reads each `\u` escape back as the character it names, so the object
// parses to the same values. Not `terminalText`, which would change them.
function reportJson(report: HubStatusReport): string {
  return (
    JSON.stringify(report).replace(
      /[\u007f-\u009f\u2028\u2029]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ) + "\n"
  );
}

// update-check.json is read for the text form alone: `--json` is the report,
// which carries no Update row, and reads no file beside it.
function print(io: Io, json: boolean, report: HubStatusReport, env: Env, now: number): void {
  io.stdout.write(
    json ? reportJson(report) : renderHubStatus(report, readUpdateCheck(report.dataDir), env, now),
  );
}

// ── The command ─────────────────────────────────────────────────────────────

export async function hubStatus(
  json: boolean,
  io: Io,
  {
    env = process.env,
    platform = process.platform,
    now = Date.now,
    reach = {},
  }: StatusOptions = {},
): Promise<number> {
  if (platform !== "linux") throw new CliError(EXIT.USAGE, "maxprice-hub status is Linux only");
  const dataDir = requireHub(env, platform);
  const refuseFree = (): never => {
    throw notRunning(env, dataDir);
  };

  // The lock, asked read-only (above): free, or no file at all, is no Hub.
  if (readOnlyLockHolder(dataDir, reach.readCgroup) === null) return refuseFree();

  try {
    const reached = await reachHub(dataDir, env, { ...reach, refuseFree });
    if (reached.kind === "offline") {
      // Never: refuseFree throws before a free lock is handed back.
      reached.lock.release();
      return refuseFree();
    }
    const { hub } = reached;
    const status = hubStatusSchema.safeParse(hub.status);
    if (!status.success) throw unreadable("/api/status");
    const answer = await hub.request("GET", PAGE_VIEW_PATH);
    if (!answer.ok) {
      throw new CliError(
        EXIT.FAILURE,
        `the running Hub refused its page view: ${refusal(answer, PAGE_VIEW_PATH)}`,
      );
    }
    const view = hubPageViewSchema.safeParse(answer.body);
    if (!view.success) throw unreadable(PAGE_VIEW_PATH);
    // The view always arrives here, and the Hub answered: never `starting`,
    // `not-responding` or `stopped`, which the schema refuses.
    const report = hubStatusReportSchema.safeParse({
      ...view.data,
      state: hubDaemonState(false, view.data, undefined, false),
      key: {
        present: status.data.credentialPresent,
        updatedAt: status.data.credentialUpdatedAt ?? null,
        source: status.data.credentialSource ?? null,
      },
      ...daemonFacts(dataDir, hub.holder),
    });
    // The view parsed, so only the lock's record can fail here: digits that
    // name no pid or port a Hub writes, pid 0, say.
    if (!report.success) throw corruptRecord(env, dataDir, hub.holder);
    print(io, json, report.data, env, now());
    return EXIT.OK;
  } catch (error) {
    // A Hub that sent no whole answer (`no-answer`): its probe unanswered,
    // refused or unreachable all the reach's 10 s, or its page view timed
    // out, refused, reset or cut short within that request's own. The
    // Popout's Not responding, with the pid, the port and the data dir the
    // lock gives, and nothing the probe's status said, which a Hub that
    // stopped answering may no longer hold; then the line and hints the
    // command exits with, exit 1. The reach's other two reasons print that
    // line alone. A lock that recorded no port all the wait (`no-port`) is no
    // daemon the rows can describe, a `serve` stuck before it recorded its
    // port or another command at work (an offline purge-machine at its
    // prompt). An operator token missing, empty, unreadable or replaced as
    // the wait ran out (`token`) says nothing of whether the Hub answers. And
    // a view that came back, a 500 or a body this binary cannot read, is an
    // answer, whose error stands alone.
    if (error instanceof HubNoAnswer && error.kind === "no-answer") {
      // A record no Hub writes gives no rows to print, and the line alone.
      const report = hubStatusReportSchema.safeParse({
        service: "maxprice-hub",
        state: "not-responding",
        ...daemonFacts(dataDir, error.holder),
      });
      if (report.success) print(io, json, report.data, env, now());
    }
    throw error;
  }
}
