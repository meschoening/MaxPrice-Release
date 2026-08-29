// Autostart ownership and self-heal for the client (map #168 / M4), the hub's
// ADR-0051 module adapted to an OPT-IN posture (ADR-0077).
//
// `tauri-plugin-autostart` — really `auto_launch` underneath — answers only
// "does a Run value by our name EXIST?", never "does it point at THIS exe?". So
// the first build to register owns the login entry forever: a run out of
// `target/` shadows the installed app, and moving the repo turns the entry into
// a dangling command line that fails silently at every login (the hub's #95).
//
// We therefore read HKCU ourselves and decide; the plugin's `enable()` stays
// the ONE writer, so a repaired entry is byte-identical to a freshly-enabled
// one. Where the hub diverges: the hub is always-on, so its boot pass REGISTERS
// a missing entry. The client's autostart is a Settings toggle, default OFF,
// and the login entry itself is the only record of that choice — there is no
// settings.json field to consult (ADR-0077) — so an absent entry at boot means
// "the user never turned it on" and the boot pass may only ever REPAIR an entry
// that already exists. Registering is the toggle's job (`set_autostart`).
//
// Everything here except `read_registry` is pure and unit-tested; the module is
// Windows-only in effect but compiles everywhere so the tests run on every
// platform (the hub firewall module's arrangement).
#![cfg_attr(not(windows), allow(dead_code))]

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
    /// No Run value by our name — autostart is simply off (the default).
    Absent,
    /// A Run value naming THIS exe. Nothing to do.
    Matches,
    /// A Run value naming some OTHER exe — a stale dev build, a moved
    /// install, or a dangling path. The user turned autostart on once; the
    /// entry just no longer points at the app that's running.
    Mismatched,
    /// The user switched us off in Task Manager's Startup tab **and a Run
    /// value exists**. Outranks the path check: a disabled entry never runs,
    /// so a stale path under it is harmless, and honouring an explicit "no"
    /// beats a tidy registry.
    DisabledByUser,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Action {
    /// Overwrite a stale entry (same value name, so this replaces in place).
    Repair,
    /// Touch nothing.
    Leave,
}

// The whole boot policy, in one pure function. No `Register` arm exists on the
// client (the hub's ADR-0051 has one): with no settings field recording the
// user's intent, an absent entry IS the intent, and registering at boot would
// turn autostart on for everyone who never asked.
//
// `Leave` on DisabledByUser is ADR-0051's behaviour change carried over:
// `enable()` rewrites the approval bytes as a side effect, so acting here
// would silently resurrect an autostart the user switched off in Task Manager.
// The TOGGLE may do that — flipping it on is the user asking, today — the boot
// pass may not.
pub fn decide_at_boot(entry: Entry) -> Action {
    match entry {
        Entry::Mismatched => Action::Repair,
        Entry::Absent | Entry::Matches | Entry::DisabledByUser => Action::Leave,
    }
}

pub fn classify(registered: Option<&str>, disabled_by_user: bool, current_exe: &str) -> Entry {
    match registered {
        // Absent OUTRANKS the opt-out. An approval byte with no Run value is
        // an orphan Windows never GCs, not an opt-out: Task Manager's Startup
        // tab enumerates Run VALUES, so it shows no row to switch back on.
        None => Entry::Absent,
        Some(_) if disabled_by_user => Entry::DisabledByUser,
        Some(value) if paths_match(value, current_exe) => Entry::Matches,
        Some(_) => Entry::Mismatched,
    }
}

// What the Settings toggle row reports. `Mismatched` folds into
// "not-registered" on purpose: an entry naming another exe means THIS app does
// not start at login, which is what the user is asking — and the boot repair
// will have rewritten it before any status is read anyway.
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
// unquoted — the client passes `--hidden` (map #168 charter decision 8), so
// the live value is `<path> --hidden`; with no args the format leaves a
// TRAILING SPACE instead. Either way a naive `==` would call every launch a
// mismatch and rewrite the registry forever. The quoted branch exists because
// Windows' own tooling and hand-edits use that form; we never write it, and
// stripping it here means a quoted entry compares EQUAL to our unquoted one
// (ADR-0051: we deliberately do not convert entries to the quoted form).
//
// The value shape mirrored here is auto-launch 0.5.0's, reached transitively
// via tauri-plugin-autostart 2.x — see the version note on `approval_disabled`
// for what to re-check on a plugin bump.
pub fn registered_exe(value: &str) -> &str {
    let trimmed = value.trim();
    match trimmed.strip_prefix('"') {
        Some(rest) => rest.split('"').next().unwrap_or(rest),
        None => trimmed,
    }
}

// Windows paths are case-insensitive. ASCII-only folding: the non-ASCII rules
// are locale-dependent and a mis-compare here is self-correcting (one extra
// `enable()` writing the identical value), so the simple rule wins.
pub fn paths_match(registered: &str, current_exe: &str) -> bool {
    let exe = current_exe.trim();
    let value = registered_exe(registered).trim_end();
    if value.eq_ignore_ascii_case(exe) {
        return true;
    }
    // auto_launch writes `{path} {args}` and the client DOES pass an arg
    // (`--hidden`), so unlike the hub this branch is the live one, not the
    // future-proofing one. The installed path itself contains no space today
    // but `C:\Program Files\…` shapes do, so we cannot split the unquoted
    // value at its first space. Match the exe as a PREFIX and require the
    // boundary. `get(..)` rather than slicing, so a non-ASCII path cannot
    // panic on a char boundary.
    value
        .get(..exe.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(exe))
        && matches!(value.as_bytes().get(exe.len()), None | Some(b' '))
}

// Is this exe a real install, as opposed to something out of the build tree?
// A build out of the tree must neither register NOR repair — whoever owns the
// entry gets launched at login, and if that is a dev build the installed app
// never runs, so it never gets the chance to reclaim it.
//
// A DENYLIST on purpose (ADR-0051): the tighter allowlist — "only register
// from %LOCALAPPDATA%\MaxPrice" — fails CLOSED and silently the day the NSIS
// installMode changes or the install is relocated. This fails OPEN: at worst a
// stray build registers itself via the toggle, and the boot repair reclaims
// the entry the next time the installed app runs.
//
// The signal is the cargo build tree's own shape: a `target` component
// IMMEDIATELY followed by a profile directory (`release`/`debug`), or by a
// target triple and then the profile — the `--target <triple>` layout.
// `debug_assertions` alone would not catch a release-profile binary run
// straight out of `target/release` (the hub's #95 shape); a bare `target`
// component alone would also condemn an install under a user account named
// `target`, which is why the profile has to sit right beneath it.
//
// Adjacency, not "the parent directory is `release`" (M5): on macOS the binary
// lives four levels below the profile dir — `target/release/bundle/macos/
// MaxPrice.app/Contents/MacOS/MaxPrice` — so a parent-only test called every
// locally-built .app an install and would have let it claim the LaunchAgent.
// The Windows shapes are unaffected: the profile dir IS the parent there, and
// it still is under this rule.
pub fn is_installed_build(exe: &Path, debug_build: bool) -> bool {
    if debug_build {
        return false;
    }
    let is_profile =
        |c: &std::ffi::OsStr| c.eq_ignore_ascii_case("release") || c.eq_ignore_ascii_case("debug");
    let parts: Vec<_> = exe.components().map(|c| c.as_os_str().to_owned()).collect();
    let in_build_tree = parts.iter().enumerate().any(|(i, part)| {
        part.eq_ignore_ascii_case("target")
            && (parts.get(i + 1).is_some_and(|p| is_profile(p))
                // `--target <triple>` puts the profile one level deeper.
                || parts.get(i + 2).is_some_and(|p| is_profile(p)))
    });
    !in_build_tree
}

// StartupApproved's 12-byte value: byte 0 is 2 (enabled) or 3 (disabled), and
// the last 8 are the FILETIME of the disable (all-zero while enabled). Mirrors
// auto_launch's own reading byte for byte, including its "too short to
// interpret ⇒ treat as enabled" fallback — the plugin and this module must
// never disagree about whether an entry is live.
//
// Mirrored from auto-launch 0.5.0, which is NOT a declared dependency of this
// crate: it arrives transitively via tauri-plugin-autostart 2.x (see
// Cargo.lock), and our `"2"` requirement is a caret range, so a `cargo update`
// inside 2.x could swap the backend under us. On any plugin bump, re-check
// auto-launch's windows.rs — both its approval-byte reading and its unquoted
// `format!("{path} {args}")` value shape (see `registered_exe`).
pub fn approval_disabled(bytes: &[u8]) -> bool {
    if bytes.len() < 8 {
        return false;
    }
    !bytes.iter().rev().take(8).all(|b| *b == 0)
}

// The only impure function here: (Run value, disabled-in-Task-Manager). A key
// or value we cannot read reads as absent/enabled — the same posture
// auto_launch takes. On the opt-in client that degrades toward reporting the
// toggle OFF rather than toward asserting a registration that may not exist.
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

#[cfg(test)]
mod tests {
    use super::*;

    // The exact bytes auto_launch writes for the client: `format!("{path}
    // {args}")` with `--hidden` as the one arg (map #168 charter decision 8).
    fn as_auto_launch_writes_it(path: &str) -> String {
        format!("{path} --hidden")
    }

    const INSTALLED: &str = r"C:\Users\dev\AppData\Local\MaxPrice\MaxPrice.exe";
    const STALE: &str =
        r"C:\Users\dev\Documents\git\MaxPrice\apps\desktop\src-tauri\target\release\MaxPrice.exe";

    #[test]
    fn the_hidden_arg_we_register_with_is_not_a_mismatch() {
        // The client's live value shape: `<path> --hidden`. Treat this as a
        // mismatch and every single launch rewrites the registry.
        assert!(paths_match(&as_auto_launch_writes_it(INSTALLED), INSTALLED));
        assert_eq!(
            classify(Some(&as_auto_launch_writes_it(INSTALLED)), false, INSTALLED),
            Entry::Matches
        );
        assert_eq!(decide_at_boot(Entry::Matches), Action::Leave);
    }

    #[test]
    fn the_trailing_space_of_an_argless_entry_is_not_a_mismatch_either() {
        // The hub's shape (`{path} ` — no args leaves one trailing space): not
        // written by this app, but the comparator must stay indifferent to it.
        assert!(paths_match(&format!("{INSTALLED} "), INSTALLED));
    }

    #[test]
    fn windows_path_case_does_not_make_an_entry_look_stale() {
        assert!(paths_match(
            &as_auto_launch_writes_it(&INSTALLED.to_uppercase()),
            INSTALLED
        ));
    }

    #[test]
    fn a_quoted_entry_compares_equal_to_our_unquoted_one() {
        // We never write the quoted form (ADR-0051 leaves quoting alone), but
        // if something else does, it must not read as stale and start a
        // rewrite war.
        assert!(paths_match(&format!("\"{INSTALLED}\""), INSTALLED));
        assert_eq!(
            registered_exe(&format!("\"{INSTALLED}\" --hidden")),
            INSTALLED
        );
    }

    #[test]
    fn a_stale_entry_is_repaired_at_boot() {
        // A dangling target\release path while the installed app is running —
        // the user turned autostart on once; keep their choice working.
        let entry = classify(Some(&as_auto_launch_writes_it(STALE)), false, INSTALLED);
        assert_eq!(entry, Entry::Mismatched);
        assert_eq!(decide_at_boot(entry), Action::Repair);
    }

    #[test]
    fn an_absent_entry_is_left_alone_at_boot() {
        // THE divergence from the hub's ADR-0051 (which registers here): the
        // client is opt-in and the entry is the only record of the choice
        // (ADR-0077), so absent = the user never asked. Registering is the
        // Settings toggle's job.
        let entry = classify(None, false, INSTALLED);
        assert_eq!(entry, Entry::Absent);
        assert_eq!(decide_at_boot(entry), Action::Leave);
    }

    #[test]
    fn a_task_manager_opt_out_is_honoured_whatever_the_registered_path_says() {
        // `enable()` rewrites the approval bytes as a side effect, so a boot
        // repair under an opt-out would silently resurrect an autostart the
        // user deliberately switched off.
        for registered in [
            Some(as_auto_launch_writes_it(INSTALLED)),
            Some(as_auto_launch_writes_it(STALE)),
        ] {
            let entry = classify(registered.as_deref(), true, INSTALLED);
            assert_eq!(entry, Entry::DisabledByUser);
            assert_eq!(decide_at_boot(entry), Action::Leave);
        }
    }

    #[test]
    fn an_orphan_approval_byte_without_a_run_value_reads_as_absent() {
        // Nothing to opt out OF: Task Manager's Startup tab enumerates Run
        // values, so a disable byte with no value shows no row to switch back
        // on. Reading it as DisabledByUser would make the toggle report
        // "disabled in Task Manager" for a user who never enabled anything.
        let entry = classify(None, true, INSTALLED);
        assert_eq!(entry, Entry::Absent);
        assert_eq!(decide_at_boot(entry), Action::Leave);
    }

    #[test]
    fn a_different_exe_sharing_our_prefix_is_still_stale() {
        assert!(!paths_match(&format!("{INSTALLED}.bak "), INSTALLED));
    }

    #[test]
    fn approval_bytes_are_read_exactly_as_auto_launch_reads_them() {
        // Captured from a real HKCU: byte 0 is 2/3, the last 8 are the disable
        // FILETIME (zero while enabled).
        let enabled = [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let disabled = [
            0x03, 0, 0, 0, 0x51, 0xe6, 0x06, 0x4b, 0x05, 0xc7, 0xdc, 0x01,
        ];
        assert!(!approval_disabled(&enabled));
        assert!(approval_disabled(&disabled));
        // Too short to interpret ⇒ enabled, matching auto_launch's own read.
        // The two must never disagree about liveness.
        assert!(!approval_disabled(&[0x02, 0, 0]));
        assert!(!approval_disabled(&[]));
    }

    // Path SHAPES, assembled from components so the same assertions run on
    // every host: `Path::new(r"C:\a\b")` is one single component on macOS, so
    // Windows literals would silently pass here by parsing into nothing.
    fn path_of(parts: &[&str]) -> std::path::PathBuf {
        parts.iter().collect()
    }

    #[test]
    fn builds_out_of_the_tree_are_not_installs() {
        // A RELEASE-profile binary run straight out of target/ (the hub's #95
        // shape): `debug_assertions` alone would have called this an install.
        let stale = path_of(&["MaxPrice", "src-tauri", "target", "release", "MaxPrice.exe"]);
        let installed = path_of(&[
            "Users",
            "dev",
            "AppData",
            "Local",
            "MaxPrice",
            "MaxPrice.exe",
        ]);
        assert!(!is_installed_build(&stale, false));
        assert!(is_installed_build(&installed, false));
        // A debug build is never an install, wherever it sits.
        assert!(!is_installed_build(&installed, true));
        // --target <triple> puts the profile dir one level deeper.
        let cross = path_of(&[
            "MaxPrice",
            "src-tauri",
            "target",
            "x86_64-pc-windows-msvc",
            "release",
            "MaxPrice.exe",
        ]);
        assert!(!is_installed_build(&cross, false));
        // A real install under a folder that merely SPELLS `target` is one:
        // the component after it is not a profile.
        let odd = path_of(&[
            "Users",
            "target",
            "AppData",
            "Local",
            "MaxPrice",
            "MaxPrice.exe",
        ]);
        assert!(is_installed_build(&odd, false));
    }

    #[test]
    fn a_locally_built_mac_bundle_is_not_an_install() {
        // macOS nests the executable FOUR levels below the profile dir, so the
        // Windows "parent is `release`" test never fired for it and every
        // `bun run build` .app looked installed (M5 — the branch M4 could only
        // compile). Both bundle layouts, plain and `--target <triple>`.
        let built = path_of(&[
            "MaxPrice",
            "apps",
            "desktop",
            "src-tauri",
            "target",
            "release",
            "bundle",
            "macos",
            "MaxPrice.app",
            "Contents",
            "MacOS",
            "MaxPrice",
        ]);
        assert!(!is_installed_build(&built, false));
        let cross = path_of(&[
            "MaxPrice",
            "src-tauri",
            "target",
            "aarch64-apple-darwin",
            "release",
            "bundle",
            "macos",
            "MaxPrice.app",
            "Contents",
            "MacOS",
            "MaxPrice",
        ]);
        assert!(!is_installed_build(&cross, false));
        // The real thing, which is what `install_desktop.sh` and the .dmg both
        // produce, carries no `target` component at all.
        let installed = path_of(&[
            "Applications",
            "MaxPrice.app",
            "Contents",
            "MacOS",
            "MaxPrice",
        ]);
        assert!(is_installed_build(&installed, false));
    }

    #[test]
    fn the_settings_row_reports_what_the_user_asked() {
        assert_eq!(report(Entry::Matches, true), "on");
        assert_eq!(report(Entry::DisabledByUser, true), "disabled-by-user");
        assert_eq!(report(Entry::Absent, true), "not-registered");
        // An entry naming ANOTHER exe means this app does not start at login.
        assert_eq!(report(Entry::Mismatched, true), "not-registered");
        // A dev build never owns the entry, whatever the registry says.
        assert_eq!(report(Entry::Matches, false), "dev-build");
    }
}
