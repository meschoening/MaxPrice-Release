# Join clients

Each machine you run Claude Code on joins the Hub through its client: a [Desktop client](../desktop-client/overview.md) or a [Headless client](../headless-client/overview.md). Join one client per machine. [Hubs and the fleet](../concepts/hubs.md) explains what a client then shares, and the switches that choose it.

Before you start, check that:

- the Hub's Popout reads **Online** on its Hub row, and the [firewall step](install.md#let-it-through-the-windows-firewall) is done;
- the machine is on the same tailnet as the Hub's PC;
- the client runs the same release as the Hub ([why](../concepts/hubs.md#versions)).

## The Hub's address

A client names the Hub by a URL: `http://`, the Hub PC's address on your tailnet, and the Hub's port, 47100 unless you [changed it](install.md#where-the-hub-listens). The console's Hub status card shows the address and the port as its **Listening** row, such as `100.101.102.103:47100`.

Either the PC's Tailscale address or its Tailscale name works. A name such as `http://my-desktop.tailnet.ts.net:47100` keeps working if the address changes. A client on the Hub's own PC can use `http://127.0.0.1:47100` too.

## From a Desktop client

In the Desktop client's Settings › **Usage hub**, enter the Hub's URL, and its Hub password if it has one, then choose **Connect**. The status line reads **Connected — hub is polling** once the Hub answers. [Join a Hub](../desktop-client/join-a-hub.md) has the whole step.

## From a Headless client

On the server, join with `maxprice hub join`, giving it the Hub's URL, and its Hub password when the Hub has one ([reference](../../../cli/README.md#maxprice-hub-joinleave)).

## What the Hub shows

A client that has joined appears in the console's Machines card, named after its hostname, and reads **live** while it is connected. The Popout counts it among the **connected clients**. Its usage then reaches the Hub's archive, and each client copies the whole fleet's usage back from it.

Rename the machine from its row's **⋯** menu, if its hostname isn't the name you want ([the Machines card](popout-and-console.md#machines)).

If the Hub has no session key yet, the first client that joins with Auto-heal on sends it its own, and the Popout's claude.ai row turns **Connected**.

## With a Hub password

When the Hub has a Hub password, a client joins only with it, and enters it once. After you change the password in the console's [Access card](popout-and-console.md#access), each client reads **Hub password rejected — polling locally** until you enter the new one in it.

## Leaving

A Desktop client leaves the Hub with **Disconnect** in Settings › Usage hub, and a Headless client with `maxprice hub leave` ([reference](../../../cli/README.md#maxprice-hub-joinleave)). What the machine already shared stays on the Hub, and its row stays in the Machines card. To delete that usage from the Hub too, use **Purge…** on its row.

## Moving the fleet to another Hub

To move the fleet from the Hub tray app to a [Headless Hub](../headless-hub/overview.md), quit the Hub tray app, copy its data dir, `%APPDATA%\maxprice-hub`, and restore the copy onto the Headless Hub before its first start. The [Headless Hub's manual](../../../hub/README.md#moving-a-fleet-to-another-hub) has the whole procedure, from the backup to pointing every client at the new address.
