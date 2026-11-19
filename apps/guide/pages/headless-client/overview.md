# Overview

The Headless client is MaxPrice with no window, for a Linux server you reach over SSH. It is one terminal command, `maxprice`. Its daemon reads the session logs Claude Code writes on that machine and keeps their usage in the [Local archive](../concepts/archive.md#the-local-archive). Its commands print the Desktop client's reports as tables in your terminal, and it can join a [Hub](../concepts/hubs.md) as one of the fleet's machines.

Use it where Claude Code runs on a machine with no desktop. On a Mac, a Windows PC or a Linux desktop, the [Desktop client](../desktop-client/overview.md) does the same job in a window.

## What it is

- **One binary for Linux x64**, with glibc 2.28 or later. There is no musl build, so it does not run on Alpine, and no arm64 build. The [Platform floor](../../../cli/README.md#platform-floor) lists the systems it was tried on.
- **A daemon and its commands.** The daemon, `maxprice serve`, does the work and runs all the time, as a systemd user unit or under another init. The reports, and most other commands, ask it and print its answer. The daemon listens on a socket in its data dir, never on a network port, so only your own user can reach it.
- **The same reports as the Desktop client:** per day, per session, per project, the 5-hour [blocks](../concepts/blocks.md), and a snapshot of the Active block, the [usage limits](../concepts/blocks.md#usage-limits) and today. They take the Desktop client's filters as options, and `--json` gives the daemon's answer for a script.
- **No root.** It installs into your home directory and runs as you.
- **It updates only when you ask it to**, from its own signed channel.

## Get started

Each step links the Reference section that holds its commands.

1. **Install it.** Download the tarball from the releases page and unpack it into `~/.local/bin` ([Install](../../../cli/README.md#install)).
2. **Start the daemon and read a report.** Run it in a terminal first, then check it with `maxprice status` and try `maxprice daily` ([First run](../../../cli/README.md#first-run)).
3. **Run it as a service**, so it keeps running after you log out ([Run it as a service](../../../cli/README.md#run-it-as-a-service)). With no systemd user manager, as in a container, run it under another init ([Other inits](../../../cli/README.md#other-inits)).
4. **Set the timezone.** Servers often run in UTC, and the reports count days in the `timezone` setting, which follows the shell's `TZ` until you set it. Set yours so that today and this week fall where you expect, and choose how a week is counted ([`maxprice settings`](../../../cli/README.md#maxprice-settings-getsetunset)).
5. **Give it your claude.ai session key**, to see your real usage limits ([`maxprice key`](../../../cli/README.md#maxprice-key-setlistremove)). [Blocks and usage limits](../concepts/blocks.md#the-claudeai-session-key) explains what the key reads. A key for another Account is kept beside the first, and storing one tracks its Account. Joined to a Hub, the Hub reads the limits for you, and these keys are only the fallback. If Claude Code reaches claude.ai through a Gateway, such as CLIProxyAPI, connect it too ([`maxprice gateway`](../../../cli/README.md#maxprice-gateway-connectlistremove)), so the usage it routes is counted under its Account.
6. **Read your usage.** The [Report options](../../../cli/README.md#report-options) choose the range, the models, the projects, the machines and the [Scope](../concepts/organizations.md#the-scope), and each report's section lists its columns: [`daily`](../../../cli/README.md#maxprice-daily), [`sessions`](../../../cli/README.md#maxprice-sessions), [`projects`](../../../cli/README.md#maxprice-projects), [`blocks`](../../../cli/README.md#maxprice-blocks) and [`live`](../../../cli/README.md#maxprice-live).
7. **Join a Hub**, if you run one, so this machine's usage joins the fleet's ([`maxprice hub join`](../../../cli/README.md#maxprice-hub-joinleave)). [Hubs and the fleet](../concepts/hubs.md) says what joining shares. To run the Hub itself on a Linux server, see the [Headless Hub](../headless-hub/overview.md).
8. **Keep it current.** `maxprice status` says when a newer release is out, and `maxprice update` installs it ([Updating](../../../cli/README.md#updating)).

## Accounts and Organizations

If you use one claude.ai login in one [Organization](../concepts/organizations.md), there is nothing to set up: every report counts it. The rest of this section matters once you use more than one of either.

**Choose what this machine counts.** These commands do what the Account cards and the Home membership menu in the Desktop client's [Settings](../desktop-client/settings.md#accounts) do ([Accounts and Organizations](../concepts/organizations.md) explains Tracked and Excluded):

- `maxprice account list` shows each [Account](../concepts/organizations.md#accounts) this machine knows, whether it is tracked, whether its key works and how many of its Organizations are tracked; `track`, `exclude` and `label` change one ([`maxprice account`](../../../cli/README.md#maxprice-account-listtrackexcludelabel)).
- `maxprice org list` does the same for Organizations ([`maxprice org`](../../../cli/README.md#maxprice-org-listtrackexcludelabel)).
- `maxprice home` shows the [Home membership](../concepts/organizations.md#home-membership), and `maxprice home set` chooses another, as the Desktop client's Settings › Home membership does ([`maxprice home`](../../../cli/README.md#maxprice-home-set)). Home's Account and Organization are always tracked, so to exclude one, make another Membership Home first.
- `maxprice key set` connects an Account: it stores the key, tracks the Account, lists the key's Memberships, and on a terminal asks whether to track each Organization the key brought that this machine didn't know. `maxprice key list` shows each stored key and, joined to a Hub, what the Hub holds for that Account; `maxprice key remove` removes one key, never the Hub's ([`maxprice key`](../../../cli/README.md#maxprice-key-setlistremove)).
- `maxprice gateway connect` connects a Gateway, such as CLIProxyAPI, which serves Claude Code on logins it holds itself: one way to use an Account, as logging in directly is another. Its records tell MaxPrice which Account and Organization served each request the session logs leave unnamed ([how](../concepts/organizations.md#how-maxprice-knows-the-organization)). Connecting tracks nothing: an Account first seen through it starts excluded, so count it with `maxprice account track`; `maxprice gateway list` and `remove` show and remove them ([`maxprice gateway`](../../../cli/README.md#maxprice-gateway-connectlistremove)).

**Choose what a report describes.** With no option, a report describes your Home membership, so a machine with one login reads as it always did. `--account` and `--org` name the [Scope](../concepts/organizations.md#the-scope) instead: each repeats, the two narrow each other, and `all` on either means every tracked one, so `--account all` is the Desktop client's **All accounts**. Naming an Account or Organization this machine excludes, or a Scope that holds no tracked Membership, is an error rather than an empty report ([Report options](../../../cli/README.md#report-options)).

**With two or more Accounts tracked**, a Scope of several [Memberships](../concepts/organizations.md#memberships) reads as the Desktop client's does, since usage limits never add up across Memberships:

- [`blocks`](../../../cli/README.md#maxprice-blocks) prints a table per Membership, most used first, as Blocks shows a tab per Membership, and names the ones with no Blocks on one last line.
- [`live`](../../../cli/README.md#maxprice-live) prints the most used Membership's Active block, then one Limits line per Membership, as the Popout lists them.
- [`projects`](../../../cli/README.md#maxprice-projects) and [`sessions`](../../../cli/README.md#maxprice-sessions) add a column naming each row's Accounts while the Scope spans several Accounts, beside the one naming its Organizations while it spans several Organizations.

On any machine, `sessions`' Total row is the Desktop client's [Projects](../desktop-client/projects.md#the-totals) total for the same range and Scope, so it can differ from the sum of the rows above it.

[`maxprice status`](../../../cli/README.md#maxprice-status) describes the whole machine, whatever the Scope. With two or more session keys stored it prints a line per key, under a count of the Accounts that need reconnecting while any key has expired; with two or more Accounts tracked, a line per tracked Membership in place of the line per Organization; and a line per connected Gateway.

On its first start the daemon counts only one Account, its Home membership's, as the Desktop client does ([Accounts](../concepts/organizations.md#accounts)); `maxprice account track` counts another.

> [!WARNING]
> On a machine that also runs the Desktop client, join only one of the two to a Hub ([why](../../../cli/README.md#a-desktop-client-on-the-same-machine)).

## When something is wrong

Start with [`maxprice status`](../../../cli/README.md#maxprice-status): it prints one line per part of the daemon, and each line with a problem names the command that fixes it. The Reference page's [Troubleshooting](../../../cli/README.md#troubleshooting) table lists the messages you may see and what to do, and [Exit codes](../../../cli/README.md#exit-codes) what each exit code means for a script.

## Files and uninstalling

The Headless client keeps everything in one data dir in your home directory: its settings, its secrets, its archive and its caches. [The data dir](../../../cli/README.md#the-data-dir) lists every file, and [Uninstalling](../../../cli/README.md#uninstalling) says what to remove.
