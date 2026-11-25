# Install

The Hub tray app is one download for each system: a disk image for a Mac with Apple Silicon, and an installer for Windows. Neither asks for administrator rights. On Windows the one step that needs them comes later, in the console: [letting the Hub through the Windows Firewall](#let-it-through-the-windows-firewall).

Install [Tailscale](https://tailscale.com) on the computer first, and sign in, so the Hub can listen on your [tailnet](../concepts/hubs.md#tailnet) from its first start.

## Download and install it

On the [releases page](https://github.com/meschoening/MaxPrice-Release/releases), download the Hub tray app for your system from the latest release:

| System                    | File                                       |
| ------------------------- | ------------------------------------------ |
| macOS, Apple Silicon only | `MaxPrice.Hub_<version>_mac-aarch64.dmg`   |
| Windows                   | `MaxPrice.Hub_<version>_x64-setup-win.exe` |

<!-- platforms -->

### macOS

1. Open the `.dmg`.
2. Drag **MaxPrice Hub** to **Applications**.
3. Open MaxPrice Hub from Applications.

It is signed with a Developer ID and notarized by Apple, so it opens with a normal double-click. It opens no window and no Dock icon: its icon appears in the menu bar, at the top right of the screen ([the menu-bar icon](popout-and-console.md#the-menu-bar-icon)). macOS tells you that it can run in the background, since it [starts at login](#starts-at-login).

### Windows

1. Run the `.exe` installer. It is not signed, so Windows SmartScreen says **Windows protected your PC**. Choose **More info**, then **Run anyway**.
2. Follow the installer to the end. On its last page, leave **Run MaxPrice Hub** ticked, or start it later from the Start menu.

It installs for your Windows user alone. It opens no window. Its icon appears in the tray, at the right of the taskbar. On Windows 11 a new tray icon often lands in the overflow, behind the **^** arrow; drag it onto the taskbar to keep it in sight.

<!-- /platforms -->

Click the icon, with either button, to open the [Popout](popout-and-console.md#the-popout), then **Open window** for the console.

## Starts at login

The Hub is meant to be always on, so it registers itself to start at login the first time it runs, with no setting to turn on. A start at login opens no window, only the icon.

On a Mac it registers a login item, and the console shows no row for it. To stop it starting at login, turn off **maxprice-hub-desktop** in System Settings › General › Login Items & Extensions. [Update and quit](update-and-quit.md#quit) says what quitting does meanwhile.

On Windows, each later start checks the registration and repairs one that names another copy of the app. The console's Hub status card shows the registration as **Starts at login**:

| Row reads                         | What it means                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Yes**                           | It starts at your next login                                                                                    |
| **No — disabled in Task Manager** | You turned it off in Task Manager's Startup apps. The Hub leaves it off until you turn it back on               |
| **No — not registered**, in amber | The registration is missing. See [Troubleshooting](troubleshooting.md#starts-at-login-reads-no--not-registered) |

To stop it starting at login, disable **MaxPrice Hub** in Task Manager's **Startup apps**. [Update and quit](update-and-quit.md#quit) says what quitting does meanwhile.

## Let it through the Windows Firewall

This step is for Windows alone. On a Mac the console checks no firewall: if you have turned on the macOS firewall, in System Settings › Network › Firewall, check that its options allow incoming connections to MaxPrice Hub.

Windows Firewall blocks connections to a new program from other machines until a rule allows them, and the per-user installer cannot add one. So on a fresh install the Hub runs, but nothing on your tailnet can reach it. The console says so in its Hub status card:

> Windows Firewall is blocking tailnet connections — other machines can't reach this hub.

1. Open the console from the Popout's **Open window**.
2. In the Hub status card, choose **Allow through firewall…**.
3. Windows asks for permission to make changes. Choose **Yes**.

The console says **Firewall rule added**, and the warning goes. The rule, named "MaxPrice Hub", lets in TCP connections to the Hub from tailnet addresses only (`100.64.0.0/10` and `fd7a:115c:a1e0::/48`), on any port, so a port change later needs no new rule. A rule you made yourself, or one Windows made when it asked you, counts as well: the warning shows only while no enabled rule lets the Hub in.

If you choose **No** at the Windows prompt, nothing changes and the warning stays, so you can try again.

## Give it a session key

The Hub reads your [usage limits](../concepts/usage-limits.md) from claude.ai with a session key, for every machine in the fleet. Until it has one, the Popout's claude.ai row reads **No key**.

Either paste one into the console: in the Claude account card, choose **Replace key…**, paste the value of your browser's `sessionKey` cookie for claude.ai ([how to copy it](../../../hub/README.md#the-session-key)), and choose **Save key**. Or skip this step: the first client that joins the Hub with [Send keys to the Hub](../concepts/hubs.md#send-keys-to-the-hub) on sends it its own key.

The Hub keeps the key in the Windows Credential Manager, or in the macOS Keychain, and never shows it again: the console shows only when it was set, and by whom.

## Optional: a Gateway

If Claude Code on your machines runs through a Gateway, such as CLIProxyAPI, rather than, or as well as, logging in directly, connect it in the console's [Gateways card](popout-and-console.md#gateways): the Hub drains its records for every client, so each request it served counts under its Account and Organization. A client that already holds the Gateway sends it to the Hub when it joins.

## Optional: a Hub password

With no [Hub password](../concepts/hubs.md#hub-password), any device on your tailnet can join the Hub. To limit it to the clients you give a password, set one in the console's [Access card](popout-and-console.md#access) before you join them.

## Where the Hub listens

The Hub listens on port 47100, on this computer's Tailscale addresses and on the computer itself. If Tailscale isn't connected when the Hub starts, it serves the computer alone, and binds the tailnet on its own within about 10 seconds of Tailscale connecting.

To change the port or the addresses, quit the Hub tray app, edit the `hub.json` in its data dir, as the [Headless Hub's manual](../../../hub/README.md#bind-and-port) describes, and start it again. Then point every client at the new address. The data dir is `%APPDATA%\maxprice-hub` on Windows, and `~/Library/Application Support/maxprice-hub` on a Mac.

## One Hub per Mac

A Mac can hold both the Hub tray app and a [Headless Hub](../headless-hub/overview.md), but run only one of them. Each keeps its own data dir, so nothing stops both starting, but only one can serve on port 47100: whichever starts second can't listen. When that is the tray app, its Hub row reads **Not responding** ([Troubleshooting](troubleshooting.md#the-hub-row-reads-not-responding)). To move the tray app's Hub to a Headless Hub, quit the tray app, stop it starting at login, and move its data as [Join clients](join-clients.md#moving-the-fleet-to-another-hub) describes.

Next: [Join clients](join-clients.md).
