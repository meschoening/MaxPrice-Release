import { parseArgs, type ParseArgsConfig } from "node:util";
import { USER_GUIDE_PAGES, USER_GUIDE_URL } from "@maxprice/shared/user-guide";
import { CliError, EXIT, usageError } from "./exit";
import { renderError } from "./render/error";
import { VERSION } from "./version";

// The Headless client's entry, `maxprice` (ADR-0118 §1, §5): a hand-written
// command table on `node:util`'s strict `parseArgs`, each command's help text
// beside it.
//
// These five imports are this module's only static ones, and a command's
// module is loaded with `await import()` when that command runs. So
// `--version` and `--help` evaluate no engine, no Zod schema and no Hono:
// `maxprice update` runs a new binary's `--version` beside a live daemon,
// which must stay fast and free of side effects (ADR-0123 §4), and only
// `serve` loads the sidecar's boot (ADR-0118 §2). Bun's compiled binary keeps
// a dynamic import lazy.

export type Writer = { write(text: string): unknown; isTTY?: boolean; columns?: number };
export type Io = { stdout: Writer; stderr: Writer };

type Options = NonNullable<ParseArgsConfig["options"]>;

export type Parsed = { values: Record<string, unknown>; positionals: string[] };

export type Command = {
  // One line for the top-level help's command list.
  summary: string;
  // What `maxprice <command> --help` prints.
  help: string;
  // `--help`/`-h` is added to every command's options.
  options: Options;
  positionals: boolean;
  // Parser errors can quote a key or password pasted as an option. Hide all
  // input except diagnostics matched against known boolean option names, in
  // this command's options and the global ones before it.
  secretSafeParseErrors?: boolean;
  run: (parsed: Parsed, io: Io) => Promise<number>;
};

// The flags every report shares (#464), turned into the Desktop's filter
// state by `report-request.ts`.
const REPORT_OPTIONS: Options = {
  since: { type: "string" },
  until: { type: "string" },
  model: { type: "string", multiple: true },
  project: { type: "string", multiple: true },
  machine: { type: "string", multiple: true },
  account: { type: "string", multiple: true },
  org: { type: "string", multiple: true },
  json: { type: "boolean" },
};

// `blocks` takes every report flag but --project: a block is cross-project
// (ADR-0017), and the Desktop's Blocks page sends no project.
const BLOCKS_OPTIONS: Options = Object.fromEntries(
  Object.entries(REPORT_OPTIONS).filter(([name]) => name !== "project"),
);

// `live` takes --account, --org and --json alone: it is the popout's
// snapshot, which has no filter rail and no range.
const LIVE_OPTIONS: Options = Object.fromEntries(
  Object.entries(REPORT_OPTIONS).filter(([name]) => ["account", "org", "json"].includes(name)),
);

// What --account and --org name (ADR-0140 §1, §2), for every report's help
// and live's.
const SCOPE_HELP = `--account and --org name the Scope, the Memberships a report describes.
Each repeats to name more, and the two intersect: every tracked Membership
whose Account is one --account names and whose Organization is one --org
names. One left out matches any; with neither, the Scope is the Home
membership. all on either matches any, and home names that side of the Home
membership. The usage whose Account is not known is in the Scope unless
every --account is a name rather than all or home.`;

// The exit code 2 every report shares.
const REPORT_USAGE_EXIT = `  2  A bad option or argument, a name that matches no or several things, an
     excluded Account or Organization, or a Scope that holds no tracked
     Membership`;

const SCOPE_OPTIONS_HELP = `  --account <account>  Only this Account, by its label, its uuid, an
                       8-character uuid prefix, or its email as read here
  --org <org>          Only this Organization, by its label, its uuid or an
                       8-character uuid prefix`;

// The report flags' help, with or without the --project line.
function reportFlagsHelp({ project }: { project: boolean }): string {
  const projectLine = project
    ? "\n  --project <name>     Only this project, by its path or its folder name"
    : "";
  const repeated = project ? "--model, --project and --machine" : "--model and --machine";
  return `Options:
  --since <date>       The first day, YYYYMMDD or YYYY-MM-DD
  --until <date>       The last day, YYYYMMDD or YYYY-MM-DD
                       Without either, the range is this week, as the Week
                       setting defines it.
  --model <family>     Only this Model family: Fable, Opus, Sonnet or Haiku${projectLine}
  --machine <name>     Only this machine, by its name, id or an 8-character
                       id prefix; needs a Hub joined with the Fleet replica on
                       ${repeated} repeat to name more.
${SCOPE_OPTIONS_HELP}
  --json               Print the daemon's response verbatim
  -h, --help           Show this help

Days are local dates in the timezone setting, or with none set, the zone
this shell is in (TZ).

${SCOPE_HELP}

Exit codes:
  1  A daemon error, a timeout or a bad response, or a settings.json it
     cannot read as a JSON object
${REPORT_USAGE_EXIT}
  3  The daemon is not running
  4  The daemon runs another version than this maxprice
`;
}

const DAILY_HELP = `Usage: maxprice daily [options]

Usage and cost per day, oldest first, then a Total row that sums the days.

Columns: Date, Models, Input, Output, Cache create, Cache read, Total tokens,
Cost. On a terminal too narrow for them all, columns drop in this order:
Cache read, Cache create, Input, Models, Output, Total tokens. Piped output
keeps every column.

${reportFlagsHelp({ project: true })}`;

const BLOCKS_HELP = `Usage: maxprice blocks [options]

The 5-hour blocks, newest first, with the active block first. They are one
Organization's: Home's while the Scope holds the Home membership, as with
no flag and under --org all, else the one Organization it names. While
more than one Organization is tracked, the header under --org all names it
(quota: <label>). Blocks are cross-project, so there is no --project.

Columns: Window, Status, Burn rate, Total tokens, Cost, Projected, 5h limit.
On a terminal too narrow for them all, columns drop in this order: Total
tokens, Burn rate, Projected, 5h limit. Piped output keeps every column.

A window marked ~ is heuristic, estimated with no Usage sample; one marked ×
was annulled, cut short by an Out-of-band reset. The line under the table is
their legend.

While two or more Accounts are tracked and the Scope holds two or more of
their Memberships (--account all, or --org all, for one), the table becomes
one section per Membership that forms Blocks in the range, the most used
first: by the highest percent of any live limit window, an expired key's
last reading included, then those with no reading, by name. Each section is
headed by the Membership (Organization · Account while the sections span
Accounts), its plan, and every limit window, over that Membership's own
Blocks:

  Acme Research · Alex (Max plan): 5-hour 41% · weekly 20%

A window with no live reading prints —. An expired key's last reading is
marked stale; a Membership with no reading says not connected, not readable
now or no limits instead. The Memberships that form no Blocks in the range
(no 5-hour limit, or no usage) share one line after the sections:
"No Blocks: Third · Blair, Side project · Alex". A Scope that holds one
Membership, as with no flag, prints the one table.

Usage whose Account is not known is in none of these Blocks. While the scope
has some in the range, one more line names its cost and tokens:
"Account not known: $2.75 · 2,500,000 tokens, outside these Blocks' limits".

${reportFlagsHelp({ project: false })}`;

const LIVE_HELP = `Usage: maxprice live [options]

One snapshot of what the tray popout shows: the Active block, the Usage
limits and today. It prints once and does not refresh.

  Active block · <label>
    Window        9:36 PM – 2:36 AM  (2h 20m in, 2:39 left)
    Cost          $10.75  8.2M tok
    Burn rate     60K tok/min · $4.74/h
    Projected     $23.24 by 2:36 AM

    5-hour limit  41%  resets 2:36 AM
    Weekly limit  33%  resets in 3d 3h
    Today         $10.75  8.2M tok

The Active block and the limits are one Organization's: Home's while the
Scope holds the Home membership, as with no flag and under --org all, else
the one it names. Its label follows "Active block" only while
more than one Organization is tracked. With no Active block, the top section
is the one line "No active block". Burn rate and Projected print while the
block has them; Projected is its total if the burn rate holds.

A limit prints — when it has no fresh reading (no limits connection, or a
reading whose reset has passed), and then no reset time. A Model-scoped
weekly limit adds its own line, named by the model it limits (Fable limit).
Today is the cost and tokens of the day in the timezone setting, or with none
set, the zone this shell is in (TZ); under --org all it is every Tracked
organization's, and reads "Today · all".

Usage whose Account is not known is in no Active block. While the scope has
some since yesterday, a last line names its cost and tokens:
"Account not known: $2.75  2.5M tok since yesterday, outside these limits".

While two or more Accounts are tracked and the Scope holds two or more of
their Memberships, the panel is the ranked popout's, with nothing folded:

  Active block · Acme Research · Alex
    Window        9:36 PM – 2:36 AM  (2h 20m in, 2:39 left)
    Cost          $10.75  8.2M tok

  Limits
    Third · Blair          5-hour 90% · weekly 60% · stale
    Acme Research · Alex   5-hour 41% (resets 2:36 AM) · weekly 20%
                           (resets in 3d 3h)
    Side project · Alex    not readable now

    Today · All accounts   $12.40  9.1M tok

The Active block is the most used Membership's whose 5-hour window is in
flight, an expired key's aside; with none in flight, the top section reads
"Most used · <Membership>" over "No active block". Limits lists every
Membership in the Scope, one line each, the most used first, as blocks
ranks its sections: every limit window with its reset, a window with no
live reading as —, an expired key's last reading marked stale, and a
Membership with no reading as not connected, not readable now or no
limits. Today is the Scope's day, named for it as the report headers name
the Scope. A Scope that holds one Membership, as with no flag, prints the
panel above.

Options:
${SCOPE_OPTIONS_HELP}
  --json               Print {"blocks":…,"usage":…,"today":…}: the daemon's
                       /api/blocks, /api/usage/current and /api/daily
                       responses the panel reads, each verbatim. For the
                       ranked panel, {"blocks":…,"accounts":…,"today":…}:
                       the head Membership's /api/blocks (null with no
                       5-hour window in flight), /api/accounts and
                       /api/daily
  -h, --help           Show this help

${SCOPE_HELP}

Exit codes:
  1  A daemon error, a timeout or a bad response, or a settings.json it
     cannot read as a JSON object
${REPORT_USAGE_EXIT}
  3  The daemon is not running
  4  The daemon runs another version than this maxprice
`;

const SESSIONS_HELP = `Usage: maxprice sessions [options]

Usage and cost per session, newest last activity first, then a Total row:
the Desktop's Projects strip total for the same range and Scope, not the sum
of the rows above it. A session counts whole in its row, but only its usage
in the range counts in the Total, so a session that began before the range
makes the Total smaller than the rows' sum; a session with usage under two
projects counts in the Total once for each.

Columns: Session, Project, Machine, Account, Organization, Models, Input,
Output, Total tokens, Cost, Last activity. Machine appears while a Hub is
joined with the Fleet replica on, Account while the Scope spans two or more
Accounts, Organization while it spans two or more Organizations. Account
lists the Accounts with usage on that row in the range, asking the daemon
once more for each Account. On a terminal too narrow for them all, columns
drop in this order: Input and Output together, then Models, Total tokens,
Machine, Organization, Account, Last activity. Piped output keeps every
column.

${reportFlagsHelp({ project: true })}`;

const PROJECTS_HELP = `Usage: maxprice projects [options]

Usage and cost per project over the range, by cost, then a Total row: the
Desktop's Projects strip total for the same range and scope. A project
folded from several directories, its own, its worktrees and its other
checkouts, lists each beneath it, indented ↳: the checkouts first, then the
worktrees by cost.

Columns: Project, Path, Top model, Machines, Accounts, Organizations,
Sessions, Total tokens, Cost, Last activity. Machines appears while a Hub is
joined with the Fleet replica on, Accounts while the Scope spans two or more
Accounts, Organizations while it spans two or more Organizations. Accounts
lists the Accounts with usage on that row in the range, asking the daemon
once more for each Account. On a terminal too narrow for them all, columns
drop in this order: Path, Top model, Sessions, Machines, Organizations,
Accounts, Total tokens, Last activity. Piped output keeps every column.

${reportFlagsHelp({ project: true })}`;

const SERVE_HELP = `Usage: maxprice serve

Run the daemon in the foreground: the usage engine over this machine's Claude
Code logs, the Local archive, and the API the other commands read.

It keeps its files in the data dir, $XDG_DATA_HOME/maxprice, or
~/.local/share/maxprice when XDG_DATA_HOME is unset or not absolute. It
tightens that dir to 0700, listens on daemon.sock in it (0600), and holds a
lock on serve.lock there, so one daemon runs per data dir.

It logs to stderr, and its boot trace to stdout; under systemd both go to the
journal.

It reads its settings from settings.json in the data dir, and refuses to
start on a file it cannot read as a JSON object, or one whose Home
membership or tracked list is a value the setting does not take. On a
first boot it saves the Home membership it chose there, so a later boot
keeps it.

It reads secrets.json in the data dir once, at start: the claude.ai session
key that 'maxprice key set' stores, and the Hub password that 'maxprice hub
join --password' stores, which it uses only when settings.json names a Hub.
It tightens a secrets.json that group or others can access to 0600. One it
cannot read, one another user owns, or one that is not valid is skipped with
one log line, and the daemon starts without its secrets; it never exits for
the file. Nothing watches it, so a change made by hand applies at the next
start.

It checks the update channel at boot and every 6 hours and writes what it
found to update-check.json in the data dir, which 'maxprice status' shows;
it never installs anything.

SIGTERM, SIGINT and SIGHUP stop it cleanly, with exit 0.

Exit codes:
  1  A crash or a failed bind
  2  An option or an argument: serve takes none
  5  Another 'maxprice serve' holds this data dir
  6  settings.json cannot be read, or its Home membership or a tracked
     list is rejected; fix the file, then start it again
`;

const SERVICE_HELP = `Usage: maxprice service <install|uninstall|status|logs> [options]

Run the daemon as a systemd user unit in the manager's config home
(~/.config/systemd/user/maxprice.service by default).
Start, stop and restart it with 'systemctl --user'.

Verbs:
  install    Write the unit, enable it and start it. It rewrites the file and
             never its drop-ins, so customize it with
             'systemctl --user edit maxprice'. It bakes in CLAUDE_CONFIG_DIR
             and XDG_DATA_HOME when this shell sets them, restarts a running
             daemon when the file changed, and prints the linger step when
             linger is off.
  uninstall  Stop and disable the unit and remove its file. The data dir, its
             secrets.json, the drop-ins and linger stay.
  status     The unit's state, start time, restarts and last exit; whether it
             runs this maxprice and serves this shell's data dir; linger;
             whether the daemon answers on its socket.
  logs       The unit's journal: journalctl --user --user-unit=maxprice.service.
             It exits with journalctl's own code.

Options for logs:
  -f, --follow     Follow the journal
  -n, --lines <N>  Show the last N lines

With no systemd user manager, every verb fails; run 'maxprice serve' under
your init instead.

Exit codes:
  1  No systemd user manager, a systemctl step failed, journalctl is not on
     PATH, or uninstall found the file gone while the manager still has the
     unit
  2  A bad verb or option, an argument after the verb, -f or -n with a verb
     other than logs, or a -n that is not a whole number
  3  status: the unit is inactive, failed or not installed;
     logs: the unit is not installed
`;

const UPDATE_HELP = `Usage: maxprice update [--check [--json]]

Install the newest maxprice from the update channel over this binary. It
installs a release only when it is signed by MaxPrice's key, under its own
version, newer than this maxprice, and its binary runs here and prints that
version; anything else leaves this binary as it is. There is no downgrade and
no rollback: the previous release stays on its release page.

It never runs sudo: this user must be able to read, write and search the
binary's directory.

After the swap, a running maxprice.service whose ExecStart is this binary is
restarted with 'systemctl --user restart maxprice.service', and update waits
up to 30 s for it to report the new version; one that runs another binary is
left running, and update says so. A 'maxprice serve' run outside the unit is
left running, and update says to restart it. Run as root, as for a shared
/usr/local/bin, it restarts nothing: each user restarts their own unit.

The daemon checks the channel at boot and every 6 hours, and never installs
anything; 'maxprice status' shows what it found on its Update line.

Options:
  --check     Only say whether a newer maxprice is available
  --json      With --check: print {"current":…,"latest":…,"available":…}
  -h, --help  Show this help

Exit codes:
  1  The check or the update failed, and this binary is unchanged; or, with
     this binary already replaced, the restart failed or the restarted
     daemon did not report the new version within 30 s
  2  Usage error
  100  --check found a newer maxprice
`;

const STATUS_HELP = `Usage: maxprice status [--json]

Show the daemon's state as a checklist: Daemon (its version and socket),
Engine (the scan, a saturated event loop, a stalled watcher, an archive it
cannot write), Limits, Hub (with, while settings.json names a Hub, its URL,
whether a Hub password is set, and auto-heal) and Pricing, then each Tracked
organization's limits once the scan is done, or while two or more Accounts
are tracked each tracked Membership's (or one warning when they cannot be
read), a line per Gateway, Update (the daemon's last check of the update
channel), a Settings line for each value in settings.json the setting does
not take (or one when the file cannot be read), a Secrets line when
secrets.json is open to group or others (the next serve tightens it) or
cannot be used (the next serve starts without it), and the double-join
warning when the Desktop client on this machine is joined to a Hub. Each line
is marked ✓ ok, ! warn, ✗ bad or – off, and one with a fix names the command
for it. The checklist shows no part of a session key, a Gateway's management
key or the Hub password. Hub URLs hide userinfo. The systemd unit's state is
'maxprice service status'.

With one session key stored, or none, Limits is one line: the limits'
connection, the age of the last sample, and the date the key was set and its
age, or key not set. With several, it is one line per key, the Home
membership's Account first: the Account's label, the key's connection, and
the date it was set and its age. When any Account's key has expired, a first
line counts them, as in 2 Accounts need reconnecting, and each expired key's
line names maxprice key set. A key stored before keys were kept per Account
is Unfiled key; once it has expired, its line reads Your saved key has
expired; maxprice key set replaces it.

A Membership line names the Membership by its Organization's label and,
while the lines span several Accounts, its Account's, as in Work · Blair,
the Home membership marked (Home). The lines are ranked most used first, as
live's Limits list is, and none is folded. Each says not connected or key
expired for an Account whose key is missing or has expired, else its last
limits answer, as an Organization line does.

A Gateway line gives the Gateway's host, its state (Draining, Statistics off,
Unreachable, Key refused or Error) and the age of its last record, and says
drained by the Hub while the joined Hub drains it. A Gateway that refuses its
key names maxprice gateway connect <url>; one with statistics off says what to
turn on.

--json prints the daemon's /api/status answer verbatim, and reads neither
settings.json, secrets.json nor update-check.json. Colour shows only on a
terminal, and NO_COLOR or TERM=dumb turns it off.

Exit codes:
  1  A daemon error, a timeout or a bad response
  2  An option other than --json, or an argument
  3  The daemon is not running
  4  The daemon runs another version than this maxprice
`;

const RESCAN_HELP = `Usage: maxprice rescan [--json]

Re-read every JSONL file under the Watched roots into the daemon: a full walk,
not the watcher's Tail-read, to catch what the watcher missed. It only adds:
an event already counted is never counted twice, and nothing is removed. It
waits for the daemon's initial scan first, saying scanning… on a terminal.

It prints how many events the walk added or updated and the total; --json
prints the daemon's answer verbatim.

Exit codes:
  1  A daemon error, a timeout or a bad response
  2  An option other than --json, or an argument
  3  The daemon is not running
  4  The daemon runs another version than this maxprice
`;

const PRICING_HELP = `Usage: maxprice pricing refresh [--json]

Fetch the LiteLLM price list once and swap it in as the active price
snapshot, through the daemon's refresher. That refresher runs one fetch at a
time, so a refresh already running, at startup or on its daily tick, is
joined, not repeated. For 10 s after a refresh ends, another one fetches
nothing and reports that refresh's outcome again, a failure included, with
no new models. A failed fetch leaves the active snapshot as it was.

It prints how many models the fetch newly priced, or the ones still
unpriced; --json prints the daemon's answer verbatim, a failed attempt's too.
A failed refresh is one line on stderr, with --json or without.

Exit codes:
  1  The refresh failed (under --json its answer still prints), a daemon
     error, a timeout or a bad response
  2  Usage error
  3  The daemon is not running
  4  The daemon runs another version than this maxprice
`;

const SETTINGS_HELP = `Usage: maxprice settings get [<setting>]
       maxprice settings set <setting> <value>...
       maxprice settings unset <setting>

Show or change this client's settings, kept in settings.json in the data dir
($XDG_DATA_HOME/maxprice, or ~/.local/share/maxprice).

Verbs:
  get    Every setting, or the one named: the value that applies, and its
         source: set in the file, the default, or rejected (the file holds a
         value the setting does not take, and the default applies). It reads
         only the file.
  set    Store a value. A value the setting does not take exits 2, with
         nothing written.
  unset  Remove the setting from the file, so it follows its default.

Settings:
  timezone       An IANA time zone, such as Europe/Berlin
  cost-mode      auto, calculate or display
  week           rolling, limit-reset or custom <day> <HH:MM>: the day sun,
                 mon, tue, wed, thu, fri or sat, the time on a 24-hour clock
  time-format    12h or 24h
  claude-paths   One or more directories to watch, replacing the list. A
                 relative path is made absolute against the current
                 directory, and ~/... is kept as typed; a path that is no
                 directory is saved with a warning. Unset, the daemon
                 watches $CLAUDE_CONFIG_DIR/projects, or with no
                 CLAUDE_CONFIG_DIR, ~/.config/claude/projects and
                 ~/.claude/projects.
  share-events   on or off: share this machine's Fleet events with the Hub
  fleet-replica  on or off: keep a Fleet replica of the Hub's events

The daemon reads claude-paths, share-events and fleet-replica from the file
and applies them live; set and unset check that it runs, and when it does
not, the change applies when it starts. The other four apply from the next
command on.

Each write takes a lock on settings.lock in the data dir and changes only its
own setting, leaving every other key in the file as it was. A setting never
set follows its default: an unset timezone is this shell's TZ, and an unset
time-format the host's.

Exit codes:
  1  settings.json cannot be read or is not a JSON object (it is left as it
     is), another maxprice held the lock for 5 s, the write failed, or the
     daemon failed to answer the check (the change is still written)
  2  A bad command, option, setting or value
  4  The daemon runs another version than this maxprice; the change is
     still written
`;

const ORG_HELP = `Usage: maxprice org list [--json]
       maxprice org track <org>
       maxprice org exclude <org> [--confirm <label>]
       maxprice org label <org> <label>
       maxprice org label <org> --unset

List this machine's Organizations, change which of them it counts, kept in
settings.json in the data dir, or label one. Every verb needs the daemon,
which assembles the Organizations, and first waits for its initial scan,
saying scanning… on a terminal. The Home membership is maxprice home's.

Verbs:
  list     Each Organization, Home first. Columns: Organization, Id,
           Tracking (Home, Tracked or Excluded), Current login (a login on
           this machine names it), Seen on, Re-walking. On a terminal too
           narrow for them all, Seen on drops, then Current login. --json
           prints the daemon's answer verbatim.
  track    Count an Excluded organization again: its usage is re-walked
           from the session files into every report. It asks nothing.
  exclude  Stop counting a Tracked organization: its usage leaves every
           report on this machine, and while a Hub is joined, this
           machine's sessions for it leave the Hub. It asks first (below).
  label    Set the Organization's label, or with --unset remove it, back to
           its default. The label rides the Hub's Label directory to every
           machine, as the Desktop's Rename does. It is trimmed, 1 to 40
           characters, and no other Organization's.

<org> is an Organization's uuid, an 8-character uuid prefix (the Id that
org list prints), or its label, exact and case-sensitive.

The Home membership's Organization is always tracked, so excluding it means
making a Membership in another Organization Home first, with maxprice home
set. Tracking a Tracked organization, or excluding an Excluded one, says so
in one line and exits 0.

exclude prints what it removes on stderr, then, on a terminal, asks you to
type the Organization's label, trimmed and case-sensitive. Off a terminal,
--confirm <label> gives the label instead; it works on a terminal too. A
label that does not match exits 1 with nothing written. There is no --yes.

A change takes a lock on settings.lock in the data dir and writes the
tracked list alone. Then it waits until the daemon shows the change and no
Organization is being re-walked, saying re-walking… on a terminal. There
is no time limit: Ctrl-C stops the wait, and the daemon finishes on its
own. If a later change replaced this one, it says so and stops waiting. It
does not wait for the Hub to forget an Excluded organization's sessions.
What changed is one line on stdout.

Exit codes:
  1  No Home membership yet; exclude of the Home membership's
     Organization; a label that does not match; a label another
     Organization already shows, or a full Label directory; settings.json
     cannot be read, or its Home or a tracked list is rejected (it is left
     as it is); another maxprice held the lock for 5 s; or a daemon error
  2  A bad command or option, a name that matches no or several
     Organizations, an empty or overlong label, or exclude off a terminal
     with no --confirm
  3  The daemon is not running
  4  The daemon runs another version than this maxprice; nothing is
     written
  130  exclude: Ctrl-C at the label prompt; nothing is written
`;

const ACCOUNT_HELP = `Usage: maxprice account list [--json]
       maxprice account track <account>
       maxprice account exclude <account> [--confirm <label>]
       maxprice account label <account> <label>
       maxprice account label <account> --unset

List the Accounts this machine knows, change which of them it counts, kept
in settings.json in the data dir, or label one. Tracking is two levels: a
session counts only when both its Account and its Organization are
tracked, so an Account's Organizations are maxprice org's. Every verb needs
the daemon and first waits for its initial scan, saying scanning… on a
terminal.

Verbs:
  list     Each Account, the Home membership's first. Columns: Account, Id
           (its uuid's first 8, or pending), Email (as read here, from a
           login on this machine), Tracking (Home, Tracked or Excluded),
           Connection (its session key's), Current login (a login on this
           machine names it), Organizations (how many it is known in, and
           how many of those are tracked: 3, 2 tracked). On a terminal too
           narrow for them all, Email drops, then Current login, then
           Organizations. --json prints the daemon's answer verbatim.
  track    Count an Excluded account again: its usage is re-walked from the
           session files into every report. It asks nothing.
  exclude  Stop counting a Tracked account: its usage leaves every report on
           this machine, and while a Hub is joined, this machine's sessions
           for it leave the Hub. It asks first, as org exclude does.
  label    Set the Account's label, or with --unset remove it, back to the
           email as read here, else Account <first 8>. The label rides the
           Hub's Label directory to every machine. It is trimmed, 1 to 40
           characters, and no other Account's. A Pending account takes none.

<account> is an Account's label, exact and case-sensitive, its uuid, an
8-character uuid prefix, or its email as read here. A Pending account, one
known only by an email no login or key has paired with its Account, is
named by that email alone.

The Home membership's Account is always tracked, so excluding it means
making a Membership of another Account Home first, with maxprice home set.
Tracking a Tracked account, or excluding an Excluded one, says so in one
line and exits 0. Until the daemon has saved this machine's tracked
Accounts after its first scan, every Account is counted and no edit is
made.

exclude prints what it removes on stderr, then, on a terminal, asks you to
type the Account's label, trimmed and case-sensitive. Off a terminal,
--confirm <label> gives the label instead; it works on a terminal too. A
label that does not match exits 1 with nothing written. There is no --yes.

A change takes a lock on settings.lock in the data dir and writes the
tracked Account list alone, then waits as org does, saying re-walking… on a
terminal. What changed is one line on stdout.

Exit codes:
  1  No Home membership yet, or no tracked Account list yet; exclude of
     the Home membership's Account; a label that does not match; label of
     a Pending account; a label another Account already shows, or a full
     Label directory; settings.json cannot be read, or its Home or a
     tracked list is rejected (it is left as it is); another maxprice held
     the lock for 5 s; or a daemon error
  2  A bad command or option, a name that matches no or several Accounts,
     an empty or overlong label, or exclude off a terminal with no
     --confirm
  3  The daemon is not running
  4  The daemon runs another version than this maxprice; nothing is
     written
  130  exclude: Ctrl-C at the label prompt; nothing is written
`;

const HOME_HELP = `Usage: maxprice home [--json]
       maxprice home set [--account <account>] [--org <org>]

Show or choose the Home membership: the Account and Organization a report
describes with no --account or --org, and the one this machine's usage with
no Account or Organization evidence counts under. Every verb needs the
daemon and first waits for its initial scan, saying scanning… on a terminal.

  home  One line per Provider: the Home membership's Organization and
        Account, by their labels, as in
          Claude  Example Research · Alex
        or Account not known while no evidence names its Account. --json
        prints {"organizations":…,"accounts":…}: the daemon's
        /api/organizations and /api/accounts answers verbatim, since no one
        route holds the Home membership.
  set   Make a Membership Home. --account and --org name it as a report's
        do, one of each: a name, home (that side of the Home membership)
        or all (any). Either may be left out while the other names exactly
        one tracked Membership. With both, the Account must hold a
        Membership in that Organization; an Excluded organization is
        tracked in the same write, and set waits through its re-walk. The
        Account must be tracked and not Pending. The old Home's Account and
        Organization stay tracked, so moving Home excludes nothing.

A change takes a lock on settings.lock in the data dir and writes the Home
membership and the tracked lists alone, then waits as org track does,
saying re-walking… on a terminal. What changed is on stdout: a Tracked line
for an Organization it tracked, then the new Home and the one that stays
tracked. Choosing the Home membership says so in one line and exits 0.

Exit codes:
  1  No Home membership yet; an Account that is excluded or Pending;
     settings.json cannot be read, or its Home or a tracked list is
     rejected (it is left as it is); another maxprice held the lock for
     5 s; or a daemon error
  2  A bad command or option, a name that matches no or several Accounts
     or Organizations, an Account with no Membership in the Organization,
     or flags that leave no or several tracked Memberships
  3  The daemon is not running
  4  The daemon runs another version than this maxprice; nothing is
     written
`;

const KEY_HELP = `Usage: maxprice key set
       maxprice key list [--json]
       maxprice key remove <account>
       maxprice key remove --unfiled

Connect, list or remove the claude.ai session keys the daemon reads the Usage
limits with, one for each Account. They are kept in secrets.json in the data
dir ($XDG_DATA_HOME/maxprice, or ~/.local/share/maxprice), readable by this
user alone (0600), and never in settings.json. No command prints any part of
a key.

Verbs:
  set     Connect an Account: read a key, check it with claude.ai through the
          daemon, store it as the key of the Account it signs in to,
          replacing that Account's earlier key, then hand the daemon every
          stored key and track that Account. A key for another Account is
          stored beside the first. On a terminal it asks for the key and
          shows nothing as it is typed or pasted; otherwise it reads all of
          stdin, as in 'maxprice key set < key.txt'.
          The key is never an argument: argv lands in shell history and ps.
          It needs the daemon running, waits for its initial scan (scanning…
          on a terminal), and stores nothing until claude.ai lists the key's
          Organizations and names its Account. It then prints
            Connected Blair (22222222), now tracked
          and each of the key's Memberships with its Organization's
          tracking: Home, Tracked or Excluded, marked (new) when this
          machine did not know the Organization before the key. A new one
          starts Excluded: on a terminal set asks Track <org>? [y/N] for
          each, and tracks the ones answered y as org track does, waiting
          through the re-walk; off a terminal it asks nothing and prints the
          maxprice org track line for each.
  list    Each stored key, one row each. Columns: Account (its label), Id
          (its uuid's first 8), Connection (the key's, as the daemon holds
          it), Set at (the date and its age). While a Hub is joined, At Hub
          says what the Hub holds for the Account, as its last status said:
          connected, expired, error, not read yet (a key it has not read),
          no key, or unknown before the daemon has reached the Hub. A key
          stored before keys were kept per Account, whose Account is not
          read yet, is one row, Unfiled key, with Id —. On a terminal too
          narrow for them all, Set at drops. It needs the daemon running.
          --json prints {"hubJoined":…,"keys":[…]}: each row's account (its
          uuid, null for the unfiled key), label, connection
          (connected, expired, error, disconnected, or null when the daemon
          holds no such key), setAt, and atHub (connected, expired, error,
          pending, none, unknown, or null with no Hub joined and for the
          unfiled key).
  remove  Remove one Account's key, and the daemon's copy when it runs.
          --unfiled removes the unfiled key, the only way to name it. It
          needs no daemon: one that is down starts without the key. The
          Hub's key is the Hub's: when the joined Hub holds one for the
          Account, a line says to remove it there with maxprice-hub key
          remove; when that is not known (no daemon, or no answer from it)
          and settings.json names a Hub, the line says to if it holds one.

<account> is an Account's label, exact and case-sensitive, its uuid, an
8-character uuid prefix, or its email as read here, as for maxprice account.
With the daemon not running, or not listing its Accounts, only a stored
key's uuid or its prefix names one. The name is never printed back, since
it may be a key pasted in its place.

The key is the sessionKey cookie of a browser signed in to claude.ai, a value
starting sk-ant-sid01-. To copy it from a browser on another machine: sign in
at claude.ai, open the developer tools, then Application (Chrome, Edge) or
Storage (Firefox), Cookies, https://claude.ai, and copy the value of
sessionKey. It is not Claude Code's OAuth token (sk-ant-oat…), which set
refuses; maxprice never reads ~/.claude/.credentials.json.

Joined to a Hub, the keys are the fallback poller's, and auto-heal pushes
each one the Hub holds no working key for its Account, unless that Account's
key was removed at the Hub after this key was set. A key stored before keys
were kept per Account goes only to a Hub none of whose keys works.

Ctrl-C at the key prompt stops with exit 130, having stored nothing. Ctrl-C
at a Track prompt stops with exit 130 too: the key and its Account's
tracking stay, and no Organization is tracked.

Exit codes:
  1  The key is a Claude Code OAuth token, claude.ai refused it or could not
     be reached, secrets.json cannot be used or written, the daemon did not
     take the key (it is still stored, for the daemon's next start), its
     Account could not be tracked in settings.json (the key is stored and in
     use), or another daemon error
  2  A bad command or option, an argument after set or list, no key given,
     a name that matches no or several Accounts, or one whose Account holds
     no key to remove, or no unfiled key to remove
  3  set, list: the daemon is not running
  4  The daemon runs another version than this maxprice; for remove, the
     change is still written
  130  set: Ctrl-C at the key prompt (nothing is stored) or at a Track prompt
       (the key stays)
`;

const GATEWAY_HELP = `Usage: maxprice gateway connect <url>
       maxprice gateway list [--json]
       maxprice gateway remove <url>

Connect, list or remove the Gateways this client drains: CLIProxyAPI
services that serve Claude Code's requests on credentials of their own, and
keep a Gateway record of each. Each Gateway's URL and management key are
kept in secrets.json in the data dir ($XDG_DATA_HOME/maxprice, or
~/.local/share/maxprice), readable by this user alone (0600), under its
Gateway id, the first 16 hex digits of a hash of its URL. No command prints
any part of a management key.

Verbs:
  connect  Read the Gateway's management key, check through the daemon that
           the Gateway at <url> answers and takes the key, store the URL and
           key, replacing the key of a Gateway already connected at that URL,
           then hand the daemon every stored Gateway. On a terminal it asks
           for the key and shows nothing as it is typed or pasted;
           otherwise it reads all of stdin, as in
           'maxprice gateway connect http://gw.example:8317 < key.txt'.
           The key is never an argument: argv lands in shell history and ps.
           It needs the daemon running, and stores nothing when the check
           fails. It then prints
             Connected Gateway gw.example:8317 (0123456789abcdef)
           and two warnings, since MaxPrice can read neither: set the
           Gateway's usage queue retention to 3600 seconds or more, and let
           nothing else drain its usage queue. Connecting tracks nothing: an
           Account first seen through the Gateway starts Excluded, which
           maxprice account list shows and maxprice account track changes.
  list     Each stored Gateway, one row each. Columns: Gateway (its URL), Id
           (its Gateway id), State (Draining, Statistics off, Unreachable,
           Key refused, Error, or not in use when the daemon does not hold
           it), Last record (the age of the last record drained this
           run, or none yet), Drained by (this machine, or the Hub while the
           joined Hub drains it) and Set at (the date and its age). On a
           terminal too narrow for them all, Set at, Last record and Drained
           by drop in that order. It needs the daemon running. --json prints
           {"gateways":[…]}: each row's id, url, state (draining,
           unreachable, unauthorized, statistics-off, error, or null),
           lastRecordAt, drainedBy (this-machine, hub, or null) and setAt.
  remove   Remove one Gateway, and the daemon's copy when it runs. <url> is
           its URL or its Gateway id. It needs no daemon: one that is down
           starts without the Gateway. A Gateway this client sent to its
           Hub stays on the Hub, where a Gateway is removed only at the Hub;
           while settings.json names a Hub, a line says so.

A URL is http or https, with no username, password, query or fragment.
Its scheme and host are read in any case, and a trailing slash is dropped,
so http://GW.example:8317/ is http://gw.example:8317. A URL that is not one
is never printed back, since it may be a key pasted in its place.

Joined to a Hub, the daemon sends each Gateway up to the Hub once, and the
Hub drains it while it holds a working connection to it; this client
drains it only while the Hub cannot.

Ctrl-C at the key prompt stops with exit 130, having stored nothing.

Exit codes:
  1  The Gateway did not answer, refused the management key or answered
     something unreadable (nothing is stored), secrets.json cannot be used
     or written, the daemon did not take the Gateways (the Gateway is still
     stored, for the daemon's next start), or another daemon error
  2  A bad command or option, no URL or more than one argument, a URL that
     is not a Gateway URL, no Gateway with that URL or id connected to
     remove, no management key given, or one that is not printable ASCII
     with no spaces
  3  connect, list: the daemon is not running
  4  The daemon runs another version than this maxprice; for remove, the
     change is still written
  130  connect: Ctrl-C at the key prompt; nothing is stored
`;

const HUB_HELP = `Usage: maxprice hub join <url> [--password] [--no-auto-heal]
       maxprice hub leave

Join this client to a MaxPrice Hub, or leave it. The Hub's URL and auto-heal
are kept in settings.json in the data dir ($XDG_DATA_HOME/maxprice, or
~/.local/share/maxprice), and its password in secrets.json there, readable by
this user alone (0600).

Verbs:
  join   Join the Hub at <url>: a host, host:port or a full URL, with http://
         and port 47100 when it names none. The URL cannot carry a username
         or password; use --password for the Hub password.
         It needs the daemon running.
         Each join writes the URL, the password and auto-heal together, so
         re-run it to change any one of them, a password changed at the Hub
         included.
  leave  Remove the Hub's URL and password, and tell the daemon when it
         runs. It needs no daemon, and keeps the auto-heal setting.

Options for join:
  --password      The Hub has a password: ask for it, showing nothing as it
                  is typed, or with no terminal read all of stdin. It is
                  never an argument. Without it the join is passwordless,
                  and a stored password is removed.
  --no-auto-heal  Never push this client's session keys to the Hub when it
                  holds no working key for their Account. Auto-heal is on
                  without it.

join first waits for the daemon to load its usage history, saying loading
usage history… on a terminal. It then saves the config, hands it to the
daemon and waits up to 10 s for the daemon to reach the Hub. Connected exits
0, and so does a Hub with no working Claude key, with a line saying what
heals it. A rejected password, a Hub version mismatch or no answer in 10 s
exits 1 with the reason; the config stays saved, and the daemon keeps
retrying a Hub that did not answer. Another command leaving the Hub
meanwhile exits 1 too, and its change stands.

While the Desktop client on this machine is joined to a Hub too, join warns:
if that is the same Hub, this machine's usage splits across two machine
entries.

Ctrl-C at the prompt stops with exit 130, having saved nothing.

Exit codes:
  1  The Hub rejected the password, is another version or did not answer in
     10 s (the config is saved); another command left the Hub meanwhile; a
     file cannot be used or written; the daemon did not take the config (it
     is saved, for the next start); or another daemon error
  2  A bad command or option, a missing or invalid URL, or no password given
  3  join: the daemon is not running
  4  The daemon runs another version than this maxprice; for leave, the
     change is still written
  130  join --password: Ctrl-C at the prompt; nothing is saved
`;

export const COMMANDS: Record<string, Command> = {
  daily: {
    summary: "Usage and cost per day",
    help: DAILY_HELP,
    options: REPORT_OPTIONS,
    positionals: false,
    run: async (parsed, io) => (await import("./commands/daily")).daily(parsed, io),
  },
  sessions: {
    summary: "Usage and cost per session",
    help: SESSIONS_HELP,
    options: REPORT_OPTIONS,
    positionals: false,
    run: async (parsed, io) => (await import("./commands/sessions")).sessions(parsed, io),
  },
  projects: {
    summary: "Usage and cost per project",
    help: PROJECTS_HELP,
    options: REPORT_OPTIONS,
    positionals: false,
    run: async (parsed, io) => (await import("./commands/projects")).projects(parsed, io),
  },
  blocks: {
    summary: "The 5-hour blocks, newest first",
    help: BLOCKS_HELP,
    options: BLOCKS_OPTIONS,
    positionals: false,
    run: async (parsed, io) => (await import("./commands/blocks")).blocks(parsed, io),
  },
  live: {
    summary: "The Active block, the limits and today, once",
    help: LIVE_HELP,
    options: LIVE_OPTIONS,
    positionals: false,
    run: async (parsed, io) => (await import("./commands/live")).live(parsed, io),
  },
  serve: {
    summary: "Run the daemon in the foreground",
    help: SERVE_HELP,
    options: {},
    positionals: false,
    run: async () => (await import("./commands/serve")).serve(),
  },
  service: {
    summary: "Install, remove or inspect the daemon's systemd user unit",
    help: SERVICE_HELP,
    options: {
      follow: { type: "boolean", short: "f" },
      lines: { type: "string", short: "n" },
    },
    positionals: true,
    run: async (parsed, io) => (await import("./commands/service")).service(parsed, io),
  },
  update: {
    summary: "Install the newest maxprice, or check for one",
    help: UPDATE_HELP,
    options: { check: { type: "boolean" }, json: { type: "boolean" } },
    positionals: false,
    run: async (parsed, io) => (await import("./commands/update")).update(parsed, io),
  },
  status: {
    summary: "Show the daemon's state, one line per part",
    help: STATUS_HELP,
    options: { json: { type: "boolean" } },
    positionals: false,
    run: async (parsed, io) => (await import("./commands/status")).status(parsed, io),
  },
  rescan: {
    summary: "Re-read every Claude Code log under the Watched roots",
    help: RESCAN_HELP,
    options: { json: { type: "boolean" } },
    positionals: false,
    run: async (parsed, io) => (await import("./commands/rescan")).rescan(parsed, io),
  },
  pricing: {
    summary: "Refresh the model prices: maxprice pricing refresh",
    help: PRICING_HELP,
    options: { json: { type: "boolean" } },
    positionals: true,
    run: async (parsed, io) => (await import("./commands/pricing")).pricing(parsed, io),
  },
  settings: {
    summary: "Show or change the settings: maxprice settings get|set|unset",
    help: SETTINGS_HELP,
    options: {},
    positionals: true,
    run: async (parsed, io) => (await import("./commands/settings")).settings(parsed, io),
  },
  account: {
    summary: "Manage Accounts: maxprice account list|track|exclude|label",
    help: ACCOUNT_HELP,
    options: { confirm: { type: "string" }, json: { type: "boolean" }, unset: { type: "boolean" } },
    positionals: true,
    run: async (parsed, io) => (await import("./commands/account")).account(parsed, io),
  },
  org: {
    summary: "Manage Organizations: maxprice org list|track|exclude|label",
    help: ORG_HELP,
    options: { confirm: { type: "string" }, json: { type: "boolean" }, unset: { type: "boolean" } },
    positionals: true,
    run: async (parsed, io) => (await import("./commands/org")).org(parsed, io),
  },
  home: {
    summary: "Show or choose the Home membership: maxprice home [set]",
    help: HOME_HELP,
    options: {
      json: { type: "boolean" },
      account: { type: "string", multiple: true },
      org: { type: "string", multiple: true },
    },
    positionals: true,
    run: async (parsed, io) => (await import("./commands/home")).home(parsed, io),
  },
  key: {
    summary: "Connect, list or remove session keys: maxprice key set|list|remove",
    help: KEY_HELP,
    options: { json: { type: "boolean" }, unfiled: { type: "boolean" } },
    positionals: true,
    secretSafeParseErrors: true,
    run: async (parsed, io) => (await import("./commands/key")).key(parsed, io),
  },
  gateway: {
    summary: "Manage Gateways: maxprice gateway connect|list|remove",
    help: GATEWAY_HELP,
    options: { json: { type: "boolean" } },
    positionals: true,
    secretSafeParseErrors: true,
    run: async (parsed, io) => (await import("./commands/gateway")).gateway(parsed, io),
  },
  hub: {
    summary: "Join or leave a MaxPrice Hub: maxprice hub join|leave",
    help: HUB_HELP,
    options: { password: { type: "boolean" }, "no-auto-heal": { type: "boolean" } },
    positionals: true,
    secretSafeParseErrors: true,
    run: async (parsed, io) => (await import("./commands/hub")).hub(parsed, io),
  },
};

function topHelp(commands: Record<string, Command>): string {
  const names = [...Object.keys(commands), "help"];
  const width = Math.max(...names.map((name) => name.length));
  const rows = [
    ...Object.entries(commands).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`),
    `  ${"help".padEnd(width)}  Show a command's help: maxprice help <command>`,
  ];
  return `maxprice ${VERSION}, the MaxPrice Headless client

Usage: maxprice <command> [options]

Commands:
${rows.join("\n")}

Options:
  -h, --help  Show this help
  --version   Print the version

Exit codes:
  0  Success
  1  Failure: a daemon error, a timeout, a bad response or a crash
  2  Usage error
  3  The daemon is not running
  4  The daemon runs another version than this maxprice
  5  Another 'maxprice serve' holds this data dir
  6  'maxprice serve' refused its settings.json
  100  'maxprice update --check' found an update
  130  Ctrl-C at a prompt: key set (the key or a Track prompt), gateway
       connect, hub join --password, org exclude or account exclude

User guide: ${USER_GUIDE_URL}${USER_GUIDE_PAGES.headlessClient}
`;
}

const TOP_HELP = "maxprice --help";

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
      // Bun 1.3.14's boolean-value refusal names only the known option. Match
      // the entire diagnostic too: the error code alone can cover messages
      // that quote values for string options. Everything else is fixed text.
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

function findCommand(commands: Record<string, Command>, name: string): Command | undefined {
  return Object.hasOwn(commands, name) ? commands[name] : undefined;
}

function lookup(commands: Record<string, Command>, name: string): Command {
  const command = findCommand(commands, name);
  if (command === undefined) throw usageError(`unknown command '${name}'`, TOP_HELP);
  return command;
}

const HELP_OPTION: Options = { help: { type: "boolean", short: "h" } };

async function dispatch(
  argv: string[],
  io: Io,
  commands: Record<string, Command>,
): Promise<number> {
  // Options before the command are the global ones; the rest are its own.
  // Global errors precede command lookup, but take the parse policy of the
  // command they precede, so an option pasted before key or hub is hidden as
  // one after it is (ADR-0121 §6).
  const at = argv.findIndex((arg) => !arg.startsWith("-"));
  const name = at === -1 ? undefined : argv[at]!;
  const rest = at === -1 ? [] : argv.slice(at + 1);
  const global = parse(
    at === -1 ? argv : argv.slice(0, at),
    { ...HELP_OPTION, version: { type: "boolean" } },
    false,
    TOP_HELP,
    name !== undefined && findCommand(commands, name)?.secretSafeParseErrors === true,
  );

  if (global.values.version === true) {
    if (argv.length !== 1) throw usageError("--version takes no other arguments", TOP_HELP);
    io.stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (name === undefined) {
    io.stdout.write(topHelp(commands));
    return EXIT.OK;
  }
  if (name === "help") {
    if (rest.length > 1) throw usageError("help takes at most one command", TOP_HELP);
    io.stdout.write(rest.length === 0 ? topHelp(commands) : lookup(commands, rest[0]!).help);
    return EXIT.OK;
  }

  const command = lookup(commands, name);
  const parsed = parse(
    rest,
    { ...command.options, ...HELP_OPTION },
    command.positionals,
    `maxprice ${name} --help`,
    command.secretSafeParseErrors,
  );
  if (global.values.help === true || parsed.values.help === true) {
    io.stdout.write(command.help);
    return EXIT.OK;
  }
  return await command.run(parsed, io);
}

// Runs one invocation and returns its exit code. stdout carries only a
// successful answer; an error is rendered to stderr (ADR-0119 §7): a CliError
// exits with its own code, anything else with 1.
export async function run(
  argv: string[],
  io: Io = { stdout: process.stdout, stderr: process.stderr },
  commands: Record<string, Command> = COMMANDS,
): Promise<number> {
  try {
    return await dispatch(argv, io, commands);
  } catch (error) {
    io.stderr.write(renderError(error));
    return error instanceof CliError ? error.code : EXIT.FAILURE;
  }
}

// `process.exitCode`, never `process.exit()`: `serve` returns 0 once its
// daemon is up, and the server it started keeps the process running.
if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2));
}
