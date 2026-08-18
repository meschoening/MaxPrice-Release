#[cfg(windows)]
mod job_object;
mod sidecar_log;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_window_state::AppHandleExt;

#[derive(Default)]
enum SidecarStatus {
    #[default]
    Pending,
    Ready(u16),
    Failed(String),
}

#[derive(Default)]
struct SidecarState {
    status: Mutex<SidecarStatus>,
    child: Mutex<Option<CommandChild>>,
    // Per-launch shared secret handed to the sidecar via MAXPRICE_AUTH_TOKEN and
    // to the renderer via get_usage_auth_token (f22). The renderer attaches it
    // to the loopback usage POSTs (/api/usage/credential, /api/usage/
    // discover-orgs) so a same-host process can't drive them. Generated once in
    // spawn_sidecar before the sidecar Command is built.
    auth_token: Mutex<Option<String>>,
    // The Windows job object the sidecar is confined to (ADR-0072). Stored for
    // the process lifetime and never taken back out: dropping this handle
    // terminates the sidecar instantly, and letting the KERNEL close it during
    // teardown is what reaches the exits `kill_sidecar` cannot — the updater's
    // `std::process::exit(0)` above all.
    #[cfg(windows)]
    job: Mutex<Option<job_object::JobHandle>>,
}

/// The renderer's handle on the durable log (issue #115 / F3).
///
/// ADR-0056 gave the shell a rotating `sidecar.log` fed by the sidecar's stdout
/// pipe. That covers everything the sidecar says — but a renderer-side failure
/// says nothing to the sidecar, and `console.error` goes to the WebView
/// console, which a packaged build has no way to show. So the renderer gets its
/// own feeder into the same file.
///
/// Deliberately NOT an HTTP endpoint on the sidecar: the failure this exists to
/// record is "the sidecar did not answer", so routing the report through the
/// sidecar would lose exactly the case that has no trace today (ADR-0059).
///
/// Managed at builder time and filled in during setup, so the command is safe
/// to call before (or after a failed) `spawn_sidecar` — `None` simply no-ops,
/// matching ADR-0056's "a failed log open degrades to stderr-only" rule.
#[derive(Default)]
struct ClientLog(Mutex<Option<std::sync::Arc<sidecar_log::RotatingLog>>>);

/// Longest renderer line accepted, in characters. Renderer messages embed
/// server error bodies, and one runaway body should not consume a meaningful
/// share of the 5 MB generation that a later incident will need.
///
/// Measured BEFORE `RotatingLog::line` escapes control characters, so a line
/// dense in them can reach the file up to ~2× this — still well within the
/// budget's intent, and clipping after the escape would be able to cut an
/// escape sequence in half.
const CLIENT_LOG_MAX_CHARS: usize = 1000;

/// Append one renderer line to `log`, prefixed `[renderer]` so a forensic read
/// can tell which side of the IPC boundary spoke, clipped to
/// `CLIENT_LOG_MAX_CHARS`.
///
/// A free function rather than the command body so it is unit-testable without
/// standing up a Tauri app and its managed state.
fn append_client_line(log: &sidecar_log::RotatingLog, line: &str) {
    let trimmed = line.trim_end();
    if trimmed.chars().count() > CLIENT_LOG_MAX_CHARS {
        // `chars()`, not bytes — a byte slice can split a UTF-8 sequence, and
        // the renderer's lines carry `·`, `—` and `…` routinely.
        let clipped: String = trimmed.chars().take(CLIENT_LOG_MAX_CHARS).collect();
        log.line("[renderer]", &format!("{clipped}… (truncated)"));
    } else {
        log.line("[renderer]", trimmed);
    }
}

/// The command's whole body, minus `State` — which cannot be constructed
/// outside the `tauri` crate, so the guard is only reachable from a test if it
/// lives here (same reason `append_client_line` is a free function).
fn append_if_open(slot: &Mutex<Option<std::sync::Arc<sidecar_log::RotatingLog>>>, line: &str) {
    // Clone the Arc and release the slot lock before writing: `RotatingLog`
    // takes its own lock, and holding both invites a lock-order problem the
    // moment either side grows.
    let log = slot.lock().clone();
    if let Some(log) = log {
        append_client_line(&log, line);
    }
}

/// Append one renderer line to the durable log.
///
/// Infallible by design — the log must never disturb what it observes
/// (ADR-0056), in this direction too: an unopened log, or a line arriving
/// before setup filled the handle, is silently dropped rather than surfaced to
/// a renderer that is already reporting a failure.
#[tauri::command]
fn log_client_event(state: State<'_, ClientLog>, line: String) {
    append_if_open(&state.0, &line);
}

/// What the window-state plugin persists across launches (map #151, T8).
///
/// Three of the six flags, and the three exclusions are each load-bearing:
///
/// - **VISIBLE would break the boot splash.** The plugin restores in its
///   `on_window_ready` hook — before the webview has run a line — and the
///   restore ends with `if flags.contains(VISIBLE) && should_show { show();
///   set_focus() }`, where `should_show` defaults to `true` when there is no
///   saved state. So with VISIBLE set, the FIRST launch shows the window
///   instantly and every later one restores `visible: true` (the window is
///   always visible when we save), which is exactly the blank-window-then-
///   assemble sequence `visible: false` + the renderer-driven show exists to
///   prevent (ADR-0066, `lib/window-show.ts`). Excluding it leaves the show
///   entirely to the renderer, unchanged.
/// - **DECORATIONS** is a constant of the product, set in tauri.conf.json.
///   Nothing in the app toggles it, so persisting it can only ever restore a
///   value the config already asserts — or, after a config change, fight it.
/// - **FULLSCREEN** is not what the ticket asked for, and it is the one flag
///   whose restore runs unconditionally (`set_fullscreen(state.fullscreen)`)
///   against a window that is still hidden. Left out until something wants it.
///
/// Geometry restore lands before the window is on screen for the same reason
/// VISIBLE is excluded — the window is hidden until the splash has painted — so
/// there is no visible jump, no matter how the restore is sequenced.
fn window_state_flags() -> tauri_plugin_window_state::StateFlags {
    use tauri_plugin_window_state::StateFlags;
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

/// Flush the window geometry to disk NOW, for an exit that will not run a hook.
///
/// The plugin saves on `CloseRequested` and on `RunEvent::Exit`, which together
/// cover every ordinary end — including `relaunch()`, whose plugin-process
/// command calls `app.request_restart()` and so goes through the event loop.
/// The one exit that reaches neither is the Windows update install: the updater
/// hands the installer to `ShellExecuteW` and calls `std::process::exit(0)`
/// (tauri-plugin-updater 2.10.1, updater.rs:865) — the same abrupt exit
/// ADR-0072 gives the sidecar a kernel-enforced lifetime for. Its
/// `on_before_exit` hook is not reachable from the renderer's install path
/// (the plugin sets it to `cleanup_before_exit` itself), so the renderer calls
/// this immediately before `downloadAndInstall`.
#[tauri::command]
fn save_window_geometry(app: AppHandle) -> Result<(), String> {
    app.save_window_state(window_state_flags())
        .map_err(|e| format!("window state save: {e}"))
}

#[tauri::command]
fn get_sidecar_url(state: State<'_, SidecarState>) -> Result<String, String> {
    match &*state.status.lock() {
        SidecarStatus::Ready(port) => Ok(format!("http://127.0.0.1:{port}")),
        SidecarStatus::Pending => Err("sidecar not ready".into()),
        SidecarStatus::Failed(msg) => Err(msg.clone()),
    }
}

#[tauri::command]
fn get_usage_auth_token(state: State<'_, SidecarState>) -> Result<String, String> {
    match &*state.auth_token.lock() {
        Some(token) => Ok(token.clone()),
        None => Err("usage auth token not ready".into()),
    }
}

// Absolute path of settings.json in Tauri's app-data dir — the single
// durable user-config file (ADR-0014). The renderer is its sole writer; the
// sidecar reads only `claudePaths` from it.
fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    Ok(dir.join("settings.json"))
}

// The embedded-webview profile directories, for the Settings > Storage report
// (map #124, tickets #125 / #126). The profile is the single largest thing our
// install puts on disk — ~71% of the bar on Windows — and it is the one segment
// the sidecar cannot find for itself: it is a separate Bun process with no
// Tauri path APIs, and on two of three platforms the profile does not live in
// the app-data directory at all. So Rust resolves it and hands it over as
// MAXPRICE_WEBVIEW_PROFILE_DIR; the sidecar walks whatever it is given and
// knows nothing about platforms. Unset (or every path missing) means the
// segment is simply ABSENT from the report, which its schema defines as "does
// not apply here" rather than as a failure.
//
// A LIST, joined by the platform's PATH delimiter, because the profile is not
// one directory everywhere:
//   - Windows: one directory, outside app-data (%LOCALAPPDATA%, while our own
//     files sit in roaming %APPDATA%).
//   - macOS: TWO directories, both outside app-data - WebKit splits durable
//     website data from its cache.
//   - Linux: NINE subdirectories INSIDE our own app-data dir. That is also why
//     the sidecar excludes these exact paths from its app-data walk; without it
//     the same bytes would land in both the `other` bucket and this segment.
//
// Paths are emitted whether or not they exist: "missing means absent" is the
// sidecar's rule, and probing here would only duplicate it.
fn webview_profile_dirs(app: &AppHandle) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        // wry 0.55 / tauri 2.11 set no custom data_directory, so WebView2 uses
        // its default per-app User Data Folder beside the local app data.
        match app.path().app_local_data_dir() {
            Ok(dir) => vec![dir.join("EBWebView")],
            Err(_) => Vec::new(),
        }
    }

    #[cfg(target_os = "macos")]
    {
        let id = app.config().identifier.clone();
        let mut out = Vec::new();
        if let Ok(home) = app.path().home_dir() {
            out.push(
                home.join("Library")
                    .join("WebKit")
                    .join(&id)
                    .join("WebsiteData"),
            );
        }
        if let Ok(cache) = app.path().app_cache_dir() {
            out.push(cache.join("WebKit"));
        }
        out
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        // WebKitGTK scatters its profile across siblings of settings.json. Named
        // explicitly rather than swept, so a future app-owned directory is not
        // silently attributed to the webview.
        const WEBKIT_DIRS: [&str; 9] = [
            "WebKitCache",
            "localstorage",
            "databases",
            "itp",
            "serviceworkers",
            "applications",
            "CacheStorage",
            "icondatabase",
            "cookies",
        ];
        match app.path().app_local_data_dir() {
            Ok(dir) => WEBKIT_DIRS.iter().map(|name| dir.join(name)).collect(),
            Err(_) => Vec::new(),
        }
    }
}

// Per-write counter feeding the unique temp-file name in write_settings_at, so
// two concurrent writes can never share — and clobber — one temp sibling.
static TMP_NONCE: AtomicU64 = AtomicU64::new(0);

// Read settings.json from `path`. Tolerant by design: an absent file AND a
// corrupt/unparseable one both return {} (the empty object). For a malformed
// file that means it self-heals on the next write rather than stranding the
// renderer's settings query in a permanent error state — mirroring the
// sidecar's readClaudePathsFromSettings tolerance. The renderer treats {} as
// "not yet created" and runs first-launch seeding.
fn read_settings_at(path: &Path) -> Result<serde_json::Value, String> {
    match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(value) => Ok(value),
            Err(e) => {
                eprintln!("[settings] ignoring malformed settings.json ({e}); treating as empty");
                Ok(serde_json::json!({}))
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(format!("settings.json read error: {e}")),
    }
}

// Write settings.json at `path` atomically: write a temp sibling, then rename
// over the target so the sidecar's watcher never sees half-written JSON
// (ADR-0014). The temp name is unique per write (pid + a process-local counter)
// so concurrent writes don't share a temp file; a failed rename best-effort
// removes the temp so it can't accumulate.
fn write_settings_at(path: &Path, next: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let nonce = TMP_NONCE.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}.{}.tmp", std::process::id(), nonce));
    let body = serde_json::to_string_pretty(next).map_err(|e| format!("serialize failed: {e}"))?;
    fs::write(&tmp, body).map_err(|e| format!("temp write failed: {e}"))?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("rename failed: {e}"));
    }
    Ok(())
}

#[tauri::command]
fn read_settings(app: AppHandle) -> Result<serde_json::Value, String> {
    read_settings_at(&settings_path(&app)?)
}

#[tauri::command]
fn write_settings(app: AppHandle, next: serde_json::Value) -> Result<(), String> {
    write_settings_at(&settings_path(&app)?, &next)
}

// Usage-limits credential (ADR-0023): the claude.ai session key + org id, stored
// as one JSON blob in the OS keychain via the `keyring` crate (macOS Keychain,
// Secret Service on Linux, Credential Manager on Windows). The renderer is the
// only client; it pushes the value to the sidecar over loopback. Never written
// to settings.json.
const CRED_SERVICE: &str = "maxprice-desktop";
const CRED_ACCOUNT: &str = "usage-credential";

fn credential_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CRED_SERVICE, CRED_ACCOUNT).map_err(|e| format!("keyring init: {e}"))
}

#[tauri::command]
fn get_credential() -> Result<Option<String>, String> {
    match credential_entry()?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read: {e}")),
    }
}

#[tauri::command]
fn set_credential(value: Option<String>) -> Result<(), String> {
    let entry = credential_entry()?;
    match value {
        Some(secret) => entry
            .set_password(&secret)
            .map_err(|e| format!("keyring write: {e}")),
        None => match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keyring delete: {e}")),
        },
    }
}

// Hub password (ADR-0037): same keychain service, its own account. The hub
// URL lives in settings.json (non-secret); the optional password comes here.
const HUB_PASSWORD_ACCOUNT: &str = "hub-password";

fn hub_password_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CRED_SERVICE, HUB_PASSWORD_ACCOUNT)
        .map_err(|e| format!("keyring init: {e}"))
}

#[tauri::command]
fn get_hub_password() -> Result<Option<String>, String> {
    match hub_password_entry()?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read: {e}")),
    }
}

#[tauri::command]
fn set_hub_password(value: Option<String>) -> Result<(), String> {
    let entry = hub_password_entry()?;
    match value {
        Some(secret) => entry
            .set_password(&secret)
            .map_err(|e| format!("keyring write: {e}")),
        None => match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keyring delete: {e}")),
        },
    }
}

fn parse_listening_line(line: &str) -> Option<u16> {
    let rest = line.trim().strip_prefix("LISTENING ")?;
    rest.trim().parse::<u16>().ok()
}

// 32 random bytes, lowercase-hex encoded — the per-launch usage auth token (f22).
fn generate_auth_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("getrandom failed");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn spawn_sidecar(app: &AppHandle) -> Result<(), String> {
    // Resolve settings.json's absolute path here — the sidecar is a separate
    // Bun process with no Tauri path APIs, so it learns the path via the
    // MAXPRICE_SETTINGS_PATH env var and chokidar-watches it (ADR-0014).
    let settings_file = settings_path(app)?;

    // The durable sidecar log (issue #116 / F4) — <app-data>/logs/sidecar.log,
    // beside settings.json. Best-effort: a failed open leaves `log` as None and
    // the app runs exactly as before this file existed (stderr-only).
    let log: Option<std::sync::Arc<sidecar_log::RotatingLog>> = settings_file
        .parent()
        .map(|dir| dir.join("logs").join("sidecar.log"))
        .and_then(|path| {
            sidecar_log::RotatingLog::open(
                &path,
                sidecar_log::LOG_CAP_BYTES,
                &format!(
                    "--- MaxPrice v{} launched (pid {}) ---",
                    app.package_info().version,
                    std::process::id()
                ),
            )
            .map_err(|e| eprintln!("[sidecar] log open failed ({e}) — stderr only"))
            .ok()
        })
        .map(std::sync::Arc::new);

    // Hand the renderer its feeder into the same file (issue #115 / F3). Done
    // here rather than at builder time because this is where the log exists;
    // the state itself is managed up front so `log_client_event` is callable
    // even on the paths that return before we get this far.
    *app.state::<ClientLog>().0.lock() = log.clone();

    // Mint the per-launch usage auth token and store it BEFORE the sidecar is
    // spawned, so it's set synchronously by the time spawn_sidecar returns (in
    // setup, before the window loads) — the renderer can't call
    // get_usage_auth_token before it exists. The same value is handed to the
    // sidecar via MAXPRICE_AUTH_TOKEN so both sides share the secret (f22).
    let token = generate_auth_token();
    {
        let state = app.state::<SidecarState>();
        *state.auth_token.lock() = Some(token.clone());
    }

    let mut sidecar_cmd = app
        .shell()
        .sidecar("maxprice-sidecar")
        .map_err(|e| format!("sidecar lookup failed: {e}"))?
        .env(
            "MAXPRICE_SETTINGS_PATH",
            settings_file.to_string_lossy().to_string(),
        )
        .env("MAXPRICE_AUTH_TOKEN", &token);

    // The webview profile's location, for GET /api/storage (map #124). Omitted
    // when nothing resolved, or when a path somehow contains the delimiter we
    // join on — in both cases the storage report drops the segment, which is the
    // schema's "does not apply here" rather than a wrong number.
    let webview_dirs = webview_profile_dirs(app);
    if !webview_dirs.is_empty() {
        match std::env::join_paths(&webview_dirs) {
            Ok(joined) => {
                sidecar_cmd = sidecar_cmd.env(
                    "MAXPRICE_WEBVIEW_PROFILE_DIR",
                    joined.to_string_lossy().to_string(),
                );
            }
            Err(e) => eprintln!("[sidecar] webview profile path unusable ({e}) — segment omitted"),
        }
    }

    // In dev the window is served from Vite's devUrl, not tauri://localhost,
    // so the sidecar's CORS allowlist must include that origin or every
    // renderer fetch fails. The sidecar reads it from VITE_SIDECAR_ORIGIN.
    if tauri::is_dev() {
        if let Some(dev_url) = &app.config().build.dev_url {
            sidecar_cmd = sidecar_cmd.env(
                "VITE_SIDECAR_ORIGIN",
                dev_url.origin().ascii_serialization(),
            );
        }
    }

    let (mut rx, child) = match sidecar_cmd.spawn() {
        Ok(spawned) => spawned,
        Err(e) => {
            if let Some(l) = &log {
                l.line("[sidecar]", &format!("spawn failed: {e}"));
            }
            return Err(format!("sidecar spawn failed: {e}"));
        }
    };
    if let Some(l) = &log {
        l.line("[sidecar]", &format!("spawned pid={}", child.pid()));
    }
    #[cfg(windows)]
    let child_pid = child.pid();

    {
        let state = app.state::<SidecarState>();
        *state.child.lock() = Some(child);
    }

    // ADR-0072 — hand the sidecar's lifetime to the kernel. On Windows this is
    // the ONLY layer: the libc-getppid watchdog is non-win32 only, so before
    // this the sidecar's sole teardown was `kill_sidecar`, which the updater's
    // `std::process::exit(0)` skips entirely. A failure degrades to exactly
    // that, so it is logged loudly and never fatal.
    #[cfg(windows)]
    {
        match job_object::confine(child_pid) {
            Ok(job) => {
                *app.state::<SidecarState>().job.lock() = Some(job);
                if let Some(l) = &log {
                    l.line("[sidecar]", "job object armed (kill-on-close)");
                }
            }
            Err(e) => {
                let msg =
                    format!("job object failed: {e} — sidecar may outlive an abnormal shell exit");
                if let Some(l) = &log {
                    l.line("[sidecar]", &msg);
                }
                eprintln!("[sidecar] {msg}");
            }
        }
    }

    let app_handle = app.clone();

    // The stdout reader populates SidecarState. setup() returns immediately;
    // the renderer's getSidecarUrl backoff (apps/desktop/src/lib/sidecar.ts)
    // waits for Ready/Failed. Every branch tees to the durable log (F4)
    // alongside its eprintln — the eprintln stays for dev terminals.
    tauri::async_runtime::spawn(async move {
        let mut announced = false;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    if !announced {
                        if let Some(port) = parse_listening_line(&line) {
                            let state = app_handle.state::<SidecarState>();
                            *state.status.lock() = SidecarStatus::Ready(port);
                            announced = true;
                            // Consumed, never forwarded — but the port at each
                            // launch is exactly what post-hoc forensics curls.
                            if let Some(l) = &log {
                                l.line("[sidecar]", line.trim_end());
                            }
                            continue;
                        }
                        if line.trim_start().starts_with("LISTENING") {
                            eprintln!("[sidecar] malformed LISTENING line: {}", line.trim_end());
                            if let Some(l) = &log {
                                l.line(
                                    "[sidecar]",
                                    &format!("malformed LISTENING line: {}", line.trim_end()),
                                );
                            }
                        }
                    }
                    eprintln!("[sidecar] {}", line.trim_end());
                    if let Some(l) = &log {
                        l.line("[sidecar]", line.trim_end());
                    }
                }
                CommandEvent::Stderr(line_bytes) => {
                    eprintln!(
                        "[sidecar:err] {}",
                        String::from_utf8_lossy(&line_bytes).trim_end()
                    );
                    if let Some(l) = &log {
                        l.line(
                            "[sidecar:err]",
                            String::from_utf8_lossy(&line_bytes).trim_end(),
                        );
                    }
                }
                CommandEvent::Terminated(t) => {
                    eprintln!(
                        "[sidecar] terminated: code={:?} signal={:?}",
                        t.code, t.signal
                    );
                    if let Some(l) = &log {
                        l.line(
                            "[sidecar]",
                            &format!("terminated: code={:?} signal={:?}", t.code, t.signal),
                        );
                    }
                    // Flip to Failed on EVERY termination, not just the
                    // pre-announce case: once we've handed out Ready(port),
                    // a later death would otherwise leave get_sidecar_url
                    // returning a URL to a dead process forever. Benign on the
                    // intentional-shutdown path (kill_sidecar during
                    // CloseRequested/ExitRequested) — the app is already
                    // tearing down. No respawn here by design.
                    let msg = if announced {
                        format!("sidecar exited after announcing port (code={:?})", t.code)
                    } else {
                        format!("sidecar exited before announcing port (code={:?})", t.code)
                    };
                    let state = app_handle.state::<SidecarState>();
                    *state.status.lock() = SidecarStatus::Failed(msg);
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// How long the shell waits for the renderer to ask for the window before
/// showing it anyway.
///
/// The main window is created hidden (`visible: false` in tauri.conf.json) so
/// the OS never paints a half-assembled page: the renderer shows it once the
/// boot splash has been committed (`src/lib/window-show.ts`). That hands the
/// window's only route to the screen to renderer code — so a bundle that fails
/// to parse, or throws before its first commit, would leave a running process
/// with no window and no way to reach it but Task Manager.
///
/// This timer is the shell's own guarantee that a launched app always ends up
/// on screen. Like [ADR-0059]'s rescan timeout it is a deadlock breaker, not a
/// latency budget: a healthy launch beats it by an order of magnitude, and
/// reading it as "how long boot may take" is how it would end up tuned down
/// into a race with the renderer it exists to cover for.
const WINDOW_SHOW_FALLBACK_MS: u64 = 4000;

/// Arm [`WINDOW_SHOW_FALLBACK_MS`].
///
/// A plain thread rather than the async runtime: a one-shot sleep needs no
/// executor, and `tokio`'s `time` feature is not enabled in this crate.
fn arm_window_show_fallback(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(WINDOW_SHOW_FALLBACK_MS));
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        // Fail open: an unreadable visibility state resolves to "show it".
        // Showing a visible window is a no-op; never showing one is not.
        if window.is_visible().unwrap_or(false) {
            return;
        }
        eprintln!("[boot] renderer never showed the window — showing it from the shell");
        let log = app.state::<ClientLog>().0.lock().clone();
        if let Some(l) = log {
            l.line(
                "[boot]",
                &format!(
                    "renderer never showed the window — shown by the shell after {WINDOW_SHOW_FALLBACK_MS}ms"
                ),
            );
        }
        let _ = window.show();
        let _ = window.set_focus();
    });
}

fn kill_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let child = state.child.lock().take();
    if let Some(child) = child {
        let _ = child.kill();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .build(),
        )
        .manage(SidecarState::default())
        .manage(ClientLog::default())
        .invoke_handler(tauri::generate_handler![
            get_sidecar_url,
            get_usage_auth_token,
            read_settings,
            write_settings,
            get_credential,
            set_credential,
            get_hub_password,
            set_hub_password,
            log_client_event,
            save_window_geometry
        ])
        .setup(|app| {
            if let Err(e) = spawn_sidecar(app.handle()) {
                eprintln!("[sidecar] startup failed: {e}");
                let state = app.state::<SidecarState>();
                *state.status.lock() = SidecarStatus::Failed(e);
            }
            // After spawn_sidecar, which is where the durable log gets opened —
            // so the fallback has somewhere to record itself if it ever fires.
            arm_window_show_fallback(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Only the main window's close should tear down the sidecar.
            // Without this guard, future secondary windows (settings, etc.)
            // would kill the shared sidecar on close. RunEvent::ExitRequested
            // still catches the all-windows-closed path.
            if window.label() == "main" && matches!(event, WindowEvent::CloseRequested { .. }) {
                kill_sidecar(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error building tauri app")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                kill_sidecar(app_handle);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_happy_path() {
        assert_eq!(parse_listening_line("LISTENING 54321"), Some(54321));
    }

    // --- the renderer's feeder into the durable log (issue #115 / F3) ---

    fn client_log_lines(body: &str) -> Vec<&str> {
        // Skip the launch header `RotatingLog::open` always writes.
        body.lines().skip(1).collect()
    }

    #[test]
    fn renderer_lines_are_prefixed_and_stamped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join("sidecar.log");
        let log = sidecar_log::RotatingLog::open(
            &path,
            sidecar_log::LOG_CAP_BYTES,
            "--- launched v0.0.0 (pid 1) ---",
        )
        .unwrap();

        append_client_line(&log, "manual-refresh: timed out after 120000ms\n");

        let body = std::fs::read_to_string(&path).unwrap();
        let lines = client_log_lines(&body);
        assert_eq!(lines.len(), 1);
        let line = lines[0];
        // `[renderer]`, not `[sidecar]`: a forensic read has to be able to tell
        // which side of the IPC boundary spoke, and a renderer-side timeout is
        // precisely the failure the sidecar's own pipe cannot report.
        assert!(
            line.contains("[renderer] manual-refresh: timed out after 120000ms"),
            "unexpected line: {line}"
        );
        // Stamped like every other line in the file (ADR-0056) — a trailing
        // newline in the message must not become a blank second line either.
        let ts = line.split(' ').next().unwrap_or("");
        assert_eq!(ts.len(), 24, "timestamp `{ts}` should be RFC3339 millis");
    }

    #[test]
    fn a_runaway_line_is_clipped_on_a_char_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join("sidecar.log");
        let log = sidecar_log::RotatingLog::open(
            &path,
            sidecar_log::LOG_CAP_BYTES,
            "--- launched v0.0.0 (pid 1) ---",
        )
        .unwrap();

        // Multi-byte throughout: a byte-wise clip would panic or emit mojibake.
        // Renderer lines embed server error bodies, so one runaway response
        // must not consume a meaningful share of the 5 MB generation that a
        // later incident will need.
        let huge = "—".repeat(CLIENT_LOG_MAX_CHARS + 500);
        append_client_line(&log, &huge);

        let body = std::fs::read_to_string(&path).unwrap();
        let lines = client_log_lines(&body);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].ends_with("… (truncated)"), "should mark the clip");
        let dashes = lines[0].chars().filter(|c| *c == '—').count();
        assert_eq!(dashes, CLIENT_LOG_MAX_CHARS);
    }

    #[test]
    fn an_unopened_log_makes_the_command_a_no_op() {
        // The ADR-0056 degrade path, from this direction: setup may never have
        // filled the handle (a failed open, or a line arriving before spawn).
        // The contract is that the command's body still runs and drops the
        // line — so drive the real body, not just `Option::default()`.
        let state = ClientLog::default();

        append_if_open(&state.0, "manual-refresh: refresh failed");

        assert!(
            state.0.lock().is_none(),
            "a no-op call must not fill the slot"
        );
    }

    #[test]
    fn an_open_log_takes_the_line_through_the_command_body() {
        // The other arm of the same guard: with the handle filled, the command
        // body must reach `append_client_line` and land exactly one record.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join("sidecar.log");
        let log = std::sync::Arc::new(
            sidecar_log::RotatingLog::open(
                &path,
                sidecar_log::LOG_CAP_BYTES,
                "--- launched v0.0.0 (pid 1) ---",
            )
            .unwrap(),
        );
        let state = ClientLog(Mutex::new(Some(log)));

        append_if_open(&state.0, "manual-refresh: refresh failed");

        let body = std::fs::read_to_string(&path).unwrap();
        let lines = client_log_lines(&body);
        assert_eq!(lines.len(), 1);
        assert!(
            lines[0].contains("[renderer] manual-refresh: refresh failed"),
            "unexpected line: {}",
            lines[0]
        );
    }

    #[test]
    fn parses_with_trailing_newline() {
        assert_eq!(parse_listening_line("LISTENING 1024\n"), Some(1024));
    }

    #[test]
    fn parses_with_surrounding_whitespace() {
        assert_eq!(parse_listening_line("   LISTENING 8080   "), Some(8080));
    }

    #[test]
    fn parses_inner_whitespace_around_port() {
        assert_eq!(parse_listening_line("LISTENING   42\n"), Some(42));
    }

    #[test]
    fn rejects_missing_port() {
        assert_eq!(parse_listening_line("LISTENING"), None);
        assert_eq!(parse_listening_line("LISTENING "), None);
    }

    #[test]
    fn rejects_non_numeric_port() {
        assert_eq!(parse_listening_line("LISTENING abc"), None);
    }

    #[test]
    fn rejects_port_above_u16() {
        assert_eq!(parse_listening_line("LISTENING 70000"), None);
    }

    #[test]
    fn rejects_unrelated_lines() {
        assert_eq!(parse_listening_line(""), None);
        assert_eq!(parse_listening_line("OTHER 1234"), None);
        assert_eq!(parse_listening_line("listening 1234"), None);
        assert_eq!(parse_listening_line("[sidecar] LISTENING 1234"), None);
    }

    #[test]
    fn read_settings_absent_file_is_empty_object() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert_eq!(read_settings_at(&path).unwrap(), serde_json::json!({}));
    }

    #[test]
    fn read_settings_parses_valid_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"costMode":"calculate"}"#).unwrap();
        assert_eq!(
            read_settings_at(&path).unwrap(),
            serde_json::json!({ "costMode": "calculate" })
        );
    }

    #[test]
    fn read_settings_tolerates_malformed_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{ this is not json ").unwrap();
        // Tolerant (f23): a corrupt file reads as empty so it self-heals on the
        // next write, instead of stranding the renderer in an error state.
        assert_eq!(read_settings_at(&path).unwrap(), serde_json::json!({}));
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let value = serde_json::json!({ "timezone": "America/Chicago", "costMode": "auto" });
        write_settings_at(&path, &value).unwrap();
        assert_eq!(read_settings_at(&path).unwrap(), value);
    }

    #[test]
    fn write_leaves_no_temp_sibling() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        write_settings_at(&path, &serde_json::json!({ "costMode": "display" })).unwrap();
        let leftovers: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");
    }
}
