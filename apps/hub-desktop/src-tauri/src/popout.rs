// Tray-popout positioning (ADR-0050, map #89 T2). Pure math, unit-tested;
// the runtime glue in lib.rs feeds it physical pixels from the tray Click's
// rect + `monitor_from_point`/`work_area` and hands the result straight to
// `set_position(PhysicalPosition)`. Everything here is physical px on ONE
// monitor — rect, work area, and set_position all speak physical, so no
// logical conversion ever happens inside (the historical multi-monitor
// failure mode, tauri #7139/#7890). Hand-rolled instead of
// tauri-plugin-positioner: the plugin has no edge-docked-taskbar variants and
// an open multi-monitor macOS bug (plugins-workspace #724).

use std::time::Duration;

/// The popout window's label. The SAME string appears in `tauri.conf.json`'s
/// window definition, in `capabilities/popout.json`'s window scope, and in the
/// renderer's `currentWindowLabel` check — four encodings of one contract, only
/// one of which the compiler can see. This const binds the Rust half; the
/// cross-file half is pinned by a test in `lib.rs` that reads the other two
/// files with `include_str!`.
pub const POPOUT_LABEL: &str = "popout";

/// A rectangle in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Px {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Px {
    pub fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }
}

/// Gap between the tray icon / work-area edge and the popout, physical px.
pub const POPOUT_GAP: f64 = 8.0;

/// The popout's physical inner size on the monitor it is about to open on:
/// its CONFIGURED logical size (tauri.conf.json — the size the CSS layout was
/// drawn against) times that monitor's live scale factor.
///
/// It deliberately takes no "current size" parameter. Deriving the popout's
/// size from the window's own size is the bug this replaces: nothing in this
/// app resizes the popout, but tao's `WM_DPICHANGED` handler does — it
/// rescales the window (old physical → logical → new physical) and caches the
/// new scale factor per window. A DPI event with no matching return event —
/// display sleep/wake, a monitor re-handshake, an RDP session, a scale change
/// arriving while the window is hidden — therefore strands the window at the
/// wrong physical size while WebView2 keeps rasterizing at the monitor's real
/// DPI, collapsing the CSS viewport (224x224 → 149x149 at scale 1.5: the
/// action row clips away, the state column ellipsizes). The popout is only
/// ever hidden and shown, never resized or recreated, so nothing corrects it
/// short of restarting the app. Config × live monitor scale is the one
/// derivation that cannot inherit that drift.
///
/// `None` when the inputs can't describe a window (non-finite or non-positive
/// scale / size): a zero-sized popout is worse than an unmoved one, so the
/// caller skips size and position together and still shows.
pub fn popout_physical_size(logical: (f64, f64), target_scale: f64) -> Option<(f64, f64)> {
    let (w, h) = (logical.0 * target_scale, logical.1 * target_scale);
    // Both axes are checked for finiteness, not just the width: NaN is caught
    // by `> 0.0` alone (every NaN comparison is false), but +INFINITY passes it
    // and would reach the caller's `as u32`, which saturates to u32::MAX.
    (target_scale.is_finite()
        && target_scale > 0.0
        && w.is_finite()
        && w > 0.0
        && h.is_finite()
        && h > 0.0)
        .then_some((w, h))
}

/// Debounce window for the Windows mousedown-blur / mouseup-Click toggle
/// flicker (tauri #8869, closed as not planned — app-side territory): a tray
/// click landing within this window of a blur-hide is the click that CAUSED
/// the blur, i.e. the close half of a toggle, and must not re-open.
pub const BLUR_DEBOUNCE_MS: u128 = 400;

/// What a tray click should do to the popout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayClick {
    /// The popout is up: this is a deliberate toggle-close.
    Hide,
    /// Open it (and, at the call site, re-assert its geometry first).
    Show,
    /// Drop the click entirely — it is the mouseup half of a click whose
    /// mousedown already blur-closed the popout.
    Swallow,
}

/// The whole tray-click decision as one pure function, so the three-way
/// outcome is testable without a tray, a window, or an event loop.
///
/// `since_blur` is how long ago a *user-caused* blur last hid the popout
/// (`None` = never, or already consumed). A click inside `BLUR_DEBOUNCE_MS` of
/// one is the click that caused it — see the const's note on tauri #8869.
///
/// The stamp is good for exactly ONE swallow, which is why the caller clears it
/// on this arm: it is set by any user blur-hide, including ones no tray click
/// follows (clicking elsewhere on the desktop), so leaving it set would also
/// swallow a deliberate re-open that happened to land inside the same window.
pub fn tray_click_action(visible: bool, since_blur: Option<Duration>) -> TrayClick {
    if visible {
        return TrayClick::Hide;
    }
    match since_blur {
        Some(elapsed) if elapsed.as_millis() < BLUR_DEBOUNCE_MS => TrayClick::Swallow,
        _ => TrayClick::Show,
    }
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    // hi can sit below lo when the popout outsizes the work area; the low
    // bound (keep the top-left reachable) wins.
    v.min(hi).max(lo)
}

// The edge a popout has to clear on the taskbar's side: whichever of the work
// area's own edge and the tray icon's near edge leaves LESS room.
//
// Usually those are the same thing — a docked icon's rect starts at the
// taskbar's inner edge, which IS the work edge. But a tray icon can also live
// in the **hidden-icons overflow flyout**, a panel that floats off the taskbar
// holding the icons that didn't get promoted; there the icon sits wholly inside
// the work area, and anchoring to the work edge drops the popout straight onto
// the flyout, covering its other icons. Clearing the icon instead gives the
// popout the same `POPOUT_GAP` stand-off from the flyout's icons that the
// docked case gets from the taskbar's edge.
//
// The flyout exists on every taskbar edge, so both directions are needed:
// `anchor_low` for the edges the popout grows away from downward/rightward
// (taskbar top / left), `anchor_high` for the ones it grows away from
// upward/leftward (taskbar bottom / right).

/// The lower bound to start from: the work edge, pushed past the tray icon.
fn anchor_low(work_edge: f64, tray_edge: f64) -> f64 {
    work_edge.max(tray_edge)
}

/// The upper bound to hang from: the work edge, pulled back to the tray icon.
fn anchor_high(work_edge: f64, tray_edge: f64) -> f64 {
    work_edge.min(tray_edge)
}

/// Where to place the popout: `tray` = the tray icon's screen rect, `mon` =
/// the monitor bounds, `work` = its work area (monitor minus taskbar / menu
/// bar / Dock), `popout` = the popout's outer size at the target monitor's
/// scale — all physical. Returns the popout's top-left corner.
///
/// macOS: the icon lives in the top menu bar — hang beneath it, centered.
/// Windows: the taskbar can dock on any edge; the inset side of the work area
/// says which, and the popout goes inside the work area on the side nearest
/// the tray (centered on the icon for top/bottom bars, bottom-aligned to it
/// for left/right bars). Every docked case anchors through `anchor_low` /
/// `anchor_high`, which also clear the hidden-icons overflow flyout when the
/// icon is parked in there — a no-op for a docked icon, whose near edge IS the
/// work edge. An auto-hidden taskbar insets nothing — then the tray rect itself
/// is the anchor and the popout sits above it.
pub fn popout_position(tray: Px, mon: Px, work: Px, popout: (f64, f64), macos: bool) -> (f64, f64) {
    let (pw, ph) = popout;
    let center_x = tray.x + tray.w / 2.0 - pw / 2.0;

    let (x, y) = if macos {
        (center_x, tray.y + tray.h + POPOUT_GAP)
    } else if work.y > mon.y {
        // taskbar TOP → popout below it (or below the flyout hanging off it)
        (center_x, anchor_low(work.y, tray.y + tray.h) + POPOUT_GAP)
    } else if work.y + work.h < mon.y + mon.h {
        // taskbar BOTTOM → popout above it, or above the hidden-icons
        // overflow flyout when the icon is parked in there
        (
            center_x,
            anchor_high(work.y + work.h, tray.y) - ph - POPOUT_GAP,
        )
    } else if work.x > mon.x {
        // taskbar LEFT → popout right of it, bottom-aligned to the tray
        (
            anchor_low(work.x, tray.x + tray.w) + POPOUT_GAP,
            tray.y + tray.h - ph,
        )
    } else if work.x + work.w < mon.x + mon.w {
        // taskbar RIGHT → popout left of it, bottom-aligned to the tray
        (
            anchor_high(work.x + work.w, tray.x) - pw - POPOUT_GAP,
            tray.y + tray.h - ph,
        )
    } else {
        // no inset (auto-hide taskbar) → anchor to the tray rect, popout above
        (center_x, tray.y - ph - POPOUT_GAP)
    };

    (
        clamp(x, work.x, work.x + work.w - pw),
        clamp(y, work.y, work.y + work.h - ph),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // A classic 1920×1080 monitor. POP is a stand-in popout size in physical
    // px — this module is pure geometry, so the fixture never has to track
    // tauri.conf.json's logical size (only `popout_physical_size`'s caller
    // does, and it reads the config at runtime).
    const POP: (f64, f64) = (264.0, 222.0);
    const MON: Px = Px {
        x: 0.0,
        y: 0.0,
        w: 1920.0,
        h: 1080.0,
    };

    #[test]
    fn windows_bottom_taskbar_places_above_centered_on_the_tray() {
        let work = Px::new(0.0, 0.0, 1920.0, 1032.0);
        let tray = Px::new(1700.0, 1040.0, 24.0, 24.0);
        let (x, y) = popout_position(tray, MON, work, POP, false);
        assert_eq!(y, 1032.0 - 222.0 - POPOUT_GAP); // above the work-area floor
        assert_eq!(x, 1700.0 + 12.0 - 132.0); // centered on the icon
    }

    #[test]
    fn windows_overflow_flyout_icon_anchors_to_the_icon_not_the_work_floor() {
        // Measured on Windows 11 (1512x949, taskbar 48 tall): the hidden-icons
        // flyout spans y 827..901 and the hub's icon inside it is 40x40 at
        // 1276,844. Anchoring to the work floor would put the popout's bottom
        // at 886, right across the flyout's other three icons.
        let work = Px::new(0.0, 0.0, 1512.0, 901.0);
        let mon = Px::new(0.0, 0.0, 1512.0, 949.0);
        let tray = Px::new(1276.0, 844.0, 40.0, 40.0);
        let pop = (279.0, 233.0);
        let (x, y) = popout_position(tray, mon, work, pop, false);
        assert_eq!(anchor_high(work.y + work.h, tray.y), 844.0); // the icon's own top
        assert_eq!(y, 844.0 - 233.0 - POPOUT_GAP);
        assert!(
            y + pop.1 <= 844.0,
            "popout must not reach the flyout's icons"
        );
        assert_eq!(x, 1276.0 + 20.0 - 139.5); // still centered on the icon
    }

    #[test]
    fn windows_docked_icon_keeps_the_work_floor_as_its_anchor() {
        // A docked icon's rect starts AT the work floor, so the anchor is the
        // taskbar edge exactly as before — the two rules coincide.
        let work = Px::new(0.0, 0.0, 1920.0, 1032.0);
        let tray = Px::new(1700.0, 1032.0, 24.0, 48.0);
        assert_eq!(anchor_high(work.y + work.h, tray.y), 1032.0);
        let (_, y) = popout_position(tray, MON, work, POP, false);
        assert_eq!(y, 1032.0 - 222.0 - POPOUT_GAP);
    }

    #[test]
    fn windows_top_taskbar_places_below_it() {
        let work = Px::new(0.0, 48.0, 1920.0, 1032.0);
        let tray = Px::new(1700.0, 12.0, 24.0, 24.0);
        // Docked under a TOP bar: the icon's bottom (36) is inside the bar, so
        // the work ceiling (48) is the binding edge — the two rules coincide,
        // exactly as they do for the bottom case.
        assert_eq!(anchor_low(work.y, tray.y + tray.h), 48.0);
        let (x, y) = popout_position(tray, MON, work, POP, false);
        assert_eq!(y, 48.0 + POPOUT_GAP);
        assert_eq!(x, 1580.0);
    }

    #[test]
    fn windows_top_taskbar_flyout_icon_anchors_to_the_icon_not_the_work_ceiling() {
        // The hidden-icons flyout hangs off the taskbar on whichever edge it is
        // docked to, so a top bar's flyout floats BELOW the work ceiling and
        // the icon sits wholly inside the work area (y 88..128 here).
        let work = Px::new(0.0, 48.0, 1920.0, 1032.0);
        let tray = Px::new(1700.0, 88.0, 40.0, 40.0);
        let (_, y) = popout_position(tray, MON, work, POP, false);
        assert_eq!(y, 128.0 + POPOUT_GAP); // clears the icon, not the bar
        assert!(y >= 88.0 + 40.0, "popout must not reach the flyout's icons");
    }

    #[test]
    fn windows_left_taskbar_places_beside_it_bottom_aligned() {
        let work = Px::new(64.0, 0.0, 1856.0, 1080.0);
        let tray = Px::new(20.0, 1000.0, 24.0, 24.0);
        let (x, y) = popout_position(tray, MON, work, POP, false);
        assert_eq!(x, 64.0 + POPOUT_GAP);
        assert_eq!(y, 1000.0 + 24.0 - 222.0);
    }

    #[test]
    fn windows_left_taskbar_flyout_icon_anchors_to_the_icon_not_the_work_edge() {
        // Flyout floating to the RIGHT of a left-docked bar: icon at x 96..136,
        // inside the work area, so anchoring to the work edge (64) would put
        // the popout across it.
        let work = Px::new(64.0, 0.0, 1856.0, 1080.0);
        let tray = Px::new(96.0, 1000.0, 40.0, 40.0);
        let (x, _) = popout_position(tray, MON, work, POP, false);
        assert_eq!(x, 136.0 + POPOUT_GAP);
        assert!(x >= 96.0 + 40.0, "popout must not reach the flyout's icons");
    }

    #[test]
    fn windows_right_taskbar_places_beside_it_bottom_aligned() {
        let work = Px::new(0.0, 0.0, 1856.0, 1080.0);
        let tray = Px::new(1880.0, 1000.0, 24.0, 24.0);
        let (x, y) = popout_position(tray, MON, work, POP, false);
        assert_eq!(x, 1856.0 - 264.0 - POPOUT_GAP);
        assert_eq!(y, 802.0);
    }

    #[test]
    fn windows_right_taskbar_flyout_icon_anchors_to_the_icon_not_the_work_edge() {
        // Flyout floating to the LEFT of a right-docked bar: icon at x
        // 1780..1820, inside the work area whose right edge is 1856.
        let work = Px::new(0.0, 0.0, 1856.0, 1080.0);
        let tray = Px::new(1780.0, 1000.0, 40.0, 40.0);
        let (x, _) = popout_position(tray, MON, work, POP, false);
        assert_eq!(x, 1780.0 - 264.0 - POPOUT_GAP);
        assert!(
            x + POP.0 <= 1780.0,
            "popout must not reach the flyout's icons"
        );
    }

    #[test]
    fn windows_autohide_taskbar_anchors_to_the_tray_rect_itself() {
        // No inset anywhere: work area == monitor.
        let tray = Px::new(1700.0, 1040.0, 24.0, 24.0);
        let (x, y) = popout_position(tray, MON, MON, POP, false);
        assert_eq!(y, 1040.0 - 222.0 - POPOUT_GAP);
        assert_eq!(x, 1580.0);
    }

    #[test]
    fn clamps_into_the_work_area_at_the_screen_edge() {
        let work = Px::new(0.0, 0.0, 1920.0, 1032.0);
        // Tray icon hard against the right screen edge: centering would spill.
        let tray = Px::new(1896.0, 1040.0, 24.0, 24.0);
        let (x, _) = popout_position(tray, MON, work, POP, false);
        assert_eq!(x, 1920.0 - 264.0);
    }

    #[test]
    fn secondary_monitor_negative_coordinates_stay_on_that_monitor() {
        let mon = Px::new(-1920.0, 0.0, 1920.0, 1080.0);
        let work = Px::new(-1920.0, 0.0, 1920.0, 1032.0);
        // Tray near that monitor's LEFT edge: centering would spill to -2020,
        // past the work area's own -1920 bound — the clamp must use the
        // monitor's coordinates, not 0.
        let tray = Px::new(-1900.0, 1040.0, 24.0, 24.0);
        let (x, y) = popout_position(tray, mon, work, POP, false);
        assert_eq!(y, 802.0);
        assert_eq!(x, -1920.0);
        assert!(x >= work.x && x + POP.0 <= work.x + work.w);
    }

    // --- popout_physical_size: the size is derived, never inherited ---

    // tauri.conf.json's popout window: 224x224 logical. The lib.rs contract
    // test is what pins these narrations to the real config; here they are
    // just the numbers the story is told in.
    const CONFIGURED: (f64, f64) = (224.0, 224.0);

    #[test]
    fn physical_size_is_the_configured_logical_size_at_the_target_scale() {
        assert_eq!(popout_physical_size(CONFIGURED, 1.0), Some((224.0, 224.0)));
        assert_eq!(popout_physical_size(CONFIGURED, 1.5), Some((336.0, 336.0)));
        assert_eq!(popout_physical_size(CONFIGURED, 2.0), Some((448.0, 448.0)));
    }

    #[test]
    fn a_dpi_stranded_window_is_re_derived_not_carried_forward() {
        // The observed failure (Windows 11, 4K @ 150%): a stray DPI event
        // left the window 224x224 PHYSICAL — its logical size applied as
        // physical — while the monitor stayed at 144dpi. Re-deriving from
        // config × the monitor's live scale restores the intended 336x336
        // whatever the window currently measures.
        let stranded = CONFIGURED;
        let corrected = popout_physical_size(CONFIGURED, 1.5).unwrap();
        assert_eq!(corrected, (336.0, 336.0));
        assert_ne!(corrected, stranded);

        // And the size feeds the anchor: positioning off the stranded size
        // would hang the popout 112px low and 56px right of centre, so the
        // correction has to happen BEFORE popout_position, not after.
        let work = Px::new(0.0, 0.0, 2560.0, 1392.0);
        let mon = Px::new(0.0, 0.0, 2560.0, 1440.0);
        let tray = Px::new(2200.0, 1338.0, 40.0, 40.0);
        let (gx, gy) = popout_position(tray, mon, work, corrected, false);
        let (bx, by) = popout_position(tray, mon, work, stranded, false);
        assert_eq!(gy + corrected.1, 1338.0 - POPOUT_GAP); // bottom on the anchor
        assert_eq!((by - gy, bx - gx), (112.0, 56.0));
    }

    #[test]
    fn a_nonsense_scale_yields_no_size_rather_than_a_zero_window() {
        assert_eq!(popout_physical_size(CONFIGURED, 0.0), None);
        assert_eq!(popout_physical_size(CONFIGURED, -1.5), None);
        assert_eq!(popout_physical_size(CONFIGURED, f64::NAN), None);
        assert_eq!(popout_physical_size((0.0, 224.0), 1.5), None);
        // +INFINITY is the one non-finite that survives `> 0.0`; unguarded it
        // would reach the caller's `as u32` and saturate to u32::MAX.
        assert_eq!(popout_physical_size((224.0, f64::INFINITY), 1.0), None);
        assert_eq!(popout_physical_size((f64::INFINITY, 224.0), 1.0), None);
        assert_eq!(popout_physical_size(CONFIGURED, f64::INFINITY), None);
    }

    #[test]
    fn macos_hangs_below_the_menu_bar_icon_centered() {
        // A 2x display: everything arrives physical, including the 2x popout.
        let mon = Px::new(0.0, 0.0, 2880.0, 1800.0);
        let work = Px::new(0.0, 50.0, 2880.0, 1650.0);
        let tray = Px::new(2500.0, 4.0, 44.0, 44.0);
        let pop = (528.0, 444.0);
        let (x, y) = popout_position(tray, mon, work, pop, true);
        assert_eq!(y, 4.0 + 44.0 + POPOUT_GAP);
        assert_eq!(x, 2500.0 + 22.0 - 264.0);
    }

    #[test]
    fn macos_clamps_at_the_right_edge_of_the_work_area() {
        let mon = Px::new(0.0, 0.0, 2880.0, 1800.0);
        let work = Px::new(0.0, 50.0, 2880.0, 1650.0);
        let tray = Px::new(2860.0, 4.0, 44.0, 44.0);
        let pop = (528.0, 444.0);
        let (x, _) = popout_position(tray, mon, work, pop, true);
        assert_eq!(x, 2880.0 - 528.0);
    }

    #[test]
    fn a_popout_bigger_than_the_work_area_keeps_its_top_left_reachable() {
        // Every other case has hi > lo, so the inverted branch of `clamp` — the
        // one that decides WHICH corner survives when the popout doesn't fit —
        // is otherwise never executed. Both axes have to overflow: a popout
        // that only outsizes the work area vertically leaves x well-behaved.
        let mon = Px::new(0.0, 0.0, 1920.0, 640.0);
        let work = Px::new(0.0, 0.0, 1920.0, 600.0); // bottom-docked bar
        let tray = Px::new(1700.0, 604.0, 24.0, 24.0);
        let pop = (2000.0, 700.0);
        // lo wins in both axes: the popout spills off the far edges, but its
        // top-left — where the popout's own content starts — stays on screen.
        assert_eq!(
            popout_position(tray, mon, work, pop, false),
            (work.x, work.y)
        );
    }

    // --- tray_click_action: the whole three-way tray-click decision ---

    #[test]
    fn a_click_on_a_visible_popout_always_closes_it() {
        // Even mid-debounce: a visible popout means the blur never happened
        // (macOS, or a Windows click that kept focus), so the stamp is moot.
        assert_eq!(tray_click_action(true, None), TrayClick::Hide);
        assert_eq!(
            tray_click_action(true, Some(Duration::from_millis(0))),
            TrayClick::Hide
        );
        assert_eq!(
            tray_click_action(true, Some(Duration::from_millis(10_000))),
            TrayClick::Hide
        );
    }

    #[test]
    fn a_click_with_no_blur_stamp_opens_the_popout() {
        assert_eq!(tray_click_action(false, None), TrayClick::Show);
    }

    #[test]
    fn a_click_inside_the_debounce_window_is_the_toggle_close_and_is_swallowed() {
        assert_eq!(
            tray_click_action(false, Some(Duration::from_millis(0))),
            TrayClick::Swallow
        );
        assert_eq!(
            tray_click_action(false, Some(Duration::from_millis(399))),
            TrayClick::Swallow
        );
    }

    #[test]
    fn a_click_past_the_debounce_window_is_a_fresh_open() {
        assert_eq!(
            tray_click_action(false, Some(Duration::from_millis(400))),
            TrayClick::Show
        );
        assert_eq!(
            tray_click_action(false, Some(Duration::from_millis(401))),
            TrayClick::Show
        );
    }
}
