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
5. **Give it your claude.ai session key**, to see your real usage limits ([`maxprice key`](../../../cli/README.md#maxprice-key-setclear)). [Blocks and usage limits](../concepts/blocks.md#the-claudeai-session-key) explains what the key reads. Joined to a Hub, the Hub reads the limits for you, and this key is only the fallback.
6. **Read your usage.** The [Report options](../../../cli/README.md#report-options) choose the range, the models, the projects, the machines and the [Organization](../concepts/organizations.md), and each report's section lists its columns: [`daily`](../../../cli/README.md#maxprice-daily), [`sessions`](../../../cli/README.md#maxprice-sessions), [`projects`](../../../cli/README.md#maxprice-projects), [`blocks`](../../../cli/README.md#maxprice-blocks) and [`live`](../../../cli/README.md#maxprice-live).
7. **Join a Hub**, if you run one, so this machine's usage joins the fleet's ([`maxprice hub join`](../../../cli/README.md#maxprice-hub-joinleave)). [Hubs and the fleet](../concepts/hubs.md) says what joining shares. To run the Hub itself on a Linux server, see the [Headless Hub](../headless-hub/overview.md).
8. **Keep it current.** `maxprice status` says when a newer release is out, and `maxprice update` installs it ([Updating](../../../cli/README.md#updating)).

## Organizations

If your claude.ai account belongs to more than one Organization, the reports count the Home organization unless you name another, and `maxprice org list` shows which ones this machine tracks ([`maxprice org`](../../../cli/README.md#maxprice-org-listtrackexcludehome)). [Organizations](../concepts/organizations.md) explains Home, Tracked and Excluded.

> [!WARNING]
> On a machine that also runs the Desktop client, join only one of the two to a Hub ([why](../../../cli/README.md#a-desktop-client-on-the-same-machine)).

## When something is wrong

Start with [`maxprice status`](../../../cli/README.md#maxprice-status): it prints one line per part of the daemon, and each line with a problem names the command that fixes it. The Reference page's [Troubleshooting](../../../cli/README.md#troubleshooting) table lists the messages you may see and what to do, and [Exit codes](../../../cli/README.md#exit-codes) what each exit code means for a script.

## Files and uninstalling

The Headless client keeps everything in one data dir in your home directory: its settings, its secrets, its archive and its caches. [The data dir](../../../cli/README.md#the-data-dir) lists every file, and [Uninstalling](../../../cli/README.md#uninstalling) says what to remove.
