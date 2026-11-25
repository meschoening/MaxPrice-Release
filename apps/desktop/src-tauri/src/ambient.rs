// The ambient tray writer (map #168 / M3; ADR-0076): ONE Rust-side module owns
// every piece of ambient tray state — the Windows tooltip, the macOS menu-bar
// title, and the update badge — on a ~60s poll of the sidecar's
// `GET /api/readout`. The webviews never write tray state, a deliberate
// divergence from ADR-0050's hub pattern (where the popout webview writes the
// tooltip): the client must have a Rust poller anyway — hidden warm webviews
// get their timers throttled on BOTH platforms, and while backgrounded both
// client webviews are hidden — and one writer gives one formatting path, one
// metric-switch rule, and a readout that survives a wedged webview.
//
// The module is also the sole UPDATE-CHECK scheduler (T5 decision 7): a check
// at boot + every ~6h via the updater plugin's Rust API. The renderer's
// install flow is untouched — UpdateGate's own `check()` + `downloadAndInstall`
// run exactly as before, triggered by the `update:available` event (or the
// `get_pending_update` command at mount) instead of its own mount-time check.
//
// Linux never spawns this (T6: no readout, no updater channel on Linux); the
// code still compiles there — the gate is `cfg!`, like the tray's.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

/// The tray the writer targets — the id `create_tray` registers.
pub const TRAY_ID: &str = "maxprice-tray";

/// Readout poll cadence. The data behind it only moves at the usage poller's
/// 1/min granularity plus file events, so faster would only burn cycles.
pub const READOUT_POLL_MS: u64 = 60_000;

/// Update-check cadence (boot + every ~6h). A long-running background app
/// would otherwise never learn of an update — the old check ran only on
/// renderer mount.
pub const UPDATE_CHECK_INTERVAL_MS: u64 = 6 * 60 * 60 * 1000;

/// The event a completed check with a pending update broadcasts to every
/// window. Payload: `{ version: string }`. The renderer's UpdateGate listens
/// for it (apps/desktop/src/components/UpdateGate.tsx — keep in lockstep).
pub const UPDATE_AVAILABLE_EVENT: &str = "update:available";

/// One readout response — the wire shape of `GET /api/readout`
/// (packages/shared/src/readout.ts; keep in lockstep).
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Readout {
    pub today_cost: f64,
    pub has_data: bool,
    /// The one-Membership popout's reading carries a Model-scoped weekly
    /// limit, so the popout will draw its `<Model> limit` row — the shell
    /// sizes the window for it (`popout::popout_content_height`) before
    /// showing. Always false for the ranked popout.
    pub has_model_window: bool,
    /// Present only while the requested Scope holds more than one Membership
    /// (#622 item 4, #637): what the money half sums. Absent under a
    /// one-Membership Scope. The sidecar decides it; the shell only words it
    /// (`wide_scope_words`).
    #[serde(default)]
    pub wide_scope: Option<WideScope>,
    /// The Readout's percent (ADR-0142 §2): the most used window, of any
    /// kind, of the most used Readable membership, at every count. Absent
    /// while no Readable membership holds a window in flight: money.
    #[serde(default)]
    pub most_used: Option<MostUsed>,
    /// The popout's limit rows (`popout::popout_content_height`): the ranked
    /// popout's Memberships, or the one-Membership popout's 5-hour and weekly
    /// rows (one when the Organization has no weekly limit).
    pub popout_limit_rows: u32,
}

/// The most used Readout (packages/shared/src/readout.ts
/// `readoutMostUsedSchema`; keep in lockstep): `top` is the title's and the
/// tooltip's head, `next` the tooltip's `Next:`, and `count` the Memberships
/// the Readout reads, every state, for `+N more`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MostUsed {
    pub count: u64,
    pub top: ReadoutMembership,
    pub next: Option<ReadoutMembership>,
}

/// One Membership's most used live window, labelled by the sidecar
/// (`Org · Account` while the set spans Accounts; None where naming it would
/// tell nothing apart, one Membership on a one-Organization machine); `pct`
/// unrounded.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadoutMembership {
    pub label: Option<String>,
    pub window: LimitWindow,
    #[serde(default)]
    pub model: Option<String>,
    pub pct: f64,
}

/// Which window a `ReadoutMembership` reads. An unknown one fails the parse.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LimitWindow {
    FiveHour,
    Weekly,
    WeeklyModel,
}

/// The money half's wide Scope (packages/shared/src/readout.ts
/// `readoutWideScopeSchema`; keep in lockstep): every tracked Membership of
/// several Accounts, every tracked Organization of one Account, or any other
/// set of `count` Memberships. An unknown `kind` fails the parse.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WideScope {
    Accounts,
    Organizations,
    Memberships { count: u64 },
}

/// Ambient state managed by the Tauri builder: the pending update (read by the
/// popout via `get_pending_update`, worn by the tray badge) and the poller's
/// kick channel (`write_settings` pokes it so a cost-mode/timezone/Scope flip
/// updates the readout immediately instead of up-to-60s later — the Scope
/// rides the same settings.json write as the other two).
#[derive(Default)]
pub struct AmbientState {
    pub pending_update: Mutex<Option<String>>,
    /// The last readout's `has_model_window` — the popout's extra-row bit.
    /// Sticky across a vanished readout (a sidecar hiccup must not make the
    /// popout jump 31px on its next open); a readout that ANSWERS overwrites.
    pub model_window: Mutex<bool>,
    /// The last readout's `popout_limit_rows` — the popout's limit rows, None
    /// before any readout answers. Sticky like `model_window`.
    pub popout_limit_rows: Mutex<Option<u32>>,
    kick: Mutex<Option<mpsc::Sender<()>>>,
}

/// Poke the ambient poller (fire-and-forget; a not-yet-spawned or dead poller
/// drops the kick silently — the next interval tick covers it).
pub fn kick(state: &AmbientState) {
    let sender = state.kick.lock().clone();
    if let Some(sender) = sender {
        let _ = sender.send(());
    }
}

// ---------- pure formatting (unit-tested) ----------

/// The Windows tray tooltip: the single metric with an app-name prefix
/// (T5 decision 5), degrading to the bare app name when there is nothing
/// honest to say (T5 decision 6 — vanish, not apologize).
///
/// The percent names its Membership and window (`ranked_tooltip`), the
/// Membership only where the sidecar labels it. Today's cost is the Scope's
/// money, so a Scope of more than one Membership (`wideScope`, #622 item 4,
/// #637) says which: `(all accounts)`, `(all organizations)` or
/// `(N memberships)`.
///
/// The mirror of `title_text` below, and dead for the same reason on the other
/// side: only the non-macOS write path calls it, while the tests that pin its
/// wording must keep running everywhere.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn tooltip_text(readout: Option<&Readout>) -> String {
    match ambient_metric(readout) {
        Metric::MostUsed(most_used) => ranked_tooltip(most_used),
        Metric::Today(cost, wide) => fit_tooltip(match wide {
            Some(wide) => format!("MaxPrice — today ${cost:.2} ({})", wide_scope_words(wide)),
            None => format!("MaxPrice — today ${cost:.2}"),
        }),
        Metric::None => "MaxPrice".to_string(),
    }
}

/// The tooltip's words for a wide Scope. `all organizations` is the v0.9.x
/// All organizations wording, kept for a single-Account machine.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn wide_scope_words(wide: &WideScope) -> String {
    match wide {
        WideScope::Accounts => "all accounts".to_string(),
        WideScope::Organizations => "all organizations".to_string(),
        WideScope::Memberships { count } => format!("{count} memberships"),
    }
}

/// The longest tray tooltip Windows shows whole: 63 UTF-16 code units. The
/// shell's own limit is 127 (`szTip` holds 128 units), but tray-icon (0.23
/// here, 0.24 in the hub tray app) hands `Shell_NotifyIconW` a NOTIFYICONDATAW whose `cbSize` is 0, which the
/// shell reads as the first version of the struct, whose `szTip` holds 64. The
/// installed client in the Windows VM showed every longer tooltip cut at
/// exactly 64 units, the percent included (#646, 2026-11-13).
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub const TOOLTIP_MAX: usize = 63;

/// The fewest UTF-16 units a shortened label keeps, its `…` included. A line
/// that cannot keep this many is dropped instead.
#[cfg_attr(target_os = "macos", allow(dead_code))]
const MIN_LABEL: usize = 8;

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `label` within `units` UTF-16 units: as is when it fits, else its start
/// and its end around a `…`, the end given two thirds of the room. The end
/// is what tells two Memberships apart (an `Org · Account` label's Account
/// half, an Organization's id suffix). Never splits a char.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn shorten_label(label: &str, units: usize) -> String {
    if utf16_len(label) <= units {
        return label.to_string();
    }
    let room = units.saturating_sub(1);
    let head_room = room / 3;
    let mut head = String::new();
    let mut used = 0;
    for c in label.chars() {
        if used + c.len_utf16() > head_room {
            break;
        }
        used += c.len_utf16();
        head.push(c);
    }
    let tail_room = room - used;
    let mut tail: Vec<char> = Vec::new();
    let mut used = 0;
    for c in label.chars().rev() {
        if used + c.len_utf16() > tail_room {
            break;
        }
        used += c.len_utf16();
        tail.push(c);
    }
    let tail: String = tail.into_iter().rev().collect();
    format!("{head}…{tail}")
}

/// `prefix label suffix` within `budget` units, shortening only the label,
/// so the prefix and the suffix (the percent) always show. None when the
/// label would keep fewer than `MIN_LABEL` units.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn fit_label_line(prefix: &str, label: &str, suffix: &str, budget: usize) -> Option<String> {
    let fixed = utf16_len(prefix) + utf16_len(suffix);
    let whole = fixed + utf16_len(label);
    if whole <= budget {
        return Some(format!("{prefix}{label}{suffix}"));
    }
    let room = budget.checked_sub(fixed)?;
    if room < MIN_LABEL {
        return None;
    }
    Some(format!("{prefix}{}{suffix}", shorten_label(label, room)))
}

/// A tooltip within `TOOLTIP_MAX`: as is when it fits, else cut on a char
/// boundary to `TOOLTIP_MAX - 1` units and ended with `…` (one unit). The
/// last resort: every line that carries a number is fitted by
/// `fit_label_line` first.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn fit_tooltip(s: String) -> String {
    if utf16_len(&s) <= TOOLTIP_MAX {
        return s;
    }
    let mut out = String::new();
    let mut units = 0;
    for c in s.chars() {
        if units + c.len_utf16() > TOOLTIP_MAX - 1 {
            break;
        }
        units += c.len_utf16();
        out.push(c);
    }
    out.push('…');
    out
}

/// A window's percent as the title and the short lines word it: `91%` for a
/// 5-hour window, `82% wk` for any other (the title adds its own leading
/// space).
fn short_pct(m: &ReadoutMembership) -> String {
    let pct = m.pct.round() as i64;
    match m.window {
        LimitWindow::FiveHour => format!("{pct}%"),
        LimitWindow::Weekly | LimitWindow::WeeklyModel => format!("{pct}% wk"),
    }
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn window_name(m: &ReadoutMembership) -> String {
    match m.window {
        LimitWindow::FiveHour => "5-hour limit".to_string(),
        LimitWindow::Weekly => "weekly limit".to_string(),
        LimitWindow::WeeklyModel => {
            format!("{} weekly limit", m.model.as_deref().unwrap_or("Model"))
        }
    }
}

/// The percent Readout's tooltip (#610, ADR-0142 §2): the most used
/// Membership and window, then `Next:`, then `+N more` for the Memberships
/// not named. Past Windows' limit (`TOOLTIP_MAX`) `Next:` drops first (its
/// Membership joins `+N more`); the head line then shortens its label, never
/// its percent, to leave room for `+N more`, which drops only when the label
/// would keep fewer than `MIN_LABEL` units. An unnamed head (one Membership
/// on a one-Organization machine) is `MaxPrice — weekly limit 64%`.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn ranked_tooltip(most_used: &MostUsed) -> String {
    let top = &most_used.top;
    let prefix = "MaxPrice — ";
    let pct = top.pct.round() as i64;
    let Some(label) = top.label.as_deref() else {
        return fit_tooltip(format!("{prefix}{} {pct}%", window_name(top)));
    };
    let suffix = format!(" {} {pct}%", window_name(top));
    let more_line = |named: u64| -> Option<String> {
        let more = most_used.count.saturating_sub(named);
        (more > 0).then(|| format!("+{more} more"))
    };
    let head = format!("{prefix}{label}{suffix}");
    if let Some(next) = most_used.next.as_ref() {
        let mut lines = vec![
            head.clone(),
            format!(
                "Next: {} {}",
                next.label.as_deref().unwrap_or(""),
                short_pct(next)
            ),
        ];
        lines.extend(more_line(2));
        let full = lines.join("\n");
        if utf16_len(&full) <= TOOLTIP_MAX {
            return full;
        }
    }
    let more = more_line(1);
    if let Some(more) = more.as_ref() {
        let budget = TOOLTIP_MAX.saturating_sub(utf16_len(more) + 1);
        if let Some(head) = fit_label_line(prefix, label, &suffix, budget) {
            return format!("{head}\n{more}");
        }
    }
    fit_label_line(prefix, label, &suffix, TOOLTIP_MAX).unwrap_or_else(|| fit_tooltip(head))
}

/// The macOS menu-bar title: T4's fixed formats — integer percent / two-decimal
/// dollars, no numeric padding — behind ONE leading space, and the EMPTY string
/// for vanish. The caller must pass the result as `Some(text)`:
/// `set_title(None)` is a silent no-op (tray-icon #322), so clearing goes
/// through `Some("")`.
///
/// That leading space IS the icon→title gap, and it is the only centring-safe
/// way to widen it. It sits between the glyph and the number, so it moves the
/// title's ink and the item's frame right by the same amount and the content
/// stays centred in its slot — which is also why the tray template's canvas
/// carries no horizontal padding (`macTrayWidth`, scripts/gen-icon-sources.ts:
/// leading dead space moves the ink WITHOUT moving the frame, and pushed the
/// content +1.75pt right until it was cropped away). A TRAILING space would be
/// the mirror fault: frame without ink, dragging the content left. The vanish
/// case must therefore stay genuinely empty — a whitespace-only title would do
/// exactly that to the icon-only state.
///
/// Only the macOS write path calls it, so every other target would flag it
/// dead — but the formatting rules are platform-independent and the tests
/// (which run on Linux and Windows, never on a Mac gate) must keep pinning them.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn title_text(readout: Option<&Readout>) -> String {
    match ambient_metric(readout) {
        Metric::MostUsed(most_used) => format!(" {}", short_pct(&most_used.top)),
        Metric::Today(cost, _) => format!(" ${cost:.2}"),
        Metric::None => String::new(),
    }
}

/// The metric switch (ADR-0142 §2, one rule for both platforms): the most
/// used window's percent, of any kind, while the readout carries one; today's
/// cost otherwise; nothing when there is no data at all (fresh install) or no
/// readout (sidecar unreachable). The sidecar sends `mostUsed` only while a
/// Readable membership holds a window in flight, so a dead key's stale
/// reading never turns money into a percent (ADR-0138 §8).
enum Metric<'a> {
    MostUsed(&'a MostUsed),
    Today(f64, Option<&'a WideScope>),
    None,
}

fn ambient_metric(readout: Option<&Readout>) -> Metric<'_> {
    match readout {
        Some(r) => match (&r.most_used, r.has_data) {
            (Some(most_used), _) => Metric::MostUsed(most_used),
            (None, true) => Metric::Today(r.today_cost, r.wide_scope.as_ref()),
            (None, false) => Metric::None,
        },
        None => Metric::None,
    }
}

/// The readout's query params, read off settings.json per poll.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadoutParams {
    pub mode: String,
    pub tz: Option<String>,
    /// The persisted Scope's tokens, unresolved (#637).
    pub scope: ScopeParams,
}

/// The persisted Scope as the readout's repeated query params, each list
/// sorted (the shared URL builders sort them too): `scopeQueryParams`
/// (packages/shared/src/scope-params.ts; keep in lockstep). All empty is the
/// default Scope, which sends no param. A Membership list names the Scope
/// alone, so the axes beside it are left out.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ScopeParams {
    pub organization: Vec<String>,
    pub account: Vec<String>,
    pub membership: Vec<String>,
}

/// Read the readout's query params off the raw settings.json value, mirroring
/// the Zod schema's semantics by hand (the `background_residency_enabled`
/// precedent — the shell cannot run the schema):
/// - `costMode`: one of auto/calculate/display, anything else → "auto"
///   (`.default("auto").catch("auto")`).
/// - `timezone`: any string passes through (the sidecar validates IANA zones;
///   an invalid one 400s, which reads as a failed poll → vanish — and the
///   renderer's own schema degrades + heals the stored value on its next
///   write). Absent → omitted, letting the sidecar default to the host zone.
/// - `scope`: the Scope's tokens, passed through unresolved
///   (`settings_scope_params`), so the tray asks for the Scope the Today tile
///   answers and the sidecar alone resolves it (#637). The default Scope sends
///   no param, so a single-Membership URL is unchanged.
pub fn settings_readout_params(settings: &serde_json::Value) -> ReadoutParams {
    let mode = match settings.get("costMode").and_then(|v| v.as_str()) {
        Some(m @ ("auto" | "calculate" | "display")) => m.to_string(),
        _ => "auto".to_string(),
    };
    let tz = settings
        .get("timezone")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    ReadoutParams {
        mode,
        tz,
        scope: settings_scope_params(settings),
    }
}

/// `settingsSchema`'s `scope` read by hand (packages/shared/src/settings.ts;
/// keep in lockstep), then `scopeQueryParams`:
/// - a `scope` key that is an object: each of `account`, `organization` and
///   `membership` an array of strings, else absent (`z.array(z.string())
///   .catch(undefined)` drops the WHOLE list on one non-string element); the
///   two axes drop empty tokens, while `membership`'s empty token is
///   `MEMBERSHIP_NONE`, an explicit empty selection, and is kept;
/// - a `scope` key of any other value, `null` included: the default Scope;
/// - no `scope` key: a released (v0.9.x) file's `organizationScope`, a
///   non-empty string, reads as the Organization axis `[it]`; anything else is
///   the default Scope.
fn settings_scope_params(settings: &serde_json::Value) -> ScopeParams {
    let Some(scope) = settings.get("scope") else {
        return match non_empty_str(settings.get("organizationScope")) {
            Some(organization) => ScopeParams {
                organization: vec![organization.to_string()],
                ..ScopeParams::default()
            },
            None => ScopeParams::default(),
        };
    };
    let Some(scope) = scope.as_object() else {
        return ScopeParams::default();
    };
    let list = |key: &str, keep_empty: bool| -> Vec<String> {
        let Some(items) = scope.get(key).and_then(|v| v.as_array()) else {
            return Vec::new();
        };
        if !items.iter().all(|v| v.is_string()) {
            return Vec::new();
        }
        let mut out: Vec<String> = items
            .iter()
            .filter_map(|v| v.as_str())
            .filter(|s| keep_empty || !s.is_empty())
            .map(|s| s.to_string())
            .collect();
        out.sort();
        out
    };
    let membership = list("membership", true);
    if !membership.is_empty() {
        return ScopeParams {
            membership,
            ..ScopeParams::default()
        };
    }
    ScopeParams {
        organization: list("organization", false),
        account: list("account", false),
        membership: Vec::new(),
    }
}

/// `z.string().min(1)` by hand: a non-empty string, or nothing — absent,
/// null, a non-string and "" all read as None.
fn non_empty_str(v: Option<&serde_json::Value>) -> Option<&str> {
    v.and_then(|v| v.as_str()).filter(|s| !s.is_empty())
}

/// Build the readout URL. `tz` is percent-encoded: IANA zone ids can carry `+`
/// (`Etc/GMT+8`), which a query parser reads as a space. The Scope's tokens
/// follow as repeated params in the shared builders' order (`organization`,
/// `account`, `membership`), none for the default Scope, encoded the same way
/// (a Pending account key's `:`). A Scope naming Accounts or Memberships adds
/// `persisted=1` (`PERSISTED_SCOPE_PARAM`, packages/shared/src/readout.ts;
/// keep in lockstep): the tokens are the persisted Scope, so the sidecar
/// applies them only as the visible controls can show them
/// (`effectiveScope`, packages/shared/src/effective-scope.ts), and on an
/// install tracking one Account answers the default Scope, as the Today tile
/// does. The shell counts no Accounts itself. The default and an
/// Organization-axis Scope, which every install applies, send no flag, so
/// their URLs are unchanged.
pub fn readout_url(port: u16, mode: &str, tz: Option<&str>, scope: &ScopeParams) -> String {
    let mut url = format!("http://127.0.0.1:{port}/api/readout?mode={mode}");
    if let Some(tz) = tz {
        url.push_str("&tz=");
        url.push_str(&percent_encode(tz));
    }
    for (key, tokens) in [
        ("organization", &scope.organization),
        ("account", &scope.account),
        ("membership", &scope.membership),
    ] {
        for token in tokens {
            url.push('&');
            url.push_str(key);
            url.push('=');
            url.push_str(&percent_encode(token));
        }
    }
    if !scope.account.is_empty() || !scope.membership.is_empty() {
        url.push_str("&persisted=1");
    }
    url
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Parse one readout body. Split from the fetch so the shape contract is
/// testable without a server.
pub fn parse_readout(body: &str) -> Option<Readout> {
    serde_json::from_str(body).ok()
}

// ---------- the poller ----------

/// Spawn the ambient thread: an immediate readout poll + update check, then a
/// 60s cadence with kick support, and an update re-check every ~6h. A plain
/// thread (the `arm_window_show_fallback` precedent — no executor needed for a
/// sleep loop); every tray write hops to the main thread, which every windowing
/// backend accepts.
pub fn spawn(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    *app.state::<AmbientState>().kick.lock() = Some(tx);

    let app = app.clone();
    std::thread::spawn(move || {
        let mut last_update_check: Option<Instant> = None;
        loop {
            if last_update_check
                .map(|at| at.elapsed() >= Duration::from_millis(UPDATE_CHECK_INTERVAL_MS))
                .unwrap_or(true)
            {
                last_update_check = Some(Instant::now());
                run_update_check(&app);
            }

            poll_readout_once(&app);

            match rx.recv_timeout(Duration::from_millis(READOUT_POLL_MS)) {
                Ok(()) => {
                    // Coalesce a burst of kicks (several settings writes in one
                    // gesture) into one poll.
                    while rx.try_recv().is_ok() {}
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                // Sender dropped — state torn down; the app is exiting.
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });
}

/// One readout poll: settings → URL → GET → tray write. EVERY failure path
/// writes the vanish state (T5 decision 6) rather than leaving a stale metric
/// on the tray.
fn poll_readout_once(app: &AppHandle) {
    let readout = fetch_readout(app);
    if let Some(r) = &readout {
        let ambient = app.state::<AmbientState>();
        *ambient.model_window.lock() = r.has_model_window;
        *ambient.popout_limit_rows.lock() = Some(r.popout_limit_rows);
    }
    write_tray_readout(app, readout);
}

fn fetch_readout(app: &AppHandle) -> Option<Readout> {
    // Port: only a Ready sidecar is reachable; Pending/Failed → vanish.
    let port = {
        let state = app.state::<crate::SidecarState>();
        let status = state.status.lock();
        match &*status {
            crate::SidecarStatus::Ready(port) => *port,
            _ => return None,
        }
    };

    // Settings re-read per poll (T5 decision 3): the file is the truth,
    // nothing to desync. A read failure degrades to defaults, matching the
    // renderer's tolerance.
    let settings = crate::settings_path(app)
        .and_then(|p| crate::read_settings_at(&p))
        .unwrap_or_else(|_| serde_json::json!({}));
    let params = settings_readout_params(&settings);
    let url = readout_url(port, &params.mode, params.tz.as_deref(), &params.scope);

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .build();
    let body = agent.get(&url).call().ok()?.into_string().ok()?;
    parse_readout(&body)
}

/// Write the readout onto the tray: macOS title, Windows (and any other
/// tray-bearing platform) tooltip. Hops to the main thread — tray mutation is
/// main-thread-only on macOS, and the hop is harmless elsewhere.
fn write_tray_readout(app: &AppHandle, readout: Option<Readout>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(tray) = handle.tray_by_id(TRAY_ID) else {
            return;
        };
        #[cfg(target_os = "macos")]
        {
            // Some(""), never None — set_title(None) is a silent no-op.
            let _ = tray.set_title(Some(title_text(readout.as_ref())));
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = tray.set_tooltip(Some(tooltip_text(readout.as_ref())));
        }
    });
}

/// One update check via the plugin's Rust API. Async because the plugin is;
/// spawned onto tauri's runtime and left to land whenever it lands.
fn run_update_check(app: &AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(u) => u,
            // Unsupported platform/config (e.g. Linux — no channel, ADR-0071).
            Err(_) => return,
        };
        match updater.check().await {
            Ok(Some(update)) => set_pending_update(&app, Some(update.version.clone())),
            Ok(None) => set_pending_update(&app, None),
            // A failed check keeps the prior verdict: a network blip must not
            // clear a badge for an update that is still pending.
            Err(e) => eprintln!("[updater] scheduled check failed: {e}"),
        }
    });
}

/// Record a check verdict: store it, wear/remove the badge, and broadcast
/// `update:available` on the None→Some (or version-change) edge so live
/// windows react without polling.
fn set_pending_update(app: &AppHandle, version: Option<String>) {
    let changed = {
        let state = app.state::<AmbientState>();
        let mut pending = state.pending_update.lock();
        let changed = *pending != version;
        *pending = version.clone();
        changed
    };
    if !changed {
        return;
    }
    apply_badge(app, version.is_some());
    if let Some(version) = version {
        let _ = app.emit(
            UPDATE_AVAILABLE_EVENT,
            serde_json::json!({ "version": version }),
        );
    }
}

/// Swap the tray icon between base and dot-variant (T4 decision 7 / T5
/// decision 7). macOS: template glyphs, and every swap re-asserts
/// `set_icon_as_template(true)` because a plain set_icon silently un-templates
/// (tray-icon #203). Windows: the color orb's dot variant via plain set_icon,
/// the base being the bundle icon the tray was created with.
fn apply_badge(app: &AppHandle, pending: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(tray) = handle.tray_by_id(TRAY_ID) else {
            return;
        };
        #[cfg(target_os = "macos")]
        {
            let bytes: &[u8] = if pending {
                include_bytes!("../icons/tray-mac-update.png")
            } else {
                include_bytes!("../icons/tray-mac.png")
            };
            if let Ok(icon) = tauri::image::Image::from_bytes(bytes) {
                let _ = tray.set_icon(Some(icon));
                let _ = tray.set_icon_as_template(true);
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            if pending {
                if let Ok(icon) =
                    tauri::image::Image::from_bytes(include_bytes!("../icons/tray-update.png"))
                {
                    let _ = tray.set_icon(Some(icon));
                }
            } else if let Some(icon) = handle.default_window_icon() {
                let _ = tray.set_icon(Some(icon.clone()));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A readout with no percent: money, or vanish without data.
    fn money(today: f64, has_data: bool) -> Readout {
        Readout {
            today_cost: today,
            has_data,
            has_model_window: false,
            wide_scope: None,
            most_used: None,
            popout_limit_rows: 2,
        }
    }

    fn wide(r: Readout, wide: WideScope) -> Readout {
        Readout {
            wide_scope: Some(wide),
            ..r
        }
    }

    fn member(label: &str, window: LimitWindow, pct: f64) -> ReadoutMembership {
        ReadoutMembership {
            label: Some(label.to_string()),
            window,
            model: None,
            pct,
        }
    }

    /// One Membership on a one-Organization machine: unnamed.
    fn unnamed(window: LimitWindow, pct: f64) -> ReadoutMembership {
        ReadoutMembership {
            label: None,
            window,
            model: None,
            pct,
        }
    }

    fn most_used(
        r: Readout,
        count: u64,
        top: ReadoutMembership,
        next: Option<ReadoutMembership>,
    ) -> Readout {
        Readout {
            most_used: Some(MostUsed { count, top, next }),
            ..r
        }
    }

    /// The one-Membership percent: `money` with its head window.
    fn one(top: ReadoutMembership) -> Readout {
        most_used(money(12.4, true), 1, top, None)
    }

    // --- one Membership (ADR-0142 §2: the most used window at every count) ---

    #[test]
    fn a_five_hour_window_reads_its_bare_percent() {
        let r = one(unnamed(LimitWindow::FiveHour, 41.4));
        assert_eq!(title_text(Some(&r)), " 41%");
        assert_eq!(tooltip_text(Some(&r)), "MaxPrice — 5-hour limit 41%");
    }

    #[test]
    fn a_weekly_window_reads_wk() {
        let r = one(unnamed(LimitWindow::Weekly, 63.5));
        assert_eq!(title_text(Some(&r)), " 64% wk");
        assert_eq!(tooltip_text(Some(&r)), "MaxPrice — weekly limit 64%");
    }

    #[test]
    fn ultra_alone_reads_its_most_used_weekly_window() {
        // An Ultra plan reports no 5-hour window: its weekly or model weekly
        // window is the percent, never money.
        let r = one(ReadoutMembership {
            model: Some("Fable".to_string()),
            ..unnamed(LimitWindow::WeeklyModel, 71.0)
        });
        assert_eq!(title_text(Some(&r)), " 71% wk");
        assert_eq!(tooltip_text(Some(&r)), "MaxPrice — Fable weekly limit 71%");
    }

    #[test]
    fn a_max_plan_between_five_hour_windows_reads_its_weekly_percent() {
        // Money before ADR-0142; the weekly window is in flight, so a percent.
        let r = one(unnamed(LimitWindow::Weekly, 33.0));
        assert_eq!(title_text(Some(&r)), " 33% wk");
        assert_ne!(title_text(Some(&r)), " $12.40");
    }

    #[test]
    fn nothing_readable_reads_as_todays_cost_two_decimals() {
        assert_eq!(title_text(Some(&money(12.4, true))), " $12.40");
        assert_eq!(
            tooltip_text(Some(&money(12.4, true))),
            "MaxPrice — today $12.40"
        );
        assert_eq!(title_text(Some(&money(0.0, true))), " $0.00");
    }

    #[test]
    fn the_percent_is_an_integer_no_padding() {
        assert_eq!(
            title_text(Some(&one(unnamed(LimitWindow::FiveHour, 5.0)))),
            " 5%"
        );
        assert_eq!(
            title_text(Some(&one(unnamed(LimitWindow::FiveHour, 100.0)))),
            " 100%"
        );
        assert_eq!(
            title_text(Some(&one(unnamed(LimitWindow::FiveHour, 81.6)))),
            " 82%"
        );
    }

    #[test]
    fn vanish_not_apologize() {
        // No readout (sidecar unreachable) or no data at all: bare app name on
        // Windows, empty title on macOS — never "$0.00" or "unavailable".
        assert_eq!(tooltip_text(None), "MaxPrice");
        assert_eq!(title_text(None), "");
        assert_eq!(tooltip_text(Some(&money(0.0, false))), "MaxPrice");
        assert_eq!(title_text(Some(&money(0.0, false))), "");
    }

    #[test]
    fn the_gap_is_one_leading_space_and_vanish_carries_none() {
        // The icon→title gap is the title's leading space (see `title_text`):
        // exactly one, never trailing, and nothing at all for vanish.
        for r in [one(unnamed(LimitWindow::Weekly, 40.0)), money(3.5, true)] {
            let t = title_text(Some(&r));
            assert!(t.starts_with(' ') && !t.starts_with("  ") && !t.ends_with(' '));
        }
        assert!(title_text(None).is_empty());
    }

    #[test]
    fn a_named_membership_heads_the_tooltip_never_the_title() {
        // One Membership while several Organizations are tracked: the sidecar
        // labels it, the tooltip names it, the menu bar has no room.
        let r = one(member("Acme · 1a2b3c4d", LimitWindow::FiveHour, 82.0));
        assert_eq!(
            tooltip_text(Some(&r)),
            "MaxPrice — Acme · 1a2b3c4d 5-hour limit 82%"
        );
        assert_eq!(title_text(Some(&r)), " 82%");
    }

    #[test]
    fn the_today_fallback_names_a_wide_scope() {
        let r = wide(money(12.4, true), WideScope::Accounts);
        assert_eq!(
            tooltip_text(Some(&r)),
            "MaxPrice — today $12.40 (all accounts)"
        );
        assert_eq!(title_text(Some(&r)), " $12.40");
        let r = wide(money(12.4, true), WideScope::Organizations);
        assert_eq!(
            tooltip_text(Some(&r)),
            "MaxPrice — today $12.40 (all organizations)"
        );
        let r = wide(money(12.4, true), WideScope::Memberships { count: 3 });
        assert_eq!(
            tooltip_text(Some(&r)),
            "MaxPrice — today $12.40 (3 memberships)"
        );
    }

    // --- several Memberships (#638's ranked lines) ---

    #[test]
    fn the_most_used_membership_and_window_head_the_tooltip() {
        let r = most_used(
            money(1.0, true),
            3,
            member("Personal", LimitWindow::Weekly, 64.0),
            Some(member("Team", LimitWindow::FiveHour, 41.0)),
        );
        assert_eq!(title_text(Some(&r)), " 64% wk");
        let t = tooltip_text(Some(&r));
        assert_eq!(
            t,
            "MaxPrice — Personal weekly limit 64%\nNext: Team 41%\n+1 more"
        );
        assert!(utf16_len(&t) <= TOOLTIP_MAX);
        let model = most_used(
            money(1.0, true),
            2,
            ReadoutMembership {
                model: Some("Fable".to_string()),
                ..member("Team", LimitWindow::WeeklyModel, 77.0)
            },
            None,
        );
        assert_eq!(
            tooltip_text(Some(&model)),
            "MaxPrice — Team Fable weekly limit 77%\n+1 more"
        );
    }

    #[test]
    fn next_drops_first_past_the_63_unit_limit() {
        let r = most_used(
            money(1.0, true),
            3,
            member("Team · Alex", LimitWindow::FiveHour, 50.0),
            Some(member("Acme · Blair Robertson", LimitWindow::Weekly, 40.0)),
        );
        let t = tooltip_text(Some(&r));
        assert_eq!(t, "MaxPrice — Team · Alex 5-hour limit 50%\n+2 more");
        assert!(utf16_len(&t) <= TOOLTIP_MAX);
    }

    #[test]
    fn a_long_head_shortens_its_label_and_keeps_its_percent_and_count() {
        // The VM's 14-Membership head: 66 units whole, cut to "…limit 9" by the
        // shell before this cap (#646).
        let r = most_used(
            money(1.0, true),
            14,
            member(
                "Team plan · 0646000d · Account 0646ffff",
                LimitWindow::Weekly,
                95.0,
            ),
            Some(member(
                "Team plan · 06460004 · Account 0646bbbb",
                LimitWindow::FiveHour,
                91.0,
            )),
        );
        let t = tooltip_text(Some(&r));
        assert!(utf16_len(&t) <= TOOLTIP_MAX, "{t}");
        let (head, more) = t.split_once('\n').expect("two lines");
        assert_eq!(more, "+13 more");
        assert!(head.starts_with("MaxPrice — Team pla…"), "{head}");
        assert!(
            head.ends_with("Account 0646ffff weekly limit 95%"),
            "{head}"
        );
    }

    #[test]
    fn a_head_with_no_room_for_the_count_keeps_its_percent() {
        // An astral character is two UTF-16 units: the cut never splits one.
        let long = "😀".repeat(80);
        let r = most_used(
            money(1.0, true),
            2,
            member(&long, LimitWindow::FiveHour, 50.0),
            Some(member("B", LimitWindow::FiveHour, 10.0)),
        );
        let t = tooltip_text(Some(&r));
        assert!(utf16_len(&t) <= TOOLTIP_MAX, "{t}");
        assert!(t.starts_with("MaxPrice — 😀"));
        assert!(t.ends_with("😀 5-hour limit 50%\n+1 more"), "{t}");
        assert!(!t.contains("Next:"));
        // Exactly 63 units fits untouched.
        let label = "a".repeat(TOOLTIP_MAX - utf16_len("MaxPrice —  5-hour limit 50%"));
        let fits = format!("MaxPrice — {label} 5-hour limit 50%");
        assert_eq!(utf16_len(&fits), TOOLTIP_MAX);
        let r = one(member(&label, LimitWindow::FiveHour, 50.0));
        assert_eq!(tooltip_text(Some(&r)), fits);
    }

    #[test]
    fn a_long_single_label_shortens_before_the_percent() {
        let r = one(member(
            &"Northwind Traders Enterprise ".repeat(3),
            LimitWindow::FiveHour,
            82.0,
        ));
        let t = tooltip_text(Some(&r));
        assert!(utf16_len(&t) <= TOOLTIP_MAX, "{t}");
        assert!(t.starts_with("MaxPrice — Northwind"), "{t}");
        assert!(t.ends_with(" 5-hour limit 82%"), "{t}");
    }

    #[test]
    fn shorten_label_keeps_both_ends_and_never_splits_a_char() {
        assert_eq!(shorten_label("abcdefghij", 10), "abcdefghij");
        assert_eq!(shorten_label("abcdefghij", 7), "ab…ghij");
        let s = shorten_label(&"😀".repeat(10), 9);
        assert!(utf16_len(&s) <= 9, "{s}");
        assert!(s.contains('…'));
    }

    // --- settings mirroring (the background_residency_enabled precedent) ---

    #[test]
    fn settings_params_mirror_the_schema_defaults() {
        let params = settings_readout_params(&serde_json::json!({}));
        assert_eq!(params.mode, "auto");
        assert_eq!(params.tz, None);
        assert_eq!(params.scope, ScopeParams::default());

        let params = settings_readout_params(&serde_json::json!({
            "costMode": "calculate",
            "timezone": "America/Chicago",
        }));
        assert_eq!(params.mode, "calculate");
        assert_eq!(params.tz.as_deref(), Some("America/Chicago"));

        // Junk degrades exactly like `.catch("auto")` / a non-string tz.
        let params = settings_readout_params(&serde_json::json!({
            "costMode": "bogus",
            "timezone": 42,
        }));
        assert_eq!(params.mode, "auto");
        assert_eq!(params.tz, None);
    }

    fn scope_of(settings: serde_json::Value) -> ScopeParams {
        settings_readout_params(&settings).scope
    }

    fn tokens(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_default_scope_sends_no_param() {
        for settings in [
            serde_json::json!({}),
            serde_json::json!({ "scope": null }),
            serde_json::json!({ "scope": 42 }),
            serde_json::json!({ "scope": "all" }),
            serde_json::json!({ "scope": {} }),
            serde_json::json!({ "scope": { "organization": [""] } }),
        ] {
            assert_eq!(scope_of(settings), ScopeParams::default());
        }
    }

    #[test]
    fn the_scope_tokens_pass_through_unresolved() {
        // No Home, no tracked list, a stale uuid: the shell resolves nothing.
        assert_eq!(
            scope_of(serde_json::json!({ "scope": { "organization": ["cccc3333"] } })),
            ScopeParams {
                organization: tokens(&["cccc3333"]),
                ..ScopeParams::default()
            }
        );
        assert_eq!(
            scope_of(serde_json::json!({
                "scope": { "account": ["all"], "organization": ["all", ""] }
            })),
            ScopeParams {
                organization: tokens(&["all"]),
                account: tokens(&["all"]),
                membership: Vec::new(),
            }
        );
        // Sorted, as the shared builders sort.
        assert_eq!(
            scope_of(serde_json::json!({ "scope": { "account": ["b", "a"] } })).account,
            tokens(&["a", "b"])
        );
    }

    #[test]
    fn a_membership_list_names_the_scope_alone() {
        let s = serde_json::json!({
            "scope": { "account": ["a"], "membership": ["o2~a2", "o1~unknown"] }
        });
        assert_eq!(
            scope_of(s),
            ScopeParams {
                membership: tokens(&["o1~unknown", "o2~a2"]),
                ..ScopeParams::default()
            }
        );
        // The empty selection's token is kept: an empty Scope, not the default.
        assert_eq!(
            scope_of(serde_json::json!({ "scope": { "membership": [""] } })).membership,
            tokens(&[""])
        );
    }

    #[test]
    fn a_list_with_a_non_string_is_dropped_whole() {
        // Zod's `.catch(undefined)` drops the WHOLE array on one bad element.
        assert_eq!(
            scope_of(serde_json::json!({
                "scope": { "organization": ["bbbb2222", 7], "account": ["a"] }
            })),
            ScopeParams {
                account: tokens(&["a"]),
                ..ScopeParams::default()
            }
        );
    }

    #[test]
    fn a_released_organization_scope_reads_as_the_organization_axis() {
        // #637: a v0.9.x file the renderer has not rewritten yet.
        assert_eq!(
            scope_of(serde_json::json!({ "organizationScope": "bbbb2222" })),
            ScopeParams {
                organization: tokens(&["bbbb2222"]),
                ..ScopeParams::default()
            }
        );
        assert_eq!(
            scope_of(serde_json::json!({ "organizationScope": "all" })).organization,
            tokens(&["all"])
        );
        for junk in [
            serde_json::json!(null),
            serde_json::json!(""),
            serde_json::json!(5),
        ] {
            assert_eq!(
                scope_of(serde_json::json!({ "organizationScope": junk })),
                ScopeParams::default()
            );
        }
        // A `scope` key wins, even a null one.
        assert_eq!(
            scope_of(serde_json::json!({ "scope": null, "organizationScope": "bbbb2222" })),
            ScopeParams::default()
        );
        assert_eq!(
            scope_of(serde_json::json!({
                "scope": { "membership": ["o~a"] },
                "organizationScope": "bbbb2222",
            }))
            .membership,
            tokens(&["o~a"])
        );
    }

    // --- URL building ---

    #[test]
    fn readout_url_carries_mode_and_encoded_tz() {
        let none = ScopeParams::default();
        assert_eq!(
            readout_url(4242, "auto", Some("America/Chicago"), &none),
            "http://127.0.0.1:4242/api/readout?mode=auto&tz=America/Chicago"
        );
        // `+` in an IANA id must not decode as a space sidecar-side.
        assert_eq!(
            readout_url(4242, "display", Some("Etc/GMT+8"), &none),
            "http://127.0.0.1:4242/api/readout?mode=display&tz=Etc/GMT%2B8"
        );
        assert_eq!(
            readout_url(80, "auto", None, &none),
            "http://127.0.0.1:80/api/readout?mode=auto"
        );
    }

    #[test]
    fn readout_url_carries_the_scope_tokens_only_when_named() {
        // The default Scope: today's URL, byte for byte.
        assert_eq!(
            readout_url(
                4242,
                "auto",
                Some("America/Chicago"),
                &scope_of(serde_json::json!({}))
            ),
            "http://127.0.0.1:4242/api/readout?mode=auto&tz=America/Chicago"
        );
        // One Organization: the one param the v0.9.x Organization scope sent.
        assert_eq!(
            readout_url(
                4242,
                "auto",
                Some("America/Chicago"),
                &scope_of(serde_json::json!({ "organizationScope": "bbbb2222" }))
            ),
            "http://127.0.0.1:4242/api/readout?mode=auto&tz=America/Chicago&organization=bbbb2222"
        );
        assert_eq!(
            readout_url(
                80,
                "auto",
                None,
                &scope_of(serde_json::json!({
                    "scope": { "account": ["all"], "organization": ["all"] }
                }))
            ),
            "http://127.0.0.1:80/api/readout?mode=auto&organization=all&account=all&persisted=1"
        );
        // A Membership list, a Pending account key's `:` encoded.
        assert_eq!(
            readout_url(
                80,
                "auto",
                None,
                &scope_of(serde_json::json!({
                    "scope": { "membership": ["o2~pending:h", "o1~a1"] }
                }))
            ),
            "http://127.0.0.1:80/api/readout?mode=auto&membership=o1~a1&membership=o2~pending%3Ah&persisted=1"
        );
        // An Account-only Scope is flagged too; the Organization axis alone
        // and `all` alone are not.
        assert_eq!(
            readout_url(
                80,
                "auto",
                None,
                &scope_of(serde_json::json!({ "scope": { "account": ["a1"] } }))
            ),
            "http://127.0.0.1:80/api/readout?mode=auto&account=a1&persisted=1"
        );
        assert_eq!(
            readout_url(
                80,
                "auto",
                None,
                &scope_of(serde_json::json!({ "scope": { "organization": ["all"] } }))
            ),
            "http://127.0.0.1:80/api/readout?mode=auto&organization=all"
        );
    }

    // --- wire parse (lockstep with packages/shared/src/readout.ts) ---

    #[test]
    fn parses_the_shared_wire_shape() {
        let body =
            r#"{"todayCost":12.48,"hasData":true,"hasModelWindow":true,"popoutLimitRows":2}"#;
        assert_eq!(
            parse_readout(body),
            Some(Readout {
                has_model_window: true,
                ..money(12.48, true)
            })
        );
        assert_eq!(parse_readout("not json"), None);
        // A missing field is a contract break, not a default — refuse it.
        assert_eq!(
            parse_readout(r#"{"todayCost":1,"hasData":true,"hasModelWindow":false}"#),
            None
        );
        // The retired Block wire (`blockLive`, ADR-0142 §5) carries no
        // `popoutLimitRows`, so it fails too: one version, no shim.
        let old = r#"{"blockLive":true,"utilizationPct":82,"todayCost":12.48,"hasData":true,"hasModelWindow":true}"#;
        assert_eq!(parse_readout(old), None);
    }

    #[test]
    fn parses_the_most_used_field() {
        let base = r#"{"todayCost":1,"hasData":true,"hasModelWindow":false,"popoutLimitRows":3"#;
        let body = format!(
            r#"{base},"mostUsed":{{"count":3,"top":{{"label":"Team","window":"weeklyModel","model":"Fable","pct":77}},"next":{{"label":null,"window":"fiveHour","pct":12}}}}}}"#
        );
        let r = parse_readout(&body).expect("parses");
        assert_eq!(r.popout_limit_rows, 3);
        assert_eq!(
            r.most_used,
            Some(MostUsed {
                count: 3,
                top: ReadoutMembership {
                    model: Some("Fable".to_string()),
                    ..member("Team", LimitWindow::WeeklyModel, 77.0)
                },
                next: Some(unnamed(LimitWindow::FiveHour, 12.0)),
            })
        );
        // Absent is None, and an unknown window is a contract break.
        let plain = parse_readout(&format!("{base}}}")).expect("parses");
        assert_eq!(plain.most_used, None);
        let bad = body.replace("weeklyModel", "monthly");
        assert_eq!(parse_readout(&bad), None);
    }

    #[test]
    fn parses_the_optional_wide_scope_field() {
        let base = r#"{"todayCost":1,"hasData":true,"hasModelWindow":false,"popoutLimitRows":2"#;
        let with = |wide: &str| format!(r#"{base},"wideScope":{wide}}}"#);
        assert_eq!(
            parse_readout(&with(r#"{"kind":"accounts"}"#)).and_then(|r| r.wide_scope),
            Some(WideScope::Accounts)
        );
        assert_eq!(
            parse_readout(&with(r#"{"kind":"organizations"}"#)).and_then(|r| r.wide_scope),
            Some(WideScope::Organizations)
        );
        assert_eq!(
            parse_readout(&with(r#"{"kind":"memberships","count":4}"#)).and_then(|r| r.wide_scope),
            Some(WideScope::Memberships { count: 4 })
        );
        // Absent is None; an unknown kind is a contract break.
        assert_eq!(
            parse_readout(&format!("{base}}}")).map(|r| r.wide_scope),
            Some(None)
        );
        assert_eq!(parse_readout(&with(r#"{"kind":"everything"}"#)), None);
    }
}
