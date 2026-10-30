# Update

On macOS and Windows, MaxPrice checks for a new version itself and asks before it installs one. On Linux, you install each new version's `.deb` yourself.

## When MaxPrice finds a new version

MaxPrice checks when it starts and about every six hours while it runs, even with its window closed. When it finds a new version:

- the window shows **Update available**, with **Later** and **Install and relaunch**;
- the tray icon wears a dot, and the [Popout](tray.md#the-popout) shows **↑ Update available** with the version. Clicking that row brings the prompt back after **Later**.

**Install and relaunch** downloads the new version, installs it and starts MaxPrice again. Your settings and [Local archive](../concepts/archive.md#the-local-archive) stay as they were. Nothing installs until you choose it.

## Check now

In Settings › **Updates**, choose **Check for updates**. It reads **You’re up to date.**, or offers **Update to** the new version, which installs it and restarts MaxPrice. **Check failed — couldn’t reach the update channel.** means the check couldn't get through; try again later.

## How each system installs it

<!-- platforms -->

### macOS

The update installs over the app in Applications, and MaxPrice reopens.

### Windows

MaxPrice closes, the installer runs, and MaxPrice reopens. The installer is not code-signed, so SmartScreen may show **Windows protected your PC** after MaxPrice has closed: click **More info**, then **Run anyway**. If you choose **Don't run** instead, MaxPrice stays closed until you start it again, and the update is offered again later.

### Linux

The Desktop client doesn't update itself on Linux, and Settings › Updates says so. To update, download the new `MaxPrice_<version>_linux.deb` from the [releases page](https://github.com/meschoening/MaxPrice-Release/releases), quit MaxPrice and install it over the old one:

```sh
sudo apt install ./MaxPrice_*_linux.deb
```

Your settings and Local archive stay as they were.

<!-- /platforms -->

## With a Hub

A client and its [Hub](../concepts/hubs.md) must speak the same version of the Hub protocol. Update the Hub and every client to the same release. Until they match, a client reads **Hub version mismatch — update both apps; polling locally** in Settings › Usage hub ([why](../concepts/hubs.md#versions)).

The Hub tray app has its own updates ([Update and quit](../hub-tray-app/update-and-quit.md)), and the Headless Hub updates when you run `maxprice-hub update` ([reference](../../../hub/README.md#maxprice-hub-update)).
