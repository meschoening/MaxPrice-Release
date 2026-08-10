use std::path::PathBuf;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

#[cfg(windows)]
mod job_object;
mod popout;
mod sidecar_log;
use tauri::tray::{MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

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
    // The per-launch ephemeral operator secret, captured from the daemon's
    // `OPERATOR_TOKEN <secret>` stdout line (ADR-0037). Held in memory and
    // handed to the operator webview via get_operator_token. NEVER logged.
    operator_token: Mutex<Option<String>>,
    // The Windows job object the daemon is confined to (ADR-0072). Stored for
    // the process lifetime and never taken back out: dropping this handle
    // terminates the daemon instantly, and letting the KERNEL close it during
    // teardown is what reaches the exits `kill_sidecar` cannot — the updater's
    // `std::process::exit(0)` above all.
    #[cfg(windows)]
    job: Mutex<Option<job_object::JobHandle>>,
}

#[tauri::command]
fn get_hub_url(state: State<'_, SidecarState>) -> Result<String, String> {
    match &*state.status.lock() {
        SidecarStatus::Ready(port) => Ok(format!("http://127.0.0.1:{port}")),
        SidecarStatus::Pending => Err("hub not ready".into()),
        SidecarStatus::Failed(msg) => Err(msg.clone()),
    }
}

#[tauri::command]
fn get_operator_token(state: State<'_, SidecarState>) -> Result<String, String> {
    match &*state.operator_token.lock() {
        Some(token) => Ok(token.clone()),
        None => Err("operator token not ready".into()),
    }
}

/// The renderer's feeder into `hub.log` — the hub's copy of the client shell's
/// `ClientLog` (ADR-0059 / issue #115), carried over for the same reason.
///
/// ADR-0056 made the DAEMON's output durable: `spawn_sidecar` tees the sidecar's
/// stdout/stderr into `<app-data>/logs/hub.log`, because a packaged Windows GUI
/// build has no console. The operator WEBVIEW sits outside that pipe entirely —
/// its `console.warn` goes to the WebView console, a surface nobody running the
/// tray app can see — so a renderer-side failure has had nowhere to land.
///
/// The Updates card (map #143) is what needed it: a launch update probe that
/// fails is deliberately swallowed rather than shown (the hub autostarts at
/// login, so the probe routinely races the network coming up), and the card's
/// error copy tells the operator the reason is in `hub.log`. Without this
/// channel that sentence would be false.
///
/// Managed at builder time and filled in during setup, so the command is safe to
/// call before — or after a failed — `spawn_sidecar`: `None` simply no-ops,
/// matching ADR-0056's "a failed log open degrades to stderr-only" rule.
#[derive(Default)]
struct HubLog(Mutex<Option<std::sync::Arc<sidecar_log::RotatingLog>>>);

/// Longest renderer line accepted, in characters. Renderer messages embed
/// upstream error strings, and one runaway message should not consume a
/// meaningful share of the 5 MB generation a later incident will need.
///
/// Measured BEFORE `RotatingLog::line` escapes control characters, so a line
/// dense in them can reach the file up to ~2x this — still well within the
/// budget's intent, and clipping after the escape could cut an escape sequence
/// in half.
const HUB_RENDERER_LOG_MAX_CHARS: usize = 1000;

/// Append one renderer line to `log`, prefixed `[renderer]` so a forensic read
/// can tell which side of the IPC boundary spoke, clipped to
/// `HUB_RENDERER_LOG_MAX_CHARS`.
///
/// A free function rather than the command body so it is unit-testable without
/// standing up a Tauri app and its managed state.
fn append_renderer_line(log: &sidecar_log::RotatingLog, line: &str) {
    let trimmed = line.trim_end();
    if trimmed.chars().count() > HUB_RENDERER_LOG_MAX_CHARS {
        // `chars()`, not bytes — a byte slice can split a UTF-8 sequence, and
        // the console's lines carry `·`, `—` and `…` routinely.
        let clipped: String = trimmed.chars().take(HUB_RENDERER_LOG_MAX_CHARS).collect();
        log.line("[renderer]", &format!("{clipped}… (truncated)"));
    } else {
        log.line("[renderer]", trimmed);
    }
}

/// The command's whole body, minus `State` — which cannot be constructed outside
/// the `tauri` crate, so the guard is only reachable from a test if it lives
/// here (same reason `append_renderer_line` is a free function).
fn append_if_open(slot: &Mutex<Option<std::sync::Arc<sidecar_log::RotatingLog>>>, line: &str) {
    // Clone the Arc and release the slot lock before writing: `RotatingLog`
    // takes its own lock, and holding both invites a lock-order problem the
    // moment either side grows.
    let log = slot.lock().clone();
    if let Some(log) = log {
        append_renderer_line(&log, line);
    }
}

/// Append one operator-window line to the durable log.
///
/// Infallible by design — the log must never disturb what it observes
/// (ADR-0056), in this direction too: an unopened log, or a line arriving
/// before setup filled the handle, is silently dropped rather than surfaced to
/// a renderer that is already reporting a failure.
#[tauri::command]
fn log_hub_event(state: State<'_, HubLog>, line: String) {
    append_if_open(&state.0, &line);
}

// Parse the `LISTENING <port>` handshake line (ADR-0002). Carried over verbatim
// from the main app's shell — proven upstream.
fn parse_listening_line(line: &str) -> Option<u16> {
    let rest = line.trim().strip_prefix("LISTENING ")?;
    rest.trim().parse::<u16>().ok()
}

// Parse the `OPERATOR_TOKEN <secret>` handshake line (ADR-0037). Returns
// the secret (whitespace-trimmed), or None for an absent/empty value or any
// unrelated line. The captured value is NEVER logged.
fn parse_operator_token_line(line: &str) -> Option<String> {
    let rest = line.trim().strip_prefix("OPERATOR_TOKEN ")?;
    let token = rest.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

// Absolute path of the bundled `maxprice-credstore` helper, a sibling of the
// shell's own executable. Tauri strips the target-triple suffix and places
// externalBins next to the current binary in BOTH dev (`target/debug/`) and
// prod, so the helper sits beside the running shell exe. None if it isn't there
// (credstore not built) — the daemon then degrades to a memory-only credstore.
fn bundled_credstore_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) {
        "maxprice-credstore.exe"
    } else {
        "maxprice-credstore"
    };
    let path = dir.join(name);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

// ---------- Windows firewall repair (ADR-0038) ----------
// The NSIS install is per-user and UNELEVATED, so nothing ever registers a
// Windows Firewall rule for the daemon exe — and Windows' default-deny then
// silently drops inbound tailnet SYNs while every local probe succeeds. The
// console detects the blocked state with an unelevated read and repairs it
// with ONE elevated netsh invocation (a UAC prompt) on the operator's click.
// Everything here except the two spawn sites is pure and unit-tested; the
// module is Windows-only in effect but compiles everywhere so the tests run
// on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
mod firewall {
    // The display name our elevated add/delete pair manages. Detection does
    // NOT key on it (see check_script) — only the fix's delete-then-add does,
    // so re-running the fix never accumulates duplicate rules.
    pub const RULE_NAME: &str = "MaxPrice Hub";

    // PowerShell single-quoted string literal: double embedded quotes, wrap.
    pub fn ps_single_quote(s: &str) -> String {
        format!("'{}'", s.replace('\'', "''"))
    }

    // PowerShell's -EncodedCommand transport: base64 over UTF-16LE. Sidesteps
    // every layer of cmdline quoting (the fix script nests powershell inside
    // Start-Process inside powershell). Hand-rolled: one call site doesn't
    // justify a base64 dependency.
    pub fn encode_ps_command(script: &str) -> String {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let bytes: Vec<u8> = script
            .encode_utf16()
            .flat_map(|unit| unit.to_le_bytes())
            .collect();
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            out.push(TABLE[(n >> 18) as usize & 63] as char);
            out.push(TABLE[(n >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 {
                TABLE[(n >> 6) as usize & 63] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                TABLE[n as usize & 63] as char
            } else {
                '='
            });
        }
        out
    }

    // SEMANTIC detection (unelevated): does ANY enabled inbound Allow rule
    // name this exe as its program? Matches our rule, a user-made rule, and
    // the rule Windows' own "Allow access" prompt creates — none should nag.
    // Direction 1 = in, Action 1 = allow (NET_FW_* enums); string -eq is
    // case-insensitive in PowerShell. Deliberately blind to remote-address
    // scope and profiles — an operator who allowed the exe their own way is
    // allowed, full stop.
    pub fn check_script(exe_path: &str) -> String {
        format!(
            "$fw = New-Object -ComObject HNetCfg.FwPolicy2\n\
             $target = {path}\n\
             foreach ($r in $fw.Rules) {{\n\
               if ($r.Enabled -and $r.Direction -eq 1 -and $r.Action -eq 1 -and $r.ApplicationName -and ($r.ApplicationName -eq $target)) {{ Write-Output 'ALLOWED'; exit 0 }}\n\
             }}\n\
             Write-Output 'BLOCKED'\n\
             exit 0",
            path = ps_single_quote(exe_path)
        )
    }

    // The ELEVATED payload: clear stale rules by our name (a moved exe path
    // leaves them behind), then allow inbound TCP to the daemon exe from the
    // tailnet ranges only — BOTH families (the CGNAT IPv4 range and the
    // Tailscale IPv6 ULA /48: the daemon binds both, since MagicDNS serves A
    // and AAAA for the machine name) — any local port, all profiles. Any-port
    // means a hub.json port change never needs a second UAC round-trip; the
    // tailnet scope keeps a password-less hub closed on non-tailnet networks
    // (ADR-0035: the tailnet is the boundary). delete's exit code is ignored
    // (no stale rule is the common case); add's is the script's verdict.
    pub fn fix_script(exe_path: &str) -> String {
        format!(
            "netsh advfirewall firewall delete rule name={name} | Out-Null\n\
             netsh advfirewall firewall add rule name={name} dir=in action=allow program={path} protocol=TCP remoteip=100.64.0.0/10,fd7a:115c:a1e0::/48 profile=any enable=yes | Out-Null\n\
             exit $LASTEXITCODE",
            name = ps_single_quote(RULE_NAME),
            path = ps_single_quote(exe_path)
        )
    }

    // The UNELEVATED wrapper: Start-Process -Verb RunAs is what raises the UAC
    // prompt; -Wait -PassThru relays the elevated child's exit code. A declined
    // prompt makes Start-Process throw → the catch maps it to 1223
    // (ERROR_CANCELLED), the same code Windows uses for a cancelled elevation.
    pub fn fix_outer_script(inner_b64: &str) -> String {
        format!(
            "try {{\n\
               $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','{inner_b64}'\n\
               exit $p.ExitCode\n\
             }} catch {{ exit 1223 }}"
        )
    }

    // The check script's stdout verdict, scanned line-wise so profile-loading
    // noise or warnings around it don't poison the read. None ⇒ the script
    // itself failed (surfaced as an error, never a silent "allowed").
    pub fn parse_check_output(stdout: &str) -> Option<bool> {
        for line in stdout.lines() {
            match line.trim() {
                "ALLOWED" => return Some(true),
                "BLOCKED" => return Some(false),
                _ => {}
            }
        }
        None
    }

    pub fn classify_fix_exit(code: Option<i32>) -> &'static str {
        match code {
            Some(0) => "applied",
            Some(1223) => "declined",
            _ => "failed",
        }
    }

    // Hidden PowerShell runner: CREATE_NO_WINDOW keeps the unelevated halves
    // invisible (the elevated child is governed by its own -WindowStyle
    // Hidden). Blocking — call from spawn_blocking.
    #[cfg(windows)]
    pub fn run_hidden_powershell(script: &str) -> std::io::Result<std::process::Output> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                &encode_ps_command(script),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    }
}

// Autostart ownership and self-heal (ADR-0051, amending ADR-0036).
//
// `tauri-plugin-autostart` — really `auto_launch` underneath — answers only
// "does a Run value by our name EXIST?", never "does it point at THIS exe?". So
// the first build to register owns the login entry forever: a run out of
// `target/` shadows the installed app, and moving the repo turns the entry into
// a dangling command line that fails silently at every login (#95).
//
// We therefore read HKCU ourselves and decide; the plugin's `enable()` stays the
// ONE writer, so a repaired entry is byte-identical to a freshly-installed one.
// Everything here except `read_registry` is pure and unit-tested; the module is
// Windows-only in effect but compiles everywhere so the tests run on every
// platform (the firewall module's arrangement).
#[cfg_attr(not(windows), allow(dead_code))]
mod autostart {
    use std::path::Path;

    #[cfg(windows)]
    pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    // Task Manager's Startup tab writes the user's opt-out here rather than
    // deleting the Run value.
    #[cfg(windows)]
    pub const APPROVED_KEY: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

    // What the login entry currently says about us.
    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    pub enum Entry {
        /// No Run value by our name — a fresh install.
        Absent,
        /// A Run value naming THIS exe. Nothing to do.
        Matches,
        /// A Run value naming some OTHER exe — the #95 state. Stale dev build,
        /// a moved install, or a dangling path.
        Mismatched,
        /// The user switched us off in Task Manager's Startup tab **and a Run
        /// value exists**. Outranks the path check: a disabled entry never runs,
        /// so a stale path under it is harmless, and honouring an explicit "no"
        /// beats a tidy registry.
        DisabledByUser,
    }

    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    pub enum Action {
        /// Write the entry for the first time.
        Register,
        /// Overwrite a stale entry (same value name, so this replaces in place).
        Repair,
        /// Touch nothing.
        Leave,
    }

    // The whole policy, in one pure function.
    //
    // Note what `Leave` on DisabledByUser fixes: before ADR-0051 the gate was
    // `!is_enabled()`, and `is_enabled()` reports false for a Task-Manager-
    // disabled entry — so every launch silently resurrected an autostart the
    // user had deliberately switched off. (`enable()` rewrites the approval
    // bytes as a side effect, which is why we must not call it here.)
    pub fn decide(entry: Entry) -> Action {
        match entry {
            Entry::DisabledByUser | Entry::Matches => Action::Leave,
            Entry::Absent => Action::Register,
            Entry::Mismatched => Action::Repair,
        }
    }

    pub fn classify(registered: Option<&str>, disabled_by_user: bool, current_exe: &str) -> Entry {
        match registered {
            // Absent OUTRANKS the opt-out. An approval byte with no Run value is
            // an orphan Windows never GCs, not an opt-out: Task Manager's Startup
            // tab enumerates Run VALUES, so it shows no row to switch back on.
            // Registering is the only exit, and `enable()` rewrites the approval
            // bytes to enabled as it goes.
            None => Entry::Absent,
            Some(_) if disabled_by_user => Entry::DisabledByUser,
            Some(value) if paths_match(value, current_exe) => Entry::Matches,
            Some(_) => Entry::Mismatched,
        }
    }

    // What the console's "Starts at login" row reports. `Mismatched` folds into
    // "not registered" on purpose: an entry naming another exe means THIS app
    // does not start at login, which is what the operator is asking.
    pub fn report(entry: Entry, installed_build: bool) -> &'static str {
        if !installed_build {
            return "dev-build";
        }
        match entry {
            Entry::DisabledByUser => "disabled-by-user",
            Entry::Matches => "on",
            Entry::Absent | Entry::Mismatched => "not-registered",
        }
    }

    // The exe out of a Run value. auto_launch writes `format!("{path} {args}")`
    // unquoted — with no args that leaves a TRAILING SPACE, so a naive `==`
    // would call every launch a mismatch and rewrite the registry forever. We
    // pass no args, so the whole trimmed value is the path. The quoted branch
    // exists because Windows' own tooling and hand-edits use that form; we never
    // write it, and stripping it here means a quoted entry compares EQUAL to our
    // unquoted one rather than looking stale (ADR-0051: we deliberately do not
    // convert entries to the quoted form).
    //
    // The value shape mirrored here is auto-launch 0.5.0's, reached
    // transitively via tauri-plugin-autostart 2.5.1 — see the version note on
    // `approval_disabled` for what to re-check on a plugin bump.
    pub fn registered_exe(value: &str) -> &str {
        let trimmed = value.trim();
        match trimmed.strip_prefix('"') {
            Some(rest) => rest.split('"').next().unwrap_or(rest),
            None => trimmed,
        }
    }

    // Windows paths are case-insensitive. ASCII-only folding: the non-ASCII
    // rules are locale-dependent and a mis-compare here is self-correcting (one
    // extra `enable()` writing the identical value), so the simple rule wins.
    pub fn paths_match(registered: &str, current_exe: &str) -> bool {
        let exe = current_exe.trim();
        let value = registered_exe(registered).trim_end();
        if value.eq_ignore_ascii_case(exe) {
            return true;
        }
        // auto_launch writes `{path} {args}`. We pass no args today, so the only
        // live case is the trailing space handled above — but the installed path
        // itself contains a space (`…\MaxPrice Hub\…`), so we cannot split the
        // unquoted value at its first one. Match the exe as a PREFIX and require
        // the boundary, which stays correct the day anyone calls Builder::arg().
        // `get(..)` rather than slicing, so a non-ASCII path cannot panic on a
        // char boundary.
        value
            .get(..exe.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(exe))
            && matches!(value.as_bytes().get(exe.len()), None | Some(b' '))
    }

    // Is this exe a real install, as opposed to something out of the build tree?
    //
    // A DENYLIST on purpose. The tighter allowlist — "only register from
    // %LOCALAPPDATA%\MaxPrice Hub" — fails CLOSED and silently: the day the NSIS
    // installMode changes to perMachine, or the install is relocated, autostart
    // quietly stops registering and nothing says so. This fails OPEN: at worst a
    // stray build registers itself, and the self-heal above reclaims the entry
    // the next time the installed app runs.
    //
    // `debug_assertions` alone would NOT have caught #95 — that entry names a
    // `target\release` exe, i.e. a release-profile binary run straight out of
    // the build tree. The build-tree SHAPE is the second signal that catches it.
    //
    // Two signals, and BOTH must hold: a profile-named parent directory
    // (`release`/`debug`) with a `target` component somewhere above it. Either
    // half alone fails closed on a real install — a bare `target` component also
    // matches an install under a folder that happens to be called that (a user
    // account named `target`), and requiring `target` IMMEDIATELY above the
    // profile misses the `--target <triple>` layout,
    // `target\x86_64-pc-windows-msvc\release\`, which is the very #95 shape.
    //
    // Deliberately NOT closed, per the fail-open posture above: a custom
    // `CARGO_TARGET_DIR` name, or `--profile dist`. The bare-word check missed
    // those too.
    pub fn is_installed_build(exe: &Path, debug_build: bool) -> bool {
        if debug_build {
            return false;
        }
        let profile_parent = exe
            .parent()
            .and_then(|p| p.file_name())
            .is_some_and(|n| n.eq_ignore_ascii_case("release") || n.eq_ignore_ascii_case("debug"));
        let target_ancestor = exe
            .parent()
            .map(|p| {
                p.components()
                    .any(|c| c.as_os_str().eq_ignore_ascii_case("target"))
            })
            .unwrap_or(false);
        !(profile_parent && target_ancestor)
    }

    // StartupApproved's 12-byte value: byte 0 is 2 (enabled) or 3 (disabled),
    // and the last 8 are the FILETIME of the disable (all-zero while enabled).
    // Mirrors auto_launch's own reading byte for byte, including its "too short
    // to interpret ⇒ treat as enabled" fallback — the plugin and this module
    // must never disagree about whether an entry is live.
    //
    // Mirrored from auto-launch 0.5.0, which is NOT a declared dependency of
    // this crate: it arrives transitively via tauri-plugin-autostart 2.5.1 (see
    // Cargo.lock), and our `"2"` requirement is a caret range, so a `cargo
    // update` inside 2.x could swap the backend under us. On any plugin bump,
    // re-check auto-launch's windows.rs — both its
    // `last_eight_bytes_all_zeros` approval reading and its unquoted
    // `format!("{path} {args}")` value shape (see `registered_exe`).
    pub fn approval_disabled(bytes: &[u8]) -> bool {
        if bytes.len() < 8 {
            return false;
        }
        !bytes.iter().rev().take(8).all(|b| *b == 0)
    }

    // The only impure function here: (Run value, disabled-in-Task-Manager).
    // A key or value we cannot read reads as absent/enabled — the same posture
    // auto_launch takes, and it degrades toward registering rather than toward
    // silently not starting at login.
    #[cfg(windows)]
    pub fn read_registry(app_name: &str) -> (Option<String>, bool) {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let registered = hkcu
            .open_subkey_with_flags(RUN_KEY, KEY_READ)
            .ok()
            .and_then(|key| key.get_value::<String, _>(app_name).ok());
        let disabled = hkcu
            .open_subkey_with_flags(APPROVED_KEY, KEY_READ)
            .ok()
            .and_then(|key| key.get_raw_value(app_name).ok())
            .map(|raw| approval_disabled(&raw.bytes))
            .unwrap_or(false);
        (registered, disabled)
    }
}

// Absolute path of the bundled `maxprice-hub` daemon, resolved exactly like the
// credstore helper above (externalBins sit beside the shell exe in dev and
// prod). The firewall rule must name the LISTENING process — the daemon, not
// the shell.
#[cfg_attr(not(windows), allow(dead_code))]
fn bundled_daemon_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) {
        "maxprice-hub.exe"
    } else {
        "maxprice-hub"
    };
    let path = dir.join(name);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

// How long a firewall verdict stays good. The check enumerates EVERY rule in
// HNetCfg.FwPolicy2 through a hidden PowerShell — cheap once, not cheap on
// repeat — and both webviews mount the same query in their own QueryClient, so
// without this the console and the popout each scan at launch and the popout
// scans again on every tray click. A firewall rule only changes when the
// operator changes it (and `fix_firewall` invalidates this itself), so a minute
// of staleness costs nothing an F5 wouldn't fix.
const FIREWALL_CACHE_TTL: Duration = Duration::from_secs(60);

// The last firewall verdict and when it was taken. Managed state, so the cache
// is per-process rather than per-webview — that is the whole point.
#[derive(Default)]
struct FirewallCache {
    verdict: Mutex<Option<(Instant, String)>>,
}

// Firewall state for the console (ADR-0038): "allowed" | "blocked" on Windows,
// "unsupported" elsewhere (macOS's app firewall prompts natively; Linux runs
// headless serve outside the console). Errors are the CHECK failing to run —
// distinct from "blocked" so the console never shows a repair button on a
// broken read. Errors are deliberately NOT cached: a broken read should retry.
#[tauri::command]
async fn check_firewall(cache: State<'_, FirewallCache>) -> Result<String, String> {
    #[cfg(windows)]
    {
        // Scoped: a parking_lot guard is not Send and must not survive into the
        // spawn_blocking await below.
        {
            let cached = cache.verdict.lock();
            if let Some((taken_at, verdict)) = cached.as_ref() {
                if taken_at.elapsed() < FIREWALL_CACHE_TTL {
                    return Ok(verdict.clone());
                }
            }
        }
        let Some(exe) = bundled_daemon_path() else {
            return Err("hub daemon exe not found beside the shell".into());
        };
        let script = firewall::check_script(&exe.to_string_lossy());
        let output =
            tauri::async_runtime::spawn_blocking(move || firewall::run_hidden_powershell(&script))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| format!("firewall check spawn failed: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let verdict = match firewall::parse_check_output(&stdout) {
            Some(true) => "allowed".to_string(),
            Some(false) => "blocked".to_string(),
            None => {
                return Err(format!(
                    "firewall check produced no verdict (exit {:?}): {}",
                    output.status.code(),
                    String::from_utf8_lossy(&output.stderr).trim()
                ))
            }
        };
        *cache.verdict.lock() = Some((Instant::now(), verdict.clone()));
        Ok(verdict)
    }
    #[cfg(not(windows))]
    {
        // Nothing to scan, nothing to cache.
        let _ = &cache;
        Ok("unsupported".into())
    }
}

// One-click repair (ADR-0038): raises UAC, registers the tailnet-scoped allow
// rule. Ok("applied") | Ok("declined") — a declined prompt is an answer, not
// an error; the console keeps the warning row without an error toast. Err ⇒
// the elevated netsh actually failed.
//
// CONSOLE-ONLY, enforced here by window label. `capabilities/popout.json`
// does NOT gate this: tauri's ACL only screens an app's own commands when the
// app ships an app-level ACL manifest (rejected — it would demand explicit
// permissions for all nine commands in both capability files), so at a local
// origin every #[tauri::command] is reachable from every window. ADR-0050 says
// the popout is a glance surface that never raises UAC; this guard is what
// makes that true, and it runs before anything is spawned.
#[tauri::command]
async fn fix_firewall(
    window: tauri::Window,
    cache: State<'_, FirewallCache>,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("firewall repair is console-only".into());
    }
    #[cfg(windows)]
    {
        let Some(exe) = bundled_daemon_path() else {
            return Err("hub daemon exe not found beside the shell".into());
        };
        let inner = firewall::fix_script(&exe.to_string_lossy());
        let outer = firewall::fix_outer_script(&firewall::encode_ps_command(&inner));
        let output =
            tauri::async_runtime::spawn_blocking(move || firewall::run_hidden_powershell(&outer))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| format!("firewall fix spawn failed: {e}"))?;
        // Whatever the outcome, the cached verdict is now a guess about a world
        // that may have changed under it — the console's re-check must be real.
        *cache.verdict.lock() = None;
        match firewall::classify_fix_exit(output.status.code()) {
            "applied" => Ok("applied".into()),
            "declined" => Ok("declined".into()),
            _ => Err(format!(
                "firewall rule add failed (exit {:?})",
                output.status.code()
            )),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = &cache;
        Err("firewall repair is Windows-only".into())
    }
}

// One reading of the login entry: what exe we are, whether we are allowed to own
// the entry, and what the entry currently says.
#[cfg(windows)]
struct AutostartProbe {
    exe: PathBuf,
    installed: bool,
    registered: Option<String>,
    entry: autostart::Entry,
}

// The ONE registry probe. `reconcile_autostart` ACTS on it, `autostart_status`
// REPORTS it — they must never disagree about the same HKCU, or the console row
// asserts a verdict the self-heal never acted on.
//
// Takes the app NAME, not the `AppHandle`: `package_info()` hands back a borrow
// that cannot cross into `autostart_status`'s `spawn_blocking`.
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

// Bring the login entry in line with reality at every launch (ADR-0051).
// Runs in setup, before the tray exists — a few microseconds of registry read.
#[cfg(windows)]
fn reconcile_autostart(app: &AppHandle) {
    // Deliberately the SAME EXPRESSION the plugin resolves its app_name from
    // (`AutoLaunchBuilder::set_app_name(&app.package_info().name)`), not a
    // hardcoded "MaxPrice Hub". A constant that drifted from productName would
    // have us reading one Run value and `enable()` writing another — a
    // duplicate login entry, and a console row stuck on "not registered".
    let probe = match probe_autostart(&app.package_info().name) {
        Ok(probe) => probe,
        Err(e) => {
            eprintln!("[hub] autostart: current_exe failed: {e}");
            return;
        }
    };
    // A build out of the tree must neither register NOR repair: whoever owns the
    // entry gets launched at login, and if that is a dev build the installed app
    // never runs, so it never gets the chance to reclaim it.
    if !probe.installed {
        eprintln!(
            "[hub] autostart: not an installed build, leaving the login entry alone ({})",
            probe.exe.display()
        );
        return;
    }
    let enable = || {
        if let Err(e) = app.autolaunch().enable() {
            eprintln!("[hub] autostart enable failed: {e}");
        }
    };
    // All three arms named: a future `Action` variant must be decided here, not
    // silently fall into `enable()`.
    match autostart::decide(probe.entry) {
        autostart::Action::Leave => {}
        autostart::Action::Repair => {
            eprintln!(
                "[hub] autostart: stale login entry -> {}; repointing at {}",
                probe.registered.as_deref().unwrap_or("").trim(),
                probe.exe.display()
            );
            enable();
        }
        autostart::Action::Register => enable(),
    }
}

// macOS/Linux keep ADR-0036's behaviour verbatim. The self-heal is a fix for a
// Windows registry semantic (#95) and has no counterpart in a LaunchAgent plist
// or a .desktop file; ADR-0050 keeps the non-Windows paths compiling and honest
// rather than deleting them.
#[cfg(not(windows))]
fn reconcile_autostart(app: &AppHandle) {
    let autostart = app.autolaunch();
    if !autostart.is_enabled().unwrap_or(false) {
        if let Err(e) = autostart.enable() {
            eprintln!("[hub] autostart enable failed: {e}");
        }
    }
}

// Does this app actually start at login? "on" | "disabled-by-user" |
// "not-registered" | "dev-build" | "unsupported". Read fresh from the registry
// on every call rather than remembered from setup, so an operator flipping the
// Task Manager switch is eventually reflected instead of our expectation of it
// — the ADR-0038 rule for the firewall verdict. The console re-asks on a slow
// poll; see the measurement note in use-autostart.ts for why not on focus.
// `async` on purpose: a plain sync command runs Blocking, inline on the invoke
// thread, and this one does host I/O (two HKCU opens). Same shape as
// `check_firewall`.
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
    #[cfg(not(windows))]
    {
        let _ = &app;
        Ok("unsupported".into())
    }
}

fn spawn_sidecar(app: &AppHandle) -> Result<(), String> {
    // The durable daemon log (issue #116 / F4) — <app-data>/logs/hub.log, the
    // twin of the client shell's sidecar.log. Best-effort: a failed open
    // leaves `log` as None and the shell runs stderr-only, exactly as before.
    let log: Option<std::sync::Arc<sidecar_log::RotatingLog>> = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("logs").join("hub.log"))
        .and_then(|path| {
            sidecar_log::RotatingLog::open(
                &path,
                sidecar_log::LOG_CAP_BYTES,
                &format!(
                    "--- MaxPrice Hub v{} launched (pid {}) ---",
                    app.package_info().version,
                    std::process::id()
                ),
            )
            .map_err(|e| eprintln!("[hub] log open failed ({e}) — stderr only"))
            .ok()
        })
        .map(std::sync::Arc::new);

    // Hand the operator webview its feeder into the same file. Done here rather
    // than at builder time because this is where the log exists; the state
    // itself is managed up front so `log_hub_event` is callable even on the
    // paths that return before we get this far.
    *app.state::<HubLog>().0.lock() = log.clone();

    let mut hub_cmd = app
        .shell()
        .sidecar("maxprice-hub")
        .map_err(|e| format!("hub sidecar lookup failed: {e}"))?
        // Embedded mode (locked contract §4/§5): the daemon emits OPERATOR_TOKEN
        // on stdout and installs the parent-death watchdog. Headless `serve` never
        // sets this and behaves exactly as before.
        .env("MAXPRICE_HUB_EMBEDDED", "1");

    // Point the embedded daemon at the bundled credstore helper for at-rest key
    // custody (contract §10). The daemon's resolveCredstorePath() reads
    // MAXPRICE_CREDSTORE_PATH first. Absent ⇒ the daemon degrades to a
    // memory-only credstore (a client re-push re-arms it).
    if let Some(credstore) = bundled_credstore_path() {
        hub_cmd = hub_cmd.env(
            "MAXPRICE_CREDSTORE_PATH",
            credstore.to_string_lossy().to_string(),
        );
    }

    // In dev the webview is served from Vite's devUrl (not tauri://localhost),
    // so the daemon must allowlist that origin for the operator window's live
    // fetches (Phase 3). The daemon reads MAXPRICE_HUB_ALLOWED_ORIGIN (contract
    // §9); in production it allowlists the Tauri origins itself, so this is
    // dev-only. Mirrors the main shell's VITE_SIDECAR_ORIGIN pass-through.
    if tauri::is_dev() {
        if let Some(dev_url) = &app.config().build.dev_url {
            hub_cmd = hub_cmd.env(
                "MAXPRICE_HUB_ALLOWED_ORIGIN",
                dev_url.origin().ascii_serialization(),
            );
        }
    }

    let (mut rx, child) = match hub_cmd.spawn() {
        Ok(spawned) => spawned,
        Err(e) => {
            if let Some(l) = &log {
                l.line("[hub]", &format!("spawn failed: {e}"));
            }
            return Err(format!("hub sidecar spawn failed: {e}"));
        }
    };
    if let Some(l) = &log {
        l.line("[hub]", &format!("spawned pid={}", child.pid()));
    }
    #[cfg(windows)]
    let child_pid = child.pid();

    {
        let state = app.state::<SidecarState>();
        *state.child.lock() = Some(child);
    }

    // ADR-0072 — hand the daemon's lifetime to the kernel. This is the third
    // Windows layer, and the only one that survives an exit the event loop
    // never sees. A failure degrades to the two pre-existing layers (i.e. the
    // orphan is possible again), so it is logged loudly and never fatal.
    #[cfg(windows)]
    {
        match job_object::confine(child_pid) {
            Ok(job) => {
                *app.state::<SidecarState>().job.lock() = Some(job);
                if let Some(l) = &log {
                    l.line("[hub]", "job object armed (kill-on-close)");
                }
            }
            Err(e) => {
                let msg =
                    format!("job object failed: {e} — daemon may outlive an abnormal shell exit");
                if let Some(l) = &log {
                    l.line("[hub]", &msg);
                }
                eprintln!("[hub] {msg}");
            }
        }
    }

    let app_handle = app.clone();

    // The stdout reader populates SidecarState. setup() returns immediately;
    // the renderer's getHubUrl/getOperatorToken backoff waits for Ready/the secret.
    // Every branch tees to the durable log (F4) alongside its eprintln — with
    // the same secret hygiene: the OPERATOR_TOKEN value never reaches either.
    tauri::async_runtime::spawn(async move {
        let mut announced = false;
        let mut secret_captured = false;
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
                                l.line("[hub]", line.trim_end());
                            }
                            continue;
                        }
                        if line.trim_start().starts_with("LISTENING") {
                            eprintln!("[hub] malformed LISTENING line: {}", line.trim_end());
                            if let Some(l) = &log {
                                l.line(
                                    "[hub]",
                                    &format!("malformed LISTENING line: {}", line.trim_end()),
                                );
                            }
                        }
                    }
                    if !secret_captured {
                        if let Some(token) = parse_operator_token_line(&line) {
                            let state = app_handle.state::<SidecarState>();
                            *state.operator_token.lock() = Some(token);
                            secret_captured = true;
                            // Secret hygiene: log that we captured it, never the value.
                            eprintln!("[hub] captured OPERATOR_TOKEN");
                            if let Some(l) = &log {
                                l.line("[hub]", "captured OPERATOR_TOKEN");
                            }
                            continue;
                        }
                    }
                    // Never echo a secret line, even if one somehow arrives after
                    // capture (secret hygiene).
                    if line.trim_start().starts_with("OPERATOR_TOKEN") {
                        continue;
                    }
                    eprintln!("[hub] {}", line.trim_end());
                    if let Some(l) = &log {
                        l.line("[hub]", line.trim_end());
                    }
                }
                CommandEvent::Stderr(line_bytes) => {
                    eprintln!(
                        "[hub:err] {}",
                        String::from_utf8_lossy(&line_bytes).trim_end()
                    );
                    if let Some(l) = &log {
                        l.line("[hub:err]", String::from_utf8_lossy(&line_bytes).trim_end());
                    }
                }
                CommandEvent::Terminated(t) => {
                    eprintln!("[hub] terminated: code={:?} signal={:?}", t.code, t.signal);
                    if let Some(l) = &log {
                        l.line(
                            "[hub]",
                            &format!("terminated: code={:?} signal={:?}", t.code, t.signal),
                        );
                    }
                    // Flip to Failed on EVERY termination so get_hub_url can't
                    // return a URL to a dead process forever. Benign on the
                    // intentional-shutdown path (kill_sidecar during exit).
                    let msg = if announced {
                        format!("hub exited after announcing port (code={:?})", t.code)
                    } else {
                        format!("hub exited before announcing port (code={:?})", t.code)
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

fn kill_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let child = state.child.lock().take();
    if let Some(child) = child {
        let _ = child.kill();
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

// ---------- Tray popout (ADR-0050) ----------
// The native two-item tray menu is gone: BOTH tray clicks summon the
// pre-created hidden `popout` window (its UI carries Open window / Quit), and
// the popout dismisses on focus loss or Esc. Window manipulation all lives
// here in Rust; the math is `popout.rs`, pure and unit-tested.

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

fn toggle_popout(app: &AppHandle, rect: &tauri::Rect) {
    let Some(window) = app.get_webview_window(popout::POPOUT_LABEL) else {
        eprintln!("[hub] popout window missing — tray click does nothing");
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
            let _ = window.hide();
            return;
        }
        // The mousedown of THIS click already blurred-and-hid the popout;
        // swallowing the mouseup Click is what makes the toggle close.
        popout::TrayClick::Swallow => return,
        popout::TrayClick::Show => {}
    }

    let tray = tray_rect_px(rect);
    let monitor = app
        .monitor_from_point(tray.x + tray.w / 2.0, tray.y + tray.h / 2.0)
        .ok()
        .flatten()
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
        // The popout's geometry is ours at show time — size as well as
        // position, and both re-asserted from scratch on every open rather
        // than inherited from the window. `popout_physical_size` carries the
        // why: tao rescales this window behind our backs on any DPI event and
        // can strand it at the wrong physical size for the rest of the
        // process's life (the CSS viewport then collapses — clipped action
        // row, ellipsized state column — which no amount of hiding and
        // showing repairs). Deriving from the configured logical size and the
        // target monitor's LIVE scale factor also retires the old
        // outer_size()/scale_factor() rescale, whose whole job was to carry a
        // size across a mixed-DPI move (tauri #7139/#7890).
        //
        // PHYSICAL, never LogicalSize: set_size would convert through tao's
        // cached per-window scale factor, which is the very value that goes
        // stale in this failure.
        if let Some(inner) = popout_logical_size(app.config())
            .and_then(|logical| popout::popout_physical_size(logical, monitor.scale_factor()))
        {
            let place = || {
                let _ = window.set_size(tauri::PhysicalSize::new(
                    inner.0.round() as u32,
                    inner.1.round() as u32,
                ));
                // Position speaks the OUTER box (set_position moves the outer
                // rect, and an undecorated Win11 window still carries an
                // invisible resize frame — 22x13px at 150%). Read it back AFTER
                // the correction so that frame delta is measured on a
                // right-sized window; the inner size is a safe stand-in.
                let pop = window
                    .outer_size()
                    .map(|s| (s.width as f64, s.height as f64))
                    .unwrap_or(inner);
                let (x, y) =
                    popout::popout_position(tray, mon, work, pop, cfg!(target_os = "macos"));
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
            // it lands: a 224px popout re-sized 224/1.5 = 149px — the exact
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
        eprintln!("[hub] popout show failed: {e}");
    }
    let _ = window.set_focus();
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id("hub-tray")
        .tooltip("MaxPrice Hub")
        .icon(app.default_window_icon().unwrap().clone())
        .on_tray_icon_event(|tray, event| {
            // BOTH buttons, on release — the popout replaced the menu, so
            // left and right click now mean the same thing (ADR-0050).
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

// Open the console from the popout's action row (ADR-0050). Hide-then-show in
// ONE command so the popout's blur (losing focus to the console) can't race a
// second IPC round-trip.
#[tauri::command]
fn open_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window(popout::POPOUT_LABEL) {
        let _ = window.hide();
    }
    show_main_window(&app);
}

// Quit from the popout's action row. Literally app.exit(0) — the single
// teardown chokepoint (app.exit → RunEvent::ExitRequested → kill_sidecar)
// stays visible in this file rather than hiding behind plugin internals.
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// Esc-dismiss, invoked by the popout renderer's keydown listener. Blur
// dismissal stays Rust-side (on_window_event below); no debounce stamp here —
// Esc doesn't race a tray click (T2).
#[tauri::command]
fn hide_popout(app: AppHandle) {
    if let Some(window) = app.get_webview_window(popout::POPOUT_LABEL) {
        let _ = window.hide();
    }
}

// Reflect the hub's live status in the tray tooltip. The operator window
// invokes this as status arrives. The status-tinted icon *variants* ship with
// the Phase 4 icon set; today the tooltip text carries the status.
//
// The tooltip arrives COMPOSED (ADR-0049). This used to match on a state token
// and build the words here, which meant the console's status vocabulary lived
// in two languages and had to be kept in lockstep by hand — the same drift the
// shared usage-status module exists to prevent. `trayTooltip` in
// apps/hub-desktop/src/lib/presentation.ts owns the words now, under test. The
// name says what it does — it sets a tooltip; it does not interpret a status.
//
// A missing tray is an ERROR, not a no-op: `setup` builds the tray with `?` and
// the builder `.expect`s, so there is no trayless platform to tolerate here.
// The only way to land in the else arm is a webview that invoked before `setup`
// ran — and the caller logs that rather than freezing the tooltip in silence.
#[tauri::command]
fn set_tray_tooltip(app: AppHandle, tooltip: String) -> Result<(), String> {
    match app.tray_by_id("hub-tray") {
        Some(tray) => tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string()),
        None => Err("tray icon 'hub-tray' not found".into()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        // The Updates card's platform gate is STATIC (map #143): `platform()`
        // from the JS side, never inferred from the updater's `check()`
        // returning null — null means "up to date" AND "no entry for your
        // platform" indistinguishably, so a manifest-driven answer would print
        // "Up to date" to a macOS host a version behind.
        .plugin(tauri_plugin_os::init())
        .manage(SidecarState::default())
        .manage(PopoutState::default())
        .manage(FirewallCache::default())
        .manage(HubLog::default())
        .invoke_handler(tauri::generate_handler![
            get_hub_url,
            get_operator_token,
            set_tray_tooltip,
            check_firewall,
            fix_firewall,
            autostart_status,
            open_main_window,
            quit_app,
            hide_popout,
            log_hub_event
        ])
        .setup(|app| {
            // macOS: run as a tray-only accessory/agent app — no dock icon
            // (ADR-0036). No-op / absent on other platforms.
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            let handle = app.handle();

            if let Err(e) = spawn_sidecar(handle) {
                eprintln!("[hub] startup failed: {e}");
                let state = app.state::<SidecarState>();
                *state.status.lock() = SidecarStatus::Failed(e);
            }

            create_tray(handle)?;

            // Always-on via autostart (ADR-0036), reconciled against reality on
            // every launch rather than gated on the plugin's existence-only
            // `is_enabled()` (ADR-0051).
            reconcile_autostart(handle);

            Ok(())
        })
        .on_window_event(|window, event| {
            // Close-to-tray (ADR-0036): the window's close button hides it and
            // keeps the daemon running. Quitting from the popout (app.exit →
            // RunEvent::ExitRequested) is the ONLY path that tears the daemon
            // down — the tray app is the always-on parent.
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
            if window.label() == popout::POPOUT_LABEL {
                match event {
                    // Focus-loss dismissal (ADR-0050). Only a blur of a
                    // VISIBLE popout is a user dismissal — our own hide()
                    // calls (toggle-close, open_main_window) also resign
                    // focus, and stamping those would swallow a deliberate
                    // reopen inside the debounce window.
                    WindowEvent::Focused(false) => {
                        if window.is_visible().unwrap_or(false) {
                            let _ = window.hide();
                            *window.state::<PopoutState>().last_blur_hide.lock() =
                                Some(Instant::now());
                        }
                    }
                    // No close button exists (frameless), but Alt+F4 etc.
                    // must hide, not destroy — the pre-created webview is the
                    // reason the popout opens instantly.
                    WindowEvent::CloseRequested { api, .. } => {
                        let _ = window.hide();
                        api.prevent_close();
                    }
                    _ => {}
                }
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

    // --- the renderer's feeder into hub.log (map #143) ---

    fn renderer_log_lines(body: &str) -> Vec<&str> {
        // Skip the launch header `RotatingLog::open` always writes.
        body.lines().skip(1).collect()
    }

    fn open_test_log(dir: &std::path::Path) -> (PathBuf, sidecar_log::RotatingLog) {
        let path = dir.join("logs").join("hub.log");
        let log = sidecar_log::RotatingLog::open(
            &path,
            sidecar_log::LOG_CAP_BYTES,
            "--- MaxPrice Hub v0.0.0 launched (pid 1) ---",
        )
        .unwrap();
        (path, log)
    }

    #[test]
    fn renderer_lines_are_prefixed_and_stamped() {
        let dir = tempfile::tempdir().unwrap();
        let (path, log) = open_test_log(dir.path());

        append_renderer_line(&log, "updates: launch probe failed — fetch error\n");

        let body = std::fs::read_to_string(&path).unwrap();
        let lines = renderer_log_lines(&body);
        assert_eq!(lines.len(), 1);
        let line = lines[0];
        // `[renderer]`, not `[hub]`: a forensic read has to be able to tell
        // which side of the IPC boundary spoke, and a swallowed launch probe is
        // precisely the failure the daemon's own pipe cannot report.
        assert!(
            line.contains("[renderer] updates: launch probe failed — fetch error"),
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
        let (path, log) = open_test_log(dir.path());

        // Multi-byte throughout: a byte-wise clip would panic or emit mojibake.
        // Renderer lines embed upstream error strings, so one runaway message
        // must not consume a meaningful share of the 5 MB generation that a
        // later incident will need.
        let huge = "—".repeat(HUB_RENDERER_LOG_MAX_CHARS + 500);
        append_renderer_line(&log, &huge);

        let body = std::fs::read_to_string(&path).unwrap();
        let lines = renderer_log_lines(&body);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].ends_with("… (truncated)"), "should mark the clip");
        let dashes = lines[0].chars().filter(|c| *c == '—').count();
        assert_eq!(dashes, HUB_RENDERER_LOG_MAX_CHARS);
    }

    #[test]
    fn an_unopened_log_makes_the_command_a_no_op() {
        // The ADR-0056 degrade path, from this direction: setup may never have
        // filled the handle (a failed open, or a line arriving before the
        // sidecar spawned). The contract is that the command's body still runs
        // and drops the line — so drive the real body, not `Option::default()`.
        let state = HubLog::default();

        append_if_open(&state.0, "updates: launch probe failed");

        assert!(
            state.0.lock().is_none(),
            "a no-op call must not fill the slot"
        );
    }

    #[test]
    fn an_open_log_takes_the_line_through_the_command_body() {
        // The other arm of the same guard: with the handle filled, the command
        // body must reach `append_renderer_line` and land exactly one record.
        let dir = tempfile::tempdir().unwrap();
        let (path, log) = open_test_log(dir.path());
        let state = HubLog(Mutex::new(Some(std::sync::Arc::new(log))));

        append_if_open(&state.0, "updates: launch probe failed");

        let body = std::fs::read_to_string(&path).unwrap();
        let lines = renderer_log_lines(&body);
        assert_eq!(lines.len(), 1);
        assert!(
            lines[0].contains("[renderer] updates: launch probe failed"),
            "unexpected line: {}",
            lines[0]
        );
    }

    // --- parse_listening_line (carried over verbatim from the main app) ---

    #[test]
    fn parses_happy_path() {
        assert_eq!(parse_listening_line("LISTENING 54321"), Some(54321));
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
        assert_eq!(parse_listening_line("[hub] LISTENING 1234"), None);
    }

    // --- parse_operator_token_line (NEW) ---

    #[test]
    fn token_parses_happy_path() {
        assert_eq!(
            parse_operator_token_line("OPERATOR_TOKEN abc123"),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn token_parses_with_trailing_newline() {
        assert_eq!(
            parse_operator_token_line("OPERATOR_TOKEN deadbeef\n"),
            Some("deadbeef".to_string())
        );
    }

    #[test]
    fn token_parses_with_surrounding_whitespace() {
        assert_eq!(
            parse_operator_token_line("   OPERATOR_TOKEN tok-9f2a   "),
            Some("tok-9f2a".to_string())
        );
    }

    #[test]
    fn token_rejects_missing_token() {
        assert_eq!(parse_operator_token_line("OPERATOR_TOKEN"), None);
        assert_eq!(parse_operator_token_line("OPERATOR_TOKEN "), None);
    }

    #[test]
    fn token_rejects_unrelated_lines() {
        assert_eq!(parse_operator_token_line(""), None);
        assert_eq!(parse_operator_token_line("LISTENING 1234"), None);
        assert_eq!(parse_operator_token_line("operator_token abc"), None);
        assert_eq!(parse_operator_token_line("[hub] OPERATOR_TOKEN abc"), None);
    }

    // --- Windows firewall repair (ADR-0038) ---

    #[test]
    fn ps_single_quote_wraps_and_doubles_embedded_quotes() {
        assert_eq!(
            firewall::ps_single_quote(r"C:\MaxPrice Hub\maxprice-hub.exe"),
            r"'C:\MaxPrice Hub\maxprice-hub.exe'"
        );
        assert_eq!(firewall::ps_single_quote("it's"), "'it''s'");
    }

    #[test]
    fn encode_ps_command_is_utf16le_base64() {
        // Known vectors: "hi" → 68 00 69 00; "€" (U+20AC) → AC 20.
        assert_eq!(firewall::encode_ps_command("hi"), "aABpAA==");
        assert_eq!(firewall::encode_ps_command("€"), "rCA=");
        assert_eq!(firewall::encode_ps_command(""), "");
    }

    #[test]
    fn check_script_embeds_escaped_path_and_verdict_tokens() {
        let s = firewall::check_script(r"C:\MaxPrice Hub\maxprice-hub.exe");
        assert!(s.contains(r"'C:\MaxPrice Hub\maxprice-hub.exe'"));
        assert!(s.contains("ALLOWED"));
        assert!(s.contains("BLOCKED"));
        assert!(s.contains("HNetCfg.FwPolicy2"));
    }

    #[test]
    fn fix_script_scopes_the_rule_to_program_and_tailnet_with_any_port() {
        let s = firewall::fix_script(r"C:\MaxPrice Hub\maxprice-hub.exe");
        // BOTH tailnet families: the daemon binds the Tailscale IPv6 ULA too
        // (MagicDNS serves AAAA records), so the rule must admit it.
        assert!(s.contains("remoteip=100.64.0.0/10,fd7a:115c:a1e0::/48"));
        assert!(s.contains("dir=in"));
        assert!(s.contains("action=allow"));
        assert!(s.contains("protocol=TCP"));
        assert!(s.contains("profile=any"));
        // Any local port — the rule survives a hub.json port change without a
        // second UAC round-trip.
        assert!(!s.contains("localport"));
        // Stale rules by our name are cleared under the same elevation.
        assert!(s.contains("delete rule"));
        assert!(s.contains(firewall::RULE_NAME));
        assert!(s.contains(r"program='C:\MaxPrice Hub\maxprice-hub.exe'"));
    }

    #[test]
    fn outer_fix_script_elevates_and_maps_a_declined_uac_to_1223() {
        let s = firewall::fix_outer_script("QUJD");
        assert!(s.contains("-Verb RunAs"));
        assert!(s.contains("QUJD"));
        assert!(s.contains("1223"));
    }

    #[test]
    fn parse_check_output_scans_lines_for_the_verdict_token() {
        assert_eq!(firewall::parse_check_output("ALLOWED\r\n"), Some(true));
        assert_eq!(firewall::parse_check_output("BLOCKED\n"), Some(false));
        assert_eq!(
            firewall::parse_check_output("some warning\nALLOWED\n"),
            Some(true)
        );
        assert_eq!(firewall::parse_check_output(""), None);
        assert_eq!(firewall::parse_check_output("garbage"), None);
    }

    #[test]
    fn classify_fix_exit_maps_success_decline_and_failure() {
        assert_eq!(firewall::classify_fix_exit(Some(0)), "applied");
        assert_eq!(firewall::classify_fix_exit(Some(1223)), "declined");
        assert_eq!(firewall::classify_fix_exit(Some(1)), "failed");
        assert_eq!(firewall::classify_fix_exit(None), "failed");
    }

    // --- autostart self-heal (ADR-0051, #95) ---

    use autostart::{Action, Entry};
    use std::path::Path;

    // The exact bytes auto_launch writes: `format!("{path} {args}")` with no
    // args, i.e. the path plus ONE trailing space, unquoted.
    fn as_auto_launch_writes_it(path: &str) -> String {
        format!("{path} ")
    }

    const INSTALLED: &str = r"C:\Users\dev\AppData\Local\MaxPrice Hub\maxprice-hub-desktop.exe";
    const STALE: &str = r"C:\Users\dev\Documents\git\MaxPrice\apps\hub-desktop\src-tauri\target\release\maxprice-hub-desktop.exe";

    #[test]
    fn the_trailing_space_auto_launch_writes_is_not_a_mismatch() {
        // The regression that matters most: treat this as a mismatch and every
        // single launch rewrites the registry.
        assert!(autostart::paths_match(
            &as_auto_launch_writes_it(INSTALLED),
            INSTALLED
        ));
        assert_eq!(
            autostart::classify(Some(&as_auto_launch_writes_it(INSTALLED)), false, INSTALLED),
            Entry::Matches
        );
        assert_eq!(autostart::decide(Entry::Matches), Action::Leave);
    }

    #[test]
    fn windows_path_case_does_not_make_an_entry_look_stale() {
        assert!(autostart::paths_match(
            &as_auto_launch_writes_it(&INSTALLED.to_uppercase()),
            INSTALLED
        ));
    }

    #[test]
    fn a_quoted_entry_compares_equal_to_our_unquoted_one() {
        // We never write the quoted form (ADR-0051 leaves quoting alone), but if
        // something else does, it must not read as stale and start a rewrite war.
        assert!(autostart::paths_match(
            &format!("\"{INSTALLED}\""),
            INSTALLED
        ));
        assert_eq!(
            autostart::registered_exe(&format!("\"{INSTALLED}\" --flag")),
            INSTALLED
        );
    }

    #[test]
    fn the_issue_95_state_is_a_repair() {
        // A dangling target\release path while the installed app is running.
        let entry = autostart::classify(Some(&as_auto_launch_writes_it(STALE)), false, INSTALLED);
        assert_eq!(entry, Entry::Mismatched);
        assert_eq!(autostart::decide(entry), Action::Repair);
    }

    #[test]
    fn a_fresh_install_registers() {
        let entry = autostart::classify(None, false, INSTALLED);
        assert_eq!(entry, Entry::Absent);
        assert_eq!(autostart::decide(entry), Action::Register);
    }

    #[test]
    fn a_task_manager_opt_out_is_honoured_whatever_the_registered_path_says() {
        // The behaviour change ADR-0051 makes: before it, `!is_enabled()` was
        // true here and every launch silently resurrected the entry.
        for registered in [
            Some(as_auto_launch_writes_it(INSTALLED)),
            Some(as_auto_launch_writes_it(STALE)),
        ] {
            let entry = autostart::classify(registered.as_deref(), true, INSTALLED);
            assert_eq!(entry, Entry::DisabledByUser);
            assert_eq!(autostart::decide(entry), Action::Leave);
        }
    }

    #[test]
    fn an_orphan_approval_byte_without_a_run_value_still_registers() {
        // Nothing to opt out OF: Task Manager's Startup tab enumerates Run
        // values, so a disable byte with no value shows no row to switch back
        // on. Read as DisabledByUser it would block a fresh install forever.
        let entry = autostart::classify(None, true, INSTALLED);
        assert_eq!(entry, Entry::Absent);
        assert_eq!(autostart::decide(entry), Action::Register);
    }

    #[test]
    fn an_entry_carrying_startup_args_is_not_a_mismatch() {
        // Nothing calls Builder::arg() today; the day something does, auto_launch
        // writes "{path} {args}" and a bare == would rewrite the registry forever.
        assert!(autostart::paths_match(
            &format!("{INSTALLED} --from-autostart"),
            INSTALLED
        ));
        // A DIFFERENT exe that merely starts with our path's prefix is still stale.
        assert!(!autostart::paths_match(
            &format!("{INSTALLED}.bak "),
            INSTALLED
        ));
    }

    #[test]
    fn approval_bytes_are_read_exactly_as_auto_launch_reads_them() {
        // Captured from a real HKCU: byte 0 is 2/3, the last 8 are the disable
        // FILETIME (zero while enabled).
        let enabled = [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let disabled = [
            0x03, 0, 0, 0, 0x51, 0xe6, 0x06, 0x4b, 0x05, 0xc7, 0xdc, 0x01,
        ];
        assert!(!autostart::approval_disabled(&enabled));
        assert!(autostart::approval_disabled(&disabled));
        // Too short to interpret ⇒ enabled, matching auto_launch's unwrap_or(true)
        // on the same read. The two must never disagree about liveness.
        assert!(!autostart::approval_disabled(&[0x02, 0, 0]));
        assert!(!autostart::approval_disabled(&[]));
    }

    #[test]
    fn builds_out_of_the_tree_are_not_installs() {
        // The #95 path: a RELEASE-profile binary run straight out of target/.
        // `debug_assertions` alone would have called this an install.
        assert!(!autostart::is_installed_build(Path::new(STALE), false));
        assert!(autostart::is_installed_build(Path::new(INSTALLED), false));
        // A debug build is never an install, wherever it sits.
        assert!(!autostart::is_installed_build(Path::new(INSTALLED), true));
        // --target <triple> puts the profile dir one level deeper.
        const CROSS: &str = r"D:\git\MaxPrice\apps\hub-desktop\src-tauri\target\x86_64-pc-windows-msvc\release\maxprice-hub-desktop.exe";
        assert!(!autostart::is_installed_build(Path::new(CROSS), false));
        // A real install under a folder that merely SPELLS `target` is an install.
        const ODD: &str = r"C:\Users\target\AppData\Local\MaxPrice Hub\maxprice-hub-desktop.exe";
        assert!(autostart::is_installed_build(Path::new(ODD), false));
    }

    #[test]
    fn the_console_row_reports_what_the_operator_asked() {
        assert_eq!(autostart::report(Entry::Matches, true), "on");
        assert_eq!(
            autostart::report(Entry::DisabledByUser, true),
            "disabled-by-user"
        );
        assert_eq!(autostart::report(Entry::Absent, true), "not-registered");
        // An entry naming ANOTHER exe means this app does not start at login.
        assert_eq!(autostart::report(Entry::Mismatched, true), "not-registered");
        // Dev builds deliberately own no entry, so saying "not registered" would
        // cry wolf in every dev session.
        assert_eq!(autostart::report(Entry::Matches, false), "dev-build");
        assert_eq!(autostart::report(Entry::Absent, false), "dev-build");
    }

    // --- the `popout` window label is ONE contract, spread over four files ---

    #[test]
    fn the_configured_popout_window_is_the_one_the_code_looks_up() {
        // tauri.conf.json defines the window; lib.rs looks it up by label to
        // re-derive its size on every open. Nothing but this test connects the
        // two — rename the window in the config and the popout silently stops
        // being sized, which on a scaled monitor is the 149px collapse
        // ADR-0050 was written to kill.
        let config: tauri::Config = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json must parse as a tauri::Config");
        let (w, h) =
            popout_logical_size(&config).expect("tauri.conf.json must define a `popout` window");
        assert!(
            w.is_finite() && w > 0.0 && h.is_finite() && h > 0.0,
            "the popout's configured size must be a real window, got {w}x{h}"
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
}
