# Overview

The Headless Hub is the MaxPrice [Hub](../concepts/hubs.md) with no window, for a Linux server or a Mac that nobody sits at. It is one terminal command, `maxprice-hub`, run all the time as a service: a systemd user unit on Linux, a LaunchAgent on macOS. It does a Hub's whole job: it reads your claude.ai [usage limits](../concepts/usage-limits.md) once for every machine, keeps the fleet's usage, and shares what you set up once with every client that joins it. In place of a tray icon it serves a read-only [Hub page](hub-page.md), which your own web server can publish.

You need one Hub for all your machines, and only if you want to see several machines' usage in one place. Run the Headless Hub on a Linux server or a Mac that stays on; on an always-on Windows PC or Mac, the [Hub tray app](../hub-tray-app/overview.md) does the same job, in a window. A Mac runs one Hub: if the Hub tray app keeps one there too, only the first to start can serve ([why](../../../hub/README.md#the-hub-tray-app-on-the-same-mac)).

## The Headless Hub and the Hub tray app

The two Hubs do the same job for the same clients, and a client joins either one the same way. They differ in how you run and watch them.

|                             | Headless Hub                                                                                                                                                                                                                 | Hub tray app                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Runs on                     | Linux x64, glibc 2.28 or later; macOS 13 or later, Apple Silicon                                                                                                                                                             | Windows x64; macOS, Apple Silicon                      |
| Runs as                     | A systemd user unit on Linux, a LaunchAgent on macOS, or under another init                                                                                                                                                  | A tray app that starts at login                        |
| Set up with                 | [`maxprice-hub setup`](../../../hub/README.md#maxprice-hub-setup), in a terminal                                                                                                                                             | Its installer and its console                          |
| Shows its state in          | [`maxprice-hub status`](../../../hub/README.md#maxprice-hub-status), and the Hub page                                                                                                                                        | Its icon, its Popout and its console                   |
| Renames, merges and purges  | [`maxprice-hub rename`](../../../hub/README.md#maxprice-hub-rename), [`maxprice-hub merge`](../../../hub/README.md#maxprice-hub-merge) and [`maxprice-hub purge-machine`](../../../hub/README.md#maxprice-hub-purge-machine) | Its console's Machines card                            |
| Keeps its session keys in   | A file only its user can read                                                                                                                                                                                                | The Windows Credential Manager or the macOS Keychain   |
| Updates                     | When you run [`maxprice-hub update`](../../../hub/README.md#maxprice-hub-update)                                                                                                                                             | When you choose **Install and restart** in its console |
| A read-only page for others | The Hub page                                                                                                                                                                                                                 | None                                                   |

By default clients reach either one over your [tailnet](../concepts/hubs.md#tailnet), and either can require a [Hub password](../concepts/hubs.md#hub-password).

## Get started

Each step links the Reference section that holds its commands.

1. **Install it** on the machine that will serve the fleet: download your platform's tarball from the releases page and unpack it into `~/.local/bin` ([Linux](../../../hub/README.md#linux), [macOS](../../../hub/README.md#macos)). It needs no root. On a Mac, fetch it with `curl` as shown there: a copy downloaded in a browser is quarantined, and macOS may stop it from starting.
2. **Have Tailscale up** on that machine, and the claude.ai session key of each [Account](../concepts/organizations.md#accounts) the Hub should read to hand, one per Account ([how to copy it](../../../hub/README.md#the-session-key)). Clients reach the Hub over your [tailnet](../concepts/hubs.md#tailnet).
3. **Run `maxprice-hub setup`** as the user the Hub will run as ([First run: setup](../../../hub/README.md#first-run-setup)). It asks for the session keys, one at a time with an optional label for each key's Account, then an optional Hub password and an optional Hub page URL, installs and starts the service, lists the steps that still need sudo, and ends with the address clients join. To script it instead, run its steps as commands ([Without a terminal](../../../hub/README.md#without-a-terminal)).
4. **Connect your Gateway**, if Claude Code runs through one, such as CLIProxyAPI: `maxprice-hub gateway connect <url>` ([reference](../../../hub/README.md#maxprice-hub-gateway-connectlistremove)), described under Gateways below.
5. **Keep it running.** On Linux, if setup lists the linger step, run it, so the Hub keeps running after you log out ([A systemd user unit](../../../hub/README.md#a-systemd-user-unit)). With no systemd user manager, as in a container, run it under another init ([Other inits](../../../hub/README.md#other-inits)).

   On macOS the service is a LaunchAgent, which runs while you are logged in to the Mac and starts again at each login ([A LaunchAgent on macOS](../../../hub/README.md#a-launchagent-on-macos)). On a Mac with FileVault, that means after a restart no client reaches the Hub until you unlock the disk and log in. For a Mac that nobody logs in to, the Reference shows a LaunchDaemon that runs it from boot, once a FileVault disk is unlocked ([A LaunchDaemon on macOS](../../../hub/README.md#a-launchdaemon-on-macos)).

6. **Join your clients** to the address setup printed: a Desktop client in Settings › Usage hub ([Join a Hub](../desktop-client/join-a-hub.md)), a Headless client with `maxprice hub join` ([reference](../../../cli/README.md#maxprice-hub-joinleave)).
7. **Publish the Hub page**, if you want one ([Publish the Hub page](../../../hub/README.md#publish-the-hub-page)). Setup's Hub page URL is where your web server will show it. On a Mac, the Apache that macOS includes can publish it ([Apache on macOS](../../../hub/README.md#apache-on-macos)). `maxprice-hub page` checks it and lists the web server's steps until it reads published.
8. **Check on it** with `maxprice-hub status`, which shows the rows the Hub page shows and the Hub's own details ([`maxprice-hub status`](../../../hub/README.md#maxprice-hub-status)).
9. **Keep it current.** `status` says when a newer release is out, and `maxprice-hub update` installs it and restarts the service ([Updating](../../../hub/README.md#updating)).

To change the port, or where the Hub listens, edit its `hub.json` ([bind and port](../../../hub/README.md#bind-and-port)).

## Running the fleet

- **Machines.** The Hub names each machine after its hostname. [Rename](../../../hub/README.md#maxprice-hub-rename), [merge](../../../hub/README.md#maxprice-hub-merge) or [purge](../../../hub/README.md#maxprice-hub-purge-machine) one from the Hub's machine, and the change reaches every client.
- **Session keys.** The Hub holds one session key per claude.ai Account. `maxprice-hub key list` lists them, each with its Account's label, whether it connects, and when and by whom it was set. `maxprice-hub key set` adds a key, or replaces its Account's, and `maxprice-hub key remove` removes one Account's key ([`maxprice-hub key set|list|remove`](../../../hub/README.md#maxprice-hub-key-setlistremove)). Run `maxprice-hub setup` again to add several in a row. A client with [Send keys to the Hub](../concepts/hubs.md#send-keys-to-the-hub) on sends its own key for an Account when the Hub's key for it stops working; after you remove a key at the Hub, it sends one only if it was set after the removal.
- **Labels.** `maxprice-hub label` renames an Account or an Organization, and every client shows the new name ([`maxprice-hub label account|org`](../../../hub/README.md#maxprice-hub-label-accountorg)).
- **Gateways.** Logging in to Claude Code directly is one way to use an Account. A Gateway, such as CLIProxyAPI, which serves Claude Code's requests on Accounts it holds itself, is another, and neither is the main one. A session run through a Gateway names no login, so connect the Gateway to the Hub with `maxprice-hub gateway connect <url>`: the Hub reads the Gateway's records, and every client counts each request it served under the Account it ran on. `maxprice-hub gateway list` shows each Gateway's state, and `maxprice-hub gateway remove <url>` removes one ([`maxprice-hub gateway connect|list|remove`](../../../hub/README.md#maxprice-hub-gateway-connectlistremove)).
- **The session keys and the Hub password** can change at any time, with no restart ([The session key and the Hub password](../../../hub/README.md#the-session-key-and-the-hub-password)).
- **Moving the fleet.** A Headless Hub can take over a fleet from another Hub, a Hub tray app included, or come back from its own backup ([Moving a fleet to another Hub](../../../hub/README.md#moving-a-fleet-to-another-hub)).

## When something is wrong

Start with [`maxprice-hub status`](../../../hub/README.md#maxprice-hub-status), and [`maxprice-hub service status`](../../../hub/README.md#maxprice-hub-service-installuninstallstatuslogs) for the unit or the LaunchAgent. Each row with a problem names the command that fixes it. The Reference page's [Troubleshooting](../../../hub/README.md#troubleshooting) table lists the messages you may see and what to do, and [Exit codes](../../../hub/README.md#exit-codes) what each exit code means for a script.

## Files and uninstalling

The Headless Hub keeps its settings, its session keys, the fleet's archive and its usage limit history in one data dir. [The data dir](../../../hub/README.md#the-data-dir) lists every file, and [Uninstalling](../../../hub/README.md#uninstalling) says what to remove.
