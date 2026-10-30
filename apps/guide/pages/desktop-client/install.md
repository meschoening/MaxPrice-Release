# Install

The Desktop client is one download for each system: a disk image for macOS, an installer for Windows and a package for Linux.

## Download

Download the Desktop client for your system from the [releases page](https://github.com/meschoening/MaxPrice-Release/releases), under the newest release's **Assets**. Each file name carries the version:

| System  | File                                   |
| ------- | -------------------------------------- |
| macOS   | `MaxPrice_<version>_mac.dmg`           |
| Windows | `MaxPrice_<version>_x64-setup-win.exe` |
| Linux   | `MaxPrice_<version>_linux.deb`         |

The Windows file that starts `MaxPrice.Hub_` is the [Hub tray app](../hub-tray-app/overview.md), not the Desktop client.

## Install it

<!-- platforms -->

### macOS

1. Open the `.dmg`.
2. Drag **MaxPrice** to **Applications**.
3. Open MaxPrice from Applications.

One `.dmg` runs on Apple Silicon and on Intel Macs. It is signed with a Developer ID and notarized by Apple, so it opens with a normal double-click. If macOS still refuses to open it, the download is probably damaged: download it again rather than going around Gatekeeper.

### Windows

1. Run the `.exe` installer.
2. The installer is not code-signed, so SmartScreen shows **Windows protected your PC**. Click **More info**, then **Run anyway**.
3. Open MaxPrice from the Start menu.

It installs for your user alone, in `%LOCALAPPDATA%\MaxPrice`, and needs no administrator rights.

### Linux

Install the `.deb` with `apt`, from the folder you downloaded it to:

```sh
sudo apt install ./MaxPrice_*_linux.deb
```

`apt` also installs the WebKitGTK and GTK 3 libraries the window needs. Open MaxPrice from your applications menu.

> [!IMPORTANT]
> On Linux the Desktop client has no tray icon or Popout, no **Start at login** and no updater. Closing its window quits it, and a new version is a new `.deb` (see [Update](update.md#linux)).

<!-- /platforms -->

Next: the [first run](first-run.md).

## Uninstall

Quit MaxPrice first (see [Tray and Popout](tray.md#quit)). On macOS and Windows, turn off **Start at login** in Settings before you remove it, so no login entry is left behind.

- **macOS:** drag MaxPrice from Applications to the Trash.
- **Windows:** in Settings › Apps › Installed apps, choose **Uninstall** from MaxPrice's menu.
- **Linux:** remove the package:

  ```sh
  sudo apt remove max-price
  ```

Uninstalling leaves your data. Your settings and [Local archive](../concepts/archive.md#the-local-archive) are in a folder of their own, which [where data lives](../concepts/archive.md#desktop-client) names for each system, and your session key and Hub password are in the system's keychain. To remove them too, delete that folder and MaxPrice's keychain entries.
