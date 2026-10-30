# Install

The Hub tray app installs for your Windows user alone, so the installer asks for no administrator rights. The one step that needs them comes later, in the console: [letting the Hub through the Windows Firewall](#let-it-through-the-windows-firewall).

Install [Tailscale](https://tailscale.com) on the PC first, and sign in, so the Hub can listen on your [tailnet](../concepts/hubs.md#tailnet) from its first start.

## Download and run the installer

1. On the [releases page](https://github.com/meschoening/MaxPrice-Release/releases), download `MaxPrice.Hub_<version>_x64-setup-win.exe` from the latest release.
2. Run it. The installer is not signed, so Windows SmartScreen says **Windows protected your PC**. Choose **More info**, then **Run anyway**.
3. Follow the installer to the end. On its last page, leave **Run MaxPrice Hub** ticked, or start it later from the Start menu.

It opens no window. Its icon appears in the tray, at the right of the taskbar. On Windows 11 a new tray icon often lands in the overflow, behind the **^** arrow; drag it onto the taskbar to keep it in sight.

Click the icon, with either button, to open the [Popout](popout-and-console.md#the-popout), then **Open window** for the console.

## Starts at login

The Hub is meant to be always on, so it registers itself to start at login the first time it runs, with no setting to turn on. Each later start checks the registration and repairs one that names another copy of the app. A start at login opens no window, only the tray icon.

The console's Hub status card shows the registration as **Starts at login**:

| Row reads                         | What it means                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Yes**                           | It starts at your next login                                                                                    |
| **No — disabled in Task Manager** | You turned it off in Task Manager's Startup apps. The Hub leaves it off until you turn it back on               |
| **No — not registered**, in amber | The registration is missing. See [Troubleshooting](troubleshooting.md#starts-at-login-reads-no--not-registered) |

To stop it starting at login, disable **MaxPrice Hub** in Task Manager's **Startup apps**. [Update and quit](update-and-quit.md#quit) says what quitting does meanwhile.

## Let it through the Windows Firewall

Windows Firewall blocks connections to a new program from other machines until a rule allows them, and the per-user installer cannot add one. So on a fresh install the Hub runs, but nothing on your tailnet can reach it. The console says so in its Hub status card:

> Windows Firewall is blocking tailnet connections — other machines can't reach this hub.

1. Open the console from the Popout's **Open window**.
2. In the Hub status card, choose **Allow through firewall…**.
3. Windows asks for permission to make changes. Choose **Yes**.

The console says **Firewall rule added**, and the warning goes. The rule, named "MaxPrice Hub", lets in TCP connections to the Hub from tailnet addresses only (`100.64.0.0/10` and `fd7a:115c:a1e0::/48`), on any port, so a port change later needs no new rule. A rule you made yourself, or one Windows made when it asked you, counts as well: the warning shows only while no enabled rule lets the Hub in.

If you choose **No** at the Windows prompt, nothing changes and the warning stays, so you can try again.

## Give it a session key

The Hub reads your [usage limits](../concepts/blocks.md#usage-limits) from claude.ai with a session key, for every machine in the fleet. Until it has one, the Popout's claude.ai row reads **No key**.

Either paste one into the console: in the Claude account card, choose **Replace key…**, paste the value of your browser's `sessionKey` cookie for claude.ai ([how to copy it](../../../hub/README.md#the-session-key)), and choose **Save key**. Or skip this step: the first client that joins the Hub with [Auto-heal](../concepts/hubs.md#auto-heal) on sends it its own key.

The Hub keeps the key in the Windows Credential Manager, and never shows it again: the console shows only when it was set, and by whom.

## Optional: a Hub password

With no [Hub password](../concepts/hubs.md#hub-password), any device on your tailnet can join the Hub. To limit it to the clients you give a password, set one in the console's [Access card](popout-and-console.md#access) before you join them.

## Where the Hub listens

The Hub listens on port 47100, on this PC's Tailscale addresses and on the PC itself. If Tailscale isn't connected when the Hub starts, it serves the PC alone, and binds the tailnet on its own within about 10 seconds of Tailscale connecting.

To change the port or the addresses, quit the Hub tray app, edit the `hub.json` in its data dir, `%APPDATA%\maxprice-hub`, as the [Headless Hub's manual](../../../hub/README.md#bind-and-port) describes, and start it again. Then point every client at the new address.

Next: [Join clients](join-clients.md).
