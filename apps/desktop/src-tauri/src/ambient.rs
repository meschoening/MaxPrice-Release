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
    pub block_live: bool,
    pub utilization_pct: Option<f64>,
    pub today_cost: f64,
    pub has_data: bool,
    /// The current sample carries a Model-scoped weekly limit, so the popout
    /// will draw its `<Model> limit` row — the shell sizes the window for it
    /// (`popout::popout_content_height`) before showing.
    pub has_model_window: bool,
    /// Present only while more than one Organization is tracked (ADR-0106
    /// §11) — absent, not null, on a single-Organization machine, so its body
    /// and therefore its tooltip stay byte-identical to before the scope.
    /// Absent reads as None (so does a `null` the sidecar never sends); a
    /// present-but-malformed object still fails the parse, a contract break
    /// like any other field's. The label is the sidecar's (roster-resolved,
    /// collision-suffixed), never resolved here.
    #[serde(default)]
    pub organizations: Option<ReadoutOrganizations>,
    /// Present only while the requested Scope holds more than one Membership
    /// (#622 item 4, #637): what the money half sums. Absent under a
    /// one-Membership Scope, so a single-Organization, single-Account body and
    /// tooltip are byte-identical to before. The sidecar decides it; the shell
    /// only words it (`wide_scope_words`).
    #[serde(default)]
    pub wide_scope: Option<WideScope>,
    /// Present only while the Scope's multi-Membership set holds two or more
    /// Readable memberships and at least one of them reads a live window
    /// (#638; ADR-0136 §6's #610/#622 rows): the Readout picks the most used
    /// Membership. Absent on a
    /// one-Account install, whose tooltip and title stay byte-identical.
    #[serde(default)]
    pub most_used: Option<MostUsed>,
    /// Present only while that set holds two or more Memberships: the ranked
    /// popout's limit rows (`popout::ranked_popout_content_height`).
    #[serde(default)]
    pub popout_limit_rows: Option<u32>,
}

/// The most used Readout (packages/shared/src/readout.ts
/// `readoutMostUsedSchema`; keep in lockstep). `five_hour_live`: some Readable
/// membership's 5-hour window is in flight, so the title and the tooltip's
/// head are `top`'s percent; false is money, with `top` as `Most used:`.
/// `count` is the set's Memberships, every state, for `+N more`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MostUsed {
    pub five_hour_live: bool,
    pub count: u64,
    pub top: ReadoutMembership,
    pub next: Option<ReadoutMembership>,
}

/// One Membership's most used live window, labelled by the sidecar
/// (`Org · Account` while the set spans Accounts); `pct` unrounded.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadoutMembership {
    pub label: String,
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

/// The readout's multi-Organization half (packages/shared/src/readout.ts;
/// keep in lockstep): `quota_label` names the Organization whose limit the
/// utilization half reads (the Scope's head Organization — Home under All).
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadoutOrganizations {
    pub quota_label: String,
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
    /// The last readout's `popout_limit_rows` — the ranked popout's row count
    /// (#638), None for today's popout. Sticky like `model_window`.
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
/// While more than one Organization is tracked (the readout carries
/// `organizations`; ADR-0106 §11) the tooltip has the room the menu-bar title
/// lacks, so it names what each metric describes: the limit is always ONE
/// Organization's — the Scope's head, Home under All — so it carries that
/// label. Today's cost is the Scope's money, so a Scope of more than one
/// Membership (`wideScope`, #622 item 4, #637) says which: `(all accounts)`,
/// `(all organizations)` or `(N memberships)`. A single-Membership tooltip is
/// byte-identical to before.
///
/// The mirror of `title_text` below, and dead for the same reason on the other
/// side: only the non-macOS write path calls it, while the tests that pin its
/// wording must keep running everywhere.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn tooltip_text(readout: Option<&Readout>) -> String {
    let organizations = readout.and_then(|r| r.organizations.as_ref());
    let wide = readout.and_then(|r| r.wide_scope.as_ref());
    let most_used = readout.and_then(|r| r.most_used.as_ref());
    match (ambient_metric(readout), most_used) {
        (Metric::MostUsed(most_used), _) => ranked_tooltip(most_used),
        (Metric::Today(cost), Some(most_used)) => {
            let money = match wide {
                Some(wide) => format!("MaxPrice — today ${cost:.2} ({})", wide_scope_words(wide)),
                None => format!("MaxPrice — today ${cost:.2}"),
            };
            let top = &most_used.top;
            // `Most used:` shortens its label to fit Windows' limit, and
            // drops when even a short one cannot.
            let budget = TOOLTIP_MAX.saturating_sub(utf16_len(&money) + 1);
            let suffix = format!(" {}", short_pct(top));
            match fit_label_line("Most used: ", &top.label, &suffix, budget) {
                Some(line) => format!("{money}\n{line}"),
                None => fit_tooltip(money),
            }
        }
        (Metric::Limit(pct), _) => {
            let suffix = format!(" 5-hour limit {pct}%");
            organizations
                .and_then(|orgs| {
                    fit_label_line("MaxPrice — ", &orgs.quota_label, &suffix, TOOLTIP_MAX)
                })
                .unwrap_or_else(|| format!("MaxPrice —{suffix}"))
        }
        (Metric::Today(cost), None) => fit_tooltip(match wide {
            Some(wide) => format!("MaxPrice — today ${cost:.2} ({})", wide_scope_words(wide)),
            None => format!("MaxPrice — today ${cost:.2}"),
        }),
        (Metric::None, _) => "MaxPrice".to_string(),
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

/// The percent Readout's tooltip (#610): the most used Membership and window,
/// then `Next:`, then `+N more` for the set's Memberships not named. Past
/// Windows' limit (`TOOLTIP_MAX`) `Next:` drops first (its Membership joins
/// `+N more`); the head line then shortens its label, never its percent, to
/// leave room for `+N more`, which drops only when the label would keep
/// fewer than `MIN_LABEL` units.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn ranked_tooltip(most_used: &MostUsed) -> String {
    let top = &most_used.top;
    let prefix = "MaxPrice — ";
    let suffix = format!(" {} {}%", window_name(top), top.pct.round() as i64);
    let more_line = |named: u64| -> Option<String> {
        let more = most_used.count.saturating_sub(named);
        (more > 0).then(|| format!("+{more} more"))
    };
    let head = format!("{prefix}{}{suffix}", top.label);
    if let Some(next) = most_used.next.as_ref() {
        let mut lines = vec![
            head.clone(),
            format!("Next: {} {}", next.label, short_pct(next)),
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
        if let Some(head) = fit_label_line(prefix, &top.label, &suffix, budget) {
            return format!("{head}\n{more}");
        }
    }
    fit_label_line(prefix, &top.label, &suffix, TOOLTIP_MAX).unwrap_or_else(|| fit_tooltip(head))
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
        Metric::Limit(pct) => format!(" {pct}%"),
        Metric::Today(cost) => format!(" ${cost:.2}"),
        Metric::None => String::new(),
    }
}

/// The metric switch (charter decision 5, one rule for both platforms):
/// 5-hour-limit percent while a block is live, today's cost otherwise, nothing
/// when there is no data at all (fresh install) or no readout (sidecar
/// unreachable). `blockLive` without a percent is treated as not-live — the
/// schema forbids it, but a formatter must not render "…limit %" on a
/// contradiction.
///
/// A readout carrying `mostUsed` (#638) decides by it alone: its percent
/// while some Readable 5-hour window is in flight, else money. `blockLive`,
/// the Scope's head Organization's, is not read then, so a dead key's
/// projection never turns money into a percent (ADR-0138 §8).
enum Metric<'a> {
    Limit(i64),
    MostUsed(&'a MostUsed),
    Today(f64),
    None,
}

fn ambient_metric(readout: Option<&Readout>) -> Metric<'_> {
    match readout {
        Some(r) => {
            if let Some(most_used) = &r.most_used {
                if most_used.five_hour_live {
                    return Metric::MostUsed(most_used);
                }
            } else if r.block_live {
                if let Some(pct) = r.utilization_pct {
                    return Metric::Limit(pct.round() as i64);
                }
            }
            if r.has_data {
                Metric::Today(r.today_cost)
            } else {
                Metric::None
            }
        }
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
        *ambient.popout_limit_rows.lock() = r.popout_limit_rows;
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

    fn readout(block_live: bool, pct: Option<f64>, today: f64, has_data: bool) -> Readout {
        Readout {
            block_live,
            utilization_pct: pct,
            today_cost: today,
            has_data,
            has_model_window: false,
            organizations: None,
            wide_scope: None,
            most_used: None,
            popout_limit_rows: None,
        }
    }

    fn scoped(r: Readout, label: &str, wide: Option<WideScope>) -> Readout {
        Readout {
            organizations: Some(ReadoutOrganizations {
                quota_label: label.to_string(),
            }),
            wide_scope: wide,
            ..r
        }
    }

    fn wide(r: Readout, wide: WideScope) -> Readout {
        Readout {
            wide_scope: Some(wide),
            ..r
        }
    }

    // --- the metric switch + fixed formats (T4 decision 3, T5 decision 5) ---

    #[test]
    fn live_block_reads_as_the_limit_percent() {
        let r = readout(true, Some(82.0), 12.4, true);
        assert_eq!(tooltip_text(Some(&r)), "MaxPrice — 5-hour limit 82%");
        assert_eq!(title_text(Some(&r)), " 82%");
    }

    #[test]
    fn the_percent_is_an_integer_no_padding() {
        // Fixed formats (T4): integer percent — 82.6 rounds, never "82.6%",
        // never "082%".
        let r = readout(true, Some(82.6), 0.0, true);
        assert_eq!(title_text(Some(&r)), " 83%");
        let single = readout(true, Some(7.2), 0.0, true);
        assert_eq!(title_text(Some(&single)), " 7%");
    }

    #[test]
    fn no_live_block_reads_as_todays_cost_two_decimals() {
        let r = readout(false, None, 12.4, true);
        assert_eq!(tooltip_text(Some(&r)), "MaxPrice — today $12.40");
        assert_eq!(title_text(Some(&r)), " $12.40");
        // $0 with data is an honest reading, not a vanish.
        let zero = readout(false, None, 0.0, true);
        assert_eq!(title_text(Some(&zero)), " $0.00");
    }

    #[test]
    fn vanish_not_apologize() {
        // Sidecar unreachable / failed poll → bare name, empty title.
        assert_eq!(tooltip_text(None), "MaxPrice");
        assert_eq!(title_text(None), "");
        // Fresh install (hasData false, nothing live) → same vanish.
        let fresh = readout(false, None, 0.0, false);
        assert_eq!(tooltip_text(Some(&fresh)), "MaxPrice");
        assert_eq!(title_text(Some(&fresh)), "");
    }

    #[test]
    fn the_gap_is_one_leading_space_and_vanish_carries_none() {
        // The item's centring rests on all three of these: the pad is LEADING
        // (a trailing one drags the content left of the slot's centre), it is
        // exactly one space, and the vanish state is genuinely empty — a
        // whitespace-only title would off-centre the icon-only state.
        for r in [
            readout(true, Some(82.0), 12.4, true),
            readout(false, None, 12.4, true),
            readout(false, None, 0.0, true),
        ] {
            let t = title_text(Some(&r));
            assert!(t.starts_with(' '), "{t:?} must lead with the gap space");
            assert!(!t[1..].starts_with(' '), "{t:?} must pad by exactly one");
            assert_eq!(t.trim_end(), t, "{t:?} must not pad on the trailing side");
        }
        assert!(title_text(None).is_empty());
    }

    #[test]
    fn a_live_flag_without_a_percent_falls_through_rather_than_lying() {
        // Schema-forbidden, formatter-defended: blockLive with a null percent
        // must not render "limit %"; with data it degrades to today's cost.
        let r = readout(true, None, 3.5, true);
        assert_eq!(tooltip_text(Some(&r)), "MaxPrice — today $3.50");
    }

    // --- more than one tracked Organization (#291; ADR-0106 §11) ---

    #[test]
    fn more_than_one_tracked_names_the_quota_organization_in_the_tooltip() {
        let live = scoped(readout(true, Some(82.0), 12.4, true), "Team", None);
        assert_eq!(
            tooltip_text(Some(&live)),
            "MaxPrice — Team 5-hour limit 82%"
        );
        // Under All the limit is still one Organization's (the Scope's head, Home).
        let live_all = scoped(
            readout(true, Some(40.0), 12.4, true),
            "Acme",
            Some(WideScope::Organizations),
        );
        assert_eq!(
            tooltip_text(Some(&live_all)),
            "MaxPrice — Acme 5-hour limit 40%"
        );
        // The today fallback is money: under All it says so; scoped to one it does not.
        let today_all = scoped(
            readout(false, None, 12.4, true),
            "Acme",
            Some(WideScope::Organizations),
        );
        assert_eq!(
            tooltip_text(Some(&today_all)),
            "MaxPrice — today $12.40 (all organizations)"
        );
        let today_one = scoped(readout(false, None, 12.4, true), "Team", None);
        assert_eq!(tooltip_text(Some(&today_one)), "MaxPrice — today $12.40");
        // Vanish stays bare.
        let fresh = scoped(
            readout(false, None, 0.0, false),
            "Acme",
            Some(WideScope::Organizations),
        );
        assert_eq!(tooltip_text(Some(&fresh)), "MaxPrice");
    }

    // --- a Scope of more than one Membership (#622 item 4, #637) ---

    #[test]
    fn the_today_fallback_names_a_wide_scope() {
        let today = readout(false, None, 12.4, true);
        assert_eq!(
            tooltip_text(Some(&wide(today.clone(), WideScope::Accounts))),
            "MaxPrice — today $12.40 (all accounts)"
        );
        assert_eq!(
            tooltip_text(Some(&wide(today.clone(), WideScope::Organizations))),
            "MaxPrice — today $12.40 (all organizations)"
        );
        assert_eq!(
            tooltip_text(Some(&wide(
                today.clone(),
                WideScope::Memberships { count: 3 }
            ))),
            "MaxPrice — today $12.40 (3 memberships)"
        );
        // A one-Organization machine of several Accounts carries no quota label,
        // and its limit half is unchanged.
        let live = wide(readout(true, Some(82.0), 12.4, true), WideScope::Accounts);
        assert_eq!(tooltip_text(Some(&live)), "MaxPrice — 5-hour limit 82%");
        // No wide Scope, no suffix: today's single-Membership tooltip.
        assert_eq!(tooltip_text(Some(&today)), "MaxPrice — today $12.40");
    }

    #[test]
    fn the_macos_title_never_names_an_organization() {
        let live = scoped(readout(true, Some(82.0), 12.4, true), "Team", None);
        assert_eq!(title_text(Some(&live)), " 82%");
        let today_all = scoped(
            readout(false, None, 12.4, true),
            "Acme",
            Some(WideScope::Organizations),
        );
        assert_eq!(title_text(Some(&today_all)), " $12.40");
        let accounts = wide(readout(false, None, 12.4, true), WideScope::Accounts);
        assert_eq!(title_text(Some(&accounts)), " $12.40");
    }

    // --- the most used Readout (#638; ADR-0136 §6's #610/#622 rows) ---

    fn member(label: &str, window: LimitWindow, pct: f64) -> ReadoutMembership {
        ReadoutMembership {
            label: label.to_string(),
            window,
            model: None,
            pct,
        }
    }

    fn most_used(
        r: Readout,
        five_hour_live: bool,
        count: u64,
        top: ReadoutMembership,
        next: Option<ReadoutMembership>,
    ) -> Readout {
        Readout {
            most_used: Some(MostUsed {
                five_hour_live,
                count,
                top,
                next,
            }),
            popout_limit_rows: Some(count.min(4) as u32 + u32::from(count > 4)),
            ..r
        }
    }

    #[test]
    fn a_live_five_hour_window_reads_the_most_used_percent() {
        let r = most_used(
            readout(true, Some(12.0), 12.4, true),
            true,
            4,
            member("Team", LimitWindow::FiveHour, 90.6),
            Some(member("Acme", LimitWindow::Weekly, 82.0)),
        );
        assert_eq!(title_text(Some(&r)), " 91%");
        // Short names, so all three lines fit in 63 units.
        assert_eq!(
            tooltip_text(Some(&r)),
            "MaxPrice — Team 5-hour limit 91%\nNext: Acme 82% wk\n+2 more"
        );
    }

    #[test]
    fn any_other_window_reads_wk_and_names_its_kind() {
        let weekly = most_used(
            readout(false, None, 12.4, true),
            true,
            2,
            member("Team · Alex", LimitWindow::Weekly, 82.0),
            Some(member("Acme · Blair", LimitWindow::FiveHour, 40.0)),
        );
        assert_eq!(title_text(Some(&weekly)), " 82% wk");
        assert_eq!(
            tooltip_text(Some(&weekly)),
            "MaxPrice — Team · Alex weekly limit 82%\nNext: Acme · Blair 40%"
        );
        let model = most_used(
            readout(false, None, 12.4, true),
            true,
            3,
            ReadoutMembership {
                model: Some("Fable".to_string()),
                ..member("Team", LimitWindow::WeeklyModel, 77.0)
            },
            None,
        );
        assert_eq!(title_text(Some(&model)), " 77% wk");
        assert_eq!(
            tooltip_text(Some(&model)),
            "MaxPrice — Team Fable weekly limit 77%\n+2 more"
        );
    }

    #[test]
    fn no_five_hour_window_in_flight_reads_money_and_the_most_used() {
        // blockLive is the head Organization's (a dead key's projection, say):
        // the most used rule ignores it.
        let r = most_used(
            wide(readout(true, Some(97.0), 12.4, true), WideScope::Accounts),
            false,
            3,
            member("Acme", LimitWindow::Weekly, 90.0),
            None,
        );
        assert_eq!(title_text(Some(&r)), " $12.40");
        assert_eq!(
            tooltip_text(Some(&r)),
            "MaxPrice — today $12.40 (all accounts)\nMost used: Acme 90% wk"
        );
        // No data: vanish, as today.
        let fresh = most_used(
            readout(false, None, 0.0, false),
            false,
            2,
            member("A", LimitWindow::Weekly, 5.0),
            None,
        );
        assert_eq!(title_text(Some(&fresh)), "");
        assert_eq!(tooltip_text(Some(&fresh)), "MaxPrice");
    }

    #[test]
    fn next_drops_first_past_the_63_unit_limit() {
        // 75 units with Next; without it the head and `+2 more` fit whole.
        let r = most_used(
            readout(false, None, 1.0, true),
            true,
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
            readout(false, None, 1.0, true),
            true,
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
        assert!(head.contains('…'));
    }

    #[test]
    fn a_head_with_no_room_for_the_count_keeps_its_percent() {
        // An astral character is two UTF-16 units: the cut never splits one.
        let long = "😀".repeat(80);
        let r = most_used(
            readout(false, None, 1.0, true),
            true,
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
        let r = most_used(
            readout(false, None, 1.0, true),
            true,
            1,
            member(&label, LimitWindow::FiveHour, 50.0),
            None,
        );
        assert_eq!(tooltip_text(Some(&r)), fits);
    }

    #[test]
    fn most_used_shortens_its_label_and_drops_only_when_none_fits() {
        // The VM's idle tooltip: cut at 64 units before.
        let r = most_used(
            readout(false, None, 1.47, true),
            false,
            14,
            member(
                "Team plan · 0646000d · Account 0646ffff",
                LimitWindow::Weekly,
                95.0,
            ),
            None,
        );
        let t = tooltip_text(Some(&r));
        assert!(utf16_len(&t) <= TOOLTIP_MAX, "{t}");
        let (money, line) = t.split_once('\n').expect("two lines");
        assert_eq!(money, "MaxPrice — today $1.47");
        assert!(line.starts_with("Most used: Team pl…"), "{line}");
        assert!(line.ends_with("0646ffff 95% wk"), "{line}");
        // A wide Scope's money words leave no room for a label: the line drops.
        let wide_r = most_used(
            wide(readout(false, None, 12.4, true), WideScope::Accounts),
            false,
            2,
            member(&"x".repeat(100), LimitWindow::Weekly, 90.0),
            None,
        );
        assert_eq!(
            tooltip_text(Some(&wide_r)),
            "MaxPrice — today $12.40 (all accounts)"
        );
    }

    #[test]
    fn the_quota_label_shortens_before_the_percent() {
        let r = scoped(
            readout(true, Some(82.0), 12.4, true),
            &"Northwind Traders Enterprise ".repeat(3),
            None,
        );
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

    #[test]
    fn parses_the_optional_most_used_fields() {
        let base = r#"{"blockLive":false,"utilizationPct":null,"todayCost":1,"hasData":true,"hasModelWindow":false"#;
        let body = format!(
            r#"{base},"mostUsed":{{"fiveHourLive":true,"count":3,"top":{{"label":"Team","window":"weeklyModel","model":"Fable","pct":77}},"next":null}},"popoutLimitRows":3}}"#
        );
        let r = parse_readout(&body).expect("parses");
        assert_eq!(r.popout_limit_rows, Some(3));
        assert_eq!(
            r.most_used,
            Some(MostUsed {
                five_hour_live: true,
                count: 3,
                top: ReadoutMembership {
                    model: Some("Fable".to_string()),
                    ..member("Team", LimitWindow::WeeklyModel, 77.0)
                },
                next: None,
            })
        );
        // Absent is None, and an unknown window is a contract break.
        let plain = parse_readout(&format!("{base}}}")).expect("parses");
        assert_eq!((plain.most_used, plain.popout_limit_rows), (None, None));
        let bad = body.replace("weeklyModel", "monthly");
        assert_eq!(parse_readout(&bad), None);
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
        let body = r#"{"blockLive":true,"utilizationPct":82,"todayCost":12.48,"hasData":true,"hasModelWindow":true}"#;
        assert_eq!(
            parse_readout(body),
            Some(Readout {
                has_model_window: true,
                ..readout(true, Some(82.0), 12.48, true)
            })
        );
        let idle = r#"{"blockLive":false,"utilizationPct":null,"todayCost":0,"hasData":false,"hasModelWindow":false}"#;
        assert_eq!(parse_readout(idle), Some(readout(false, None, 0.0, false)));
        // The pre-model-row wire (no hasModelWindow) is a contract break too.
        let old = r#"{"blockLive":true,"utilizationPct":82,"todayCost":12.48,"hasData":true}"#;
        assert_eq!(parse_readout(old), None);
        assert_eq!(parse_readout("not json"), None);
        // A missing field is a contract break, not a default — refuse it.
        assert_eq!(parse_readout(r#"{"blockLive":false}"#), None);
    }

    #[test]
    fn parses_the_optional_organizations_field() {
        let body = r#"{"blockLive":true,"utilizationPct":82,"todayCost":12.48,"hasData":true,"hasModelWindow":false,"organizations":{"quotaLabel":"Acme · 1a2b3c4d"}}"#;
        assert_eq!(
            parse_readout(body),
            Some(scoped(
                readout(true, Some(82.0), 12.48, true),
                "Acme · 1a2b3c4d",
                None
            ))
        );
        // A malformed organizations object is a contract break, not a default.
        let bad = r#"{"blockLive":true,"utilizationPct":82,"todayCost":12.48,"hasData":true,"hasModelWindow":false,"organizations":{"label":"Acme"}}"#;
        assert_eq!(parse_readout(bad), None);
    }

    #[test]
    fn parses_the_optional_wide_scope_field() {
        let base = r#"{"blockLive":false,"utilizationPct":null,"todayCost":1,"hasData":true,"hasModelWindow":false"#;
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
