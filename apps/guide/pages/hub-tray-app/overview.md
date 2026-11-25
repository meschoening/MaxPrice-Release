# Overview

The Hub tray app, **MaxPrice Hub**, is a [Hub](../concepts/hubs.md) for Windows and macOS. It runs in the Windows tray or the macOS menu bar on one always-on computer, and the clients on your other machines join it to share their usage and their usage limits. Its download on the [releases page](https://github.com/meschoening/MaxPrice-Release/releases) is "MaxPrice Hub".

It is a Hub and nothing else: it reports no usage of its own. To count the usage of the computer it runs on too, install the [Desktop client](../desktop-client/overview.md) beside it, and join that to it like any other machine.

## What it is

- **A Hub that starts when you log in.** It starts hidden, as an icon in the Windows tray or the macOS menu bar, and keeps the Hub running until you quit it. On a Mac it has no Dock icon.
- **A Popout** that opens from that icon: one glance at whether the Hub is online, whether its claude.ai session keys work, and how many clients are connected.
- **A console window**, opened from the Popout, where you run the Hub: its status, its session keys (one per Account, with each Account's Organizations), the [Gateways](popout-and-console.md#gateways) it drains, its [Hub password](../concepts/hubs.md#hub-password), the machines in the fleet, and its updates.

Inside, it runs the same Hub as the [Headless Hub](../headless-hub/overview.md), so the two do the same job. The Headless Hub runs on a Linux server or a Mac instead, with no window, and it can publish a read-only Hub page; the tray app has none. Run one Hub for all your machines, and on a Mac only one of the two ([one Hub per Mac](install.md#one-hub-per-mac)).

## What it needs

- Windows x64, or a Mac with Apple Silicon. There is no build for Intel Macs.
- A computer that stays on while your other machines run Claude Code, since a client falls back to its own polling while its Hub is away.
- [Tailscale](https://tailscale.com) on that computer and on every machine that joins it. Clients reach the Hub over your tailnet ([why](../concepts/hubs.md#tailnet)).
- A claude.ai session key, for your usage limits. You can paste one into the console, or let the first client that joins with [Send keys to the Hub](../concepts/hubs.md#send-keys-to-the-hub) on send its own ([the session key](../concepts/usage-limits.md#the-claudeai-session-key)).

## Where to start

1. [Install](install.md) it, let it through the Windows Firewall on Windows, and give it a session key.
2. [Join clients](join-clients.md) to it, from each machine you run Claude Code on.
3. Look at it any time from [the Popout and the console](popout-and-console.md).

[Update and quit](update-and-quit.md) covers updates, quitting, and starting at login. [Troubleshooting](troubleshooting.md) goes through what to do when a client can't reach the Hub, or a row in the Popout reads something other than you expect.
