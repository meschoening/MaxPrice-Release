# Overview

The Headless Hub is the MaxPrice [Hub](../concepts/hubs.md) with no window, for a Linux server. It is one terminal command, `maxprice-hub`, run all the time as a systemd user unit. It does a Hub's whole job: it reads your claude.ai [usage limits](../concepts/blocks.md#usage-limits) once for every machine, keeps the fleet's usage, and shares what you set up once with every client that joins it. In place of a tray icon it serves a read-only [Hub page](hub-page.md), which your own web server can publish.

You need one Hub for all your machines, and only if you want to see several machines' usage in one place. Run the Headless Hub on a Linux server that stays on; on an always-on Windows PC, the [Hub tray app](../hub-tray-app/overview.md) does the same job.

## The Headless Hub and the Hub tray app

The two Hubs do the same job for the same clients, and a client joins either one the same way. They differ in how you run and watch them.

|                             | Headless Hub                                                                                                                                                                                                                 | Hub tray app                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Runs on                     | Linux x64, glibc 2.28 or later                                                                                                                                                                                               | Windows x64                                            |
| Runs as                     | A systemd user unit, or under another init                                                                                                                                                                                   | A tray app that starts at login                        |
| Set up with                 | [`maxprice-hub setup`](../../../hub/README.md#maxprice-hub-setup), in a terminal                                                                                                                                             | Its installer and its console                          |
| Shows its state in          | [`maxprice-hub status`](../../../hub/README.md#maxprice-hub-status), and the Hub page                                                                                                                                        | Its tray icon, its Popout and its console              |
| Renames, merges and purges  | [`maxprice-hub rename`](../../../hub/README.md#maxprice-hub-rename), [`maxprice-hub merge`](../../../hub/README.md#maxprice-hub-merge) and [`maxprice-hub purge-machine`](../../../hub/README.md#maxprice-hub-purge-machine) | Its console's Machines card                            |
| Keeps its session key in    | A file only its user can read                                                                                                                                                                                                | The Windows Credential Manager                         |
| Updates                     | When you run [`maxprice-hub update`](../../../hub/README.md#maxprice-hub-update)                                                                                                                                             | When you choose **Install and restart** in its console |
| A read-only page for others | The Hub page                                                                                                                                                                                                                 | None                                                   |

By default clients reach either one over your [tailnet](../concepts/hubs.md#tailnet), and either can require a [Hub password](../concepts/hubs.md#hub-password).

## Get started

Each step links the Reference section that holds its commands.

1. **Install it** on the server that will serve the fleet: download the tarball from the releases page and unpack it into `~/.local/bin` ([Install](../../../hub/README.md#install)). It needs no root.
2. **Have Tailscale up** on that server, and your claude.ai session key to hand ([how to copy it](../../../hub/README.md#the-session-key)). Clients reach the Hub over your [tailnet](../concepts/hubs.md#tailnet).
3. **Run `maxprice-hub setup`** as the user the Hub will run as ([First run: setup](../../../hub/README.md#first-run-setup)). It asks for the session key, an optional Hub password and an optional Hub page URL, installs and starts the service, lists the steps that still need sudo, and ends with the address clients join. To script it instead, run its steps as commands ([Without a terminal](../../../hub/README.md#without-a-terminal)).
4. **Keep it running after you log out.** If setup lists the linger step, run it ([Run it as a service](../../../hub/README.md#run-it-as-a-service)). With no systemd user manager, as in a container, run it under another init ([Other inits](../../../hub/README.md#other-inits)).
5. **Join your clients** to the address setup printed: a Desktop client in Settings › Usage hub ([Join a Hub](../desktop-client/join-a-hub.md)), a Headless client with `maxprice hub join` ([reference](../../../cli/README.md#maxprice-hub-joinleave)).
6. **Publish the Hub page**, if you want one ([Publish the Hub page](../../../hub/README.md#publish-the-hub-page)). Setup's Hub page URL is where your web server will show it. `maxprice-hub page` checks it and lists the web server's steps until it reads published.
7. **Check on it** with `maxprice-hub status`, which shows the rows the Hub page shows and the Hub's own details ([`maxprice-hub status`](../../../hub/README.md#maxprice-hub-status)).
8. **Keep it current.** `status` says when a newer release is out, and `maxprice-hub update` installs it and restarts the service ([Updating](../../../hub/README.md#updating)).

To change the port, or where the Hub listens, edit its `hub.json` ([bind and port](../../../hub/README.md#bind-and-port)).

## Running the fleet

- **Machines.** The Hub names each machine after its hostname. [Rename](../../../hub/README.md#maxprice-hub-rename), [merge](../../../hub/README.md#maxprice-hub-merge) or [purge](../../../hub/README.md#maxprice-hub-purge-machine) one from the Hub's machine, and the change reaches every client.
- **The session key and the Hub password** can change at any time, with no restart ([The session key and the Hub password](../../../hub/README.md#the-session-key-and-the-hub-password)). A client with [Auto-heal](../concepts/hubs.md#auto-heal) on sends its own key when the Hub's stops working.
- **Moving the fleet.** A Headless Hub can take over a fleet from another Hub, a Hub tray app included, or come back from its own backup ([Moving a fleet to another Hub](../../../hub/README.md#moving-a-fleet-to-another-hub)).

## When something is wrong

Start with [`maxprice-hub status`](../../../hub/README.md#maxprice-hub-status), and [`maxprice-hub service status`](../../../hub/README.md#maxprice-hub-service-installuninstallstatuslogs) for the unit. Each row with a problem names the command that fixes it. The Reference page's [Troubleshooting](../../../hub/README.md#troubleshooting) table lists the messages you may see and what to do, and [Exit codes](../../../hub/README.md#exit-codes) what each exit code means for a script.

## Files and uninstalling

The Headless Hub keeps its settings, its session key, the fleet's archive and its usage limit history in one data dir. [The data dir](../../../hub/README.md#the-data-dir) lists every file, and [Uninstalling](../../../hub/README.md#uninstalling) says what to remove.
