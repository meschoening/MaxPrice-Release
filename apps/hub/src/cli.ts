import { parseArgs, type ParseArgsConfig } from "node:util";
import { USER_GUIDE_PAGES, USER_GUIDE_URL } from "@maxprice/shared/user-guide";
import type { ServiceArgs } from "@maxprice/usage-core/systemd-service";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { SERVE_LOCK_POLL_MS, SERVE_LOCK_RETRY_MS } from "./serve-lock-bound";
import { VERSION } from "./version";

// The Hub's command line, `maxprice-hub` (ADR-0127 §2, ADR-0129 §2): the
// Headless client's shape (apps/cli/src/main.ts), a hand-written verb table on
// `node:util`'s strict `parseArgs` with each verb's help beside it, except
// that no verb means `serve`, since the hub tray app spawns the daemon with no
// arguments.
//
// It does no work of its own: what a verb does is a handler index.ts passes
// in. So `--version` and `--help` are answered before any handler runs, before
// the data dir is resolved or a file is touched: `update` runs a new binary's
// `--version` beside a live daemon (ADR-0129 §2).

// The Hub's exit codes (ADR-0127 §2, §6, §7, §8, ADR-0129 §4, ADR-0130 §6).
export const EXIT = {
  OK: 0,
  // A crash, a failed first bind, a lock flock could not take, a data dir
  // holding a restore that did not finish, a Hub running on the data dir of
  // a command that edits its files, a running Hub a command could not reach,
  // or that did not answer a request, within 10 s, that refused its operator
  // token, its probe, `status`'s page view, a password or a key, that sent
  // an answer it cannot read, that stopped while it waited, or that it lost,
  // a serve.lock record no Hub writes, two password entries that differ, a
  // key claude.ai refused or could not check or a Claude Code OAuth token
  // given as one, a service step that failed, or restore's backup running,
  // written while it is copied, or unreadable; for `page` and its commands,
  // a hub.json they cannot use, or a Hub page URL at which the page is not
  // published; for `setup`, a Hub its ending waited 10 s for in vain; for
  // `update`, a check or an update that failed, a binary run from source, a
  // restart that failed, or a restarted Hub that did not report the new
  // version within 30 s.
  FAILURE: 1,
  // A usage error, a secret given as an argument or not at all, `key`,
  // `status`, `restore`, `service` or `update` off Linux, no Hub at the data
  // dir, an invalid password, a machine a command cannot act on, a backup
  // restore cannot use, or a data dir that already holds a Hub's files; an
  // invalid Hub page URL, or none set; `setup` off Linux, as root, off a
  // terminal, or with a data dir the unit does not or would not serve.
  USAGE: 2,
  // `status` found no Hub running on the data dir (ADR-0127 §8), `service
  // status` found the unit not active or not installed, or `service logs`
  // found it not installed: ADR-0119 §6's "not running" code, which is
  // LSB's.
  NOT_RUNNING: 3,
  // The running Hub answered 409 on the protocol check: it speaks another
  // Hub protocol than this binary, so an update is half done until it
  // restarts (ADR-0119 §6's skew code, ADR-0126 §7, ADR-0127 §7).
  SKEW: 4,
  // `serve` found another maxprice-hub holding its data dir's lock through
  // the SERVE_LOCK_RETRY_MS its take asks again for (serve-lock.ts); the unit's
  // `RestartPreventExitStatus=5` keeps systemd from retrying it.
  ALREADY_RUNNING: 5,
  // `update --check` found a newer release, as `dnf check-update` exits 100
  // when it lists one (ADR-0129 §4, the Headless client's ADR-0123 §5), so a
  // script can tell "an update" from "the check failed".
  UPDATE_AVAILABLE: 100,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

// A line under an error: free text, or a label and the command it names,
// which the renderer aligns with the other pairs in its block.
export type Hint = string | { label: string; command: string };

// An error a command expects, with the code it exits with. Anything else a
// command throws exits 1.
export class CliError extends Error {
  constructor(
    readonly code: ExitCode,
    message: string,
    readonly hints: readonly Hint[] = [],
  ) {
    super(message);
    this.name = "CliError";
  }
}

// A usage error is one line, naming the help to read.
export function usageError(message: string, help: string): CliError {
  return new CliError(EXIT.USAGE, `${message} (see '${help}')`);
}

export type Writer = { write(text: string): unknown };
export type Io = { stdout: Writer; stderr: Writer };

// What each command does; index.ts's. Each returns its exit code.
export type HubHandlers = {
  serve: () => Promise<number>;
  // Its prompts are the handler's, on a terminal (ADR-0128 §1).
  setup: (io: Io) => Promise<number>;
  // `--json` given or not; `io` is the invocation's.
  status: (json: boolean, io: Io) => Promise<number>;
  // The password and the key are read by the handler, never from argv.
  passwordSet: () => Promise<number>;
  passwordClear: () => Promise<number>;
  keySet: (io: Io) => Promise<number>;
  keyClear: (io: Io) => Promise<number>;
  rename: (machineId: string, newName: string) => Promise<number>;
  merge: (sourceId: string, targetId: string) => Promise<number>;
  purgeMachine: (machineId: string) => Promise<number>;
  compact: () => Promise<number>;
  restore: (dir: string, samples: string[]) => Promise<number>;
  service: (args: ServiceArgs, io: Io) => Promise<number>;
  // `--check` and `--json` given or not; the handler refuses --json alone.
  update: (check: boolean, json: boolean, io: Io) => Promise<number>;
  page: (io: Io) => Promise<number>;
  pageSet: (url: string, io: Io) => Promise<number>;
  pageClear: (io: Io) => Promise<number>;
  pageSnippet: (io: Io) => Promise<number>;
};

type Options = NonNullable<ParseArgsConfig["options"]>;

export type Verb = {
  // One line for the top-level help's command list.
  summary: string;
  // What `maxprice-hub <verb> --help` prints.
  help: string;
  // `--help`/`-h` is added to every verb's options.
  options: Options;
  positionals: boolean;
  // A password or a key pasted as an argument or an option would ride argv,
  // and a parse error could quote it. Hide all input except diagnostics
  // matched against known boolean option names, in this verb's options and
  // the global ones before it.
  secretSafeParseErrors?: boolean;
  // `values` are the verb's parsed options; `io` is the invocation's.
  run: (
    positionals: string[],
    handlers: HubHandlers,
    values: Parsed["values"],
    io: Io,
  ) => Promise<number>;
};

const DATA_DIR = `The data dir is MAXPRICE_HUB_DATA_DIR when it is set. Otherwise it is
$XDG_DATA_HOME/maxprice-hub on Linux, or ~/.local/share/maxprice-hub when
XDG_DATA_HOME is unset or not absolute; %APPDATA%\\maxprice-hub on Windows;
and ~/Library/Application Support/maxprice-hub on macOS.`;

// What the four commands that act on the Hub's data share (ADR-0127 §7):
// the running Hub's own route while one holds the data dir, else its files.
const OPERATOR = `On Linux the data dir's serve.lock says whether a Hub runs there. While
one does, the command goes through that Hub's own route, as the console
does, with the data dir's operator-token, and the change applies at once,
with no restart; the Hub must answer within 10 s. With the lock free, the
command holds it and edits the data dir's files itself. Elsewhere it edits
the files, and refuses while anything answers /healthz on hub.json's port.
It refuses a data dir with no hub.json: only serve or setup makes one, or
restore copies one from a backup.

${DATA_DIR}`;

const OPERATOR_EXIT_1 = `  1  On Linux, a Hub runs on the data dir but did not answer within 10 s
     (see maxprice-hub service logs), serve.lock held a pid alone all that
     time (a serve still starting, or another command at work), the Hub
     refused the operator token or its status probe, sent an answer this
     maxprice-hub cannot read, stopped while it waited, or was lost;
     elsewhere, a Hub answers /healthz on hub.json's port; or flock failed
     on serve.lock`;

const SKEW_EXIT_4 = `  4  On Linux, the running Hub speaks another Hub protocol: restart it to
     finish the update`;

const SERVE_HELP = `Usage: maxprice-hub serve

Run the Hub in the foreground: the claude.ai usage poller, the fleet event
archive, and the API its clients, its console and its Hub page read. With no
command, maxprice-hub runs serve.

${DATA_DIR}

serve creates the data dir and its hub.json, whose port and bind it serves
on, when they are missing; otherwise only setup makes them, or restore,
from a backup. On Linux it tightens the data dir to 0700 and holds a lock on
serve.lock there, which records its pid and port, so one Hub runs per data
dir. A lock another process holds it asks again for, every ${SERVE_LOCK_POLL_MS} ms for
${SERVE_LOCK_RETRY_MS} ms, before it reads hub.json or binds anything. It refuses a data dir
holding .restore-staging, which a restore killed while it placed its files
leaves: move that data dir aside and restore again.

On Linux it checks the update channel at boot and every 6 hours, writes
what it found to update-check.json (0600) in the data dir, which
'maxprice-hub status' shows, and logs a newer version once. It never
installs anything: 'maxprice-hub update' does.

It logs to stdout and stderr; under systemd both go to the journal.

SIGTERM, SIGINT and SIGHUP stop it cleanly, with exit 0.

Exit codes:
  1  A crash, flock failing on serve.lock, a data dir holding a restore
     that did not finish (.restore-staging), or a failed first bind; for
     an address in use, that line says whether a Hub already answers
     /healthz there or something else holds it, with the holder's pid and
     command when /proc shows them
  2  An option or an argument: serve takes none
  5  Another maxprice-hub held this data dir's serve.lock for all of
     ${SERVE_LOCK_RETRY_MS} ms, asked every ${SERVE_LOCK_POLL_MS} ms
`;

const STATUS_HELP = `Usage: maxprice-hub status [--json]

Describe the Hub running on the data dir as the hub tray app's Popout
describes its own: the Hub row (Online, Local only, Event sync down or Not
responding), the claude.ai row, the Access row and the connected clients;
then the session key (set or not, when and by whom, never any part of it),
the Hub's version, Update, the data dir, and the pid and port serve.lock
records. A row that has a fix names its command. Linux only.

Update is serve's last check of the update channel, read from
update-check.json in the data dir: a newer version (naming maxprice-hub
update), current, a check that failed (with why), or not checked yet. It
compares the newest version with this maxprice-hub's own. While the Hub runs
another version than this maxprice-hub, as it does after an update until it
restarts, Update names that restart instead.

The data dir's serve.lock says whether a Hub runs there. While one does,
status asks it through its own routes with the data dir's operator-token,
and it must answer within 10 s. One that recorded its port there but sends
no whole answer, to the probe or to the page view, reads Not responding; a
lock that records no port all that time (a serve still starting, or another
command at work) prints no rows. status changes no file: it holds
serve.lock only for the instant it asks it, which a serve starting just
then waits out, asking again for ${SERVE_LOCK_RETRY_MS} ms. It refuses a data dir
with no hub.json: only serve or setup makes one, or restore copies one
from a backup. 'maxprice-hub service status' describes the systemd unit
instead.

Options:
  --json  Print one object instead: the Hub page's view of the Hub, the Hub
          row's state, the key, the data dir, the pid, the port and whether
          the pid runs in maxprice-hub.service; for a Hub that recorded its
          port but did not answer, the state "not-responding" with the last
          four alone. It has no Update and reads no update-check.json

${DATA_DIR}

Exit codes:
  1  The running Hub sent no whole answer within 10 s, to its status probe
     or its page view, or was lost (status prints its Not responding rows
     first; see maxprice-hub service logs); serve.lock held a pid alone all
     that time (a serve still starting, or another command at work: no
     rows); the Hub refused the operator token, its status probe or its page
     view, sent an answer this maxprice-hub cannot read, or stopped while it
     waited; serve.lock records a pid or port no Hub writes; or flock failed
     on serve.lock
  2  A bad option or an argument, not Linux, or no Hub at the data dir
  3  No Hub runs on the data dir
${SKEW_EXIT_4}
`;

const PASSWORD_HELP = `Usage: maxprice-hub password set
       maxprice-hub password clear

Set or clear the Hub password, which hub.json in the data dir keeps as an
argon2id hash, never as the password. A password is 1 to 128 printable
ASCII characters with no spaces.

On a terminal, set asks for the password twice and shows nothing as it is
typed; otherwise it reads all of stdin, as in
'maxprice-hub password set < password.txt'. The password is never an
argument: argv lands in shell history and ps.

On Linux the data dir's serve.lock says whether a Hub runs there. While one
does, the command sends the change to that Hub's own route, as the console
does, with the data dir's operator-token, and the Hub applies it at once,
with no restart; the Hub must answer within 10 s. With the lock free, the
command holds it and rewrites hub.json, which the Hub reads when it starts.
Elsewhere it rewrites hub.json without checking for a running Hub, which
applies the change only once it restarts. It refuses a data dir with no
hub.json: only serve or setup makes one, or restore copies one from a
backup.

${DATA_DIR}

Ctrl-C at a prompt stops with exit 130, having written nothing.

Exit codes:
  1  The two entries did not match, flock failed on serve.lock, or hub.json
     cannot be written; on Linux, a running Hub did not answer within 10 s
     (see maxprice-hub service logs), serve.lock held a pid alone all that
     time (a serve still starting, or another command at work), or the Hub
     refused the operator token, its status probe or the change, sent an
     answer this maxprice-hub cannot read, stopped while it waited, or was
     lost
  2  A bad command or option, a password given as an argument, no Hub at
     the data dir, or no password or an invalid one
${SKEW_EXIT_4}
  130  set: Ctrl-C at a prompt; nothing is written
`;

const KEY_HELP = `Usage: maxprice-hub key set
       maxprice-hub key clear

Store or remove the claude.ai session key the Hub polls the Usage limits
with. The Hub keeps it in secrets.json in the data dir, readable by this
user alone (0600). Linux only: elsewhere the Hub keeps it in the keychain,
and the console sets it.

Verbs:
  set    Read the key, check it with claude.ai, then hand it to the running
         Hub, or store it for the Hub's next start. On a terminal it asks
         for the key and shows nothing as it is typed or pasted; otherwise
         it reads all of stdin, as in 'maxprice-hub key set < key.txt'. The
         key is never an argument: argv lands in shell history and ps. It
         stores nothing until claude.ai lists the key's Organizations, and
         reaches the Hub only once it has.
  clear  Remove the stored key, and the running Hub's copy. It checks
         nothing.

The data dir's serve.lock says whether a Hub runs there. While one does,
the command sends the key, or the clear, to that Hub's own route, as the
console does, with the data dir's operator-token: the Hub stores the key
and polls with it at once, or stops polling at once. The Hub must answer
within 10 s. With the lock free, the command holds it and writes or removes
secrets.json itself, which the Hub reads when it starts. It refuses a data
dir with no hub.json: only serve or setup makes one, or restore copies one
from a backup.

The key is the sessionKey cookie of a browser signed in to claude.ai, a value
starting sk-ant-sid01-. To copy it from a browser on another machine: sign in
at claude.ai, open the developer tools, then Application (Chrome, Edge) or
Storage (Firefox), Cookies, https://claude.ai, and copy the value of
sessionKey. It is not Claude Code's OAuth token (sk-ant-oat…), which set
refuses; maxprice-hub never reads ~/.claude/.credentials.json.

${DATA_DIR}

Ctrl-C at the prompt stops with exit 130, having stored nothing.

Exit codes:
  1  The key is a Claude Code OAuth token, claude.ai refused it or could not
     be reached, the running Hub did not answer within 10 s (see
     maxprice-hub service logs), serve.lock held a pid alone all that time
     (a serve still starting, or another command at work), the Hub refused
     the operator token, its status probe or the change, sent an answer this
     maxprice-hub cannot read, stopped while it waited, or was lost, flock
     failed on serve.lock, or secrets.json cannot be written or removed
  2  A bad command or option, an argument after set or clear, not Linux, no
     Hub at the data dir, or no key given
  4  The running Hub speaks another Hub protocol: restart it to finish the
     update
  130  set: Ctrl-C at the prompt; nothing is stored
`;

const RENAME_HELP = `Usage: maxprice-hub rename <machineId> <newName>

Rename a machine in the Hub's Machine directory, as the console's Rename
does. The name is trimmed, 1 to 63 characters, and in use by no other
machine, whatever its case.

${OPERATOR}

Exit codes:
${OPERATOR_EXIT_1}
  2  A bad option or argument, no Hub at the data dir, or the rename failed:
     an unknown machine, a name that is invalid or already in use, or a
     fleet event archive that did not load
${SKEW_EXIT_4}
`;

const MERGE_HELP = `Usage: maxprice-hub merge <sourceId> <targetId>

Merge one machine into another, as the console's Merge does: the source
becomes an alias of the target, and no Fleet event is rewritten.

${OPERATOR}

Exit codes:
${OPERATOR_EXIT_1}
  2  A bad option or argument, no Hub at the data dir, or the merge failed:
     an unknown machine, a machine merged into itself, an alias cycle, or a
     fleet event archive that did not load
${SKEW_EXIT_4}
`;

const PURGE_HELP = `Usage: maxprice-hub purge-machine <machineId>

Purge a machine, as the console's Purge does: its Fleet events leave the
archive, with its identity rows and its Machine directory entry, and clients
receive an incremental deletion. It first asks you to type the machine's
name, one line of stdin, which a pipe can give; Ctrl-C there stops it,
having purged nothing. When it edits the files itself, it asks while it
holds serve.lock, so a serve started meanwhile exits 5.

${OPERATOR}

Exit codes:
${OPERATOR_EXIT_1}
  2  A bad option or argument, no Hub at the data dir, or the purge failed:
     an unknown machine, no typed name or one that does not match, an
     identity directory it cannot read, or a fleet event archive that did
     not load
${SKEW_EXIT_4}
  130  Ctrl-C at the name prompt; nothing is purged
`;

const COMPACT_HELP = `Usage: maxprice-hub compact

Compact the fleet event archive, as the console's Compact does: it reclaims
the space replaced and removed events left behind, and keeps the usage and
the incremental history.

${OPERATOR}

Exit codes:
${OPERATOR_EXIT_1}
  2  A bad option or argument, no Hub at the data dir, or the compaction
     failed
${SKEW_EXIT_4}
`;

const RESTORE_HELP = `Usage: maxprice-hub restore <dir> [--samples <usage-history.jsonl>]...

Restore a stopped Hub's data dir, or a backup of one, at <dir> into the
data dir, before the data dir's first serve: a fleet moves to another Hub
this way, or a Hub comes back from a backup. It copies hub.json and
events.sqlite, which <dir> must hold, and usage-history.jsonl, the Machine,
Identity, Organization and Organization assertion directories and the Hub
roster when it holds them. It never copies secrets.json,
operator-token, serve.lock or update-check.json, nor any other file: give
the restored Hub its session key with key set or setup. It only reads <dir>,
and writes every file 0600.

The archive keeps the backup's Fleet events, Fleet change cursor and
Deletion generation, under a fresh epoch, always: every client then reseeds
once and re-contributes its usage since the backup, in any order.

--samples <file> merges a client's usage-history.jsonl into the restored
history, for the Hub's own samples since the backup; give it once for each
client. A sample the history already holds is dropped, and a line that is
not a sample is skipped.

It runs on Linux only, with the Hub stopped: it holds the data dir's
serve.lock while it works, and refuses while anything else holds it or
<dir>'s, or when <dir>'s events.sqlite changes while it is copied. It
refuses a data dir that already holds any of a Hub's files. A refused
restore, or one that fails before it places a file, leaves no restored
file there; one killed or failing while it places them leaves
.restore-staging beside them, and restore, serve and setup then refuse
that data dir until it is moved aside. It prints what it restored and the
next steps.

${DATA_DIR}

Exit codes:
  1  A Hub is running on the data dir or on <dir>, another maxprice-hub
     command holds the data dir's serve.lock, the data dir holds a restore
     that did not finish (.restore-staging beside a Hub's file),
     events.sqlite, its WAL or its journal changed while it was copied, a
     backup file cannot be read, flock failed on a serve.lock, a copy,
     write, rename or fsync failed (a failure once a file is placed keeps
     .restore-staging), or the merged usage history did not read back
  2  A bad option or argument, not Linux, no Hub to restore at <dir>, <dir>
     is the data dir or holds it, an input that overlaps .restore-staging,
     an unsafe serve.lock in the data dir, a data dir that already holds a
     Hub's files, a backup file restore cannot use, or a --samples file
     that cannot be read or has lines but no sample
`;

const SERVICE_HELP = `Usage: maxprice-hub service <install|uninstall|status|logs> [options]

Run the Hub as a systemd user unit, maxprice-hub.service, in the user
manager's config home (~/.config/systemd/user/maxprice-hub.service by
default). Start, stop and restart it with 'systemctl --user'. Linux only.

The unit runs 'maxprice-hub serve' and restarts it 10 s after a crash or a
failed first bind (exit 1), at most 5 starts in 15 minutes, but never after
exit 5: another maxprice-hub holds the data dir.

Verbs:
  install    Write the unit, enable it and start it. It rewrites the file and
             never its drop-ins, so customize it with
             'systemctl --user edit maxprice-hub'. It bakes in
             MAXPRICE_HUB_DATA_DIR when this shell sets it, a relative one
             made absolute against this directory, restarts a running Hub
             when the file changed, and prints the linger step when linger
             is off.
  uninstall  Stop and disable the unit and remove its file. The data dir, its
             secrets.json, the drop-ins and linger stay.
  status     The unit's state, start time, restarts and last exit; whether it
             runs this maxprice-hub and serves this shell's data dir; linger;
             whether a Hub answers /healthz on the port the data dir's
             serve.lock records; and who holds that lock when the unit
             stopped on exit 5.
  logs       The unit's journal, through
             journalctl --user --user-unit=maxprice-hub.service.
             It exits with journalctl's own code.

Options for logs:
  -f, --follow     Follow the journal
  -n, --lines <N>  Show the last N lines

The data dir is MAXPRICE_HUB_DATA_DIR when it is set, else
$XDG_DATA_HOME/maxprice-hub, or ~/.local/share/maxprice-hub when
XDG_DATA_HOME is unset or not absolute. The unit never sees this shell's
XDG_DATA_HOME, so when only that moves the data dir, set
MAXPRICE_HUB_DATA_DIR before install; status flags a unit whose data dir
is not this shell's, and setup refuses such a shell.

With no systemd user manager, every verb fails; run 'maxprice-hub serve'
under your init instead, restarting it after exit 1 but not after exit 5.

Exit codes:
  1  No systemd user manager, a systemctl step failed, journalctl is not on
     PATH, or uninstall found the file gone while the manager still has the
     unit
  2  A bad verb or option, an argument after the verb, -f or -n with a verb
     other than logs, a -n that is not a whole number, or not Linux
  3  status: the unit is not active, or not installed;
     logs: the unit is not installed
`;

const UPDATE_HELP = `Usage: maxprice-hub update [--check [--json]]

Install the newest maxprice-hub from the update channel over this binary. It
installs a release only when it is signed by MaxPrice's key, under its own
version, newer than this maxprice-hub, and its binary runs here and prints
that version; anything else leaves this binary as it is. There is no
downgrade and no rollback: the previous release stays on its release page.

The channel is the Headless Hub's own, headless-hub-latest.json. Linux only:
the hub tray app updates itself, its daemon included, through its own
updater.

It never runs sudo: this user must be able to read, write and search the
binary's directory. From source it refuses, and --check still works.

After the swap, a running maxprice-hub.service whose ExecStart is this
binary is restarted with 'systemctl --user restart maxprice-hub.service',
and update waits up to 30 s for the restarted Hub to report the new version
on its /page/view, at the port serve.lock records in the unit's data dir.
One that runs another binary is left running, and update says so.
Otherwise a 'maxprice-hub serve' run outside the unit on this shell's data
dir is left running, and update says to restart it; with no such serve,
update only swaps. Run as root, as for a shared /usr/local/bin, it restarts
nothing: each user restarts their own unit.

A Headless Hub's serve checks the channel at boot and every 6 hours, and
never installs anything; 'maxprice-hub status' shows what it found on its
Update row.

Options:
  --check     Only say whether a newer maxprice-hub is available; it
              downloads and writes nothing
  --json      With --check: print {"current":…,"latest":…,"available":…}
  -h, --help  Show this help

This shell's data dir is MAXPRICE_HUB_DATA_DIR when it is set, else
$XDG_DATA_HOME/maxprice-hub, or ~/.local/share/maxprice-hub when
XDG_DATA_HOME is unset or not absolute. The unit's is found the same way
from the unit's own Environment, never this shell's.

Exit codes:
  0  Success; with --check, this maxprice-hub is current
  1  The check or the update failed, or this maxprice-hub runs from source,
     and this binary is unchanged; or, with this binary already replaced,
     the restart failed or the restarted Hub did not report the new version
     within 30 s (see maxprice-hub service logs)
  2  A bad option or an argument, --json without --check, or not Linux
  100  --check found a newer maxprice-hub
`;

const PAGE_HELP = `Usage: maxprice-hub page
       maxprice-hub page set <url>
       maxprice-hub page clear
       maxprice-hub page snippet

Report or set the Hub page URL: the address at which your own web server
publishes the Hub page, the read-only page the Hub serves to loopback peers
at http://127.0.0.1:<port>/page/. The Hub never writes web-server config:
it prints an Apache snippet, and you install it with sudo.

page reports the Hub page URL, the loopback target, a reading and the
one-line contract for any other web server. With a URL set, it first asks
/healthz whether the Hub runs: on Linux at the port serve.lock records,
elsewhere at hub.json's port. It then fetches <url>view, waiting at most
5 s, and reads published, another Hub's page, something other than the Hub
page, the web server refusing this machine (403), the snippet not installed
(404), the web server unable to reach the Hub (502 or 503), another status,
or no answer. It asks both directly, never through a proxy HTTP_PROXY or
its kin name. A stopped Hub reads Hub not running. While the Hub runs and
the page is not published, page prints the steps that install the snippet
on Debian or Ubuntu's Apache, sudo a2enmod proxy_http first. With no URL
set, or a stored one that is not valid, which it names and the Hub treats
as unset, it exits 0 and names the SSH tunnel route instead:
ssh -L <port>:127.0.0.1:<port> to the Hub's machine, then the loopback
target.

page set writes <url> to hub.json. It must be an http:// or https:// URL
with no user name, password, query or fragment, whose path segments hold
only letters, digits, ".", "_", "~" and "-", none of them empty, "." or
"..". It appends a trailing slash when the path lacks one, since the page's
relative links resolve only under it. It prints the new snippet and says
any installed copy is now stale, every time: nothing tracks one.

page clear removes the Hub page URL. A web server keeps publishing the page
until its snippet is removed.

page snippet writes the snippet alone to stdout, so that
maxprice-hub page snippet | sudo tee <file> installs it.

None of the four takes serve.lock, and none needs the Hub stopped or
restarted: the Hub reads the Hub page URL only for its boot log. Each
refuses a data dir with no hub.json: only serve or setup makes one, or
restore copies one from a backup. Each also refuses a hub.json the Hub's boot
would replace with the defaults, and changes nothing.

${DATA_DIR}

Exit codes:
  1  page: a Hub page URL is set and the page is not published there; any
     of the four: a hub.json that is not JSON, not an object or holds a
     wrong-typed passwordHash, or one that cannot be read or written
  2  A bad command or option, no Hub at the data dir, an invalid Hub page
     URL (page set), or no valid one set (page snippet)
`;

const SETUP_HELP = `Usage: maxprice-hub setup

Walk the Hub's setup on a terminal, in four steps: the claude.ai session
key, the Hub password, the Hub page URL and maxprice-hub.service. Each step
runs its command's own code, key set, password set or clear, page set or
clear, and service install, and has that command's effect; setup adds only
the questions around them. Linux only: the hub tray app sets itself up.

Before it creates anything, it refuses root, since the Hub runs as its own
user; a stdin that is not a terminal, listing the commands to run in its
place, in order; and, with a systemd user manager, an installed
maxprice-hub.service that serves another data dir than this shell's, or a
shell from which the unit would serve another once installed: the unit
never sees XDG_DATA_HOME, so where that alone moves the data dir, set
MAXPRICE_HUB_DATA_DIR instead.

It first makes the data dir (0700) and its hub.json when they are missing,
as serve does, so the Hub's first start already has its key and password.
While a Hub runs on the data dir, the key and password steps go through
it, as key set and password set do, and it applies each at once. Each step
commits on its own. Enter skips or keeps the first three steps. At step 4's
[Y/n] prompt, Enter installs and starts the service; n skips it. A failed
step says why and asks again. Ctrl-C at a prompt, or Ctrl-D on an empty
visible one, stops setup with exit 130, keeping every step it completed.
Run again, the first three steps show what is set and keep it on Enter.
An installed unit is installed again without a question, which restarts
the Hub only when the unit's file changed.

At the end it waits up to 10 s for the Hub, when step 4 started the unit or
serve.lock names a running Hub, and reads the Hub page as page does. It then
lists the sudo steps still missing: loginctl enable-linger while the unit is
installed and linger is off, and those that install the Apache snippet while
the page is not published. Enter checks again, and q finishes. Last, it
prints the address clients join. With no Hub running and none started, it
says how to start serve under your own init, or, after an install that
failed, to run service install again once fixed, and exits 0.

It never sets bind or port: edit them in hub.json, then restart the Hub.

${DATA_DIR}

Exit codes:
  1  The Hub did not answer within 10 s, at the start or at the end
     (maxprice-hub service logs says why when the unit runs it), refused
     the operator token or its status probe, sent an answer this
     maxprice-hub cannot read, or stopped while it waited; flock failed on
     serve.lock, or the data dir holds a restore that did not finish
     (.restore-staging)
  2  An argument or option, not Linux, root, stdin not a terminal, or a
     maxprice-hub.service that serves, or once installed from this shell
     would serve, another data dir than this shell's
${SKEW_EXIT_4}
  130  Ctrl-C at a prompt, or Ctrl-D on an empty visible one; every step
       completed before it is kept
`;

function usage(verb: string, message: string): CliError {
  return usageError(message, `maxprice-hub ${verb} --help`);
}

export const VERBS: Record<string, Verb> = {
  serve: {
    summary: "Run the Hub in the foreground",
    help: SERVE_HELP,
    options: {},
    positionals: false,
    run: (_positionals, handlers) => handlers.serve(),
  },
  setup: {
    summary: "Walk the Hub's setup on a terminal (Linux)",
    help: SETUP_HELP,
    options: {},
    positionals: true,
    // A key or a password pasted after setup, which reads both, would ride
    // argv: no message here quotes it.
    secretSafeParseErrors: true,
    run: async (positionals, handlers, _values, io) => {
      if (positionals.length > 0) throw usage("setup", "setup takes no arguments");
      return await handlers.setup(io);
    },
  },
  status: {
    summary: "Describe the running Hub: maxprice-hub status [--json]",
    help: STATUS_HELP,
    options: { json: { type: "boolean" } },
    positionals: false,
    run: (_positionals, handlers, values, io) => handlers.status(values.json === true, io),
  },
  password: {
    summary: "Set or clear the Hub password: maxprice-hub password set|clear",
    help: PASSWORD_HELP,
    options: {},
    positionals: true,
    secretSafeParseErrors: true,
    // No message here quotes what was typed: a password pasted where the
    // command goes, or after it, would be.
    run: async ([command, ...rest], handlers) => {
      switch (command) {
        case undefined:
          throw usage("password", "password needs a command: set or clear");
        case "set":
          // ADR-0128 §6: the handler reads it, so any argument is refused.
          if (rest.length > 0) {
            throw usage(
              "password",
              "the password is never an argument: argv lands in shell history and ps; " +
                "type it at the prompt or pipe it on stdin",
            );
          }
          return await handlers.passwordSet();
        case "clear":
          if (rest.length > 0) throw usage("password", "password clear takes no arguments");
          return await handlers.passwordClear();
        default:
          throw usage("password", "unknown password command; the commands are set and clear");
      }
    },
  },
  key: {
    summary: "Set or clear the session key: maxprice-hub key set|clear",
    help: KEY_HELP,
    options: {},
    positionals: true,
    secretSafeParseErrors: true,
    // ADR-0126 §6: no message here quotes what was typed, a key pasted
    // where the command goes or after it included.
    run: async ([command, ...rest], handlers, _values, io) => {
      switch (command) {
        case undefined:
          throw usage("key", "key needs a command: set or clear");
        case "set":
          if (rest.length > 0) {
            throw usage(
              "key",
              "the key is never an argument: argv lands in shell history and ps; " +
                "paste it at the prompt or pipe it on stdin",
            );
          }
          return await handlers.keySet(io);
        case "clear":
          if (rest.length > 0) throw usage("key", "key clear takes no arguments");
          return await handlers.keyClear(io);
        default:
          throw usage("key", "unknown key command; the commands are set and clear");
      }
    },
  },
  rename: {
    summary: "Rename a machine",
    help: RENAME_HELP,
    options: {},
    positionals: true,
    run: async ([machineId, newName, ...extra], handlers) => {
      if (machineId === undefined || newName === undefined || extra.length > 0) {
        throw usage("rename", "rename takes two arguments: <machineId> <newName>");
      }
      return await handlers.rename(machineId, newName);
    },
  },
  merge: {
    summary: "Merge one machine into another",
    help: MERGE_HELP,
    options: {},
    positionals: true,
    run: async ([sourceId, targetId, ...extra], handlers) => {
      if (sourceId === undefined || targetId === undefined || extra.length > 0) {
        throw usage("merge", "merge takes two arguments: <sourceId> <targetId>");
      }
      return await handlers.merge(sourceId, targetId);
    },
  },
  "purge-machine": {
    summary: "Purge a machine and its Fleet events",
    help: PURGE_HELP,
    options: {},
    positionals: true,
    run: async ([machineId, ...extra], handlers) => {
      if (machineId === undefined || extra.length > 0) {
        throw usage("purge-machine", "purge-machine takes one argument: <machineId>");
      }
      return await handlers.purgeMachine(machineId);
    },
  },
  compact: {
    summary: "Compact the fleet event archive",
    help: COMPACT_HELP,
    options: {},
    positionals: false,
    run: (_positionals, handlers) => handlers.compact(),
  },
  restore: {
    summary: "Restore a stopped Hub's backup into an empty data dir",
    help: RESTORE_HELP,
    options: { samples: { type: "string", multiple: true } },
    positionals: true,
    run: async ([dir, ...extra], handlers, values) => {
      if (dir === undefined || extra.length > 0) {
        throw usage("restore", "restore takes one argument: <dir>");
      }
      return await handlers.restore(dir, (values.samples as string[] | undefined) ?? []);
    },
  },
  service: {
    summary: "Run the Hub as a systemd user unit (Linux)",
    help: SERVICE_HELP,
    options: {
      follow: { type: "boolean", short: "f" },
      lines: { type: "string", short: "n" },
    },
    positionals: true,
    run: (positionals, handlers, values, io) =>
      handlers.service(
        {
          positionals,
          follow: values.follow === true,
          lines: values.lines as string | undefined,
        },
        io,
      ),
  },
  update: {
    summary: "Install the newest maxprice-hub, or check for one (Linux)",
    help: UPDATE_HELP,
    options: { check: { type: "boolean" }, json: { type: "boolean" } },
    positionals: false,
    run: (_positionals, handlers, values, io) =>
      handlers.update(values.check === true, values.json === true, io),
  },
  page: {
    summary: "Report or set the Hub page URL: page [set <url>|clear|snippet]",
    help: PAGE_HELP,
    options: {},
    positionals: true,
    run: async ([command, ...rest], handlers, _values, io) => {
      switch (command) {
        case undefined:
          return await handlers.page(io);
        case "set":
          if (rest.length !== 1) throw usage("page", "page set takes one argument: <url>");
          return await handlers.pageSet(rest[0]!, io);
        case "clear":
          if (rest.length > 0) throw usage("page", "page clear takes no arguments");
          return await handlers.pageClear(io);
        case "snippet":
          if (rest.length > 0) throw usage("page", "page snippet takes no arguments");
          return await handlers.pageSnippet(io);
        default:
          throw usage("page", "unknown page command; the commands are set, clear and snippet");
      }
    },
  },
};

function topHelp(): string {
  const names = [...Object.keys(VERBS), "help"];
  const width = Math.max(...names.map((name) => name.length));
  const rows = [
    ...Object.entries(VERBS).map(([name, verb]) => `  ${name.padEnd(width)}  ${verb.summary}`),
    `  ${"help".padEnd(width)}  Show a command's help: maxprice-hub help <command>`,
  ];
  return `maxprice-hub ${VERSION}, the MaxPrice Hub's daemon

Usage: maxprice-hub [<command>] [options]

With no command, it runs serve.

Commands:
${rows.join("\n")}

Options:
  -h, --help  Show this help
  --version   Print the version

The commands other than serve, setup, status, service, update, restore and
page act on the Hub at the data dir. On Linux, while a Hub runs there, they
go through its own routes with the data dir's operator-token, and it
applies each change at once, with no restart; with none running, they edit
the data dir's files. Elsewhere they edit the files, and key is Linux only.
setup walks key set, password set, page set and service install on a
terminal, on Linux, making the data dir first as serve does. status
describes the Hub running there, the same way, on Linux. restore fills an
empty data dir from a stopped Hub's backup, and service runs serve as a
systemd user unit, both on Linux. update replaces this binary with the
newest release, on Linux, and restarts the unit that runs it. page set and
page clear edit hub.json beside a running Hub too, which reads the Hub page
URL only for its boot log.

Exit codes:
  0  Success, or serve stopped cleanly
  1  A crash, a failed first bind, flock failing on serve.lock, a data dir
     holding a restore that did not finish, a Hub running on the data dir
     of a command that edits its files, a running Hub a command could not
     reach within 10 s, or that did not answer a request within 10 s (a
     change may then have been applied), that refused its operator token,
     its probe, its page view, a password or a key, that sent an answer it
     cannot read, that stopped while it waited or that it lost, a
     serve.lock record no Hub writes, two password entries that differ, a
     key claude.ai refused or could not check or a Claude Code OAuth token
     given as one, a service step that failed, or restore's backup
     running, written while it is copied, or unreadable; for page, a
     hub.json it cannot use, or a Hub page URL at which the page is not
     published; for setup, a Hub its ending waited 10 s for in vain; for
     update, a check or an update that failed, a binary run from source, a
     restart that failed, or a restarted Hub that did not report the new
     version within 30 s
  2  Usage error, a secret given as an argument or not at all, no Hub at
     the data dir, an invalid password, key set or clear, status, restore,
     service or update, off Linux, a machine a command cannot act on, a
     backup restore cannot use, or a data dir that already holds a Hub's
     files; an invalid Hub page URL, or none set; setup off Linux, as root,
     off a terminal, or beside a unit that serves, or would serve, another
     data dir
  3  status: no Hub runs on the data dir; service status: the unit is not
     active, or not installed; service logs: the unit is not installed
  4  The running Hub speaks another Hub protocol: restart it to finish the
     update
  5  serve: another maxprice-hub held the data dir's serve.lock for ${SERVE_LOCK_RETRY_MS} ms
  100  update --check: a newer maxprice-hub is available
  130  Ctrl-C at a prompt: password set or key set, which write nothing,
       purge-machine, which purges nothing, or setup, which keeps every
       step it completed

User guide: ${USER_GUIDE_URL}${USER_GUIDE_PAGES.headlessHub}
`;
}

const TOP_HELP = "maxprice-hub --help";

const HELP_OPTION: Options = { help: { type: "boolean", short: "h" } };

type Parsed = { values: Record<string, unknown>; positionals: string[] };

// parseArgs throws only for what it was given, so any throw is a usage error.
function parse(
  args: string[],
  options: Options,
  positionals: boolean,
  help: string,
  secretSafeErrors = false,
): Parsed {
  try {
    const { values, positionals: rest } = parseArgs({
      args,
      options,
      allowPositionals: positionals,
      strict: true,
    });
    return { values, positionals: rest };
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (secretSafeErrors) {
      const code = (error as { code?: unknown }).code;
      // Bun's boolean-value refusal names only the known option. Match the
      // entire diagnostic, as the Headless client does: the error code alone
      // can cover messages that quote values. Everything else is fixed text.
      const knownBoolean =
        code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" &&
        Object.entries(options).some(([name, option]) => {
          const label = option.short ? `-${option.short}, --${name}` : `--${name}`;
          return (
            option.type === "boolean" && message === `Option '${label}' does not take an argument`
          );
        });
      if (!knownBoolean) {
        message =
          code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? "unknown option" : "invalid command options";
      }
    }
    throw usageError(message.charAt(0).toLowerCase() + message.slice(1), help);
  }
}

function findVerb(name: string): Verb | undefined {
  return Object.hasOwn(VERBS, name) ? VERBS[name] : undefined;
}

function lookup(name: string): Verb {
  const verb = findVerb(name);
  if (verb === undefined) throw usageError(`unknown command '${name}'`, TOP_HELP);
  return verb;
}

async function dispatch(argv: string[], io: Io, handlers: HubHandlers): Promise<number> {
  // Options before the verb are the global ones; the rest are its own.
  // Global errors take the parse policy of the verb they precede, so an
  // option pasted before password is hidden as one after it is.
  const at = argv.findIndex((arg) => !arg.startsWith("-"));
  const name = at === -1 ? undefined : argv[at]!;
  const rest = at === -1 ? [] : argv.slice(at + 1);
  const global = parse(
    at === -1 ? argv : argv.slice(0, at),
    { ...HELP_OPTION, version: { type: "boolean" } },
    false,
    TOP_HELP,
    name !== undefined && findVerb(name)?.secretSafeParseErrors === true,
  );

  if (global.values.version === true) {
    if (argv.length !== 1) throw usageError("--version takes no other arguments", TOP_HELP);
    io.stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (name === undefined && global.values.help === true) {
    io.stdout.write(topHelp());
    return EXIT.OK;
  }
  if (name === "help") {
    if (rest.length > 1) throw usageError("help takes at most one command", TOP_HELP);
    io.stdout.write(rest.length === 0 ? topHelp() : lookup(rest[0]!).help);
    return EXIT.OK;
  }

  // No verb is serve: the tray app's contract.
  const verbName = name ?? "serve";
  const verb = lookup(verbName);
  const parsed = parse(
    rest,
    { ...verb.options, ...HELP_OPTION },
    verb.positionals,
    `maxprice-hub ${verbName} --help`,
    verb.secretSafeParseErrors,
  );
  if (global.values.help === true || parsed.values.help === true) {
    io.stdout.write(verb.help);
    return EXIT.OK;
  }
  return await verb.run(parsed.positionals, handlers, parsed.values, io);
}

// One line of an error's text, however it was thrown: line breaks fold to a
// space, and no value inside it reaches the terminal as a control character
// (`terminalText`).
function oneLine(text: string): string {
  return terminalText(text.replace(/\s*[\r\n]+\s*/g, " ").trim());
}

// An error's stderr text: its message on one line, then a CliError's hints,
// each indented two spaces. A label/command pair pads its label to the
// block's longest label plus two spaces, so the commands line up: the
// Headless client's layout (ADR-0119 §7), with no prefix.
// Exported for setup, which prints a failed step's error this way, indented
// under the step (ADR-0128 §3).
export function renderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = [oneLine(message)];
  if (error instanceof CliError) {
    const width = Math.max(
      0,
      ...error.hints.map((hint) => (typeof hint === "string" ? 0 : oneLine(hint.label).length)),
    );
    for (const hint of error.hints) {
      lines.push(
        typeof hint === "string"
          ? `  ${oneLine(hint)}`
          : `  ${oneLine(hint.label).padEnd(width)}  ${oneLine(hint.command)}`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

// Runs one invocation and returns its exit code. A CliError exits with its
// own code, anything else with 1, its message one line on stderr and a
// CliError's hints under it.
export async function runHubCli(
  argv: string[],
  handlers: HubHandlers,
  io: Io = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  try {
    return await dispatch(argv, io, handlers);
  } catch (error) {
    io.stderr.write(renderError(error));
    return error instanceof CliError ? error.code : EXIT.FAILURE;
  }
}
