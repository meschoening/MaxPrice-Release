mod ambient;
mod autostart;
#[cfg(windows)]
mod job_object;
#[cfg(any(target_os = "macos", test))]
mod macos_popout;
mod popout;
mod sidecar_log;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

use parking_lot::Mutex;
use tauri::tray::{MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
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
fn save_window_geometry(window: tauri::Window, app: AppHandle) -> Result<(), String> {
    require_main_window(window.label(), "save_window_geometry")?;
    app.save_window_state(window_state_flags())
        .map_err(|e| format!("window state save: {e}"))
}

/// Refuse a privileged command invoked from any window but `main`.
///
/// `capabilities/popout.json` does NOT gate the app's own #[tauri::command]s:
/// tauri only ACL-screens those when the app ships an app-level ACL manifest,
/// which this crate deliberately does not — so at a local origin every command
/// is reachable from every window, the popout included (the hub's finding,
/// ADR-0050; map #168 M2). The popout is a glance surface that reads reports
/// over loopback HTTP; every secret-bearing or state-mutating command carries
/// this guard so a compromised or merely buggy popout renderer can neither
/// read the keychain nor rewrite settings.
///
/// Takes the label rather than the `&Window` (which cannot be constructed
/// outside a running app) so the refusal is unit-testable.
fn require_main_window(label: &str, command: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err(format!("{command} is main-window-only"))
    }
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
fn get_usage_auth_token(
    window: tauri::Window,
    state: State<'_, SidecarState>,
) -> Result<String, String> {
    require_main_window(window.label(), "get_usage_auth_token")?;
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
fn write_settings(
    window: tauri::Window,
    app: AppHandle,
    next: serde_json::Value,
) -> Result<(), String> {
    require_main_window(window.label(), "write_settings")?;
    write_settings_at(&settings_path(&app)?, &next)?;
    // Kick the ambient readout poller (map #168 M3; T5 decision 3): the poller
    // re-reads settings.json per poll, so this makes a costMode/timezone flip
    // update the tray readout immediately instead of up-to-60s later.
    ambient::kick(&app.state::<ambient::AmbientState>());
    Ok(())
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
fn get_credential(window: tauri::Window) -> Result<Option<String>, String> {
    require_main_window(window.label(), "get_credential")?;
    match credential_entry()?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read: {e}")),
    }
}

#[tauri::command]
fn set_credential(window: tauri::Window, value: Option<String>) -> Result<(), String> {
    require_main_window(window.label(), "set_credential")?;
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
fn get_hub_password(window: tauri::Window) -> Result<Option<String>, String> {
    require_main_window(window.label(), "get_hub_password")?;
    match hub_password_entry()?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read: {e}")),
    }
}

#[tauri::command]
fn set_hub_password(window: tauri::Window, value: Option<String>) -> Result<(), String> {
    require_main_window(window.label(), "set_hub_password")?;
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
                            // The ambient poller's first pass races this
                            // handshake and vanishes on a Pending port; the
                            // kick repolls now instead of leaving the tray
                            // readout bare for its first full minute (M3).
                            ambient::kick(&app_handle.state::<ambient::AmbientState>());
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

/// Whether the [`WINDOW_SHOW_FALLBACK_MS`] force-show is still owed.
///
/// The timer's proposition is "did anyone ever decide where this window
/// belongs?" — not "is the window on screen right now". Gating it on
/// visibility alone confuses the two, and ADR-0079 is precisely the ADR that
/// stopped window state from being a proxy for app intent: the renderer shows
/// the window at ~1s, which leaves ~3s in which a close-to-tray HIDES it, and
/// the timer then wakes to find a hidden window, re-shows the one the user
/// just dismissed, steals focus, and writes "renderer never showed the window"
/// into the durable log moments after the first-close toast said the opposite.
///
/// A close inside that window is the user answering the timer's question, on
/// BOTH branches (hide-to-tray and `app.exit(0)`), so both cancel.
#[derive(Default)]
struct WindowShowFallback {
    cancelled: AtomicBool,
}

/// The force-show decision, pure so both arms are unit-testable without a
/// window, an event loop, or a four-second sleep.
///
/// Visibility fails OPEN (an unreadable state resolves to "show it": showing a
/// visible window is a no-op, never showing one is not), but an explicit
/// cancel outranks it in both directions.
///
/// Deliberately NOT covered: macOS `Cmd+H` (app-hide) inside the same 4s has
/// the identical shape — a user gesture the timer cannot see — and
/// cancel-on-close does not reach it. Covering it needs a renderer→shell "I
/// showed it" signal, since Tauri 2 emits no `Shown` window event; that is a
/// cross-layer change for a much rarer gesture, and this fix does not make it
/// harder.
fn should_force_show(cancelled: bool, visible: bool) -> bool {
    !cancelled && !visible
}

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
        let cancelled = app
            .state::<WindowShowFallback>()
            .cancelled
            .load(Ordering::Relaxed);
        if !should_force_show(cancelled, window.is_visible().unwrap_or(false)) {
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
        // Ahead of the show, for `show_main_window`'s reason. Inert on the
        // ordinary launch (the tile is already there) and load-bearing on the
        // one path that reaches here with it hidden.
        set_dock_icon_visible(&app, true);
        let _ = window.show();
        let _ = window.set_focus();
        // This is a route to the screen that `show_main_window` does not own,
        // so it carries the `main:shown` poke itself (F9) — a renderer that
        // booted paused (a `--hidden` seed) must not stay paused behind a
        // window the shell just rescued.
        let _ = window.emit_to("main", popout::MAIN_SHOWN_EVENT, ());
    });
}

fn kill_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let child = state.child.lock().take();
    if let Some(child) = child {
        let _ = child.kill();
    }
}

/// Background residency (map #168 / M1): does closing the main window hide it
/// rather than quit? Reads `keepRunningInBackground` straight out of the raw
/// settings.json value — the shell cannot run the Zod schema, so this mirrors
/// its semantics by hand: absent or non-bool → true (`.default(true)` /
/// `.catch(true)` in packages/shared/src/settings.ts — keep in lockstep).
fn background_residency_enabled(settings: &serde_json::Value) -> bool {
    match settings.get("keepRunningInBackground") {
        Some(serde_json::Value::Bool(b)) => *b,
        _ => true,
    }
}

/// The tray popout's Model-scoped-limit opt-in: reads `showModelLimit`
/// straight out of the raw settings.json value, mirroring the schema by hand
/// like `background_residency_enabled` — absent or non-bool → false
/// (`.default(false)` / `.catch(false)` in packages/shared/src/settings.ts —
/// keep in lockstep). ANDed with the readout's `has_model_window` to size the
/// popout: the renderer draws the row under exactly those two bits.
fn model_limit_row_enabled(settings: &serde_json::Value) -> bool {
    matches!(
        settings.get("showModelLimit"),
        Some(serde_json::Value::Bool(true))
    )
}

/// The first-close toast's persisted once-flag (map #168 / M1): a marker file
/// in the app-data dir, NOT a settings.json field — the renderer is the sole
/// writer of settings.json, and a Rust-side write would race its
/// read-modify-write and get silently clobbered.
///
/// Windows-only in use (the toast is charter decision 9), but compiled
/// everywhere so the once-per-install claim stays unit-tested off the primary.
#[cfg_attr(not(windows), allow(dead_code))]
const FIRST_CLOSE_TOAST_MARKER: &str = "first-close-toast-shown";

/// Claim the one-time first-close toast: true exactly once per install.
/// `create_new` is an atomic create-if-absent, so even two racing closes can't
/// both claim it. Any error (marker exists, dir unwritable) means "don't
/// toast" — a lost toast is strictly better than a repeated one.
#[cfg_attr(not(windows), allow(dead_code))]
fn claim_first_close_toast(app_data_dir: &Path) -> bool {
    let _ = fs::create_dir_all(app_data_dir);
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(app_data_dir.join(FIRST_CLOSE_TOAST_MARKER))
        .is_ok()
}

/// One-time Windows-only disclosure (map #168 charter decision 9): the first
/// close that hides instead of quits tells the user where the app went.
#[cfg(windows)]
fn show_first_close_toast_once(app: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    if !claim_first_close_toast(&dir) {
        return;
    }
    let _ = app
        .notification()
        .builder()
        .title("MaxPrice is still running")
        .body("Closing the window keeps MaxPrice in the system tray. Turn this off in Settings.")
        .show();
}

// ---------- Autostart (map #168 / M4; ADR-0077, ADR-0051's arrangement) ----
// The "Start at login" toggle, OPT-IN with the OS login entry as the only
// record of the choice: no settings.json field exists, so the Settings row can
// never assert a state the registry disagrees with. `enable()` registers with
// the `--hidden` launch arg (charter decision 8), so a login launch is
// tray-only; the pure policy lives in `autostart.rs`.

/// Facts about how this process was launched, decided once in `run()`.
struct LaunchFlags {
    /// `--hidden` on the command line — the autostart entry's launch arg. A
    /// hidden launch never shows the main window: the renderer's
    /// `showAppWindow()` asks this via `launched_hidden`, and the shell's own
    /// 4s force-show fallback is never armed (charter decision 8). The tray is
    /// the only presence; tray Open and a second manual launch still show.
    hidden: bool,
}

/// Read-only: was this process launched with `--hidden`? Callable from any
/// window — it holds no secret and mutates nothing, so no
/// `require_main_window` guard.
#[tauri::command]
fn launched_hidden(flags: State<'_, LaunchFlags>) -> bool {
    flags.hidden
}

/// One reading of the login entry: what exe we are, whether we are allowed to
/// own the entry, and what the entry currently says.
#[cfg(windows)]
struct AutostartProbe {
    exe: PathBuf,
    installed: bool,
    registered: Option<String>,
    entry: autostart::Entry,
}

// The ONE registry probe. `reconcile_autostart` ACTS on it, `autostart_status`
// REPORTS it, `set_autostart` gates on it — they must never disagree about the
// same HKCU, or the Settings row asserts a verdict the self-heal never acted
// on. Takes the app NAME, not the `AppHandle`: `package_info()` hands back a
// borrow that cannot cross into a `spawn_blocking`.
#[cfg(windows)]
fn probe_autostart(app_name: &str) -> std::io::Result<AutostartProbe> {
    let exe = std::env::current_exe()?;
    let installed = autostart::is_installed_build(&exe, cfg!(debug_assertions));
    let (registered, disabled) = autostart::read_registry(app_name);
    let entry = autostart::classify(registered.as_deref(), disabled, &exe.to_string_lossy());
    Ok(AutostartProbe {
        exe,
        installed,
        registered,
        entry,
    })
}

/// Keep an EXISTING login entry pointing at the running install (map #168 /
/// M4). Repair-only — the divergence from the hub's ADR-0051, whose boot pass
/// also registers: the client is opt-in and the entry is the only record of
/// the user's choice, so an absent entry means "never asked" and must stay
/// absent. Runs in setup — a few microseconds of registry read.
#[cfg(windows)]
fn reconcile_autostart(app: &AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    // Deliberately the SAME EXPRESSION the plugin resolves its app_name from
    // (`set_app_name(&app.package_info().name)`), not a hardcoded "MaxPrice".
    // A constant that drifted from productName would have us reading one Run
    // value and `enable()` writing another — a duplicate login entry.
    let probe = match probe_autostart(&app.package_info().name) {
        Ok(probe) => probe,
        Err(e) => {
            eprintln!("[autostart] current_exe failed: {e}");
            return;
        }
    };
    // A build out of the tree must neither register NOR repair: whoever owns
    // the entry gets launched at login, and if that is a dev build the
    // installed app never runs, so it never gets the chance to reclaim it.
    if !probe.installed {
        return;
    }
    match autostart::decide_at_boot(probe.entry) {
        autostart::Action::Leave => {}
        autostart::Action::Repair => {
            eprintln!(
                "[autostart] stale login entry -> {}; repointing at {}",
                probe.registered.as_deref().unwrap_or("").trim(),
                probe.exe.display()
            );
            if let Err(e) = app.autolaunch().enable() {
                eprintln!("[autostart] enable failed: {e}");
            }
        }
    }
}

/// macOS/Linux: nothing to reconcile. Linux has no autostart in this map (T6
/// ruled it out — a windowless launch on a host-less session strands the
/// user), and on macOS the LaunchAgent plist is written by us into our own
/// per-user path, so the Windows staleness mechanics (#95) have no
/// counterpart; whether a plist self-heal is ever needed is M5's question,
/// answered on Apple hardware rather than speculated here.
#[cfg(not(windows))]
fn reconcile_autostart(_app: &AppHandle) {}

/// Does this app actually start at login? "on" | "disabled-by-user" |
/// "not-registered" | "dev-build" | "unsupported". Read fresh on every call
/// rather than remembered from setup, so a user flipping the Task Manager
/// switch is eventually reflected instead of our expectation of it (ADR-0051;
/// the renderer re-asks on a slow poll — see use-autostart.ts for why not on
/// focus). `async` on purpose: this does host I/O (two HKCU opens), which must
/// not run inline on the invoke thread.
#[tauri::command]
async fn autostart_status(app: AppHandle) -> Result<String, String> {
    #[cfg(windows)]
    {
        // Same expression as reconcile_autostart — see the note there.
        // `package_info()` borrows the app; take the String before crossing.
        let name = app.package_info().name.clone();
        let probe = tauri::async_runtime::spawn_blocking(move || probe_autostart(&name))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        Ok(autostart::report(probe.entry, probe.installed).to_string())
    }
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_autostart::ManagerExt;
        // The plugin owns the LaunchAgent plist wholesale; existence is the
        // state, and there is no Task-Manager-style opt-out to read.
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        if !autostart::is_installed_build(&exe, cfg!(debug_assertions)) {
            return Ok("dev-build".into());
        }
        Ok(if app.autolaunch().is_enabled().unwrap_or(false) {
            "on".into()
        } else {
            "not-registered".into()
        })
    }
    #[cfg(target_os = "linux")]
    {
        // Autostart is out of scope on Linux (T6/map #168): a windowless
        // launch on a session with no StatusNotifierHost strands the user.
        let _ = &app;
        Ok("unsupported".into())
    }
}

/// The Settings toggle's writer. Dev builds are refused outright — the UI
/// disables the toggle on "dev-build", this guard is what makes that true —
/// and enabling under a Task Manager opt-out deliberately re-enables: the boot
/// pass may never resurrect an opt-out (ADR-0051), but the toggle IS the user
/// asking, today. Returns the fresh post-write status so the renderer can
/// settle its row without a second round trip.
#[tauri::command]
async fn set_autostart(
    window: tauri::Window,
    app: AppHandle,
    enable: bool,
) -> Result<String, String> {
    require_main_window(window.label(), "set_autostart")?;
    #[cfg(windows)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let name = app.package_info().name.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
            let probe = probe_autostart(&name).map_err(|e| e.to_string())?;
            if !probe.installed {
                return Err("autostart is unavailable in dev builds".into());
            }
            if enable {
                app.autolaunch().enable().map_err(|e| e.to_string())?;
            } else if !matches!(probe.entry, autostart::Entry::Absent) {
                // disable() deletes the Run value; deleting an absent one is
                // at best a no-op and at worst an error dressed as one.
                app.autolaunch().disable().map_err(|e| e.to_string())?;
            }
            let probe = probe_autostart(&name).map_err(|e| e.to_string())?;
            Ok(autostart::report(probe.entry, probe.installed).to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_autostart::ManagerExt;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        if !autostart::is_installed_build(&exe, cfg!(debug_assertions)) {
            return Err("autostart is unavailable in dev builds".into());
        }
        let autolaunch = app.autolaunch();
        if enable {
            autolaunch.enable().map_err(|e| e.to_string())?;
        } else if autolaunch.is_enabled().unwrap_or(false) {
            autolaunch.disable().map_err(|e| e.to_string())?;
        }
        Ok(if autolaunch.is_enabled().unwrap_or(false) {
            "on".into()
        } else {
            "not-registered".into()
        })
    }
    #[cfg(target_os = "linux")]
    {
        let _ = (&app, enable);
        Err("autostart is not available on Linux".into())
    }
}

// ---------- Tray popout (ADR-0050; map #168 / M2) ----------
// The tray exists always while the app runs (charter decision 10): BOTH tray
// clicks summon the pre-created hidden `popout` window (its UI carries Open /
// Quit — M3), and the popout dismisses on focus loss or Esc. Window
// manipulation all lives here in Rust; the math is `popout.rs`, pure and
// unit-tested, ported wholesale from the hub.

#[derive(Default)]
struct PopoutState {
    // When Focused(false) last hid the popout. A tray click landing within
    // BLUR_DEBOUNCE_MS of it is the click that CAUSED the blur — Windows
    // deactivates on mousedown but delivers the tray Click on mouseup
    // (tauri #8869) — so re-showing would turn a toggle-close into a flicker.
    last_blur_hide: Mutex<Option<Instant>>,
}

// The tray event's rect arrives in physical pixels (tray-icon emits physical;
// tauri wraps them in Position/Size enums). to_physical(1.0) passes physical
// values through untouched — the positioner plugin reads it the same way.
fn tray_rect_px(rect: &tauri::Rect) -> popout::Px {
    let pos = rect.position.to_physical::<f64>(1.0);
    let size = rect.size.to_physical::<f64>(1.0);
    popout::Px::new(pos.x, pos.y, size.width, size.height)
}

// The popout's configured LOGICAL size, straight from tauri.conf.json — the
// window definition stays the single source, so the size we re-assert can
// never drift from the one the CSS layout was drawn against.
//
// Takes the Config rather than the AppHandle so a test can hand it a
// `tauri.conf.json` parsed off disk — no app, no event loop.
fn popout_logical_size(config: &tauri::Config) -> Option<(f64, f64)> {
    config
        .app
        .windows
        .iter()
        .find(|w| w.label == popout::POPOUT_LABEL)
        .map(|w| (w.width, w.height))
}

// Round the popout's corners on macOS — ADR-0050's deferred aspiration, taken
// without the cost that deferred it. That ADR ruled the window opaque because
// Tauri's `transparent: true` is the obvious lever and macOS gates it behind
// the `macos-private-api` feature; what it did not weigh is that AppKit will
// round a window through entirely PUBLIC API. Mask the content view's layer to
// a rounded rect and stop the window painting its own ground behind it: the
// webview is a layer-backed subview, so the mask clips it too, and the window
// stays opaque everywhere the mask keeps.
//
// Called once, at setup, on a window that is only ever hidden and shown —
// neither of which disturbs a layer mask, so there is nothing to re-assert per
// open (unlike geometry, which DPI drift really does strand — see
// `popout_physical_size`).
//
// Every failure here is cosmetic by construction: a popout with square corners
// is the shipped v1. So each step degrades in place with a log rather than
// unwinding, and none of them can leave the window half-styled in a way that
// hides content.
#[cfg(target_os = "macos")]
fn round_popout_corners(window: &tauri::WebviewWindow, radius: f64) {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSColor, NSView, NSWindow};

    let ptr = match window.ns_window() {
        Ok(ptr) => ptr,
        Err(e) => {
            eprintln!("[popout] no NSWindow — corners stay square: {e}");
            return;
        }
    };
    // SAFETY: `ns_window()` returns this window's live NSWindow, retained by
    // the window itself for as long as it exists; we borrow it for this call
    // only. Setup runs on the main thread, which is where every AppKit call
    // below is required to happen.
    let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };

    let Some(content) = ns_window.contentView() else {
        eprintln!("[popout] NSWindow has no content view — corners stay square");
        return;
    };
    let content: Retained<NSView> = content;

    // The mask alone would cut the corners out of an OPAQUE window, and macOS
    // would keep painting the window's own background in the gap. Clearing both
    // is what makes the cut-away actually transparent — and it is not the
    // `transparent: true` ADR-0050 declined: the webview still paints an opaque
    // ground over every pixel the mask keeps, so there is no first-paint flash
    // and no vibrancy behind it.
    ns_window.setOpaque(false);
    ns_window.setBackgroundColor(Some(&NSColor::clearColor()));

    content.setWantsLayer(true);
    match content.layer() {
        Some(layer) => {
            layer.setCornerRadius(radius);
            layer.setMasksToBounds(true);
        }
        None => eprintln!("[popout] content view has no layer — corners stay square"),
    }
    // The system shadow is traced from the window's opaque shape, which we just
    // changed; without this it keeps the square outline it cached at creation
    // and the popout wears a shadow with corners the window no longer has.
    ns_window.invalidateShadow();
}

/// Hide the popout AND tell it so — the only way this app hides that window.
///
/// The popout is hidden from five places (tray toggle-close, the popout's
/// "Open MaxPrice" row, Esc, focus-loss dismissal, Alt+F4) and every one of
/// them must emit, because the popout webview cannot observe its own window
/// leaving the screen — see popout.rs's "Window-visibility events" note. One
/// helper is the whole discipline: a bare `window.hide()` added later would
/// silently reinstate a popout polling four sidecar endpoints forever behind a
/// window nobody can see.
///
/// Takes the `AppHandle` rather than a window so the `on_window_event` sites
/// (which are handed a `Window`, not a `WebviewWindow`) can route through it
/// too. A missing popout window is a no-op — the same shrug every other
/// lookup here gives.
fn hide_popout_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(popout::POPOUT_LABEL) else {
        return;
    };
    let _ = window.hide();
    let _ = window.emit_to(popout::POPOUT_LABEL, popout::POPOUT_HIDDEN_EVENT, ());
}

fn toggle_popout(app: &AppHandle, rect: &tauri::Rect) {
    let Some(window) = app.get_webview_window(popout::POPOUT_LABEL) else {
        eprintln!("[popout] popout window missing — tray click does nothing");
        return;
    };

    // One decision, one lock: the blur stamp is read AND consumed under the
    // same guard, so the swallow can't be replayed by a second click.
    let action = {
        let state = app.state::<PopoutState>();
        let mut stamp = state.last_blur_hide.lock();
        let action = popout::tray_click_action(
            window.is_visible().unwrap_or(false),
            stamp.map(|at| at.elapsed()),
        );
        if action == popout::TrayClick::Swallow {
            *stamp = None;
        }
        action
    };
    match action {
        popout::TrayClick::Hide => {
            // Direct toggle-close (macOS, or a Windows click that somehow kept
            // focus). No debounce stamp — that belongs to blur alone.
            hide_popout_window(app);
            return;
        }
        // The mousedown of THIS click already blurred-and-hid the popout;
        // swallowing the mouseup Click is what makes the toggle close.
        popout::TrayClick::Swallow => return,
        popout::TrayClick::Show => {}
    }

    // Snapshot the clicked screen before settings IO, never from the hidden
    // popout's previous monitor. The macOS adapter owns the coordinate units.
    #[cfg(target_os = "macos")]
    let anchor = macos_popout::capture(rect);
    let (model_row, update_pending) = {
        let ambient = app.state::<ambient::AmbientState>();
        let model_window = *ambient.model_window.lock();
        let update_pending = ambient.pending_update.lock().is_some();
        // The row is an opt-in (Settings › Claude account) on top of the
        // wire's presence bit; settings.json is re-read here rather than
        // cached so a flip on the Settings page lands on the very next
        // open (the poller's own re-read is up to 60s behind it).
        let enabled = settings_path(app)
            .and_then(|p| read_settings_at(&p))
            .map(|v| model_limit_row_enabled(&v))
            .unwrap_or(false);
        (model_window && enabled, update_pending)
    };
    let logical = popout_logical_size(app.config())
        .map(|(w, _)| (w, popout::popout_content_height(model_row, update_pending)));
    if let Some(logical) = logical {
        #[cfg(target_os = "macos")]
        {
            let placed = anchor.as_ref().and_then(|a| a.placement(logical));
            if let Some(p) = placed {
                if let Err(error) = macos_popout::apply(&window, p) {
                    eprintln!("[popout] positioning failed: {error}");
                }
            } else {
                // No placement: keep the last position (ADR-0084 — never
                // guess a display) but still apply the configured size, which
                // the pre-adapter path wrote unconditionally. tao's queued
                // setter is fine here: nothing changes display, so the
                // activation ordering apply() exists for is moot.
                match &anchor {
                    Some(a) => eprintln!(
                        "[popout] no screen for the click — showing at last position: {a:?} size={logical:?}"
                    ),
                    None => eprintln!(
                        "[popout] no native screen snapshot (off main thread) — showing at last position"
                    ),
                }
                let _ = window.set_size(tauri::LogicalSize::new(logical.0, logical.1));
            }
        }
        if !cfg!(target_os = "macos") {
            place_popout_physical(app, &window, rect, logical);
        }
    }
    // Strictly show THEN focus: tao no-ops set_focus on an invisible window
    // (macOS), and an unfocused show can't blur-dismiss (#7884) — while on
    // Windows a re-shown-without-focus window stops firing blur entirely
    // (#13633). The focus is what makes focus-loss dismissal work at all.
    //
    // show() is the one call on this path with no fallback: if it fails the
    // tray click did nothing at all and the user has no way to find out, so it
    // gets a log. size/position/focus stay best-effort — each degrades into a
    // popout that is merely mispositioned or unfocused, not absent.
    if let Err(e) = window.show() {
        eprintln!("[popout] popout show failed: {e}");
    }
    let _ = window.set_focus();
    // Tell the popout webview it just came on screen (map #168 M3): its
    // queries refetch on this poke. An explicit event because WebView2's
    // `visibilityState` never flips on hide/show (charter decision 11), so the
    // renderer cannot observe its own window appearing.
    let _ = window.emit_to(popout::POPOUT_LABEL, popout::POPOUT_SHOWN_EVENT, ());
}

// Windows retains physical pixels and the two passes required by WM_DPICHANGED.
fn place_popout_physical(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    rect: &tauri::Rect,
    logical: (f64, f64),
) {
    let tray = tray_rect_px(rect);
    // On Windows the tray, monitor bounds, work area, and setter all use
    // the same global physical-pixel coordinates.
    let monitors = app.available_monitors().unwrap_or_default();
    let bounds: Vec<popout::Px> = monitors
        .iter()
        .map(|m| {
            popout::Px::new(
                m.position().x as f64,
                m.position().y as f64,
                m.size().width as f64,
                m.size().height as f64,
            )
        })
        .collect();
    let monitor = popout::monitor_containing(&bounds, tray.x + tray.w / 2.0, tray.y + tray.h / 2.0)
        .map(|i| monitors[i].clone())
        .or_else(|| app.primary_monitor().ok().flatten());
    // Position when we can, but never let missing monitor/size info keep the
    // popout from opening — the stale position beats no popout at all.
    if let Some(monitor) = monitor {
        let mon = popout::Px::new(
            monitor.position().x as f64,
            monitor.position().y as f64,
            monitor.size().width as f64,
            monitor.size().height as f64,
        );
        let wa = monitor.work_area();
        let work = popout::Px::new(
            wa.position.x as f64,
            wa.position.y as f64,
            wa.size.width as f64,
            wa.size.height as f64,
        );

        let scale = monitor.scale_factor();
        let place = || {
            // Reassert size using the destination's DPI, never the stale
            // per-window scale that a hidden WM_DPICHANGED can leave behind.
            match popout::popout_inner_size(logical, scale, false) {
                Some(popout::InnerSize::Logical(w, h)) => {
                    let _ = window.set_size(tauri::LogicalSize::new(w, h));
                }
                Some(popout::InnerSize::Physical(w, h)) => {
                    let _ = window
                        .set_size(tauri::PhysicalSize::new(w.round() as u32, h.round() as u32));
                }
                // Nothing describable to assert — leave the window at
                // whatever it already measures and still place it.
                None => {}
            }
            // Position speaks the OUTER box (set_position moves the outer
            // rect, and an undecorated Win11 window still carries an
            // invisible resize frame — 22x13px at 150%). Read it back AFTER
            // the correction so that frame delta is measured on a
            // right-sized window. It also speaks PHYSICAL on every
            // platform, so the fallback is still derived — config x the
            // target monitor's scale — with the configured logical size as
            // the last resort.
            let anchor = popout::popout_physical_size(logical, scale);
            let Some(pop) = window
                .outer_size()
                .map(|s| (s.width as f64, s.height as f64))
                .ok()
                .or(anchor)
            else {
                // No physical size from either source. Placing off the
                // LOGICAL pair instead would silently mix units (half the
                // real box on a 2x display), so leave the popout where it
                // is — it still shows, which is the standing trade here.
                return;
            };
            let (x, y) = popout::popout_position(tray, mon, work, pop, false);
            let _ = window.set_position(tauri::PhysicalPosition::new(
                x.round() as i32,
                y.round() as i32,
            ));
        };
        // TWICE, on purpose. Moving the popout to a monitor whose scale
        // differs from the one it was last parked on makes Windows deliver
        // WM_DPICHANGED *synchronously inside our own set_position*, and
        // tao's handler answers it by rescaling the window itself
        // (old physical → old logical → new physical) and SetWindowPos-ing
        // to Windows' suggested rect. So the first pass's work is undone as
        // it lands: a 236px popout re-sized 236/1.5 ≈ 157px — the exact
        // collapse ADR-0050 exists to kill — and moved somewhere we did not
        // choose. The second pass runs after that rescale, re-asserting the
        // size AND re-reading `outer_size` so the invisible-frame delta is
        // finally measured at the DESTINATION monitor's DPI.
        //
        // Not gated on a scale comparison: `window.scale_factor()` is the
        // cached per-window value this whole routine distrusts. With no DPI
        // event the second pass is an idempotent no-op, and the window is
        // still hidden either way (`show()` is below), so nothing flickers.
        place();
        place();
    }
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    // Per-platform base icon (map #168 M3): macOS wears the black+alpha
    // template `$` glyph (T4 decision 5 — the color orb is unusable as a
    // template and un-Mac-like untemplated); everywhere else the bundle icon.
    // The initial tooltip is the ambient writer's vanish state — the bare app
    // name — which the first readout poll replaces within seconds.
    #[cfg(target_os = "macos")]
    let builder = TrayIconBuilder::with_id(ambient::TRAY_ID)
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/tray-mac.png"
        ))?)
        .icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let builder = TrayIconBuilder::with_id(ambient::TRAY_ID)
        .tooltip("MaxPrice")
        .icon(app.default_window_icon().unwrap().clone());
    builder
        .on_tray_icon_event(|tray, event| {
            // BOTH buttons, on release — the popout replaces any menu, so
            // left and right click mean the same thing (ADR-0050).
            if let TrayIconEvent::Click {
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle_popout(tray.app_handle(), &rect);
            }
        })
        .build(app)?;

    Ok(())
}

// ---------- macOS Dock tile (map #168 / ADR-0082) ----------
// The Dock tile belongs to the PROCESS, not to any window: an app left on the
// default Regular activation policy keeps its tile with zero windows on
// screen, which is why ADR-0079's close-to-tray left behind an icon that
// opened nothing. The tile is therefore a fifth thing every route to and from
// the screen has to carry, and it gets the same discipline as the four before
// it (popout.rs's "Window-visibility events"): ONE helper, called from every
// show and hide site, so the tile can never disagree with the window it
// stands for.
//
// `set_dock_visibility` rather than `set_activation_policy`: it is the
// purpose-built call (it also pins visible windows on screen across the
// transform) and it carries tao's 1s guard against the macOS bug where rapid
// process-type transforms strand DUPLICATE Dock icons — a bug this feature
// would otherwise court every time the window opens and closes. The guard's
// price is `arm_dock_hide_reassert` below.
#[cfg(target_os = "macos")]
fn apply_dock_visibility(app: &AppHandle, visible: bool) {
    if let Err(e) = app.set_dock_visibility(visible) {
        eprintln!("[dock] set_dock_visibility({visible}) failed: {e}");
    }
}

// No-op off macOS, so no call site needs a `cfg` and a later one cannot forget
// the platform: Windows drops the taskbar button with the window itself, and
// Linux ships no residency at all (T6).
#[cfg(not(target_os = "macos"))]
fn apply_dock_visibility(_app: &AppHandle, _visible: bool) {}

/// Bumped by every assertion that the tile is VISIBLE — which is to say by
/// every route back to the screen, since `set_dock_icon_visible` is the one
/// helper all of them call. [`arm_dock_hide_reassert`] samples it at the hide
/// and again past tao's guard: an unchanged reading is the only proof that
/// nothing brought the window back, and window visibility alone cannot supply
/// it (see [`should_reassert_dock_hide`]).
static DOCK_SHOW_GENERATION: AtomicU64 = AtomicU64::new(0);

/// The ONE helper every show and hide site calls (see the note above), so the
/// tile can never disagree with the window it stands for — and, being also
/// its only writer, so the show generation can never drift from the shows it
/// counts.
fn set_dock_icon_visible(app: &AppHandle, visible: bool) {
    if visible {
        DOCK_SHOW_GENERATION.fetch_add(1, Ordering::Relaxed);
    }
    apply_dock_visibility(app, visible);
}

/// How long after a hide the Dock tile is re-checked — just past tao's own
/// `DOCK_SHOW_TIMEOUT` of 1s. See [`should_reassert_dock_hide`].
const DOCK_HIDE_REASSERT_MS: u64 = 1200;

/// Does a hidden main window still owe a Dock hide?
///
/// tao's `set_dock_visibility(false)` returns EARLY when a show happened
/// within the last second — its own guard against the duplicate-icon bug.
/// That makes one ordinary gesture silently lossy: open from the tray, Cmd+W
/// straight away, and the tile outlives the window for good. So every hide
/// arms one re-check past the guard's window — a reopen inside those 1.2s is
/// the user having answered otherwise, and re-hiding the tile under a window
/// they are looking at is the one outcome worse than a tile that lingers.
///
/// "Still off screen" is deliberately NOT read off the window alone: macOS
/// reports `isVisible == false` for a MINIMIZED or `Cmd+H`'d window too, and
/// both of those belong in the Dock by definition. Close to tray, reopen from
/// the tray, then Cmd+M just past tao's 1s guard, and a visibility-only
/// re-check drops the tile for a window the user had that moment put INTO the
/// Dock — recoverable only via tray Open. So the deciding input is
/// `shown_since`: did any route back to the screen run since this re-check was
/// armed ([`DOCK_SHOW_GENERATION`])? Visibility stays as the second half of
/// the AND, covering the reverse case — a window on screen that the
/// generation never saw come back.
///
/// Both inputs fail CLOSED, the mirror of [`should_force_show`]'s open: an
/// unreadable window state resolves to "leave it alone", because a wrong
/// re-hide (a visible window with no tile, and no gesture that clears it) is
/// worse than a wrong skip (a tile the next close takes away).
fn should_reassert_dock_hide(main_visible: Option<bool>, shown_since: bool) -> bool {
    !shown_since && main_visible == Some(false)
}

/// Arm [`DOCK_HIDE_REASSERT_MS`]. A plain thread, for the same reason
/// `arm_window_show_fallback` uses one: a one-shot sleep needs no executor.
/// Returns immediately off macOS rather than being `cfg`'d out at the call
/// site, keeping the hide path one straight line on every platform.
fn arm_dock_hide_reassert(app: &AppHandle) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let app = app.clone();
    // Sampled HERE, on the hide path, rather than inside the thread: the
    // question is what happened AFTER this hide, and a first reading taken
    // 1.2s later would already have missed it.
    let armed_at = DOCK_SHOW_GENERATION.load(Ordering::Relaxed);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(DOCK_HIDE_REASSERT_MS));
        let visible = app
            .get_webview_window("main")
            .and_then(|w| w.is_visible().ok());
        let shown_since = DOCK_SHOW_GENERATION.load(Ordering::Relaxed) != armed_at;
        if should_reassert_dock_hide(visible, shown_since) {
            set_dock_icon_visible(&app, false);
        }
    });
}

// Bring the main window back from wherever background residency left it. The
// three calls are one gesture and all three are load-bearing: with residency
// on the window may be HIDDEN (show), a user may have minimized it before
// closing (unminimize), and a shown-but-unfocused window is indistinguishable
// from one that ignored the request (set_focus). Every "the user asked for the
// app" path routes here — the popout's Open row, a second launch, and macOS's
// Dock/Spotlight Reopen — so they cannot drift apart.
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // Five calls now, and the Dock tile goes FIRST: `set_focus` ends in
        // `activateIgnoringOtherApps:`, which only brings back the menu bar
        // once the process is a foreground app again — asking in the other
        // order raises a window under someone else's menu bar.
        set_dock_icon_visible(app, true);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        // Four calls now, and the fourth is load-bearing for the same reason
        // the first three are: the main webview cannot see its own window come
        // back (popout.rs's "Window-visibility events" note), so it would keep
        // its invalidation rounds parked behind a window the user is looking
        // at. Scoped to "main" — both windows run the same bundle, and the
        // popout must never react to the main window's visibility.
        let _ = window.emit_to("main", popout::MAIN_SHOWN_EVENT, ());
    }
}

// Open the main window from the popout's action row (M3's "Open MaxPrice").
// Hide-then-show in ONE command so the popout's blur (losing focus to the main
// window) can't race a second IPC round-trip — the hub's proven pattern.
#[tauri::command]
fn open_main_window(app: AppHandle) {
    hide_popout_window(&app);
    show_main_window(&app);
}

// ---------- macOS application menu (map #168 / M5; T4 decision 6a) ----------
// macOS's DEFAULT Quit item sends the native `terminate:` selector, which tao
// does not intercept: the app receives `RunEvent::Exit` and NEVER
// `ExitRequested` (T2 research). That bypasses the teardown chokepoint M1
// built, so Cmd+Q gets its own item whose handler is `app.exit(0)` — the same
// call the popout's Quit row makes, landing on the same path.
//
// Only that ONE item is replaced; the rest of `Menu::default` is kept verbatim.
// Edit's predefined Cut/Copy/Paste/Select-All are what give a macOS WKWebView
// working Cmd+C/V at all (the OS routes them through the menu, not the
// webview), so hand-rolling a whole menu to change one item is how those
// silently go missing.
#[cfg(target_os = "macos")]
const MAC_QUIT_ITEM_ID: &str = "mac-quit";

// Build the default menu, then swap its Quit. Every structural assumption is
// CHECKED rather than assumed — the app submenu is the first entry and its
// predefined Quit is the last item, both true of tauri 2.11.2's
// `Menu::default`, neither guaranteed. If a future tauri reshapes it, we hand
// back the untouched stock menu: an app whose Cmd+Q takes the old
// `terminate:` path (which the `RunEvent::Exit` arm in `run` still covers)
// beats one that silently deleted whatever item moved into that slot.
#[cfg(target_os = "macos")]
fn macos_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem};

    let menu = Menu::default(app)?;
    let Some(app_menu) = menu
        .items()?
        .first()
        .and_then(|kind| kind.as_submenu().cloned())
    else {
        eprintln!("[menu] no app submenu — keeping the stock Quit");
        return Ok(menu);
    };
    let items = app_menu.items()?;
    let last_is_quit = items
        .last()
        .and_then(|kind| kind.as_predefined_menuitem())
        .and_then(|item| item.text().ok())
        .is_some_and(|text| text.contains("Quit"));
    if !last_is_quit {
        eprintln!("[menu] app submenu does not end in Quit — keeping the stock one");
        return Ok(menu);
    }
    app_menu.remove_at(items.len() - 1)?;
    // Text matches the predefined item's own wording ("Quit <app name>"), so
    // the swap is invisible; the accelerator has to be re-declared because
    // only the predefined item carries one implicitly.
    app_menu.append(&MenuItem::with_id(
        app,
        MAC_QUIT_ITEM_ID,
        format!("Quit {}", app.package_info().name),
        true,
        Some("Cmd+Q"),
    )?)?;
    Ok(menu)
}

// Esc-dismiss, invoked by the popout renderer's keydown listener. Blur
// dismissal stays Rust-side (on_window_event below); no debounce stamp here —
// Esc doesn't race a tray click.
#[tauri::command]
fn hide_popout(app: AppHandle) {
    hide_popout_window(&app);
}

// Quit from the popout's Quit row (M3) — the hub's proven pattern: literally
// app.exit(0), so the single teardown chokepoint (app.exit →
// RunEvent::ExitRequested → kill_sidecar) stays visible in this file rather
// than hiding behind plugin internals.
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// The pending update's version, if the ambient scheduler's last check found
// one (map #168 M3). Deliberately NOT main-window-gated: the popout reads it
// on every show to render its update row, and the value is a public release
// version — neither a secret nor a mutation.
#[tauri::command]
fn get_pending_update(state: State<'_, ambient::AmbientState>) -> Option<String> {
    state.pending_update.lock().clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `--hidden` is the autostart entry's launch arg (map #168 / M4): a login
    // launch is tray-only. Decided once, before the builder exists, and
    // carried as managed state for `launched_hidden`. A user typing it at a
    // shell gets the same behavior — that is the arg's meaning, not a leak.
    let hidden_launch = std::env::args().skip(1).any(|a| a == "--hidden");
    let builder = tauri::Builder::default()
        // Registered FIRST (the plugin's own guidance): a second launch hands
        // its argv to this callback in the RUNNING instance and exits itself
        // (map #168 charter decision 7). Show before focus — with background
        // residency the window may be hidden in the tray, and focusing a
        // hidden window is a no-op on Windows. Registered on macOS too: the
        // Dock/Spotlight path is RunEvent::Reopen (T2), but `open -n` can
        // still mint a second instance and should land here, not in a second
        // sidecar.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second HIDDEN launch is the login entry racing an app the
            // user already started (or restarted): it asked for no window,
            // so popping one would turn every such race into a surprise.
            // Manual second launches always show (M4).
            if args.iter().any(|a| a == "--hidden") {
                return;
            }
            show_main_window(app);
        }))
        // `enable()` registers `<exe> --hidden`, so autostart launches are
        // windowless by construction (ADR-0077; LaunchAgent on macOS — the
        // builder default).
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg("--hidden")
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                // The popout's geometry is derived from scratch on every open
                // (config × the target monitor's live scale — toggle_popout);
                // persisting it would only save a stale monitor's position for
                // the plugin to restore at boot and this code to overwrite.
                .with_denylist(&[popout::POPOUT_LABEL])
                .build(),
        );
    // Windows-only: the first-close toast's transport (map #168 / M1).
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_notification::init());
    // macOS only: the stock menu with our own Cmd+Q (map #168 / M5). Set here
    // rather than in `setup` because tauri installs its default menu during
    // `build()` when none was declared — declaring ours means one menu is ever
    // created, not two.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(macos_menu).on_menu_event(|app, event| {
        // Our Quit, and only ours: every other item in the menu is
        // predefined and handled natively.
        if event.id() == MAC_QUIT_ITEM_ID {
            app.exit(0);
        }
    });
    builder
        .manage(SidecarState::default())
        .manage(ClientLog::default())
        .manage(PopoutState::default())
        .manage(ambient::AmbientState::default())
        .manage(LaunchFlags {
            hidden: hidden_launch,
        })
        .manage(WindowShowFallback::default())
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
            save_window_geometry,
            open_main_window,
            hide_popout,
            quit_app,
            get_pending_update,
            launched_hidden,
            autostart_status,
            set_autostart
        ])
        .setup(move |app| {
            if let Err(e) = spawn_sidecar(app.handle()) {
                eprintln!("[sidecar] startup failed: {e}");
                let state = app.state::<SidecarState>();
                *state.status.lock() = SidecarStatus::Failed(e);
            }
            // After spawn_sidecar, which is where the durable log gets opened —
            // so the fallback has somewhere to record itself if it ever fires.
            // Never armed on a --hidden launch: the fallback exists to rescue
            // a window the renderer failed to show, and a login launch has no
            // window owed — arming it would pop the app open 4 seconds after
            // every sign-in (charter decision 8). The tray is the presence;
            // tray Open still reaches a renderer that failed to paint.
            if !hidden_launch {
                arm_window_show_fallback(app.handle());
            }
            // A `--hidden` launch is the close-to-tray shape with no close in
            // it: the main window is never shown, so nothing would ever ask
            // for the tile back — and left alone it sits in the Dock for the
            // whole session opening nothing. Only this branch: an ordinary
            // launch keeps its tile from the first bounce, since the ~1s
            // before the renderer shows the window is exactly when a user is
            // watching the Dock for proof the app started.
            if hidden_launch {
                set_dock_icon_visible(app.handle(), false);
            }
            // Keep an existing login entry pointing at this install (M4;
            // repair-only — see reconcile_autostart).
            reconcile_autostart(app.handle());
            // The tray exists always while the app runs (map #168 charter
            // decision 10), independent of the background toggle. Linux waits
            // on M7: T6 gates tray creation on a live StatusNotifierHost bus
            // check, and until that gate exists a hostless session would get a
            // silently-swallowed icon. cfg! (not #[cfg]) keeps the tray code
            // compiled on every platform.
            // macOS rounds no undecorated window for us; do it ourselves
            // before the popout is ever shown (it is pre-created hidden, so
            // this lands well ahead of the first tray click).
            #[cfg(target_os = "macos")]
            {
                match app.get_webview_window(popout::POPOUT_LABEL) {
                    Some(popout_window) => {
                        round_popout_corners(&popout_window, popout::POPOUT_CORNER_RADIUS)
                    }
                    None => eprintln!("[popout] popout window missing — corners stay square"),
                }
            }
            if !cfg!(target_os = "linux") {
                create_tray(app.handle())?;
                // The ambient tray writer + update-check scheduler (map #168
                // M3; ADR-0076). Linux never spawns it: T6 rules the readout
                // off Linux, and ADR-0071 excludes Linux from the update
                // channel — the tray it would write may not even exist.
                ambient::spawn(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close-to-tray (map #168 / M1): with "keep running in background"
            // on (default), the main window's close button HIDES it — the
            // sidecar keeps serving (limit polling, local archive, hub sync)
            // and the tray is the way back in. With it off, close means quit.
            // Either way the window is never destroyed, and `app.exit(0)` is
            // the one teardown call — kill_sidecar left CloseRequested with the
            // hide (a hidden window must never kill what it advertises as
            // running) and lives on RunEvent::ExitRequested, which exit(0)
            // raises. ADR-0072's Job Object stays untouched underneath as the
            // crash/End-task backstop.
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let app = window.app_handle();
                    // Read the flag from disk at close time (the ADR-0015
                    // posture: settings.json is the wire). Any read failure
                    // defaults ON, mirroring the schema's `.catch(true)`.
                    // Linux has no residency until M7 wires the Host gate (T6):
                    // hiding with no StatusNotifierHost strands the user with
                    // no way back into the app.
                    let enabled = !cfg!(target_os = "linux")
                        && settings_path(app)
                            .and_then(|p| read_settings_at(&p))
                            .map(|v| background_residency_enabled(&v))
                            .unwrap_or(true);
                    api.prevent_close();
                    // Cancel the 4s boot force-show before either branch runs
                    // (F6). A close is the user answering the question that
                    // timer asks — "does anyone want this window on screen?" —
                    // and the answer is no on BOTH branches, so the store sits
                    // ahead of the `if`. Outside the boot window this is an
                    // inert write against a timer that already fired.
                    app.state::<WindowShowFallback>()
                        .cancelled
                        .store(true, Ordering::Relaxed);
                    if enabled {
                        let _ = window.hide();
                        // The main webview cannot see itself leave the screen
                        // (popout.rs's "Window-visibility events" note), so the
                        // hide says so out loud: the renderer parks ADR-0058's
                        // invalidation rounds until the matching `main:shown`
                        // (F9). Coalescing, never skipping — a reopen pays the
                        // one round owed rather than showing stale numbers.
                        let _ = window.emit_to("main", popout::MAIN_HIDDEN_EVENT, ());
                        // After the hide, never before: the tile stands for a
                        // window on screen, and dropping it first would leave
                        // one visible with no way back to it if the hide then
                        // failed. The re-check covers tao's 1s guard.
                        set_dock_icon_visible(app, false);
                        arm_dock_hide_reassert(app);
                        #[cfg(windows)]
                        show_first_close_toast_once(app);
                    } else {
                        // Quit EXPLICITLY rather than letting the close fall
                        // through to "the last window was destroyed" (M5). That
                        // fall-through stopped being true the moment M2
                        // pre-created the popout window: a window that only
                        // ever hides is never destroyed, so the last-window
                        // exit never fires and the app survived a close it was
                        // told to quit on — as a tray-only zombie whose main
                        // window was gone for good, since `open_main_window`
                        // can show a hidden window but cannot resurrect a
                        // destroyed one. Preventing the close first keeps the
                        // window alive right through teardown, so there is
                        // exactly ONE way out of this handler on both branches.
                        app.exit(0);
                    }
                }
            }
            if window.label() == popout::POPOUT_LABEL {
                match event {
                    // Focus-loss dismissal (ADR-0050). Only a blur of a
                    // VISIBLE popout is a user dismissal — our own hide()
                    // calls (toggle-close, open_main_window) also resign
                    // focus, and stamping those would swallow a deliberate
                    // reopen inside the debounce window.
                    WindowEvent::Focused(false) if window.is_visible().unwrap_or(false) => {
                        hide_popout_window(window.app_handle());
                        *window.state::<PopoutState>().last_blur_hide.lock() = Some(Instant::now());
                    }
                    // No close button exists (frameless), but Alt+F4 etc.
                    // must hide, not destroy — the pre-created webview is the
                    // reason the popout opens instantly.
                    WindowEvent::CloseRequested { api, .. } => {
                        hide_popout_window(window.app_handle());
                        api.prevent_close();
                    }
                    _ => {}
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error building tauri app")
        .run(|app_handle, event| {
            // ExitRequested is the ordinary teardown chokepoint (quit_app, or
            // the last window closing with residency off). RunEvent::Exit ALSO
            // tears down: on macOS the DEFAULT menu's Cmd+Q fires Exit without
            // ever raising ExitRequested (T2, map #168) — M5 replaces that
            // item, but the shared machinery must not orphan a sidecar in the
            // meantime. kill_sidecar takes the child out of its slot, so the
            // ordinary path calling both is a harmless no-op second time.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                kill_sidecar(app_handle);
            }
            // Dock click, Spotlight/Finder/`open -a` relaunch — with the main
            // window hidden in the tray, Reopen is the ONLY signal any of them
            // produce (Launch Services dedupes them before a second process
            // exists, so the single-instance callback never fires for them;
            // T2 research, T4 decision 1). `has_visible_windows` is ignored on
            // purpose: a hidden window does not count as visible, and showing
            // an already-visible one just raises it — which is what a Dock
            // click means anyway.
            #[cfg(target_os = "macos")]
            if matches!(event, RunEvent::Reopen { .. }) {
                show_main_window(app_handle);
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

    // --- the boot force-show asks about intent, not visibility (F6) ---

    #[test]
    fn a_close_inside_the_boot_window_cancels_the_force_show() {
        // The sequence that shipped broken: the renderer shows the window at
        // ~1s, the user closes it to the tray at ~2s, and the 4s timer wakes to
        // a hidden window. Reading visibility alone it re-shows the window the
        // user just dismissed and logs "renderer never showed the window" —
        // moments after the first-close toast said the opposite.
        assert!(!should_force_show(true, false));
        // An explicit cancel outranks visibility in both directions: the
        // residency-off branch is mid-`app.exit(0)` and has nothing to show.
        assert!(!should_force_show(true, true));
    }

    #[test]
    fn a_window_nobody_ever_showed_is_still_force_shown() {
        // The case the timer exists for: a bundle that failed to parse asked
        // for nothing, so the shell shows the window itself.
        assert!(should_force_show(false, false));
        // And a healthy launch — the renderer already showed it — is a no-op.
        assert!(!should_force_show(false, true));
    }

    // --- the Dock tile's re-check past tao's guard (ADR-0082) ---

    #[test]
    fn a_still_hidden_window_owes_the_dock_hide_a_second_time() {
        // The gesture tao's 1s guard swallows: open from the tray, Cmd+W
        // straight away. The hide was skipped, nothing showed the window
        // since, and it is still off screen — so the tile is still owed.
        assert!(should_reassert_dock_hide(Some(false), false));
    }

    #[test]
    fn a_reopened_window_keeps_its_dock_tile() {
        // The user answered otherwise inside the 1.2s — re-hiding here would
        // strand a visible window with no tile, and no gesture clears that.
        assert!(!should_reassert_dock_hide(Some(true), true));
        // Unreadable visibility fails CLOSED, the mirror of should_force_show.
        assert!(!should_reassert_dock_hide(None, false));
    }

    #[test]
    fn a_window_minimized_after_a_reopen_keeps_its_dock_tile() {
        // macOS reports isVisible == false for a MINIMIZED window too, so the
        // visibility half alone would drop the tile for a window the user just
        // put INTO the Dock: reopen from the tray, then Cmd+M past the 1s
        // guard. The show since the hide is what settles it.
        assert!(!should_reassert_dock_hide(Some(false), true));
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

    // --- background residency (map #168 / M1) ---

    #[test]
    fn background_residency_defaults_on() {
        // Absent field and non-bool junk both mean ON — mirroring the Zod
        // schema's `.default(true).catch(true)` (see settings.ts).
        assert!(background_residency_enabled(&serde_json::json!({})));
        // showModelLimit: absent/non-bool → false, the schema's default.
        assert!(!model_limit_row_enabled(&serde_json::json!({})));
        assert!(!model_limit_row_enabled(
            &serde_json::json!({ "showModelLimit": "yes" })
        ));
        assert!(model_limit_row_enabled(
            &serde_json::json!({ "showModelLimit": true })
        ));
        assert!(background_residency_enabled(
            &serde_json::json!({ "keepRunningInBackground": "no" })
        ));
        assert!(background_residency_enabled(
            &serde_json::json!({ "costMode": "auto" })
        ));
    }

    #[test]
    fn background_residency_honors_a_stored_bool() {
        assert!(!background_residency_enabled(
            &serde_json::json!({ "keepRunningInBackground": false })
        ));
        assert!(background_residency_enabled(
            &serde_json::json!({ "keepRunningInBackground": true })
        ));
    }

    #[test]
    fn first_close_toast_claims_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        // The marker DIR may not exist yet on a fresh install — the claim
        // creates it rather than failing silent forever.
        let data_dir = dir.path().join("app-data");
        assert!(claim_first_close_toast(&data_dir));
        // Every later claim — same process or a relaunch — must lose.
        assert!(!claim_first_close_toast(&data_dir));
        assert!(!claim_first_close_toast(&data_dir));
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

    // --- the `popout` window label is ONE contract, spread over four files ---
    // (map #168 / M2 — the hub's cross-file contract test, replicated)

    #[test]
    fn the_configured_popout_window_is_the_one_the_code_looks_up() {
        // tauri.conf.json defines the window; lib.rs looks it up by label to
        // re-derive its size on every open. Nothing but this test connects the
        // two — rename the window in the config and the popout silently stops
        // being sized, which on a scaled monitor is the 165px collapse
        // ADR-0050 was written to kill.
        let config: tauri::Config = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json must parse as a tauri::Config");
        let (w, h) =
            popout_logical_size(&config).expect("tauri.conf.json must define a `popout` window");
        assert!(
            w.is_finite() && w > 0.0 && h.is_finite() && h > 0.0,
            "the popout's configured size must be a real window, got {w}x{h}"
        );
        // The configured height must BE the T3 contract's live height (map
        // #168 M3): toggle_popout re-asserts `popout_content_height(..)`
        // on every open, so a config height that drifted from the constant
        // would only ever apply to the window's first, hidden pre-show state —
        // an inconsistency nothing else would surface.
        assert_eq!(
            h,
            popout::POPOUT_HEIGHT,
            "tauri.conf.json's popout height must equal popout::POPOUT_HEIGHT"
        );
    }

    #[test]
    fn the_macos_corner_radius_matches_the_stylesheet() {
        // The corner is drawn twice — the layer mask `round_popout_corners`
        // applies, and the CSS border-radius that curves the frame running
        // along it — and only one of the two is visible to the compiler. Two
        // radii that disagree do not fail anywhere: they render as a hairline
        // that drifts off the corner it is supposed to trace, which is exactly
        // the kind of 1px wrongness nobody files.
        //
        // Reading the stylesheet as text is crude, but the alternative is no
        // check at all — the same trade the label and height contracts above
        // already make against JSON.
        let css = include_str!("../../src/styles/globals.css");
        let rule = css
            .split(".popout-window.popout-rounded .popout-root {")
            .nth(1)
            .and_then(|rest| rest.split('}').next())
            .expect("globals.css must carry a `.popout-window.popout-rounded .popout-root` rule");
        let expected = format!("border-radius: {}px;", popout::POPOUT_CORNER_RADIUS as u32);
        assert!(
            rule.contains(&expected),
            "globals.css's rounded-popout rule must set `{expected}` \
             (popout::POPOUT_CORNER_RADIUS), got:{rule}"
        );
    }

    #[test]
    fn the_popout_capability_is_scoped_to_the_popout_window() {
        // The fourth encoding of the same label. A capability whose `windows`
        // scope misses the popout leaves it with NO permissions at all — every
        // core plugin call from its renderer fails at runtime, silently at
        // build time.
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/popout.json"))
                .expect("capabilities/popout.json must parse as JSON");
        let windows = capability["windows"]
            .as_array()
            .expect("the popout capability must scope itself to windows");
        assert!(
            windows
                .iter()
                .any(|w| w.as_str() == Some(popout::POPOUT_LABEL)),
            "capabilities/popout.json must scope `{}`, got {windows:?}",
            popout::POPOUT_LABEL
        );
    }

    // --- tray_rect_px ---

    #[test]
    fn tray_rect_px_passes_both_position_flavours_through_unscaled() {
        // What this pins is that the helper never RESCALES: it reads a
        // Physical variant straight through, and reads a Logical variant at
        // scale 1.0 — i.e. also straight through. It does NOT pin that
        // tray-icon emits physical px (that is an upstream fact this code
        // relies on); it pins that whatever arrives is taken at face value,
        // which is what keeps popout.rs a single-coordinate-space module.
        let physical = tauri::Rect {
            position: tauri::Position::Physical(tauri::PhysicalPosition::new(1276, 844)),
            size: tauri::Size::Physical(tauri::PhysicalSize::new(40, 40)),
        };
        assert_eq!(
            tray_rect_px(&physical),
            popout::Px::new(1276.0, 844.0, 40.0, 40.0)
        );

        let logical = tauri::Rect {
            position: tauri::Position::Logical(tauri::LogicalPosition::new(1276.0, 844.0)),
            size: tauri::Size::Logical(tauri::LogicalSize::new(40.0, 40.0)),
        };
        assert_eq!(
            tray_rect_px(&logical),
            popout::Px::new(1276.0, 844.0, 40.0, 40.0)
        );

        // Negative coordinates (a monitor left of the primary) survive intact.
        let secondary = tauri::Rect {
            position: tauri::Position::Physical(tauri::PhysicalPosition::new(-1900, 1040)),
            size: tauri::Size::Physical(tauri::PhysicalSize::new(24, 24)),
        };
        assert_eq!(
            tray_rect_px(&secondary),
            popout::Px::new(-1900.0, 1040.0, 24.0, 24.0)
        );
    }

    // --- require_main_window: the ACL gap's hand-rolled half ---

    #[test]
    fn privileged_commands_refuse_every_window_but_main() {
        // capabilities/*.json cannot gate the app's own commands (no app-level
        // ACL manifest — see the guard's doc), so this string equality IS the
        // whole wall between the popout's renderer and the keychain.
        assert_eq!(require_main_window("main", "get_credential"), Ok(()));
        assert_eq!(
            require_main_window(popout::POPOUT_LABEL, "get_credential"),
            Err("get_credential is main-window-only".to_string())
        );
        // Any future third window starts refused, not trusted.
        assert!(require_main_window("settings-2", "write_settings").is_err());
    }
}
