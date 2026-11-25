# Troubleshooting

Start with the Popout: its Hub row says whether the Hub is running and reachable, and its claude.ai row whether it can read your usage limits. The console's Hub status card shows any warning in full.

## A client reads "Hub unreachable — polling locally"

The client can't reach the Hub at the URL it was given. Open the Hub's Popout, and go by its Hub row:

- **No icon:** first check that it isn't hidden ([the icon is missing](#the-icon-is-missing)). If it isn't there either, the Hub isn't running: start **MaxPrice Hub** from the Start menu, or from Applications on a Mac.
- **Local only:** nothing off the Hub's computer can reach it. The console's Hub status card says why: either the [Windows Firewall warning](#windows-firewall-is-blocking-tailnet-connections), or [no tailnet interface](#no-tailnet-interface). With neither, and a grey dot, the Hub's `hub.json` sets `bind` to `loopback`, which serves this computer alone on purpose ([where the Hub listens](install.md#where-the-hub-listens)).
- **Online:** the Hub is reachable on the tailnet, so look at the client. Check that its URL matches the console's **Listening** row, port included ([the Hub's address](join-clients.md#the-hubs-address)), and that the client's machine is signed in to the same tailnet.

## Other client statuses

A Desktop client's Settings › Usage hub gives the reason it is polling by itself:

| Status                                                       | What to do                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **Hub has no working Claude key — polling locally**          | Give the Hub a new session key: the [claude.ai row](#the-claudeai-row-reads-key-expired-no-key-or-poll-failing) below |
| **Hub password rejected — polling locally**                  | Enter the Hub's current password in the client ([with a Hub password](join-clients.md#with-a-hub-password))           |
| **Hub version mismatch — update both apps; polling locally** | Update the Hub and the client to the same release ([Update](update-and-quit.md#update))                               |

## Windows Firewall is blocking tailnet connections

The Hub runs, but Windows Firewall drops connections to it from other machines. Choose **Allow through firewall…** in the warning, then **Yes** at the Windows prompt ([Install](install.md#let-it-through-the-windows-firewall)). If you chose **No**, the warning stays: choose the button again.

## No tailnet interface

> No tailnet interface — the hub is serving loopback only. It will bind Tailscale automatically as soon as it connects.

Tailscale isn't connected on the Hub's computer, so the Hub serves the computer alone. Start Tailscale and sign in; within about 10 seconds the Hub binds the tailnet on its own, and the Popout reads **Online**. There is nothing to restart.

## The claude.ai row reads Key expired, No key or Poll failing

- **Key expired:** claude.ai refused the session key, which happens when that browser session ends. Paste a fresh key with **Replace key…** in the Claude account card ([Claude account](popout-and-console.md#claude-account)), or on that Account's row of the [Accounts card](popout-and-console.md#accounts) when the Hub has several. A client with Send keys to the Hub on sends the Hub its own key for that Account when its works, unless you removed the Account's key at the Hub after that key was set.
- **No key:** the Hub has no session key. Set one the same way, or join a client with Send keys to the Hub on.
- **Poll failing:** the Hub couldn't read your limits from claude.ai, for a reason other than the key, such as the computer's network. It keeps trying once a minute, and the row recovers on its own when a read succeeds.

With keys for several Accounts the row counts them instead, as in **1 key expired**, **2 need a key** or **No key works**. The console's [Accounts card](popout-and-console.md#accounts) lists the Accounts that need a key first, each with what it needs.

## The Hub row reads Not responding

The console can't reach its own Hub. Most often the Hub couldn't start, because another program holds its port, 47100: a second Hub on the same computer, for example, such as a Headless Hub on the same Mac ([one Hub per Mac](install.md#one-hub-per-mac)). The [log](#the-log) says what held it. Quit the Hub tray app, stop that program or [change the port](install.md#where-the-hub-listens), and start the Hub tray app again.

## The Hub row reads Stopped

The Hub stopped after it had started. Choose **Restart hub**, in the Popout or in the console's Hub status card: it restarts the whole app, and clients reconnect on their own. If it keeps stopping, the [log](#the-log) says why.

## The Hub row reads Event sync down

> Fleet event archive failed to load — clients can't push events. Restart the hub.

The Hub still reads your usage limits, but no client can send it usage. Quit the Hub tray app from the Popout, and start it again. If the warning comes back, the [log](#the-log) says why the archive didn't load.

## Starts at login reads No — not registered

This row is Windows only. The Hub couldn't register itself to start at login, so it won't start after a restart of Windows. It tries again each time it starts, so quit it and start it again from the Start menu. If the row still reads the same, the [log](#the-log) says why.

## Updates reads Check failed

The Hub couldn't get an answer from its update channel: the network, or the channel itself. Choose **Try again**. If it keeps failing, the reason is in the [log](#the-log). You can always [install a release by hand](update-and-quit.md#installing-by-hand).

## The icon is missing

- **macOS:** when the menu bar has more icons than room, macOS hides the ones that don't fit, and on a Mac with a notch an icon can sit behind it. Quit a menu-bar app you don't need. On macOS 26 or later, also check that MaxPrice Hub is on under **Allow in the Menu Bar** in System Settings › Menu Bar.
- **Windows:** on Windows 11, a new tray icon goes into the overflow, behind the **^** arrow at the right of the taskbar. To keep it in sight, drag it onto the taskbar, or turn on **MaxPrice Hub** under Settings › Personalization › Taskbar › Other system tray icons.

## The log

The Hub tray app writes its log to `%APPDATA%\com.maxprice.hub\logs\hub.log` on Windows, and `~/Library/Application Support/com.maxprice.hub/logs/hub.log` on a Mac, the Hub's own lines included. Where the console's messages say "the reason is in hub.log", this is the file.
