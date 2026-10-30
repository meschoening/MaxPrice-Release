# Update and quit

## Update

The Hub tray app updates itself, and its Hub with it, from the console's App info card. It never installs an update until you ask.

Each time it starts, it checks for a newer release. The **Updates** row then reads **Up to date**, or the new version followed by **available**. A check that couldn't reach the update channel at start-up leaves the row at **Not checked**, since the PC's network may not be up yet at login; **Check for updates** asks again, and **Check again**, beside **Up to date**, asks once more.

When a release is available, the card says what installing does:

> Installing restarts the hub.
> Connected clients reconnect on their own and the event archive is untouched; usage polling pauses until it's back.

Choose **Install and restart**. The app downloads the release, quits to install it, and starts again on its own; the console window closes on the way. Open it again from the Popout.

> [!IMPORTANT]
> A Hub and its clients must run the same release to speak to each other ([why](../concepts/hubs.md#versions)). Update the Hub first, then every client. Until a client catches up, it reads **Hub version mismatch — update both apps; polling locally**.

### Installing by hand

You can also install a release over the running app: download its `MaxPrice.Hub_<version>_x64-setup-win.exe` from the [releases page](https://github.com/meschoening/MaxPrice-Release/releases) and run it, as in [Install](install.md#download-and-run-the-installer). The installer closes the running app first, and may ask you to let it. On its last page, leave **Run MaxPrice Hub** ticked, or start it from the Start menu afterwards. Your settings, key, password and the fleet's archive are kept.

## Quit

Closing the console window only hides it. To stop the Hub, open the Popout and choose **Quit MaxPrice Hub**.

While the Hub is stopped, no client can reach it. Each one reads **Hub unreachable — polling locally**, reads its usage limits from claude.ai itself, and keeps its own usage on its machine ([fallback polling](../concepts/hubs.md#fallback-polling)). When the Hub is back, each client reconnects on its own and sends up what it held meanwhile.

To start it again, choose **MaxPrice Hub** in the Start menu. It also starts at your next login.

## Stop it starting at login

The Hub registers itself to start at login on every launch ([Install](install.md#starts-at-login)), so there is no switch for it in the console. To stop it, open Task Manager, go to **Startup apps**, and disable **MaxPrice Hub**. The Hub honours that from then on, and its Starts at login row reads **No — disabled in Task Manager**. Enable it there again to undo it.

## Uninstall

Quit the Hub first, then uninstall **MaxPrice Hub** from Windows Settings › Apps › Installed apps.

The uninstaller removes the app. Its option to delete the app's data removes the app's log folder, `%APPDATA%\com.maxprice.hub`, but never the Hub's data dir, `%APPDATA%\maxprice-hub`, which holds the fleet's archive and settings: back it up first if you mean to move the fleet to a Headless Hub later ([Join clients](join-clients.md#moving-the-fleet-to-another-hub)), or delete it by hand if you no longer want it. The Hub's session key stays in the Windows Credential Manager, and the firewall rule named "MaxPrice Hub" stays in Windows Defender Firewall's inbound rules until you delete it there.
