//! macOS placement uses one global POINT coordinate system. The Windows
//! physical-pixel path cannot be shared: macOS multiplies each display's
//! origin by its own scale, and divides a window move by its OLD scale.
//! Deliberately copied into hub-desktop, like popout.rs (ADR-0084).

#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Screen {
    /// AppKit global points, bottom-left origin, y increasing upwards.
    pub frame: Rect,
    pub visible: Rect,
    pub scale: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    /// Global points with the primary display's TOP-left as origin (Tauri).
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// AppKit top edge, retained from the same display snapshot as placement.
    appkit_top: f64,
}

/// Preserve the old 8-physical-pixel gap on Retina, now consistently in points.
const GAP: f64 = 4.0;

/// `pointer` is a native, unscaled AppKit point, sampled in the tray callback.
/// `tray` is tray-icon's click rectangle: top-down global points multiplied by
/// the CLICKED status window's scale. Never use the popout's previous scale.
pub fn placement(
    screens: &[Screen],
    pointer: (f64, f64),
    tray: Rect,
    size: (f64, f64),
) -> Option<Placement> {
    // NSMouseInRect's edge rule for unflipped rects: the top and left edges
    // are inside, the bottom and right are not. The cursor on a display's
    // topmost row reads y == NSMaxY(frame), so `y < maxY` would reject a
    // slam-to-top click on the status item and mis-seam stacked displays.
    let screen = screens.iter().find(|s| {
        pointer.0 >= s.frame.x
            && pointer.0 < s.frame.x + s.frame.w
            && pointer.1 > s.frame.y
            && pointer.1 <= s.frame.y + s.frame.h
    })?;
    let primary_top = screens.first()?.frame.y + screens.first()?.frame.h;
    let scale = screen.scale;
    if !scale.is_finite()
        || scale <= 0.0
        || !size.0.is_finite()
        || !size.1.is_finite()
        || size.0 <= 0.0
        || size.1 <= 0.0
    {
        return None;
    }
    let tray = Rect {
        x: tray.x / scale,
        y: tray.y / scale,
        w: tray.w / scale,
        h: tray.h / scale,
    };
    let work = screen.visible;
    let top = primary_top - work.y - work.h;
    let x = (tray.x + tray.w / 2.0 - size.0 / 2.0)
        .min(work.x + work.w - size.0)
        .max(work.x);
    let y = (tray.y + tray.h + GAP).min(top + work.h - size.1).max(top);
    Some(Placement {
        x,
        y,
        width: size.0,
        height: size.1,
        appkit_top: primary_top - y,
    })
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
pub struct Anchor {
    screens: Vec<Screen>,
    pointer: (f64, f64),
    tray: Rect,
}

#[cfg(target_os = "macos")]
impl Anchor {
    pub fn placement(&self, size: (f64, f64)) -> Option<Placement> {
        placement(&self.screens, self.pointer, self.tray, size)
    }
}

#[cfg(target_os = "macos")]
pub fn capture(tray: &tauri::Rect) -> Option<Anchor> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSScreen};

    let mtm = MainThreadMarker::new()?;
    // Resolve in native points BEFORE decoding tray-icon's scaled rectangle.
    // No primary-monitor fallback: that would turn missing data into a known
    // wrong-screen move. The caller still shows at its last position on failure.
    let pointer = NSEvent::mouseLocation();
    let screens: Vec<_> = NSScreen::screens(mtm)
        .iter()
        .map(|s| {
            let f = s.frame();
            let v = s.visibleFrame();
            Screen {
                frame: Rect {
                    x: f.origin.x,
                    y: f.origin.y,
                    w: f.size.width,
                    h: f.size.height,
                },
                visible: Rect {
                    x: v.origin.x,
                    y: v.origin.y,
                    w: v.size.width,
                    h: v.size.height,
                },
                scale: s.backingScaleFactor(),
            }
        })
        .collect();
    let pos = tray.position.to_physical::<f64>(1.0);
    let size_px = tray.size.to_physical::<f64>(1.0);
    Some(Anchor {
        screens,
        pointer: (pointer.x, pointer.y),
        tray: Rect {
            x: pos.x,
            y: pos.y,
            w: size_px.width,
            h: size_px.height,
        },
    })
}

#[cfg(target_os = "macos")]
pub fn apply(window: &tauri::WebviewWindow, p: Placement) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSWindow;

    let _mtm = MainThreadMarker::new().ok_or("popout placement requires the main thread")?;
    let ptr = window.ns_window().map_err(|e| e.to_string())?;
    // SAFETY: Tauri owns this live NSWindow. Borrow only for this call, after
    // checking the main thread; never retain the pointer across window teardown.
    let native = unsafe { &*(ptr as *const NSWindow) };
    let mut frame = native.frame();
    frame.size.width = p.width;
    frame.size.height = p.height;
    frame.origin.x = p.x;
    frame.origin.y = p.appkit_top;
    // tao queues its logical setters onto GCD even on the main thread, whereas
    // show/focus execute synchronously. Finish BOTH changes before the caller
    // activates the popout, so activation happens on the destination display.
    native.setContentSize(frame.size);
    native.setFrameTopLeftPoint(frame.origin);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }
    fn screen(frame: Rect, scale: f64) -> Screen {
        Screen {
            frame,
            visible: rect(frame.x, frame.y + 48.0, frame.w, frame.h - 76.0),
            scale,
        }
    }
    fn event(s: Screen, primary_top: f64) -> ((f64, f64), Rect) {
        let tray = rect(
            s.frame.x + s.frame.w - 220.0,
            primary_top - s.frame.y - s.frame.h + 4.0,
            60.0,
            24.0,
        );
        let mouse = (tray.x + 30.0, primary_top - tray.y - 12.0);
        (
            mouse,
            rect(
                tray.x * s.scale,
                tray.y * s.scale,
                tray.w * s.scale,
                tray.h * s.scale,
            ),
        )
    }

    #[test]
    fn mixed_scales_and_every_display_arrangement_use_the_clicked_screen() {
        for frame in [
            rect(1512.0, -98.0, 1920.0, 1080.0), // right, top aligned (live repro)
            rect(-1920.0, -98.0, 1920.0, 1080.0), // left
            rect(0.0, 982.0, 1920.0, 1080.0),    // above
            rect(0.0, -1080.0, 1920.0, 1080.0),  // below
            rect(1512.0, 250.0, 1920.0, 1080.0), // offset, not top aligned
        ] {
            for scales in [(2.0, 1.0), (1.0, 2.0), (2.0, 2.0), (1.0, 1.0)] {
                let screens = [
                    screen(rect(0.0, 0.0, 1512.0, 982.0), scales.0),
                    screen(frame, scales.1),
                ];
                // Alternate twice: geometry takes NO previous-window scale or
                // position, so a hidden window cannot carry a monitor forward.
                for clicked in [0, 1, 0, 1] {
                    let s = screens[clicked];
                    let (mouse, tray) = event(s, 982.0);
                    let p = placement(&screens, mouse, tray, (236.0, 329.0)).unwrap();
                    assert_eq!(p.x + 118.0, tray.x / s.scale + tray.w / s.scale / 2.0);
                    assert_eq!(p.y, 982.0 - s.frame.y - s.frame.h + 32.0);
                    assert_eq!(p.appkit_top, 982.0 - p.y);
                    assert!(p.x >= s.visible.x && p.x + p.width <= s.visible.x + s.visible.w);
                    let top = 982.0 - s.visible.y - s.visible.h;
                    assert!(p.y >= top && p.y + p.height <= top + s.visible.h);
                }
            }
        }
    }

    #[test]
    fn live_retina_laptop_and_airplay_use_their_own_menu_bar_clearance() {
        let screens = [
            Screen {
                frame: rect(0.0, 0.0, 1512.0, 982.0),
                visible: rect(0.0, 58.0, 1512.0, 891.0),
                scale: 2.0,
            },
            Screen {
                frame: rect(1512.0, -98.0, 1920.0, 1080.0),
                visible: rect(1512.0, -98.0, 1920.0, 1080.0),
                scale: 1.0,
            },
        ];
        let laptop = placement(
            &screens,
            (930.0, 966.0),
            rect(1800.0, 0.0, 120.0, 66.0),
            (236.0, 260.0),
        )
        .unwrap();
        assert_eq!((laptop.x, laptop.y), (812.0, 37.0));
        let external = placement(
            &screens,
            (2793.0, 967.0),
            rect(2763.0, 0.0, 60.0, 30.0),
            (236.0, 260.0),
        )
        .unwrap();
        assert_eq!((external.x, external.y), (2675.0, 34.0)); // observed broken y was 66
    }

    #[test]
    fn top_row_belongs_to_the_display_below_it() {
        let lower = screen(rect(0.0, 0.0, 1512.0, 982.0), 2.0);
        let above = screen(rect(0.0, 982.0, 1920.0, 1080.0), 1.0);
        let (_, tray) = event(lower, 982.0);
        // A slam-to-top click on the status item reads y == NSMaxY(frame).
        let p = placement(&[lower], (700.0, 982.0), tray, (236.0, 260.0)).unwrap();
        assert_eq!(p.x + 118.0, tray.x / 2.0 + tray.w / 2.0 / 2.0);
        // The seam row is the LOWER display's menu bar, not the upper's bottom.
        let seam = placement(&[lower, above], (700.0, 982.0), tray, (236.0, 260.0)).unwrap();
        assert_eq!(seam, p);
        let (_, tray_above) = event(above, 982.0);
        let top = placement(&[lower, above], (700.0, 2062.0), tray_above, (236.0, 260.0)).unwrap();
        assert_eq!(top.y, 982.0 - above.frame.y - above.frame.h + 32.0);
        // The bottom edge is outside: y == 0 is on no display.
        assert!(placement(&[lower], (700.0, 0.0), tray, (236.0, 260.0)).is_none());
    }

    #[test]
    fn primary_order_is_not_a_monitor_selection_fallback() {
        let a = screen(rect(0.0, 0.0, 1512.0, 982.0), 2.0);
        let b = screen(rect(1512.0, -98.0, 1920.0, 1080.0), 1.0);
        // Same top for both means reversing the primary-order array preserves
        // the global frame origin too; overlap of scaled bounds is irrelevant.
        let (mouse, tray) = event(b, 982.0);
        assert_eq!(
            placement(&[a, b], mouse, tray, (236.0, 260.0)),
            placement(&[b, a], mouse, tray, (236.0, 260.0))
        );
        assert!(placement(&[a, b], (8000.0, 0.0), tray, (236.0, 260.0)).is_none());
        assert!(placement(&[], mouse, tray, (236.0, 260.0)).is_none());
    }

    #[test]
    fn work_area_clamps_edges_and_keeps_an_oversized_popout_reachable() {
        let s = screen(rect(-1920.0, 0.0, 1920.0, 1080.0), 1.0);
        let p = placement(
            &[s],
            (-1.0, 1064.0),
            rect(-20.0, 0.0, 20.0, 24.0),
            (236.0, 260.0),
        )
        .unwrap();
        assert_eq!(p.x, -236.0);
        let p = placement(
            &[s],
            (-1910.0, 1064.0),
            rect(-1920.0, 0.0, 20.0, 24.0),
            (3000.0, 2000.0),
        )
        .unwrap();
        assert_eq!((p.x, p.y), (-1920.0, 28.0));
    }

    #[test]
    fn invalid_sizes_and_scales_do_not_move_the_window() {
        let mut s = screen(rect(0.0, 0.0, 1512.0, 982.0), 2.0);
        let (mouse, tray) = event(s, 982.0);
        for size in [(0.0, 260.0), (236.0, f64::NAN), (f64::INFINITY, 260.0)] {
            assert!(placement(&[s], mouse, tray, size).is_none());
        }
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            s.scale = scale;
            assert!(placement(&[s], mouse, tray, (236.0, 260.0)).is_none());
        }
    }
}
