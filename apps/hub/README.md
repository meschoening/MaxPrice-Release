# The MaxPrice Hub

The MaxPrice Hub is the optional, always-on part of MaxPrice: one per fleet, on a machine you choose. It polls the claude.ai Usage limits of every Organization its session key lists, keeps the fleet's Usage history and its archive of Fleet events, and serves both to the clients that join it over your tailnet. While a client is connected, the Hub is the fleet's one poller: the client's own poller pauses, the samples it missed backfill down, the samples it took while the Hub was away push up, and its reports show every machine's usage. When the Hub's session key stops working, a Connected client that holds a working key pushes it up (auto-heal, on by default).

The Hub comes in two forms:

- **The hub tray app**, MaxPrice Hub, for Windows: an installer that runs the Hub from the tray, with an operator console ([The hub tray app](#the-hub-tray-app)).
- **The Headless Hub**, `maxprice-hub`, for a Linux server: one binary, for Linux x64 with glibc ([Platform floor](#platform-floor)), driven from a terminal, with a read-only [Hub page](#the-hub-page) that your own web server can publish.

This is the Headless Hub's manual. Clients join a Hub from the Desktop client's Settings (Usage hub), or with the Headless client's `maxprice hub join` ([its manual](../cli/README.md)).

## Contents

- [Install](#install)
- [First run: setup](#first-run-setup)
- [Run it as a service](#run-it-as-a-service)
- [Other inits](#other-inits)
- [bind and port](#bind-and-port)
- [The session key and the Hub password](#the-session-key-and-the-hub-password)
- [Publish the Hub page](#publish-the-hub-page)
- [Updating](#updating)
- [Moving a fleet to another Hub](#moving-a-fleet-to-another-hub)
- [The data dir](#the-data-dir)
- [Uninstalling](#uninstalling)
- [Troubleshooting](#troubleshooting)
- [Platform floor](#platform-floor)
- [Commands](#commands)
- [Exit codes](#exit-codes)
- [How a command reaches a running Hub](#how-a-command-reaches-a-running-hub)
- [The Hub page](#the-hub-page)
- [The hub tray app](#the-hub-tray-app)
- [Development](#development)

## Install

The Headless Hub ships as `maxprice-hub_<version>_linux-x64.tar.gz` on the [releases page](https://github.com/meschoening/MaxPrice-Release/releases), from the first release that carries the Headless Hub.

The tarball holds one file, `maxprice-hub`, with mode 0755. Download it, then, in the directory that holds it and no other `maxprice-hub_` tarball:

```sh
mkdir -p ~/.local/bin && tar -xzf maxprice-hub_*_linux-x64.tar.gz -C ~/.local/bin
```

The same line replaces an older `maxprice-hub` there and leaves the rest of `~/.local/bin` alone. It needs no root. A Hub already running keeps the old version until it restarts, `systemctl --user restart maxprice-hub` for the user unit; until then `maxprice-hub status`'s Update row says so, and a command exits 4 when the new version speaks another Hub protocol. [`maxprice-hub update`](#updating) replaces the binary and restarts the unit in one step.

On Ubuntu and Debian, the default `~/.profile` adds `~/.local/bin` to `PATH` at your next login once the directory exists. Until then, or in a shell that does not, add it yourself:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Then check that it runs:

```sh
maxprice-hub --version
```

### From source

A release with no `maxprice-hub_` tarball predates the Headless Hub. Build the binary instead, with [Bun](https://bun.sh) 1.3.14 or newer, in a checkout of the source:

```sh
bun install --frozen-lockfile
bun apps/hub/scripts/build-binaries.ts linux-x64
install -D -m 0755 apps/hub/binaries/maxprice-hub-x86_64-unknown-linux-gnu ~/.local/bin/maxprice-hub
```

The build first builds the Hub page, then compiles `apps/hub/binaries/maxprice-hub-x86_64-unknown-linux-gnu` with the page's files inside it. Only the linux-x64 build embeds them: any other target serves no page files.

Then put `~/.local/bin` on `PATH` and check that it runs, as above.

## First run: setup

`maxprice-hub setup` walks a new Hub's setup on a terminal, in four steps: the claude.ai session key, the Hub password, the Hub page URL and the systemd user unit. Run it as the user the Hub will run as, not root, on the machine that will serve the fleet, with Tailscale up there so that its ending can name the address clients join. Have the claude.ai `sessionKey` cookie to hand ([how to copy it](#the-session-key)).

Setup makes the [data dir](#the-data-dir) and its `hub.json` first, so the Hub's first start already has the key and the password you give it: it is never open and keyless on the tailnet, even briefly. By default the data dir is `~/.local/share/maxprice-hub`. To keep it elsewhere, set `MAXPRICE_HUB_DATA_DIR` to an absolute path first, in every shell you run `maxprice-hub` from; step 4 bakes it into the unit, and prints an `Environment=MAXPRICE_HUB_DATA_DIR=…` line under its first line.

A first run, every step taken, on a server whose own name `hub.example` stands for, with a web server on it:

```
$ maxprice-hub setup
MaxPrice Hub 0.9.0 · data dir ~/.local/share/maxprice-hub (new)
1/4 claude.ai session key
    Paste the sessionKey cookie (hidden; Enter skips):
    Connected: 3 Organizations found.
    Stored in ~/.local/share/maxprice-hub/secrets.json (0600); the Hub reads it when it starts.
2/4 Hub password. Clients enter it once.
    Set one? [y/N] y
    New Hub password:
    Again:
    password set — the Hub applies it when it starts
3/4 Hub page URL: where your web server will publish it (Enter skips)
    > http://hub.example/MaxPrice
    Hub page URL set to http://hub.example/MaxPrice/; the end of setup checks it.
4/4 Install and start maxprice-hub.service? [Y/n]
    maxprice-hub.service updated: ~/.config/systemd/user/maxprice-hub.service
    maxprice-hub.service is enabled and started.
    active (pid 4182)

Hub page: not published: the snippet is not installed (404 from http://hub.example/MaxPrice/view)
Run these, then press Enter to check again (q finishes):
    sudo loginctl enable-linger dev
    sudo a2enmod proxy_http                      # pulls in proxy; first time only
    maxprice-hub page snippet | sudo tee /etc/apache2/conf-available/maxprice-hub.conf
    sudo a2enconf maxprice-hub
    sudo apache2ctl configtest
    sudo systemctl restart apache2               # after a2enmod; a reload for later snippet changes

Hub page: published at http://hub.example/MaxPrice/

Clients join http://100.101.102.103:47100 (password protected)
    Desktop client:  Settings › Usage hub
    Headless client: maxprice hub join http://100.101.102.103:47100 --password
```

Each step runs its command's own code, `key set`, `password set` or `password clear`, `page set` or `page clear`, and `service install`, and has that command's effect: setup adds only the questions around them, and takes no options. Each step prints its command's own lines, indented under it.

- **Each step commits on its own.** Enter skips or keeps the first three steps: a skipped key still makes a working Hub, since a client that joins with auto-heal on pushes its key. At step 4's `[Y/n]` prompt, Enter installs and starts the service; answer `n` to skip. A failed step says why under it and asks again, and a failed install asks `Try again? [y/N]`. The password defaults to none, and step 3 prints no snippet: the ending's lines install it.
- **Ctrl-C at any prompt**, or Ctrl-D on an empty visible one, stops setup with exit 130 and keeps every step it completed.
- **Run again,** the first three steps show what is set and keep it on Enter: `1/4 Session key: set 2026-10-25 14:02, local. Replace? [y/N]`, `2/4 Hub password: set. Keep, change or clear? [K/c/x]` and `3/4 Hub page URL: <url>  (Enter keeps, - clears)`. An installed unit reads `4/4 Service: maxprice-hub.service is installed` and is installed again with no question, `unchanged` unless its file changed, which restarts a running Hub. While a Hub runs, the key and password steps go through it and it applies each at once, as `key set` and `password set` do; step 3 edits `hub.json` beside it, as `page set` does.
- **No systemd user manager,** as in a container: step 4 prints `4/4 Service: no systemd user manager` and the line every `service` verb gives then, and the ending says to run `serve` under your own init ([Other inits](#other-inits)).
- **The ending** waits up to 10 s for the Hub when step 4 started the unit or `serve.lock` names a running Hub, reading the lock's record and never taking the lock. With a Hub page URL set it prints the page's reading, as `maxprice-hub page` reads it. Then come the sudo steps still missing: `sudo loginctl enable-linger <user>` while the unit is installed and linger is off, and, while the page is not published, the Apache lines `page` prints ([Publish the Hub page](#publish-the-hub-page)), all but its own check, which Enter makes. Enter checks again, and `q` finishes. After those checks it reaches the Hub again, within a fresh 10 s, before it prints how clients join, so a restart meanwhile gives the new address.
- **How clients join** is the first address the Hub binds that is not loopback, as the hub tray app's Popout shows it, with `--password` only when a Hub password is set. With loopback alone it says to set `bind` in `hub.json` and restart the Hub ([bind and port](#bind-and-port)).

Setup exits 0 once its steps ran, whether or not the page is published: `maxprice-hub page` is the later check. With no Hub running and none started, it says how to start `serve` under your own init, or, after an install that failed, to run `service install` again once fixed, and exits 0 too. [`maxprice-hub setup`](#maxprice-hub-setup) lists what it refuses and its exit codes.

### Without a terminal

Off a terminal setup refuses, exit 2, and lists the commands it walks. To script a setup, run them in its order, `service install` first, since its `serve` makes the `hub.json` the others refuse to run without:

```sh
maxprice-hub service install                  # starts serve, which makes the data dir and hub.json
maxprice-hub key set < key.txt
maxprice-hub password set < password.txt
maxprice-hub page set http://hub.example/MaxPrice
maxprice-hub page                             # should read "published" once the snippet is installed
```

Each reads its secret from all of stdin, trimmed; delete `key.txt` and `password.txt` afterwards, or pipe the values in from wherever you keep them. From the first line to the third the Hub runs on the tailnet without its key or its password, a window setup avoids by making `hub.json` first. A running Hub applies each change at once. Then run the steps setup's ending would list: `loginctl enable-linger` while linger is off, and the Apache lines `page` prints until it reads published. With no systemd user manager, start `serve` under your own init in place of `service install` ([Other inits](#other-inits)).

## Run it as a service

```sh
maxprice-hub service install
```

This writes a systemd user unit, `~/.config/systemd/user/maxprice-hub.service` (or the user manager's own config home, when it has another), then enables and starts it. The unit's `ExecStart` is the `maxprice-hub` that ran `install`, so run it from the binary the unit should run, and run it again after moving the binary.

A user unit runs while your user manager does, and by default that ends with your last login session. When linger is off, `install` says so and prints the step that keeps the manager running from boot, logged in or not:

```sh
loginctl enable-linger
```

If `loginctl` refuses, an administrator can enable it for you with `sudo loginctl enable-linger <user>`, the line `setup` lists among its sudo steps instead.

The unit `install` writes, for a user `dev`:

```ini
# Generated by `maxprice-hub service install`, which rewrites this file.
# Customize it with `systemctl --user edit maxprice-hub`.
[Unit]
Description=MaxPrice Headless Hub
StartLimitIntervalSec=15min
StartLimitBurst=5

[Service]
Type=exec
ExecStart=/home/dev/.local/bin/maxprice-hub serve
Restart=on-failure
RestartSec=10s
RestartPreventExitStatus=5

[Install]
WantedBy=default.target
```

- **Restarts.** A crash or a failed first bind (exit 1) restarts after 10 s. Once five starts fall within 15 minutes, systemd refuses the next and leaves the unit failed; it counts every start, hand restarts and `maxprice-hub update`'s included. Exit 5 never restarts: another `maxprice-hub` holds the data dir, and no relaunch fixes that. `maxprice-hub service install` clears a failed state.
- **Your shell's variables.** The user manager never sees them. When the installing shell sets `MAXPRICE_HUB_DATA_DIR`, `install` adds an `Environment=MAXPRICE_HUB_DATA_DIR=…` line after `ExecStart` and prints it; a relative value is made absolute against the current directory. It never bakes `XDG_DATA_HOME`, so when only that moves your data dir, set `MAXPRICE_HUB_DATA_DIR` before `install`. `maxprice-hub service status` flags a unit whose data dir is not your shell's, and `setup` refuses such a shell before it creates anything.
- **Customizing.** `install` puts the generated text back whenever the file differs from it, so a hand edit is lost, and it never touches the unit's drop-ins: put changes in one with `systemctl --user edit maxprice-hub`. When the file changed, `install` restarts a running Hub. The unit sets no `MemoryMax=` and no sandboxing, and no ordering against a Headless client's `maxprice.service` beside it: a client retries its Hub on its own.

Day to day, `systemctl --user start|stop|restart maxprice-hub` drives the unit, `maxprice-hub service status` describes it, `maxprice-hub service logs -f` follows its journal, and `maxprice-hub status` describes the Hub itself.

The unit needs a systemd user manager, which `systemctl --user` reaches. With none, as in a container or an SSH session with no `XDG_RUNTIME_DIR` or user bus, every `service` verb exits 1 and says so. Run `serve` under another init instead.

## Other inits

`maxprice-hub serve` runs under any supervisor that keeps a process in the foreground.

### A systemd system unit

A system unit runs the Hub for one user, with no user manager and no linger. Write `/etc/systemd/system/maxprice-hub-dev.service`, with `dev` replaced by that user's name:

```ini
[Unit]
Description=MaxPrice Headless Hub for dev
StartLimitIntervalSec=15min
StartLimitBurst=5

[Service]
Type=exec
User=dev
ExecStart=/home/dev/.local/bin/maxprice-hub serve
Restart=on-failure
RestartSec=10s
RestartPreventExitStatus=5

[Install]
WantedBy=multi-user.target
```

Name it `maxprice-hub-<user>.service`, never `maxprice-hub.service`: the Hub's commands count a `serve` whose cgroup ends in `/maxprice-hub.service` as the user unit's, so `maxprice-hub update` would print no restart line for it, and `status` would report it as running in the user unit. The name also lets several users run one each.

systemd sets `HOME` from `User=`, so the Hub keeps its files in that user's `~/.local/share/maxprice-hub`, the data dir that user's own commands reach. When that user's data dir is elsewhere, add `Environment=MAXPRICE_HUB_DATA_DIR=…` under `[Service]`, with an absolute path, since a system unit runs in `/`. It needs no ordering after the network: the Hub binds loopback at once and its tailnet addresses as they appear ([bind and port](#bind-and-port)). Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now maxprice-hub-dev
```

It differs from the user unit in five ways:

- `maxprice-hub service …` manages only the user unit. Use `sudo systemctl status|restart|stop maxprice-hub-dev`, and `sudo journalctl -u maxprice-hub-dev` for its logs.
- The hints a command prints name the user unit or a foreground `serve`: `maxprice-hub service logs` for a Hub that did not answer, `maxprice-hub service install` or `maxprice-hub serve` for one not running, and `restart its serve (pid N)` for one of another protocol. Read them as `sudo journalctl -u maxprice-hub-dev` and `sudo systemctl … maxprice-hub-dev`, and never follow the `service install` one (the next point).
- Never also install the user unit, with `maxprice-hub service install` or a yes at `setup`'s step 4 (answer `n`): the two would contend for one data dir, and the loser stops on exit 5.
- `maxprice-hub update`, run as that user from a shell whose data dir is the unit's, swaps the binary and prints `A 'maxprice-hub serve' (pid N) still runs 0.9.0: restart it to finish the update.` Restart it with `sudo systemctl restart maxprice-hub-dev`; until then `status`'s Update row ends `restart serve to finish the update`.
- Linger is not needed.

Run every `maxprice-hub` command as that user, from a shell whose data dir is the unit's: the commands reach the running Hub through its data dir's `operator-token`, which that user alone can read.

On a host where SELinux is enforcing, as RHEL and Rocky Linux ship, the system manager may be refused a binary under `/home` (`status=203/EXEC` in `systemctl status`). Then install the binary outside `/home`, such as `/usr/local/bin`, and point `ExecStart` there, or use the user unit, which is not affected.

### Any other supervisor

Give `serve` this contract:

| Exit | When                                                                                                               | The supervisor                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 0    | SIGTERM, SIGINT or SIGHUP stopped it cleanly                                                                       | Leaves it stopped                                                                                                           |
| 1    | A crash, a failed first bind, `flock` failing on `serve.lock`, or a data dir holding a restore that did not finish | Restarts it after a delay, within a bound: the generated unit waits 10 s, and gives up once 5 starts fall within 15 minutes |
| —    | Killed by a signal the supervisor did not send, such as the OOM killer's                                           | Restarts it, as after exit 1                                                                                                |
| 5    | Another `maxprice-hub` holds this data dir's `serve.lock`                                                          | Never restarts it                                                                                                           |

- Run it as the user whose data dir it serves, with that user's `HOME`, and with `MAXPRICE_HUB_DATA_DIR` or `XDG_DATA_HOME` when that user's commands set them.
- It stays in the foreground: it never daemonizes and writes no PID file for the supervisor. `serve.lock` records its pid and port for the Hub's own commands, and keeps them after it exits.
- Stop it with SIGTERM. SIGINT and SIGHUP do the same: once it has logged its boot lines, each runs its teardown, closing the fleet event archive, and exits 0. Before that, the signal's default action ends it.
- It logs to stdout and stderr. Keep both.
- One `serve` runs per data dir. A second one exits 5, half a second after it starts, and leaves the first running.
- Unlike the Headless client, it listens on TCP: on `port` (47100 by default), at the addresses `bind` names ([bind and port](#bind-and-port)), loopback always among them. It connects out over HTTPS to claude.ai once it has a key, to list the key's Organizations and poll their Usage limits once a minute, and to the update channel on GitHub at boot and every 6 hours.

## bind and port

Two keys in the data dir's `hub.json` say where the Hub listens, and neither `setup` nor any command sets them: `bind` and `port`. Edit them by hand, leaving the file's other keys as they are, then restart the Hub, `systemctl --user restart maxprice-hub` for the user unit: it reads them only when it starts.

```json
{
  "port": 47100,
  "bind": "tailnet"
}
```

- **`port`** is one TCP port, 1–65535, 47100 by default, on every address the Hub binds. Clients join on it, and the Hub page snippet proxies to it: after changing it, install the snippet again (`maxprice-hub page snippet | sudo tee …`, then reload the web server), or `maxprice-hub page` reads 502, and point every client at the new port.
- **`bind: "tailnet"`**, the default, binds `127.0.0.1` and this machine's Tailscale addresses: its IPv4 in `100.64.0.0/10` and its IPv6 in `fd7a:115c:a1e0::/48`, whichever it has. With neither, the Hub serves loopback alone and warns `No tailnet interface — the hub is serving loopback only. It will bind Tailscale automatically as soon as it connects.`
- **`bind: "loopback"`** binds `127.0.0.1` alone. Only this machine reaches the Hub then: its own clients, and the web server that publishes the Hub page. `status` reads `– Hub  Local only`, and setup's ending says no client can join.
- **An IP address** binds that address and `127.0.0.1`; `0.0.0.0` or `::` binds that wildcard alone, which covers loopback. An address the machine does not have yet serves loopback alone, `Waiting for <address> — the hub is serving loopback only until that address exists.`, until it appears. An address that is neither loopback nor a tailnet address binds with a warning: its traffic is unencrypted, protected only by the Hub password when one is set.
- **A hostname** goes to the operating system as written. It cannot be checked against the machine's addresses, so a bind of it that fails is retried rather than ending the Hub.

The bind is reconciled, not settled once at boot. Every 10 s the Hub compares the addresses it should bind with the machine's interfaces: it binds an address when it appears, logging `[hub] bound <address>:<port>`, and releases one after two checks in a row miss it. So a Hub that starts before Tailscale is up serves loopback for a few seconds, then binds the tailnet on its own, with no restart. A first bind refused at boot, such as a port another process holds, exits 1 with one line saying what holds it ([`maxprice-hub serve`](#maxprice-hub-serve)).

`maxprice-hub status` shows the outcome on its Hub row, with the bind's own warning, and its Daemon row names the port. `maxprice-hub page` checks the page through the web server, and setup's ending names the address clients join.

## The session key and the Hub password

### The session key

The Hub reads the Usage limits with a claude.ai session key: the `sessionKey` cookie of a browser signed in to claude.ai, a value starting `sk-ant-sid01-`. To copy it from a browser on another machine, sign in at claude.ai, open the developer tools, then Application (Chrome, Edge) or Storage (Firefox), Cookies, `https://claude.ai`, and copy the value of `sessionKey`. It is not Claude Code's OAuth token (`sk-ant-oat…`), which `key set` refuses; `maxprice-hub` never reads `~/.claude/.credentials.json`.

```sh
maxprice-hub key set
```

On a terminal `key set` asks for the key and shows nothing as it is typed or pasted; otherwise it reads all of stdin, as in `maxprice-hub key set < key.txt`. It first lists the key's Organizations with claude.ai and stores nothing when claude.ai refuses the key or cannot be reached; then it hands the key to the running Hub, which stores it and polls with it at once, or, with none running, writes it for the Hub's next start. `maxprice-hub key clear` removes it, and a running Hub stops polling at once. [`maxprice-hub key set|clear`](#maxprice-hub-key-setclear) has the details.

On Linux the Hub keeps the key in `secrets.json` in its data dir, mode 0600, and nowhere else: no keychain is used. The file holds the key with when and by whom it was set, `local` for the console or `key set`, or the id of the machine whose client pushed it. The key, a full-account credential, rests there in plaintext: root can read it, and so can anyone holding a backup of the data dir. `maxprice-hub status` shows whether a key is set, when and by whom, and never any part of it.

A Connected client re-keys a Hub whose key stopped working when its own key works: a Desktop client unless Settings turns auto-heal off, and a Headless client unless it joined with `--no-auto-heal`. A Hub with no key gets one from the first client that joins with auto-heal on.

### The Hub password

With no Hub password, the default, the Hub is open on the tailnet: every client may join, and `status`'s Access row reads `No password`. With one, a client joins only with it, entered once: in the Desktop client's Settings, or with `maxprice hub join <url> --password` on a Headless client.

```sh
maxprice-hub password set
```

A password is 1 to 128 printable ASCII characters with no spaces. On a terminal `password set` asks for it twice and shows nothing as it is typed; otherwise it reads all of stdin, as in `maxprice-hub password set < password.txt`. It is never an argument, since argv lands in shell history and `ps`. `hub.json` keeps its argon2id hash, never the password. `maxprice-hub password clear` opens the Hub again. A running Hub applies either at once.

The Hub's own commands never need the password: they reach a running Hub with the data dir's operator token ([How a command reaches a running Hub](#how-a-command-reaches-a-running-hub)). So a forgotten password locks nobody out for long: `password set` on the Hub's machine replaces it, and each client then enters the new one.

## Publish the Hub page

The [Hub page](#the-hub-page) is a read-only web page that mirrors the hub tray app's Popout: the Hub, claude.ai and Access rows and the count of Connected clients. The Hub serves it to loopback peers alone, at `http://127.0.0.1:<port>/page/`, and your own web server, on the same machine, publishes it by proxying one path there. The web server decides who may see it; the Hub password does not gate it. The Hub never writes web-server config: it runs as you and never holds sudo, so it prints the configuration and you install it.

Where your web server publishes the page is the Hub page URL, `pageUrl` in `hub.json`, which `maxprice-hub page set <url>` stores, or setup's step 3. It is not the address clients join, and it need not be public. The Hub checks the page by fetching it there itself, so `page` and setup can read it as published only where the URL's host resolves and answers from the Hub's own machine; the page itself is unaffected. None of the `page` commands needs the Hub stopped or restarted.

With no web server, open the page through an SSH tunnel from your own machine, `ssh -L 47100:127.0.0.1:47100 <host>`, then `http://127.0.0.1:47100/page/`. The local port may differ from the Hub's.

### Apache on Debian or Ubuntu

```sh
maxprice-hub page set http://hub.example/MaxPrice   # stores …/MaxPrice/, prints the snippet
sudo a2enmod proxy_http                      # pulls in proxy; first time only
maxprice-hub page snippet | sudo tee /etc/apache2/conf-available/maxprice-hub.conf
sudo a2enconf maxprice-hub
sudo apache2ctl configtest
sudo systemctl restart apache2               # after a2enmod; a reload for later snippet changes
maxprice-hub page                            # should read "published"
```

`maxprice-hub page` prints the last six of these lines while the Hub runs and the page is not published, and setup's ending lists the five between them among its sudo steps. For `http://hub.example/MaxPrice/` on the default port, the snippet reads:

```apache
# MaxPrice Hub page — generated by maxprice-hub 0.9.0 for http://hub.example/MaxPrice/
# Proxies to the Hub on 127.0.0.1:47100. Regenerate (maxprice-hub page snippet) after changing
# the Hub's port or page URL. Sets no headers: the Hub sends its own CSP and caching (ADR-0124).
# Needs mod_proxy_http.
RedirectMatch 301 ^/MaxPrice$ /MaxPrice/
<Location /MaxPrice/>
    ProxyPass        http://127.0.0.1:47100/page/
    ProxyPassReverse http://127.0.0.1:47100/page/
</Location>
```

- It proxies the URL's path, and only it, to the Hub's page on `hub.json`'s port. Apache does not redirect the bare path, `/MaxPrice`, to its slash form by itself, so the anchored `RedirectMatch` does; a root path, for a vhost of its own, needs none and reads `<Location />`.
- It has no `<IfModule>` guard, so with no proxy module loaded `apache2ctl configtest` fails on `ProxyPass`. With `mod_proxy` loaded but not `mod_proxy_http`, the test passes and the path answers 500, which `page` reports; `a2enmod proxy_http` enables both.
- It has no `Require`, `Header`, `ProxyPreserveHost` or timeout. Your server's own access policy decides who sees the page, and the Hub sends its own headers: never `Header always set` a `Content-Security-Policy` there, which would add a second policy beside the Hub's. Apache's default, `ProxyPreserveHost Off`, sends the Hub a loopback `Host`, which the page requires.
- `conf-available` with `a2enconf` is Debian's idiom, and applies to every vhost. The snippet is plain Apache configuration, so a server laid out otherwise can include the file where its own configuration includes such files.
- Nothing tracks an installed copy. `page set` prints the new snippet and calls any installed copy stale, every time. After a change of the URL's path or of the Hub's port, install it again.

To stop publishing the page: `maxprice-hub page clear`, then `sudo a2disconf maxprice-hub && sudo systemctl reload apache2`. The web server keeps publishing it until its snippet is removed.

### nginx

This example follows nginx's documentation and has never been run against a Hub. Inside the `server` block that serves `hub.example`, for the default port:

```nginx
location /MaxPrice/ {
    proxy_pass http://127.0.0.1:47100/page/;
}
location = /MaxPrice {
    return 301 /MaxPrice/;
}
```

- With a URI on `proxy_pass`, here `/page/`, nginx replaces the part of the request's URI that matched the location with it, so `/MaxPrice/view` reaches the Hub as `/page/view`.
- By default nginx sends `Host: $proxy_host`, the host and port `proxy_pass` names, `127.0.0.1:47100`, which is a loopback `Host` the page accepts, and adds no `X-Forwarded-*` header. So set no `proxy_set_header Host` and no `add_header`.
- nginx's documentation says that a prefix location ending in a slash, whose requests `proxy_pass` handles, already answers its bare form with a 301 to the slash form. The exact-match location makes that redirect explicit.

Store the URL with `maxprice-hub page set http://hub.example/MaxPrice` (its snippet is Apache's, so ignore it), then check the configuration, reload nginx and check the page:

```sh
sudo nginx -t
sudo systemctl reload nginx
maxprice-hub page                            # should read "published"
```

`page` still lists Apache's install lines until the page reads published.

### Any other web server

The contract, which `maxprice-hub page` prints as one line for the URL set:

- Proxy the URL's path, with its trailing slash, to `http://127.0.0.1:<port>/page/`, and nothing else: no path of the web server may reach the Hub's API.
- Send the Hub a loopback `Host`, such as `127.0.0.1:<port>`, rather than the visitor's: the page answers only `127.0.0.0/8` in dotted decimal, `[::1]` or `localhost`, each with or without a port, and gives anything else the same 404 as an unknown path. A forwarded header never stands in for it.
- Add no headers: the Hub sends its own `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy` and caching.
- Redirect the bare path to its slash form: the page's links are relative, and resolve only under the slash.

Tailscale Serve, and proxies that keep the visitor's `Host`, are untested.

## Updating

```sh
maxprice-hub update --check
maxprice-hub update
```

`update` reads the Headless Hub's own channel, `headless-hub-latest.json` on MaxPrice's update release, whose one entry, `linux-x86_64`, is `maxprice-hub_<version>_linux-x64.tar.gz`. It installs a release only when it is signed by MaxPrice's key, under its own version, newer than this `maxprice-hub`, and its binary runs here and prints that version. Anything else leaves this binary as it is. There is no prompt, no downgrade and no rollback: the previous release stays on its release page. It never runs sudo, so this user must be able to read, write and search the binary's directory, as it can `~/.local/bin`. It prints the change, `maxprice-hub 0.9.0 → 0.9.1 (~/.local/bin/maxprice-hub)`, then:

- A running `maxprice-hub.service` whose `ExecStart` is this binary is restarted with `systemctl --user restart maxprice-hub.service`, and `update` waits up to 30 s for the restarted Hub to report the new version on its `/page/view`, at the port the unit's data dir's `serve.lock` records: `Restarted maxprice-hub.service, which now runs 0.9.1.` A failed restart, or no answer in time, exits 1 naming `maxprice-hub service logs`; the binary is replaced either way.
- A unit that runs another binary is left running, and `update` says `'maxprice-hub service install' points it here.`
- With no unit running, a `maxprice-hub serve` on this shell's data dir, in a terminal, a [system unit](#a-systemd-system-unit) or another init, is left running, and `update` says to restart it to finish the update.
- Run as root, as for a shared `/usr/local/bin`, it restarts nothing: each user restarts their own unit with `systemctl --user restart maxprice-hub`, and a system unit is restarted with `sudo systemctl restart maxprice-hub-<user>`.

`update` is Linux only, `--check` included: the hub tray app updates itself, its Hub included, through its own updater. Run from source it refuses and names the build, and `--check` still works.

A Headless Hub's `serve` checks the channel itself, at boot and every 6 hours, and never installs anything. It writes what it found to `update-check.json` in the data dir and logs a newer version once: `[hub] maxprice-hub 0.9.1 is available (this is 0.9.0); run 'maxprice-hub update'`. There is no setting to turn the check off. `maxprice-hub status`'s Update row shows it: `! Update  0.9.1 available   → maxprice-hub update`, `✓ Update  current`, `– Update  not checked yet` just after a first boot, or `– Update  check failed: <why>`, which is not a fault, since an air-gapped server is not broken. The row compares the newest version with the `maxprice-hub` that runs `status`, so a stale file never announces what is already installed; and while the running Hub is another version than that binary, the row says how to finish the update: `! Update  the daemon runs 0.9.0, this maxprice-hub is 0.9.1   → systemctl --user restart maxprice-hub`, or, for a `serve` outside the unit, `…: restart serve to finish the update`.

The first release that ships the Headless Hub has nothing to update from: its channel starts with the second.

## Moving a fleet to another Hub

A fleet moves to another Hub by `maxprice-hub restore`: the old Hub's data, copied into a new Hub's empty data dir before its first start, under a fresh epoch. Bringing a Hub back from its own backup is the same procedure, on the same machine.

A backup is a copy of a stopped Hub's whole data dir, from any platform: a Windows tray Hub's (`%APPDATA%\maxprice-hub`, once the tray app has quit) restores onto a Headless Hub. Stop the Hub first, then copy, then start it again:

```sh
systemctl --user stop maxprice-hub
cp -a ~/.local/share/maxprice-hub /backups/maxprice-hub
systemctl --user start maxprice-hub
```

`restore` refuses a backup it can tell is still being written, but it cannot see a write-ahead log that a backup tool copied at another moment than the archive itself. So copy a stopped Hub's files, or take an SQLite online backup of its `events.sqlite`, which has no write-ahead log. The copy carries the key in `secrets.json`, in plaintext, which `restore` never copies.

Why a fresh epoch: a client knows a Hub's archive only by its epoch and by how far through its changes it has read, the Fleet change cursor. Under the old epoch, a client that comes back after other clients have pushed the restored Hub's cursor past its own would stall for good, its usage since the backup never reaching the Hub. Under a fresh one, every client sees a new archive, reseeds once and contributes its usage since the backup again, in any order.

**1. Pre-check each client of v0.9.0 or earlier.** Before the restored Hub starts, each such client's `fleet-forget.json` must be absent or hold `null`. A client newer than v0.9.0 needs no check: it completes a pending forget on the restored Hub at the same URL, and runs its Organization repair's Hub forgets there again. The file sits beside the client's Fleet replica:

| Client                  | Its directory                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------- |
| Desktop client, Linux   | `$XDG_DATA_HOME/com.maxprice.desktop`, by default `~/.local/share/com.maxprice.desktop` |
| Desktop client, macOS   | `~/Library/Application Support/com.maxprice.desktop`                                    |
| Desktop client, Windows | `%APPDATA%\com.maxprice.desktop`                                                        |
| Headless client         | its data dir, `$XDG_DATA_HOME/maxprice`, by default `~/.local/share/maxprice`           |

A file that holds anything else is a forget still pending on the old Hub, which records the Hub's URL and its epoch. On a client of v0.9.0 or earlier, at the same URL under a fresh epoch it would never complete, and meanwhile the usage it covers would stay barred from the Hub. So first point that client at the restored Hub under another URL, such as its tailnet address where it had the machine's name: there the forget is retargeted and completes, and the file reads `null` again. A newer client retargets it at the same URL, as it does under another.

Two copies to take now, from the same directory, if you want them: each client's `usage-history.jsonl`, for `--samples` in step 2, since the Hub's own samples since the backup come back only that way; and the `fleet-events.sqlite` of a client whose Fleet replica may hold the events of a machine that will never connect again, taken by the old Hub after the backup. The reseed in step 4 discards them, and no other copy exists.

**2. Restore into an empty data dir, before its first `serve`.** On the new Hub's machine, with nothing run there yet but the install (not `setup`, not `serve`, which make the `hub.json` that `restore` then refuses), and `MAXPRICE_HUB_DATA_DIR` set first if the data dir is not the default:

```sh
maxprice-hub restore /backups/maxprice-hub \
  --samples ~/from-client-a/usage-history.jsonl --samples ~/from-client-b/usage-history.jsonl
```

It copies `hub.json` and `events.sqlite`, which the backup must hold, and the `usage-history.jsonl`, the Machine directory, the Identity directory, the Organization directory, the Organization assertion directory and the Hub roster, `organization-roster.json`, when it holds them. It never copies `secrets.json`, `operator-token`, `serve.lock` or `update-check.json`, nor any other file: the key, the operator token, the lock and the update record belong to the Hub that wrote them. It only reads the backup, writes every file 0600 into a 0700 data dir, and gives the archive a fresh epoch, always. `--samples` merges each client's samples into the restored history. It prints what it restored, then the next steps:

```
Restored the Hub at /backups/maxprice-hub into ~/.local/share/maxprice-hub.
  events.sqlite: 48,213 events, Fleet change cursor 9,876, Deletion generation 2
  epoch: 1b9d4c2e-6f0a-4d7b-9a3e-5c8f2e1d0b7a, fresh (the backup's was 7e3a9f10-2b4c-4e8d-a6f1-0c9d8b7a5e43)
  machines: 3 in the Machine directory
  usage history: 52,104 samples, the latest at 2026-10-24T09:12:00.000Z; --samples added 318 from 2 file(s), the latest at 2026-10-24T14:40:00.000Z
  hub.json: bind tailnet, port 47100, password set
  copied: machine-directory.json, identity-directory.json, organization-directory.json, organization-assertion-directory.json, organization-roster.json, usage-history.jsonl, events.sqlite, hub.json
  not copied: hub.json.lock, secrets.json, serve.lock, update-check.json
Next steps:
  1. Before it starts, check every client of v0.9.0 or earlier: its fleet-forget.json
     must be absent or null. One whose file holds a forget intent first reaches this Hub
     under another URL. A newer client needs no check.
  2. Give it the session key: maxprice-hub key set, or maxprice-hub setup.
  3. Start it: maxprice-hub service install, or maxprice-hub serve.
  4. Redo by hand any operator edit made after the backup: a rename, a merge, a purge
     or a password change.
Every client then reseeds once and re-contributes its usage since the backup, in any order.
```

It refuses a data dir that already holds any of a Hub's files, a backup still running or written while it is copied, and a backup that is no Hub's, such as a client's Fleet replica; [`maxprice-hub restore`](#maxprice-hub-restore) lists every refusal and what a restore cut short leaves behind.

**3. Set the key, then start the Hub.** `maxprice-hub key set`, or `maxprice-hub setup`, whose steps then read the restored password and Hub page URL as set and keep them on Enter. Then `maxprice-hub service install`, or `maxprice-hub serve` under your own init. Setup never changes `bind` or `port`.

**4. The clients come back.** The restored `hub.json` keeps its `port` and `bind`, so a Hub restored on the machine that served the fleet answers at the URL every client already has. Each client reconnects on its own, meets the fresh epoch, reseeds its Fleet replica once from the Hub's archive, one full download, keeping its reports meanwhile, then contributes its own usage since the backup again. Order does not matter. Each client also publishes its Home organization, its identity rows and its Organization assertions again on connect, and each Organization label comes back from any client that adopted it. A machine the backup does not know registers on its first contact, under its hostname.

**5. Redo by hand any operator edit made after the backup.** The restored Hub is the backup's, so these are undone: machine renames, merges and purges (redo a purge with `purge-machine`), and a password change (`password set`). Forgets made after the backup are undone too: a client's Forget can be repeated from its Storage settings. The Organization repair's forgets made on the old Hub after the backup are not redone at an unchanged URL. The Hub's own samples since the backup come back only through `--samples`.

What a restore cannot bring back is whatever happened only on the old Hub after the backup: the deletions and edits above, the samples no client still holds, and the events a machine that never reconnects sent it after the backup, which survive only in other clients' Fleet replicas until they reseed.

A Hub restored on another machine answers at another URL, so re-point every client: the Desktop client in its Settings, the Headless client with `maxprice hub join <url>` (`--password` when the Hub has one). The rest goes the same way. At the new URL a pending forget is retargeted and completes, and the Organization repair's forgets run again, which changes nothing that is already gone.

## The data dir

The data dir is `MAXPRICE_HUB_DATA_DIR` when it is set. Otherwise it is `$XDG_DATA_HOME/maxprice-hub`, or `~/.local/share/maxprice-hub` when `XDG_DATA_HOME` is unset or not absolute. The Hub and every command compute it the same way, so a shell with another `MAXPRICE_HUB_DATA_DIR` or `XDG_DATA_HOME` reaches another Hub; `maxprice-hub service status` flags a unit whose data dir is not the shell's. A relative `MAXPRICE_HUB_DATA_DIR` is read against the working directory. On Windows, for the hub tray app, it is `%APPDATA%\maxprice-hub`; on macOS, where no Hub ships, `~/Library/Application Support/maxprice-hub`.

Only `serve`, `setup` and `restore` make a data dir and its `hub.json`. The commands that act on a Hub refuse a data dir with no `hub.json`, `no Hub at <dir>; set MAXPRICE_HUB_DATA_DIR`, exit 2, so a mistyped data dir never becomes a fresh, empty Hub. On Linux each of the three makes it 0700, or tightens one that group or others can reach, and says so, so only this user can open the files in it. Keep it on a local filesystem: its locks and its SQLite files are unsupported on a network filesystem.

| File                                    | What it holds                                                                                                                                                                                                                                                                 | Mode  | `restore` copies it                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------- |
| `hub.json`                              | The config: `port`, `bind`, `passwordHash` (the Hub password's argon2id hash, `null` with none) and `pageUrl` (the Hub page URL, absent or `null` with none). Made by `serve`, `setup` or `restore`, normalized at each boot, and rewritten by the password and page commands | 0600  | Yes, and requires it                    |
| `hub.json.lock`                         | An empty SQLite file every writer of `hub.json` locks for its read-modify-write; it holds no config and no secret                                                                                                                                                             | umask | No                                      |
| `events.sqlite`, with `-wal`            | The fleet event archive: every Fleet event the clients pushed, its epoch, its Fleet change cursor and its Deletion generation. Its write-ahead log exists while the Hub runs                                                                                                  | umask | Yes, and requires it; its WAL folded in |
| `usage-history.jsonl`                   | The Usage history: every Usage sample the Hub polled or a client pushed up                                                                                                                                                                                                    | umask | Yes, with `--samples` merged in         |
| `machine-directory.json`                | The Machine directory: each machine's id, name, registration and merge                                                                                                                                                                                                        | umask | Yes                                     |
| `identity-directory.json`               | The Identity directory, which folds a project's checkouts across machines                                                                                                                                                                                                     | umask | Yes                                     |
| `organization-directory.json`           | The Organization directory: the fleet's Organization labels                                                                                                                                                                                                                   | umask | Yes                                     |
| `organization-assertion-directory.json` | The Organization assertion directory                                                                                                                                                                                                                                          | umask | Yes                                     |
| `organization-roster.json`              | The Hub roster: the Organizations the Hub's key last listed, which it polls                                                                                                                                                                                                   | umask | Yes                                     |
| `secrets.json`                          | The claude.ai session key, with when and by whom it was set; there is no file while no key is stored                                                                                                                                                                          | 0600  | No                                      |
| `operator-token`                        | A running Hub's operator token, written just before its first bind and deleted when it stops                                                                                                                                                                                  | 0600  | No                                      |
| `serve.lock`                            | The lock that keeps one Hub per data dir, with the pid of the last process that took it and, for a `serve`, its port                                                                                                                                                          | 0600  | No                                      |
| `update-check.json`                     | `serve`'s last check of the update channel, `{checkedAt, current, latest, error}`, which `status` shows                                                                                                                                                                       | 0600  | No                                      |
| `.restore-staging`                      | A restore's working dir (0700). Present only while `restore` runs, or after one cut short once it placed a file, which `serve`, `setup` and `restore` then refuse                                                                                                             | 0700  | —                                       |

A file marked umask has the mode the umask gives a new file; `restore` writes every file it places 0600. A first boot with no key and no client writes `hub.json`, `hub.json.lock`, `serve.lock`, `operator-token`, `events.sqlite` and its WAL, and `update-check.json` once its first check is done. The others appear with what they hold.

A few more names can appear beside them. A directory or roster file the Hub cannot read at boot is kept as `<name>.bak`, and that part starts empty, or for the Identity directory stays off for that run. A `hub.json` that is not JSON or holds a `passwordHash` of the wrong type is kept as `hub.json.bak` (0600), and the Hub comes up with the defaults, open, and says so loudly: restore the hash from the copy, then restart. Most files are written through a temporary file beside them, renamed into place, so a writer killed in between can leave one, such as `hub.json.<pid>.tmp`; it is safe to delete while no `maxprice-hub` runs.

To read the data dir's files by hand, stop the Hub first or read copies: the archive is held open exclusively while the Hub runs.

## Uninstalling

```sh
maxprice-hub service uninstall
rm ~/.local/bin/maxprice-hub
```

`service uninstall` stops and disables the unit and removes its file. It keeps the data dir with its `secrets.json`, the unit's drop-ins in the `maxprice-hub.service.d` dir it names (`~/.config/systemd/user/maxprice-hub.service.d` by default), and linger. Stop any `maxprice-hub serve` running outside the unit, then remove those too if you want them gone: that `.d` dir, `loginctl disable-linger` when nothing else of yours needs it, and the web server's snippet:

```sh
sudo a2disconf maxprice-hub
sudo systemctl reload apache2
sudo rm /etc/apache2/conf-available/maxprice-hub.conf
```

Deleting the data dir deletes the Hub: its archive of every machine's Fleet events, its Usage history, its directories and its session key. The clients keep their own Usage histories, and their Fleet replicas are disposable copies that a new Hub replaces. To keep the Hub for a later [restore](#moving-a-fleet-to-another-hub), copy the stopped Hub's data dir first. Like the Hub, this recipe takes `MAXPRICE_HUB_DATA_DIR` when it is set and ignores an unset, empty or relative `XDG_DATA_HOME`. It requires `realpath` with `-m -s` support (GNU coreutils or a compatible implementation), which normalizes `.` and `..` lexically without following symlinks, as the Hub reads the path; the deletion runs only if that succeeds:

```sh
if [ -n "${MAXPRICE_HUB_DATA_DIR:-}" ]; then
  data_dir="$MAXPRICE_HUB_DATA_DIR"
else
  case "${XDG_DATA_HOME:-}" in
    /*) data_dir="$XDG_DATA_HOME/maxprice-hub" ;;
    *) data_dir="$HOME/.local/share/maxprice-hub" ;;
  esac
fi
data_dir=$(realpath -m -s -- "$data_dir") &&
  rm -r -- "$data_dir"
```

For a system unit, in place of `service uninstall`:

```sh
sudo systemctl disable --now maxprice-hub-dev
sudo rm /etc/systemd/system/maxprice-hub-dev.service
sudo systemctl daemon-reload
```

## Troubleshooting

Start with `maxprice-hub status`: the Hub, claude.ai and Access rows and the connected clients, as the hub tray app's Popout shows them, then the key, the version, Update, the data dir and the daemon. Each row that has a fix names its command. `maxprice-hub service status` describes the unit instead.

| What you see                                                                                                   | What to do                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxprice-hub is not running for ~/.local/share/maxprice-hub` (exit 3)                                         | Run the hint it prints: `systemctl --user start maxprice-hub` and `maxprice-hub service logs` once the unit is installed, else `maxprice-hub service install` or `maxprice-hub serve`. A shell with another `MAXPRICE_HUB_DATA_DIR` or `XDG_DATA_HOME` asks another data dir |
| `no Hub at ~/.local/share/maxprice-hub; set MAXPRICE_HUB_DATA_DIR` (exit 2)                                    | That data dir holds no `hub.json`: point `MAXPRICE_HUB_DATA_DIR` at the Hub's data dir, or make one with `maxprice-hub setup`                                                                                                                                                |
| `maxprice-hub is already running for … (pid …)`: `serve` exits 5                                               | Another `maxprice-hub`, a Hub or a command editing its files, holds this data dir; use that Hub, or stop it first                                                                                                                                                            |
| `[hub] cannot bind …: … (EADDRINUSE)`: `serve` exits 1                                                         | The line says whether a Hub already answers `/healthz` on that port or something else holds it, with its pid when `/proc` shows one; stop it, or give this Hub another `port` in `hub.json` ([bind and port](#bind-and-port))                                                |
| `the running Hub speaks another Hub protocol: restart maxprice-hub.service to finish the update` (exit 4)      | The binary changed under a running Hub: `systemctl --user restart maxprice-hub`, or restart the `serve` whose pid the line names                                                                                                                                             |
| Every `service` verb exits 1: `no systemd user manager here (systemctl --user failed: …)`                      | Run `maxprice-hub serve` under another init; see [Other inits](#other-inits)                                                                                                                                                                                                 |
| The unit failed, or stops when you log out                                                                     | `maxprice-hub service logs -n 100` says why; `maxprice-hub service install` clears a failed state, and `loginctl enable-linger` keeps it running after logout                                                                                                                |
| `setup needs a terminal; without one, run its steps as commands, in this order:` (exit 2)                      | Run `setup` on a terminal (`ssh -t`), or the commands it lists, as in [Without a terminal](#without-a-terminal)                                                                                                                                                              |
| `maxprice-hub.service would serve …, not this shell's …: the unit never sees XDG_DATA_HOME` (exit 2)           | Set `MAXPRICE_HUB_DATA_DIR` to this shell's data dir, then run `setup` again                                                                                                                                                                                                 |
| `that is a Claude Code OAuth token, not a claude.ai session key` (exit 1)                                      | Give the `sessionKey` cookie, `sk-ant-sid01-…`, from a browser signed in to claude.ai ([The session key](#the-session-key))                                                                                                                                                  |
| `That session key looks invalid or expired.` (exit 1)                                                          | Copy a fresh `sessionKey` from a signed-in browser, then run `maxprice-hub key set` again                                                                                                                                                                                    |
| `status`'s claude.ai row reads `No key` or `Key expired`                                                       | Run the command it names, `maxprice-hub key set`. Just after the Hub starts with a key, `No key` lasts only until claude.ai answers its first poll                                                                                                                           |
| `status`'s claude.ai row reads `Poll failing`                                                                  | The key is set, but no poll has read an Organization's limits: check that this machine reaches claude.ai                                                                                                                                                                     |
| `The Hub listens on loopback only, so no client can join it.` (setup), or the Hub row reads `Local only`       | Under the default `bind`, bring Tailscale up, and the Hub binds it as it connects; otherwise set `bind` in `hub.json` and restart the Hub                                                                                                                                    |
| `page` reads `the snippet is not installed (404 from …)` (exit 1)                                              | Install the snippet with the steps `page` prints under it, then run `maxprice-hub page` again                                                                                                                                                                                |
| `page` reads `the web server cannot reach the Hub (502 from …)`, or 503 (exit 1)                               | If the Hub's port changed, the installed snippet names the old one: install a fresh one from `maxprice-hub page snippet` and reload the web server                                                                                                                           |
| `page` reads `the web server refused this machine (403 from …)` (exit 1)                                       | Your web server's access policy turns away the Hub's own machine, which `page` asks from; admit it                                                                                                                                                                           |
| `page` reads `Hub not running: …` (exit 1)                                                                     | Start the Hub, then run `maxprice-hub page` again                                                                                                                                                                                                                            |
| `… holds a restore that did not finish (.restore-staging); move the data dir aside and restore again` (exit 1) | A restore was killed while it placed its files, and `serve`, `setup` and `restore` refuse the data dir: move it aside and restore again into an empty one                                                                                                                    |
| `… already holds …; restore writes only into a data dir that holds none of a Hub's files` (exit 2)             | Something made the data dir before the restore: move it aside, or restore into another `MAXPRICE_HUB_DATA_DIR`                                                                                                                                                               |

## Platform floor

`maxprice-hub` is built by Bun for linux-x64 and links against glibc. In each image below, the binary from the tarball ran as a new user other than root, with no network: `maxprice-hub --version`, then `maxprice-hub serve` from a fresh data dir on a loopback bind with no key, then `maxprice-hub status` and `status --json` against that Hub, `maxprice-hub page`, and SIGTERM, which stopped `serve` with exit 0. The floor, the oldest glibc where all three pass, is **glibc 2.28** (Rocky Linux 8). No older glibc was tried.

| Image          | glibc       | `--version`                       | `serve`                    | `status` |
| -------------- | ----------- | --------------------------------- | -------------------------- | -------- |
| `ubuntu:20.04` | 2.31        | exit 0                            | listening; SIGTERM exits 0 | exit 0   |
| `ubuntu:22.04` | 2.35        | exit 0                            | listening; SIGTERM exits 0 | exit 0   |
| `ubuntu:24.04` | 2.39        | exit 0                            | listening; SIGTERM exits 0 | exit 0   |
| `debian:11`    | 2.31        | exit 0                            | listening; SIGTERM exits 0 | exit 0   |
| `debian:12`    | 2.36        | exit 0                            | listening; SIGTERM exits 0 | exit 0   |
| `rockylinux:8` | 2.28        | exit 0                            | listening; SIGTERM exits 0 | exit 0   |
| `rockylinux:9` | 2.34        | exit 0                            | listening; SIGTERM exits 0 | exit 0   |
| `alpine`       | none (musl) | exit 127: the shell's `not found` | not run                    | not run  |

- **musl and arm64.** There is no musl or arm64 build: the tarball is x86-64 and needs glibc's loader, which Alpine lacks, so its shell reports `not found`.
- **No runtime check.** Older glibc versions are untested. A missing loader or required symbol prevents `maxprice-hub` from starting; the shell or loader reports the failure.

## Commands

Every command takes `-h` or `--help`, and `maxprice-hub help <command>` prints the same text. With no command, `maxprice-hub` runs `serve`: that is how the hub tray app spawns it. Every command exits 0 when it succeeds; each section's table lists its other codes, and [Exit codes](#exit-codes) lists them all. Errors go to stderr, one line with any hints indented under it, and every line that carries outside text, a machine's name or a path, prints control characters as escapes.

`rename`, `merge`, `purge-machine`, `compact`, `password` and `key` act on the Hub at the data dir. On Linux, while a Hub runs there, they go through its own routes, as its console does, and it applies each change at once, with no restart; with none running, they edit the data dir's files under its lock ([How a command reaches a running Hub](#how-a-command-reaches-a-running-hub)). Machine ids are in the data dir's `machine-directory.json`, each entry's `machineId` beside its `name`; a client's own is the `machine-id` file in its data dir.

### `maxprice-hub serve`

`maxprice-hub serve`, or `maxprice-hub` alone: run the Hub in the foreground, the claude.ai usage poller, the fleet event archive, and the API its clients, its console and its Hub page read. It takes no options. [Run it as a service](#run-it-as-a-service) and [Other inits](#other-inits) run it for you.

- It makes the data dir and its `hub.json` when they are missing, with the defaults: `bind` `tailnet`, `port` 47100, no password. On Linux it makes the dir 0700 or tightens a looser one, logging either, and holds a lock on `serve.lock` for its whole life, recording its pid and then its port, so one Hub runs per data dir. A lock another process holds it asks again for, every 25 ms for 500 ms, before it reads `hub.json` or binds anything, so a hold that brief, such as `status` asking the lock, is waited out. Held past that, it exits 5: `maxprice-hub is already running for ~/.local/share/maxprice-hub (pid 4182, maxprice-hub.service)`.
- It refuses a data dir holding `.restore-staging`, the mark of a restore cut short: `<dir> holds a restore that did not finish (.restore-staging); move the data dir aside and restore again`.
- It binds what `bind` and `port` say, reconciled every 10 s ([bind and port](#bind-and-port)). A port in use at boot exits 1 with one line saying whether a Hub answers `/healthz` there or something else holds it, with the holder's pid and command when `/proc` shows them (another user's process shows neither): `[hub] cannot bind 127.0.0.1:47100: something that is not a Hub holds it (pid 977, nginx) (EADDRINUSE)`.
- On Linux it writes the data dir's `operator-token` just before its first bind, and deletes it when it stops; it never prints it.
- It reads `secrets.json` once, at boot. It tightens one that group or others can reach to 0600, and skips one that is unreadable, owned by another user or invalid, with one line each; it boots keyless rather than exit. A change made by hand under a running Hub is not seen until its next start, and the next key pushed overwrites it.
- On Linux it checks the update channel at boot and every 6 hours, writes `update-check.json` (0600), and logs a newer version once ([Updating](#updating)). It never installs anything.
- It logs to stdout and stderr; under systemd both go to the journal, and there is no log file. It prints no `LISTENING <port>` or `OPERATOR_TOKEN` line: those are the tray app's handshake with its embedded Hub.
- SIGTERM, SIGINT and SIGHUP stop it cleanly, with exit 0, closing the archive, so closing a foreground `serve`'s terminal runs the same teardown as SIGTERM.

A boot, here with a tailnet, a published page, a password and a key:

```
[hub] listening on http://127.0.0.1:47100
[hub] listening on http://100.101.102.103:47100
[hub] listening on http://[fd7a:115c:a1e0::1234:5678]:47100
[hub] Hub page: http://127.0.0.1:47100/page/ (loopback only), published at http://hub.example/MaxPrice/
[hub] password protected
[hub] data dir: /home/dev/.local/share/maxprice-hub
[hub] session key: from /home/dev/.local/share/maxprice-hub/secrets.json, set 2026-10-25T14:02:11.000Z by local
```

With no password the password line reads ``[hub] no password set — open on the tailnet (set one from the console or `maxprice-hub password set`)``, and with no key the last reads `[hub] session key: none in <path>`. The `published at` half is the Hub page URL as read at boot: a later `page set` leaves it stale until the next start. A build that embeds no page files, such as a run from source, warns that `/page/` answers 404 and names the linux-x64 build.

| Exit | Meaning                                                                                                                                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | A crash, `flock` failing on `serve.lock`, a data dir holding a restore that did not finish (`.restore-staging`), or a failed first bind; for an address in use, that line says whether a Hub already answers `/healthz` there or something else holds it, with the holder's pid and command when `/proc` shows them |
| 2    | An option or an argument: `serve` takes none                                                                                                                                                                                                                                                                        |
| 5    | Another `maxprice-hub` held this data dir's `serve.lock` for all of 500 ms, asked every 25 ms                                                                                                                                                                                                                       |

### `maxprice-hub setup`

`maxprice-hub setup`: walk the Hub's setup on a terminal, in four steps, the session key, the Hub password, the Hub page URL and `maxprice-hub.service`, then list the sudo steps still missing and how clients join ([First run: setup](#first-run-setup)). It takes no options. Linux only: the hub tray app sets itself up.

Before it creates anything, it refuses, exit 2, in this order: any argument or option, never quoted, since a key or a password pasted after `setup` would be one; any platform but Linux; root, `run setup as the user the Hub runs as, not as root`; a stdin that is not a terminal, listing the commands to run in its place ([Without a terminal](#without-a-terminal)); and, with a systemd user manager, a data dir the unit does not serve. That is an installed `maxprice-hub.service` that serves another data dir than this shell's, or a shell from which the unit would serve another once installed: the unit never sees `XDG_DATA_HOME`, so where that alone moves the data dir, set `MAXPRICE_HUB_DATA_DIR` and run setup again. Each refusal names both dirs and the fix.

It then makes the data dir (0700, or tightens a looser one) and its `hub.json`, as `serve` does, holding `serve.lock` only while it does, and refuses a data dir holding `.restore-staging`, exit 1. Its first line names the version and the data dir, with `(new)` when setup wrote the first `hub.json`. No prompt is ever answered with the lock held: each step takes it only inside its command.

| Exit | Meaning                                                                                                                                                                                                                                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | The Hub did not answer within 10 s, at the start or at the end (`maxprice-hub service logs` says why when the unit runs it), refused the operator token or its status probe, sent an answer this `maxprice-hub` cannot read, or stopped while it waited; `flock` failed on `serve.lock`, or the data dir holds a restore that did not finish (`.restore-staging`) |
| 2    | An argument or option, not Linux, root, stdin not a terminal, or a `maxprice-hub.service` that serves, or once installed from this shell would serve, another data dir than this shell's                                                                                                                                                                          |
| 4    | On Linux, the running Hub speaks another Hub protocol: restart it to finish the update                                                                                                                                                                                                                                                                            |
| 130  | Ctrl-C at a prompt, or Ctrl-D on an empty visible one; every step completed before it is kept                                                                                                                                                                                                                                                                     |

### `maxprice-hub status`

`maxprice-hub status [--json]`: describe the Hub running on the data dir as the hub tray app's Popout describes its own, Linux only. The Hub, claude.ai and Access rows and the count of Connected clients come first; then the session key (set or not, when and by whom, never any part of it), the Hub's version, Update, the data dir, and the pid and port `serve.lock` records. A row that has a fix names its command:

```
✓ Hub        Online
✓ claude.ai  Connected
! Access     No password   → maxprice-hub password set
             2 connected clients
  Key        Key set 5m ago locally
  Version    0.9.0
✓ Update     current
  Data dir   ~/.local/share/maxprice-hub
  Daemon     pid 4182, maxprice-hub.service · 127.0.0.1:47100
```

Each line is marked `✓` ok, `!` warn, `✗` bad or `–` off. The Hub row reads `– Hub  Local only` for a deliberate `bind: "loopback"`, `! Hub  Local only` with the bind's own warning for a bind waiting for its address, and `! Hub  Event sync down` when the fleet event archive did not load on a Hub bound beyond loopback, naming `maxprice-hub service logs` when the Hub runs in its unit. claude.ai reads `No key` or `Key expired`, each naming `maxprice-hub key set`, or `Poll failing`. The Key row reads, for example, `Key set 1h ago, healed by <machine id>` for a key a client pushed, or `No key set`. Update is described under [Updating](#updating). Once the Hub answers, `status` exits 0, whatever the rows say.

It reaches the Hub as the other commands do ([How a command reaches a running Hub](#how-a-command-reaches-a-running-hub)), then asks for its Hub page data, which carries the rows. A Hub that recorded its port in `serve.lock` and itself sends no whole answer, its status probe unanswered, refused or unreachable all the reach's 10 s, or its page data timed out, refused, reset or cut short within its own 10 s, prints `✗ Hub  Not responding` with the rows that read it dimmed to `—`, never what its status said before, then the request's own line, and exits 1:

```
✗ Hub        Not responding
– claude.ai  —
– Access     —
             — connected clients
  Key        —
  Version    —
✓ Update     current
  Data dir   ~/.local/share/maxprice-hub
  Daemon     pid 4182, maxprice-hub.service · 127.0.0.1:47100
the running Hub on 127.0.0.1:47100 did not answer GET /page/view within 10 s; nothing was changed
  Why:  maxprice-hub service logs
```

These print their line alone, with no rows, and exit 1: a lock with a pid alone all that time (a `serve` still starting, or another command at work); an `operator-token` missing, empty, unreadable or replaced as the wait ran out; page data that came back with an error; and a `serve.lock` record no Hub writes, such as pid 0. With no Hub running it exits 3 and says how to start one, by whether the user unit is installed:

```
maxprice-hub is not running for ~/.local/share/maxprice-hub
  Start it:        systemctl --user start maxprice-hub
  Why it stopped:  maxprice-hub service logs
```

or `Install it as a service:  maxprice-hub service install` and `Or run it in a terminal:  maxprice-hub serve`.

`status` changes no file. It asks `serve.lock` through a read-only descriptor it never creates, for a shared lock it lets go at once: free, or no file at all, is no Hub running, whatever pid the record names. A holder that lets go before the command saw its port gives exit 3; once a port was seen, a lock found free is a Hub that stopped while it waited, exit 1 with `run it again`, and a fresh run then exits 3. While the lock is free it holds it for that instant; a `serve` whose own take lands then waits it out, since `serve` asks again for 500 ms. Only a `status` stopped or stalled past that half second, holding the lock, makes a starting `serve` exit 5.

`--json` prints one object instead: the Hub page's data, the Hub row's `state` (`online`, `local-only` or `events-down`), the `key` (`present`, `updatedAt`, `source`), and the `dataDir`, `pid`, `port` and `inUnit`, whether the pid runs in `maxprice-hub.service`. For a Hub that recorded its port and did not answer it is `{service, state: "not-responding", dataDir, pid, port, inUnit}`, before the same exit 1. `dataDir` is always absolute, even for a relative `MAXPRICE_HUB_DATA_DIR`. It carries no Update and reads no `update-check.json`. Not running prints nothing on stdout. `maxprice-hub service status` describes the systemd unit instead.

| Exit | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | The running Hub sent no whole answer within 10 s, to its status probe or its page view, or was lost (`status` prints its Not responding rows first; see `maxprice-hub service logs`); `serve.lock` held a pid alone all that time (a `serve` still starting, or another command at work: no rows); the Hub refused the operator token, its status probe or its page view, sent an answer this `maxprice-hub` cannot read, or stopped while it waited; `serve.lock` records a pid or port no Hub writes; or `flock` failed on `serve.lock` |
| 2    | A bad option or an argument, not Linux, or no Hub at the data dir                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3    | No Hub runs on the data dir                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 4    | On Linux, the running Hub speaks another Hub protocol: restart it to finish the update                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### `maxprice-hub password set|clear`

`maxprice-hub password set` and `maxprice-hub password clear`: set or clear the Hub password ([The Hub password](#the-hub-password)), which `hub.json` keeps as an argon2id hash, never as the password.

- `set` checks the data dir first, so a mistyped one costs no typing. On a terminal it asks `New Hub password:` and then `Again:`, showing nothing as it is typed; the rule, 1 to 128 printable ASCII characters with no spaces, is checked after the first entry, so an invalid password is never typed twice, and entries that differ exit 1 with nothing written. Off a terminal it reads all of stdin once, trimmed. The password is never an argument: one given there is refused without being quoted. Ctrl-C at a prompt exits 130, having written nothing.
- `clear` reads nothing: the Hub is open again.
- Either reaches the Hub only once the password is read, so no prompt holds `serve.lock`. On Linux a running Hub is sent the change and applies it at once: `password set — the running Hub applies it at once`. With none running it rewrites `hub.json` under the lock: `password set — the Hub applies it when it starts`. Elsewhere it rewrites `hub.json` without checking for a running Hub, which applies it only once it restarts: `password set — restart the hub daemon to apply`.

Clients send the password as `Authorization: Bearer <password>`; with none set, every request passes and any credential a client still sends is ignored. The Desktop client keeps it in the OS keychain, and the Headless client in its `secrets.json`. The hub tray app's console sets it from its Access card, and needs none itself.

| Exit | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | The two entries did not match, `flock` failed on `serve.lock`, or `hub.json` cannot be written; on Linux, a running Hub did not answer within 10 s (see `maxprice-hub service logs`), `serve.lock` held a pid alone all that time (a `serve` still starting, or another command at work), or the Hub refused the operator token, its status probe or the change, sent an answer this `maxprice-hub` cannot read, stopped while it waited, or was lost |
| 2    | A bad command or option, a password given as an argument, no Hub at the data dir, or no password or an invalid one                                                                                                                                                                                                                                                                                                                                    |
| 4    | On Linux, the running Hub speaks another Hub protocol: restart it to finish the update                                                                                                                                                                                                                                                                                                                                                                |
| 130  | `set`: Ctrl-C at a prompt; nothing is written                                                                                                                                                                                                                                                                                                                                                                                                         |

### `maxprice-hub key set|clear`

`maxprice-hub key set` and `maxprice-hub key clear`: store or remove the claude.ai session key the Hub polls the Usage limits with ([The session key](#the-session-key)). The Hub keeps it in `secrets.json` in the data dir, readable by this user alone (0600). Linux only: elsewhere `key set` and `key clear` exit 2, `Linux only; re-key from the console`, since the Hub keeps the key in the keychain there and its console sets it.

- `set` checks the data dir first, then reads the key: on a terminal at a hidden prompt, `Session key:`, otherwise all of stdin, trimmed. It is never an argument. An `sk-ant-oat…` value exits 1 without calling claude.ai. Then it lists the key's Organizations with claude.ai: a key claude.ai refuses gives `That session key looks invalid or expired.`, and one it cannot list `Couldn't reach Anthropic — check your connection and try again.`, each exit 1, storing nothing. Only then does it reach the Hub, so neither the prompt nor the listing holds `serve.lock`. A running Hub is sent the key, stores it and polls with it at once: stderr reads `Stored in <path> (0600).` With none running the command writes `secrets.json` itself, recorded as set `local`: `Stored in <path> (0600); the Hub reads it when it starts.` Either way stdout reads `Connected: 3 Organizations found.` Ctrl-C at the prompt exits 130, storing nothing.
- `clear` checks nothing. A running Hub is sent the clear, deletes the file and stops polling at once, `session key cleared — the running Hub stops polling at once`; with none running the command deletes the file itself, `session key cleared — removed <path>`, or says none was stored.

A running Hub stores a key before it lists its Organizations and polls with it, so a push that takes longer than 10 s exits 1 saying the key may have been stored, which it has.

| Exit | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | The key is a Claude Code OAuth token, claude.ai refused it or could not be reached, the running Hub did not answer within 10 s (see `maxprice-hub service logs`), `serve.lock` held a pid alone all that time (a `serve` still starting, or another command at work), the Hub refused the operator token, its status probe or the change, sent an answer this `maxprice-hub` cannot read, stopped while it waited, or was lost, `flock` failed on `serve.lock`, or `secrets.json` cannot be written or removed |
| 2    | A bad command or option, an argument after `set` or `clear`, not Linux, no Hub at the data dir, or no key given                                                                                                                                                                                                                                                                                                                                                                                                |
| 4    | The running Hub speaks another Hub protocol: restart it to finish the update                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 130  | `set`: Ctrl-C at the prompt; nothing is stored                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### `maxprice-hub rename`

`maxprice-hub rename <machineId> <newName>`: rename a machine in the Hub's Machine directory, as the console's Rename does. The name is trimmed, 1 to 63 characters, and in use by no other machine, whatever its case. It prints `renamed <machineId> to "<newName>"`. A name in use exits 2, naming it.

| Exit | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | On Linux, a Hub runs on the data dir but did not answer within 10 s (see `maxprice-hub service logs`), `serve.lock` held a pid alone all that time (a `serve` still starting, or another command at work), the Hub refused the operator token or its status probe, sent an answer this `maxprice-hub` cannot read, stopped while it waited, or was lost; elsewhere, a Hub answers `/healthz` on `hub.json`'s port; or `flock` failed on `serve.lock` |
| 2    | A bad option or argument, no Hub at the data dir, or the rename failed: an unknown machine, a name that is invalid or already in use, or a fleet event archive that did not load                                                                                                                                                                                                                                                                     |
| 4    | On Linux, the running Hub speaks another Hub protocol: restart it to finish the update                                                                                                                                                                                                                                                                                                                                                               |

### `maxprice-hub merge`

`maxprice-hub merge <sourceId> <targetId>`: merge one machine into another, as the console's Merge does. The source becomes an alias of the target, such as an old machine id a reinstall left behind, and no Fleet event is rewritten: reports fold the source's usage under the target's name. It prints `merged <sourceId> into <targetId> (alias only — no events rewritten)`.

| Exit | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | On Linux, a Hub runs on the data dir but did not answer within 10 s (see `maxprice-hub service logs`), `serve.lock` held a pid alone all that time (a `serve` still starting, or another command at work), the Hub refused the operator token or its status probe, sent an answer this `maxprice-hub` cannot read, stopped while it waited, or was lost; elsewhere, a Hub answers `/healthz` on `hub.json`'s port; or `flock` failed on `serve.lock` |
| 2    | A bad option or argument, no Hub at the data dir, or the merge failed: an unknown machine, a machine merged into itself, an alias cycle, or a fleet event archive that did not load                                                                                                                                                                                                                                                                  |
| 4    | On Linux, the running Hub speaks another Hub protocol: restart it to finish the update                                                                                                                                                                                                                                                                                                                                                               |

### `maxprice-hub purge-machine`

`maxprice-hub purge-machine <machineId>`: purge a machine, as the console's Purge does. Its Fleet events leave the archive, with its identity rows and its Machine directory entry, and clients receive an incremental deletion. It first asks you to type the machine's name, `Type the machine's name ("<name>") to confirm purge:`, one line of stdin, which a pipe can give; a name that does not match purges nothing, exit 2. Through a running Hub it asks for the name that Hub's Machine directory gives, and prints `purged "<name>" (<machineId>); clients receive an incremental deletion`; editing the files itself it adds the count of events dropped. Offline it asks while it holds `serve.lock`, so a `serve` started meanwhile exits 5. Ctrl-C at the prompt stops it, having purged nothing. A machine whose name holds a control character shows it escaped and cannot be confirmed by typing that: rename it first.

| Exit | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | On Linux, a Hub runs on the data dir but did not answer within 10 s (see `maxprice-hub service logs`), `serve.lock` held a pid alone all that time (a `serve` still starting, or another command at work), the Hub refused the operator token or its status probe, sent an answer this `maxprice-hub` cannot read, stopped while it waited, or was lost; elsewhere, a Hub answers `/healthz` on `hub.json`'s port; or `flock` failed on `serve.lock` |
| 2    | A bad option or argument, no Hub at the data dir, or the purge failed: an unknown machine, no typed name or one that does not match, an identity directory it cannot read, or a fleet event archive that did not load                                                                                                                                                                                                                                |
| 4    | On Linux, the running Hub speaks another Hub protocol: restart it to finish the update                                                                                                                                                                                                                                                                                                                                                               |
| 130  | Ctrl-C at the name prompt; nothing is purged                                                                                                                                                                                                                                                                                                                                                                                                         |

### `maxprice-hub compact`

`maxprice-hub compact`: compact the fleet event archive, as the console's Compact does. It reclaims the space replaced and removed events left in `events.sqlite`, and keeps the usage, the epoch and the incremental history. It prints `compacted: <N> bytes reclaimed; usage and incremental history preserved`. The Hub answers nothing else while it compacts, so a compaction that takes longer than 10 s exits 1 saying the change may have been applied, though it completes.

| Exit | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | On Linux, a Hub runs on the data dir but did not answer within 10 s (see `maxprice-hub service logs`), `serve.lock` held a pid alone all that time (a `serve` still starting, or another command at work), the Hub refused the operator token or its status probe, sent an answer this `maxprice-hub` cannot read, stopped while it waited, or was lost; elsewhere, a Hub answers `/healthz` on `hub.json`'s port; or `flock` failed on `serve.lock` |
| 2    | A bad option or argument, no Hub at the data dir, or the compaction failed                                                                                                                                                                                                                                                                                                                                                                           |
| 4    | On Linux, the running Hub speaks another Hub protocol: restart it to finish the update                                                                                                                                                                                                                                                                                                                                                               |

### `maxprice-hub restore`

`maxprice-hub restore <dir> [--samples <usage-history.jsonl>]...`: restore a stopped Hub's data dir, or a backup of one, at `<dir>` into the data dir, before the data dir's first `serve`. A fleet moves to another Hub this way, or a Hub comes back from a backup: [Moving a fleet to another Hub](#moving-a-fleet-to-another-hub) walks it. Linux only, with the Hub stopped: it has no path through a running Hub.

- **What it copies.** `hub.json` and `events.sqlite`, which `<dir>` must hold, then `usage-history.jsonl`, `machine-directory.json`, `identity-directory.json`, `organization-directory.json`, `organization-assertion-directory.json` and `organization-roster.json` when it holds them, and nothing else: never `secrets.json`, `operator-token`, `serve.lock` or `update-check.json`. It only reads `<dir>`, and writes every file 0600 into a 0700 data dir.
- **The archive.** It copies `events.sqlite` with its write-ahead log or rollback journal when present, never its `-shm`, and folds them in on the copy. Then SQLite's integrity check reads every page, and the Hub's own load validates every stored event's sequence and payload, as `serve` would: the integrity check alone does not check the Hub's rules. An archive that is a client's Fleet replica, not a Hub's, is refused. The copy keeps the backup's Fleet events, Fleet change cursor and Deletion generation, under a fresh epoch, always: no option keeps the old one.
- **`hub.json`** must be a JSON object, and its `passwordHash`, when present, a string or `null`: defaulting a wrong one would reopen a password-protected Hub. It keeps its `port` and `bind`, so the Hub's URL stays unchanged. The directories and the roster must each be JSON.
- **`--samples <file>`**, repeatable, merges a client's own `usage-history.jsonl` into the restored history, for the Hub's own samples since the backup: give it once for each client. A sample the history already holds is dropped, and a stamped copy replaces an unstamped one at the same instant; the merged samples are appended in time order after the backup's lines, which stay byte for byte, and the result must read back whole before anything is placed. A line that is not a sample is skipped and counted; a file with lines but no sample, or one that cannot be read, is refused.
- **What it refuses.** While anything holds the data dir's `serve.lock`, naming its pid, or `<dir>`'s, which it asks read-only and never creates: a running Hub's files are not a backup. An `events.sqlite`, WAL or journal in `<dir>` that changed while it was copied: something is writing it. A data dir that already holds any of a Hub's files, or an `events.sqlite` WAL, shared-memory or journal file: it never replaces a file. A `<dir>` with no `hub.json` or no `events.sqlite`, a `<dir>` that is the data dir, or a data dir inside the backup, through symlinks too. A backup input or `--samples` file at or below the data dir's `.restore-staging`, through its path or any symlink, refused before any cleanup with every input left untouched: move it outside staging first. A data dir `serve.lock` that is not a regular file with one link, or that aliases an input; the lock it takes is inspected again before it records its pid.
- **Staging.** All work happens in `.restore-staging` inside the data dir, made 0700 under the lock. Each file is copied there, checked and synced, then renamed into the data dir, `hub.json` last, after which the data dir is synced and the staging dir removed. A restore refused, or failing before it places a file, leaves no restored file. One killed or failing once it has placed files leaves `.restore-staging` beside them: `serve`, `setup` and `restore` then refuse that data dir, exit 1, until you move it aside and restore again into an empty one. A staging dir with no Hub file beside it, from a restore that placed nothing, the next `restore` removes.
- A `status` asking the data dir's lock in the instant `restore` takes it makes `restore` exit 1 with its `stop it first` line, naming the record's last holder, having changed nothing; `status` only asks a data dir that holds `hub.json`, which `restore` refuses anyway, with exit 2.

It prints what it restored, then the next steps.

| Exit | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | A Hub is running on the data dir or on `<dir>`, another `maxprice-hub` command holds the data dir's `serve.lock`, the data dir holds a restore that did not finish (`.restore-staging` beside a Hub's file), `events.sqlite`, its WAL or its journal changed while it was copied, a backup file cannot be read, `flock` failed on a `serve.lock`, a copy, write, rename or fsync failed (a failure once a file is placed keeps `.restore-staging`), or the merged usage history did not read back |
| 2    | A bad option or argument, not Linux, no Hub to restore at `<dir>`, `<dir>` is the data dir or holds it, an input that overlaps `.restore-staging`, an unsafe `serve.lock` in the data dir, a data dir that already holds a Hub's files, a backup file restore cannot use, or a `--samples` file that cannot be read or has lines but no sample                                                                                                                                                    |

### `maxprice-hub service install|uninstall|status|logs`

`maxprice-hub service <verb>`: the Hub as a systemd user unit, `maxprice-hub.service` ([Run it as a service](#run-it-as-a-service)). There is no start, stop or restart verb: `systemctl --user` does those. Linux only.

- `install` writes the unit, enables it and starts it, as above: it runs `daemon-reload`, `reset-failed` and `enable --now`, restarts a running Hub when the file changed, says `updated` or `unchanged`, prints the `Environment=` line it bakes, if any, and prints the linger step when linger is off.
- `uninstall` stops and disables the unit and removes its file. The data dir, its `secrets.json`, the drop-ins and linger stay, and it says so.
- `status` shows the unit's state, start time, restarts and last exit; whether it runs this `maxprice-hub` and serves this shell's data dir; linger; whether a Hub answers `/healthz` on the port the data dir's `serve.lock` records; and, for a unit that stopped on exit 5, who held that lock. `maxprice-hub status` describes the Hub itself.
- `logs` shows the unit's journal, as `journalctl --user --user-unit=maxprice-hub.service` does, and exits with journalctl's own code. `-f` or `--follow` follows it, and `-n <N>` or `--lines <N>` shows the last N lines.

With no systemd user manager every verb exits 1 with one line: `no systemd user manager here (systemctl --user failed: <reason>); run 'maxprice-hub serve' under your init, restarting it after exit 1 but not after exit 5 (the README's unit for other inits shows one)`. That unit is [A systemd system unit](#a-systemd-system-unit).

| Exit | Meaning                                                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | No systemd user manager, a systemctl step failed, `journalctl` is not on `PATH`, or `uninstall` found the file gone while the manager still has the unit |
| 2    | A bad verb or option, an argument after the verb, `-f` or `-n` with a verb other than `logs`, a `-n` that is not a whole number, or not Linux            |
| 3    | `status`: the unit is not active, or not installed; `logs`: the unit is not installed                                                                    |

### `maxprice-hub update`

`maxprice-hub update [--check [--json]]`: install the newest `maxprice-hub` from the update channel over this binary, then restart the unit that runs it. `--check` only says whether a newer one is available, `maxprice-hub 0.9.1 is available (this is 0.9.0); run 'maxprice-hub update'.` with exit 100, or `maxprice-hub 0.9.0 is current.` with exit 0; it downloads and writes nothing. With it, `--json` prints `{"current":…,"latest":…,"available":…}` instead. [Updating](#updating) says what it checks and what it restarts. Linux only, `--check` included.

| Exit | Meaning                                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Success; with `--check`, this `maxprice-hub` is current                                                                                                                                                                                                            |
| 1    | The check or the update failed, or this `maxprice-hub` runs from source, and this binary is unchanged; or, with this binary already replaced, the restart failed or the restarted Hub did not report the new version within 30 s (see `maxprice-hub service logs`) |
| 2    | A bad option or an argument, `--json` without `--check`, or not Linux                                                                                                                                                                                              |
| 100  | `--check` found a newer `maxprice-hub`                                                                                                                                                                                                                             |

### `maxprice-hub page [set <url>|clear|snippet]`

`maxprice-hub page`, `maxprice-hub page set <url>`, `maxprice-hub page clear` and `maxprice-hub page snippet`: report or set the Hub page URL, and print the Apache snippet that publishes the page there ([Publish the Hub page](#publish-the-hub-page)). None of the four takes `serve.lock`, and none needs the Hub stopped or restarted: the Hub reads the Hub page URL only for its boot log. Each refuses a data dir with no `hub.json`, exit 2, and a `hub.json` the Hub's boot would replace with the defaults, not JSON, not an object or holding a `passwordHash` of the wrong type, exit 1, changing nothing.

- **`page`** prints the Hub page URL, the loopback target and a reading, then the one-line contract for any other web server. With a URL set, it first asks `/healthz` whether the Hub runs, at the port `serve.lock` records (off Linux, at `hub.json`'s), then fetches `<url>view`, waiting at most 5 s, and reads the answer: published; another Hub's page, a view of another version, as between an update's swap and the Hub's restart; something other than the Hub page; the web server refused this machine (403); the snippet is not installed (404); the web server cannot reach the Hub (502 or 503: if the Hub's port changed, regenerate and reinstall the snippet); another status; or no answer, with the error. A stopped Hub reads `Hub not running` and says to start it. While the Hub runs and the page is not published, it prints the install steps for Debian or Ubuntu's Apache. It asks the Hub and the URL directly, never through a proxy that `HTTP_PROXY` or its kin name, so this machine must resolve and reach the URL's host itself. It exits 0 when the page is published or no URL is set, and 1 otherwise. With no URL set, or a stored one that is not valid, which it names and the Hub treats as unset, it names the SSH tunnel instead.
- **`page set <url>`** stores the URL in `hub.json`. It must be an `http://` or `https://` URL with no user name, password, query or fragment, whose path segments hold only letters, digits, `.`, `_`, `~` and `-`, none of them empty, `.` or `..`. It appends a trailing slash when the path lacks one, since the page's relative links resolve only under it. A rejected URL exits 2 with the reason, and changes nothing. It prints the new snippet, for `hub.json`'s port, and says any installed copy is now stale, every time: nothing tracks one.
- **`page clear`** removes the URL. A web server keeps publishing the page until its snippet is removed: on Debian or Ubuntu, `sudo a2disconf maxprice-hub && sudo systemctl reload apache2`.
- **`page snippet`** writes the snippet alone to stdout, so that `maxprice-hub page snippet | sudo tee <file>` installs it. With no valid URL set it exits 2.

| Exit | Meaning                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `page`: a Hub page URL is set and the page is not published there; any of the four: a `hub.json` that is not JSON, not an object or holds a wrong-typed `passwordHash`, or one that cannot be read or written |
| 2    | A bad command or option, no Hub at the data dir, an invalid Hub page URL (`page set`), or no valid one set (`page snippet`)                                                                                   |

### `maxprice-hub help`

`maxprice-hub help [<command>]`: with no command, the list of commands, the global options, the exit codes and the address of the User guide's Headless Hub Overview, as `maxprice-hub --help` prints them; with one, that command's help, as `maxprice-hub <command> --help` prints it. Unlike `maxprice`, `maxprice-hub` alone runs `serve`.

| Exit | Meaning                                  |
| ---- | ---------------------------------------- |
| 2    | More than one command, or an unknown one |

### `maxprice-hub --version`

`maxprice-hub --version`: print the bare version, such as `0.9.0`, with no name, and nothing else. It resolves no data dir and touches no file, so `update` runs it on a new binary beside a running Hub.

| Exit | Meaning                    |
| ---- | -------------------------- |
| 2    | Another argument beside it |

## Exit codes

| Exit | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success, or `serve` stopped cleanly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 1    | A crash, a failed first bind, `flock` failing on `serve.lock`, a data dir holding a restore that did not finish, a Hub running on the data dir of a command that edits its files, a running Hub a command could not reach within 10 s, or that did not answer a request within 10 s (a change may then have been applied), that refused its operator token, its probe, its page view, a password or a key, that sent an answer it cannot read, that stopped while it waited or that it lost, a `serve.lock` record no Hub writes, two password entries that differ, a key claude.ai refused or could not check or a Claude Code OAuth token given as one, a service step that failed, or restore's backup running, written while it is copied, or unreadable; for `page`, a `hub.json` it cannot use, or a Hub page URL at which the page is not published; for `setup`, a Hub its ending waited 10 s for in vain; for `update`, a check or an update that failed, a binary run from source, a restart that failed, or a restarted Hub that did not report the new version within 30 s |
| 2    | Usage error, a secret given as an argument or not at all, no Hub at the data dir, an invalid password, `key set` or `clear`, `status`, `restore`, `service` or `update`, off Linux, a machine a command cannot act on, a backup restore cannot use, or a data dir that already holds a Hub's files; an invalid Hub page URL, or none set; `setup` off Linux, as root, off a terminal, or beside a unit that serves, or would serve, another data dir                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 3    | `status`: no Hub runs on the data dir; `service status`: the unit is not active, or not installed; `service logs`: the unit is not installed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 4    | The running Hub speaks another Hub protocol: restart it to finish the update                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5    | `serve`: another `maxprice-hub` held the data dir's `serve.lock` for 500 ms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 100  | `update --check`: a newer `maxprice-hub` is available                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 130  | Ctrl-C at a prompt: `password set` or `key set`, which write nothing, `purge-machine`, which purges nothing, or `setup`, which keeps every step it completed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Nothing is written when a prompt is interrupted, but `setup` keeps the steps it completed. `password set`, `key set` and `setup` exit 130 themselves. At `purge-machine`'s prompt the SIGINT ends the process, its default action, which a shell reports as 130 (128 + 2) and a supervisor as a signal; so does a Ctrl-C while one of `setup`'s steps is at work between its prompts.

## How a command reaches a running Hub

`rename`, `merge`, `purge-machine`, `compact`, `password set|clear` and `key set|clear` act on the Hub at the data dir, and on Linux each first asks the data dir's `serve.lock`:

- **Free:** no Hub runs there. The command holds the lock while it edits the data dir's files itself. A `serve` started meanwhile asks again for half a second: it waits out an edit shorter than that, and exits 5 when the command holds the lock longer, which the unit does not retry, so start it again once the command is done. `purge-machine` holds it while it waits at its typed-name prompt too; `password set` and `key set` read their secret before they ask, so their prompts never hold it.
- **Held by a `serve` that recorded its port:** the command goes through that Hub's own route, the one its console uses, on `127.0.0.1:<port>`, with `<data dir>/operator-token` as its bearer, and the Hub applies the change at once, with no restart. The token passes whether or not a Hub password is set, so the commands need no password; whoever can read the token can edit the data dir's files anyway.
- **Held with no port recorded,** by a `serve` still starting or by another command at work: it waits. It goes live once the port is recorded, or takes the lock once its holder lets go. It never guesses a port from `hub.json`, which may have changed under the running Hub.

A Hub the command saw running that stops while it waits, as in the gap of `systemctl --user restart maxprice-hub`, keeps the lock free for the `serve` that replaces it: the command exits 1 with `maxprice-hub stopped running for <dir> while the command waited for it; run it again`. A `status` asking the lock in the instant the command looks, over the record a Hub that exited left, reads the same way, and the command exits 1 so, having changed nothing: run it again.

Reaching the Hub has 10 s, up to its authenticated status answer, which waits for the Hub to finish loading. Past it the command exits 1 for a stopped Hub, a missing or empty `operator-token`, a refused connection, a lock with no port or a Hub still loading, with the last reason it waited on and the journal to read:

```
maxprice-hub is running for ~/.local/share/maxprice-hub (pid 4182) but did not answer within 10 s: 127.0.0.1:47100 sent no answer
  Why:  maxprice-hub service logs
```

A 401 exits 1 naming the token file, `the running Hub on 127.0.0.1:<port> refused the operator token in <path>`. The one exception is the status probe's 401 when the file has changed since the command read it: that is a Hub just started, and the command waits on with its new token. Once the Hub is reached, a 401 is final. An answer that is not a Hub's status exits 1, `something that is not a Hub answers on 127.0.0.1:<port>`. A Hub of another Hub protocol exits 4, before any change or prompt, with `the running Hub speaks another Hub protocol: restart maxprice-hub.service to finish the update`, or `restart its serve (pid N)` for a `serve` outside the unit. A route's own refusal, an unknown machine, a name in use or an alias cycle, exits 2 in its words, as the offline edit does; a rename's collision names the name already in use.

Each request after the reach has 10 s of its own, `compact`'s and `key set`'s included, and is sent once: the command never sends it again on its own. The Hub makes a change before it answers, and a Hub stopped meanwhile may make it when it resumes, so a change with no answer exits 1 with

```
the running Hub on 127.0.0.1:47100 did not answer POST /api/store/compact within 10 s: the change may have been applied, or may still be when the Hub resumes
  Check it before running the command again.
  Why:  maxprice-hub service logs
```

and one whose connection broke with `lost the running Hub on 127.0.0.1:<port> during <METHOD> <path> (<code>): the change may have been applied` and the same two lines under it. Check whether it took before you run the command again; if it did, running it again ends in the same state (a key set again is recorded as set again, and a purge repeated finds the machine unknown). `purge-machine`'s listing changes nothing, and its line says so, and a refused connection sent nothing: `lost the running Hub on 127.0.0.1:<port>: it refused the connection, so nothing was sent`.

The commands talk to `127.0.0.1` over a socket of their own, never through a proxy that `HTTP_PROXY` or `http_proxy` names, so neither the operator token nor a password or key they send crosses one.

Elsewhere there is no lock: `rename`, `merge`, `purge-machine` and `compact` refuse while anything answers `/healthz` on `hub.json`'s port, and `password` rewrites `hub.json` without checking, which a running Hub reads only when it restarts. `key` is Linux only.

## The Hub page

A Headless Hub serves its Hub page whether or not anything publishes it, and only to a socket peer on loopback, on every address it binds, a wildcard included. Any other peer, a tailnet one included, gets the same 404 as an unknown path: the page is absent from the tailnet, not forbidden there. `X-Forwarded-For` is never read, and the Hub password does not gate the page. The page also requires a loopback `Host`, to stop a browser's DNS rebinding: `127.0.0.0/8` in canonical dotted decimal, `[::1]` or `localhost` in any case, optionally with a canonical decimal port 1–65535, so an SSH tunnel's other local port works. A missing, foreign or malformed `Host` gets the same 404, even over a loopback socket, and no forwarded header stands in for it. The check applies only to `/page`; the Hub's API keeps its own authorization.

| Route         | Answer                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `/page/`      | the page (`index.html`); every other built file at its relative path, hashed ones in `assets/` |
| `/page/view`  | the page's data, once the Hub has finished booting                                             |
| `/page`       | a `301` to the relative `page/`                                                                |
| anything else | unchanged: `GET /` is still a 404                                                              |

Only `GET` and `HEAD` are answered. Every page answer carries a strict `Content-Security-Policy`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Hashed assets are cached for a year as immutable, and everything else is `no-store`. No ETag is sent, so a web server needs to add no header. A visitor learns the Hub's bound addresses, its bind warning and its fleet event archive's counters, and never a client's hostname or address, an Organization id, a usage reading or who set the key.

The page asks for its data every 5 s while its tab is shown, with no retry: any failure, a web server's 502 included, reads `Not responding` until a reading succeeds. When the Hub's version changes, it reloads itself once. Its header shows the host the browser reached it at, and its footer the version.

Only the linux-x64 build embeds the page's files: `bun apps/hub/scripts/build-binaries.ts linux-x64` builds the page, writes its manifest, then compiles with it. Every other target, the hub tray app's included, embeds none, and the tray app's Hub mounts no page route at all. Run from source (`bun --filter @maxprice/hub dev`), a Headless Hub answers `/page/view` but holds no page files, so `/page/` is a 404, and its boot log says so.

## The hub tray app

On Windows the Hub ships as **MaxPrice Hub**, a tray app (`com.maxprice.hub`) that runs `maxprice-hub` as its own embedded Hub: it starts the Hub, which dies with the app, and it is the always-on parent, so quitting it from the tray stops the Hub. Install it from the releases page, and it:

- launches hidden to the tray at login;
- starts the Hub, which binds the tailnet and loopback, optionally behind a Hub password, and polls once a minute;
- shows a status-tinted tray icon, a Popout with the Hub, claude.ai and Access rows, and an operator console: the Hub's status, its fleet event archive with an epoch-preserving compact, the Machines card with rename, merge and purge, the Organizations, and the claude.ai key's health with replace and clear. The key is never displayed.

The tray app keeps its data dir in `%APPDATA%\maxprice-hub` and its key in Windows' credential store, through the `maxprice-credstore` helper beside the binary: a restart keeps the key, but not when or by whom it was set. Without the helper it holds the key in memory, which a restart loses, and says `no credstore helper found`. It updates itself, its Hub included, through its own updater, and `maxprice-hub update`, `service`, `status`, `key`, `setup` and `restore` are Linux only. Its console needs no Hub password: the embedded Hub hands the app a fresh operator token at each launch. Its earlier `service install|uninstall|status`, which registered the Hub with each platform's own service manager, is gone: the tray app's autostart replaces it on Windows, and on Linux `service` returns as the user unit above.

The tray app ships for Windows only. Its macOS code is written and unit-tested, but has never been built or run. Build the installer from the source root with `bun run build:hub` (it needs Rust too); it lands in `apps/hub-desktop/src-tauri/target/release/bundle/`.

## Development

### Run from source

```sh
export MAXPRICE_HUB_DATA_DIR=$(mktemp -d)       # a throwaway data dir, never the real one
printf '{"port": 47199, "bind": "loopback"}\n' > "$MAXPRICE_HUB_DATA_DIR/hub.json"   # this machine only
bun --filter @maxprice/hub dev                   # serve, from source
bun apps/hub/src/index.ts --help                 # every command and its exit codes
# with the Hub running: on Linux it applies these at once, elsewhere restart it after
bun apps/hub/src/index.ts password set           # set the Hub password (prompt or stdin)
bun apps/hub/src/index.ts password clear         # clear it: the Hub is open again
```

Unset, `MAXPRICE_HUB_DATA_DIR` leaves the Hub on the real `~/.local/share/maxprice-hub`, so give every run its own. With no `hub.json` the Hub writes the defaults, which bind the tailnet on 47100, where real clients may already be looking for a Hub, so write one first, as above. Run from source, a Headless `serve` on Linux checks the real update channel at boot, and holds no Hub page files. `maxprice-hub update` refuses from source, and `--check` works. For a GUI, `bun run dev:hub` runs the hub tray app with its embedded Hub.

### Front-to-back dev rig

A Hub polling a fake claude.ai, a sidecar consuming it and the renderer, with no real claude.ai and no packaging. The fake, `packages/usage-core/src/fake-claude.ts`, is a test fixture, so it is in the development tree but not the published source. For a GUI rig, replace terminals 1 and 2 with the tray app (`bun run dev:hub`).

Terminal 1, the fake claude.ai, which prints its base URL and a session key:

```sh
bun packages/usage-core/src/fake-claude.ts
```

Terminal 2, a Hub on loopback polling the fake:

```sh
export MAXPRICE_HUB_DATA_DIR=$(mktemp -d)
printf '{"port": 47199, "bind": "loopback"}\n' > "$MAXPRICE_HUB_DATA_DIR/hub.json"
MAXPRICE_CLAUDE_BASE_URL=http://127.0.0.1:<fake-port>/api bun apps/hub/src/index.ts
```

Push the fake's session key into the Hub, the key alone: the Hub lists every Organization the key can read and polls all of them, and it refuses a body that also names an `orgId`. No `Authorization` header is needed while the Hub is open, the rig's default; add `-H "Authorization: Bearer $HUB_PASSWORD"` if you set one (`printf '%s' "$HUB_PASSWORD" | bun apps/hub/src/index.ts password set`, from a shell with the same `MAXPRICE_HUB_DATA_DIR`: on Linux the running Hub applies it at once, elsewhere restart it):

```sh
curl -s -X POST -H "content-type: application/json" \
  -d '{"sessionKey":"sk-test-fake"}' http://127.0.0.1:47199/api/credential
```

With a Hub-connected sidecar holding a local credential this step is optional: auto-heal pushes the client's key into a keyless Hub on connect. On Linux, `bun apps/hub/src/index.ts key set` with the fake's base URL in `MAXPRICE_CLAUDE_BASE_URL` does the same from the terminal.

Terminal 3, a sidecar consuming the Hub. `VITE_SIDECAR_ORIGIN` puts terminal 4's browser origin in the sidecar's CORS allowlist; without it every renderer request to the sidecar is blocked:

```sh
VITE_SIDECAR_ORIGIN=http://127.0.0.1:1420 \
MAXPRICE_HUB_URL=http://127.0.0.1:47199 \
MAXPRICE_USAGE_HISTORY_PATH=/tmp/sidecar-rig/usage-history.jsonl \
  bun --filter @maxprice/sidecar dev
```

Add `MAXPRICE_HUB_PASSWORD=$HUB_PASSWORD` beside `MAXPRICE_HUB_URL` if the Hub has a password, and `MAXPRICE_HUB_AUTO_HEAL=0` to keep the sidecar's key local.

Terminal 4, the renderer:

```sh
VITE_SIDECAR_URL=http://127.0.0.1:<sidecar-port> bun --filter @maxprice/desktop dev
```

Then drive `http://127.0.0.1:1420/`: the Active block and This week rings fill from the Hub's samples. Kill the Hub mid-stream and the sidecar falls back, its own poller taking over at once, its first sample within seconds; restart the Hub and the sidecar reconnects and pushes up the samples it took meanwhile (`curl http://127.0.0.1:47199/api/samples` shows them, with the `Authorization` header when a password is set). To watch auto-heal, key the Hub with a junk credential (`{"sessionKey":"sk-wrong"}`): its claude.ai state goes to expired, and a connected sidecar holding the good key re-keys it within one retry, about 15 s.

Afterwards remove the temporary data dirs; on Linux the fake key goes with the Hub's, in its `secrets.json`. On Windows or macOS, with a real credstore helper built, the Hub stored the fake key in the real keychain slot: delete it (`apps\hub\credstore\target\release\maxprice-credstore.exe delete`), or set `MAXPRICE_CREDSTORE_ACCOUNT` for the run so the real slot is never touched.
