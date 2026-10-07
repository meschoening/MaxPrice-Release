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
}

/// The readout's multi-Organization half (packages/shared/src/readout.ts;
/// keep in lockstep): `quota_label` names the Organization whose limit the
/// utilization half reads (the scope's Quota organization — Home under All),
/// and `all` says the money half is the union of every tracked Organization.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadoutOrganizations {
    pub quota_label: String,
    pub all: bool,
}

/// Ambient state managed by the Tauri builder: the pending update (read by the
/// popout via `get_pending_update`, worn by the tray badge) and the poller's
/// kick channel (`write_settings` pokes it so a cost-mode/timezone/Organization
/// scope flip updates the readout immediately instead of up-to-60s later —
/// the scope rides the same settings.json write as the other two).
#[derive(Default)]
pub struct AmbientState {
    pub pending_update: Mutex<Option<String>>,
    /// The last readout's `has_model_window` — the popout's extra-row bit.
    /// Sticky across a vanished readout (a sidecar hiccup must not make the
    /// popout jump 31px on its next open); a readout that ANSWERS overwrites.
    pub model_window: Mutex<bool>,
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
/// Organization's — the Quota organization, Home under All — so it carries that
/// label; today's cost is the scope's money, so only All says so. A single
/// Organization's tooltip is byte-identical to before.
///
/// The mirror of `title_text` below, and dead for the same reason on the other
/// side: only the non-macOS write path calls it, while the tests that pin its
/// wording must keep running everywhere.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn tooltip_text(readout: Option<&Readout>) -> String {
    let organizations = readout.and_then(|r| r.organizations.as_ref());
    match (ambient_metric(readout), organizations) {
        (Metric::Limit(pct), Some(orgs)) => {
            format!("MaxPrice — {} 5-hour limit {pct}%", orgs.quota_label)
        }
        (Metric::Limit(pct), None) => format!("MaxPrice — 5-hour limit {pct}%"),
        (Metric::Today(cost), Some(orgs)) if orgs.all => {
            format!("MaxPrice — today ${cost:.2} (all organizations)")
        }
        (Metric::Today(cost), _) => format!("MaxPrice — today ${cost:.2}"),
        (Metric::None, _) => "MaxPrice".to_string(),
    }
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
/// (which run on the Windows primary) must keep pinning them.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn title_text(readout: Option<&Readout>) -> String {
    match ambient_metric(readout) {
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
enum Metric {
    Limit(i64),
    Today(f64),
    None,
}

fn ambient_metric(readout: Option<&Readout>) -> Metric {
    match readout {
        Some(r) => {
            if r.block_live {
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
    /// The resolved Organization scope: a tracked uuid, "all", or None for Home.
    pub organization: Option<String>,
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
/// - `organizationScope`: resolved against Home and the tracked list exactly
///   as the renderer's `parseSettings` resolves it (`resolve_organization_scope`
///   below), so the tray asks for the scope the Today tile answers (ADR-0106
///   §11). Home → None → no param, so a single-Organization URL is unchanged.
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
        organization: resolve_organization_scope(settings),
    }
}

/// `z.string().min(1).nullable().catch(null)` by hand: a non-empty string, or
/// nothing — absent, null, a non-string and "" all read as null.
fn non_empty_str(v: Option<&serde_json::Value>) -> Option<&str> {
    v.and_then(|v| v.as_str()).filter(|s| !s.is_empty())
}

/// A hand mirror of `resolveOrganizationScope`
/// (packages/shared/src/organization-scope.ts; keep in lockstep) over the three
/// Zod fields it reads (packages/shared/src/settings.ts): `homeOrganization`
/// and `organizationScope` are `z.string().min(1).nullable().catch(null)`, and
/// `trackedOrganizations` is `z.array(z.string()).catch([])` — which drops the
/// WHOLE list on one non-string element, not just that element, so this does
/// too (else the shell would count a second member the renderer does not, and
/// ask for All where the Today tile answers Home). The rule itself: no Home
/// narrows nothing; a scope naming nothing tracked, or naming Home itself, is
/// Home; `all` over a one-member set is Home.
fn resolve_organization_scope(settings: &serde_json::Value) -> Option<String> {
    let home = non_empty_str(settings.get("homeOrganization"))?;
    let scope = non_empty_str(settings.get("organizationScope"))?;
    let tracked: Vec<&str> = match settings
        .get("trackedOrganizations")
        .and_then(|v| v.as_array())
    {
        Some(list) if list.iter().all(|v| v.is_string()) => {
            list.iter().filter_map(|v| v.as_str()).collect()
        }
        _ => Vec::new(),
    };
    let mut members: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    members.insert(home);
    members.extend(tracked.into_iter().filter(|s| !s.is_empty()));
    if scope == "all" {
        return (members.len() >= 2).then(|| "all".to_string());
    }
    (scope != home && members.contains(scope)).then(|| scope.to_string())
}

/// Build the readout URL. `tz` is percent-encoded: IANA zone ids can carry `+`
/// (`Etc/GMT+8`), which a query parser reads as a space. `organization` is
/// appended only when the scope is not Home (ADR-0106 §2: absent means Home),
/// encoded the same way for symmetry — a uuid or `all` never needs it.
pub fn readout_url(port: u16, mode: &str, tz: Option<&str>, organization: Option<&str>) -> String {
    let mut url = format!("http://127.0.0.1:{port}/api/readout?mode={mode}");
    if let Some(tz) = tz {
        url.push_str("&tz=");
        url.push_str(&percent_encode(tz));
    }
    if let Some(organization) = organization {
        url.push_str("&organization=");
        url.push_str(&percent_encode(organization));
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
        *app.state::<AmbientState>().model_window.lock() = r.has_model_window;
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
    let url = readout_url(
        port,
        &params.mode,
        params.tz.as_deref(),
        params.organization.as_deref(),
    );

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
        }
    }

    fn scoped(r: Readout, label: &str, all: bool) -> Readout {
        Readout {
            organizations: Some(ReadoutOrganizations {
                quota_label: label.to_string(),
                all,
            }),
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
        let live = scoped(readout(true, Some(82.0), 12.4, true), "Team", false);
        assert_eq!(
            tooltip_text(Some(&live)),
            "MaxPrice — Team 5-hour limit 82%"
        );
        // Under All the limit is still one Organization's (the Quota organization, Home).
        let live_all = scoped(readout(true, Some(40.0), 12.4, true), "Acme", true);
        assert_eq!(
            tooltip_text(Some(&live_all)),
            "MaxPrice — Acme 5-hour limit 40%"
        );
        // The today fallback is money: under All it says so; scoped to one it does not.
        let today_all = scoped(readout(false, None, 12.4, true), "Acme", true);
        assert_eq!(
            tooltip_text(Some(&today_all)),
            "MaxPrice — today $12.40 (all organizations)"
        );
        let today_one = scoped(readout(false, None, 12.4, true), "Team", false);
        assert_eq!(tooltip_text(Some(&today_one)), "MaxPrice — today $12.40");
        // Vanish stays bare.
        let fresh = scoped(readout(false, None, 0.0, false), "Acme", true);
        assert_eq!(tooltip_text(Some(&fresh)), "MaxPrice");
    }

    #[test]
    fn the_macos_title_never_names_an_organization() {
        let live = scoped(readout(true, Some(82.0), 12.4, true), "Team", false);
        assert_eq!(title_text(Some(&live)), " 82%");
        let today_all = scoped(readout(false, None, 12.4, true), "Acme", true);
        assert_eq!(title_text(Some(&today_all)), " $12.40");
    }

    // --- settings mirroring (the background_residency_enabled precedent) ---

    #[test]
    fn settings_params_mirror_the_schema_defaults() {
        let params = settings_readout_params(&serde_json::json!({}));
        assert_eq!(params.mode, "auto");
        assert_eq!(params.tz, None);
        assert_eq!(params.organization, None);

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

    fn org_settings(scope: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "homeOrganization": "aaaa1111",
            "trackedOrganizations": ["bbbb2222"],
            "organizationScope": scope,
        })
    }

    #[test]
    fn the_scope_resolves_like_the_shared_rule() {
        // Home (null / absent) → no param: today's URL.
        assert_eq!(
            settings_readout_params(&org_settings(serde_json::Value::Null)).organization,
            None
        );
        // A tracked uuid → that uuid.
        assert_eq!(
            settings_readout_params(&org_settings(serde_json::json!("bbbb2222")))
                .organization
                .as_deref(),
            Some("bbbb2222")
        );
        // All over two members → "all".
        assert_eq!(
            settings_readout_params(&org_settings(serde_json::json!("all")))
                .organization
                .as_deref(),
            Some("all")
        );
        // Unresolvable: an untracked uuid, the Home uuid itself, a non-string, "".
        for junk in [
            serde_json::json!("cccc3333"),
            serde_json::json!("aaaa1111"),
            serde_json::json!(42),
            serde_json::json!(""),
        ] {
            assert_eq!(
                settings_readout_params(&org_settings(junk)).organization,
                None
            );
        }
    }

    #[test]
    fn all_over_one_member_is_home() {
        let one = serde_json::json!({ "homeOrganization": "aaaa1111", "organizationScope": "all" });
        assert_eq!(settings_readout_params(&one).organization, None);
        // Home repeated in the list, and "" entries, add no member.
        let dup = serde_json::json!({
            "homeOrganization": "aaaa1111",
            "trackedOrganizations": ["aaaa1111", ""],
            "organizationScope": "all",
        });
        assert_eq!(settings_readout_params(&dup).organization, None);
    }

    #[test]
    fn no_home_narrows_nothing() {
        let s = serde_json::json!({ "trackedOrganizations": ["bbbb2222"], "organizationScope": "bbbb2222" });
        assert_eq!(settings_readout_params(&s).organization, None);
    }

    #[test]
    fn a_tracked_list_with_a_non_string_is_dropped_whole() {
        // Zod's `.catch([])` drops the WHOLE array on one bad element, so the
        // renderer sees one member and resolves "all" to Home; the shell must too.
        let s = serde_json::json!({
            "homeOrganization": "aaaa1111",
            "trackedOrganizations": ["bbbb2222", 7],
            "organizationScope": "all",
        });
        assert_eq!(settings_readout_params(&s).organization, None);
    }

    // --- URL building ---

    #[test]
    fn readout_url_carries_mode_and_encoded_tz() {
        assert_eq!(
            readout_url(4242, "auto", Some("America/Chicago"), None),
            "http://127.0.0.1:4242/api/readout?mode=auto&tz=America/Chicago"
        );
        // `+` in an IANA id must not decode as a space sidecar-side.
        assert_eq!(
            readout_url(4242, "display", Some("Etc/GMT+8"), None),
            "http://127.0.0.1:4242/api/readout?mode=display&tz=Etc/GMT%2B8"
        );
        assert_eq!(
            readout_url(80, "auto", None, None),
            "http://127.0.0.1:80/api/readout?mode=auto"
        );
    }

    #[test]
    fn readout_url_carries_the_organization_only_when_scoped() {
        assert_eq!(
            readout_url(4242, "auto", Some("America/Chicago"), None),
            "http://127.0.0.1:4242/api/readout?mode=auto&tz=America/Chicago"
        );
        assert_eq!(
            readout_url(4242, "auto", Some("America/Chicago"), Some("bbbb2222")),
            "http://127.0.0.1:4242/api/readout?mode=auto&tz=America/Chicago&organization=bbbb2222"
        );
        assert_eq!(
            readout_url(80, "auto", None, Some("all")),
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
        let body = r#"{"blockLive":true,"utilizationPct":82,"todayCost":12.48,"hasData":true,"hasModelWindow":false,"organizations":{"quotaLabel":"Acme · 1a2b3c4d","all":true}}"#;
        assert_eq!(
            parse_readout(body),
            Some(scoped(
                readout(true, Some(82.0), 12.48, true),
                "Acme · 1a2b3c4d",
                true
            ))
        );
        // A malformed organizations object is a contract break, not a default.
        let bad = r#"{"blockLive":true,"utilizationPct":82,"todayCost":12.48,"hasData":true,"hasModelWindow":false,"organizations":{"quotaLabel":"Acme"}}"#;
        assert_eq!(parse_readout(bad), None);
    }
}
