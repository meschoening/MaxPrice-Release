//! The hub tray app's menu-bar icon on macOS (ADR-0148 §3), as chosen
//! in Map 9's prototype (#755): quiet when healthy. Online is the orb's rows
//! glyph as a template image, inked by the bar like every other item. Every
//! other tone is the same glyph in the bar's ink with a system-coloured dot at
//! its top right, cut out of the glyph by a clear ring.
//!
//! The dotted icons cannot go through tray-icon: it takes one fixed RGBA
//! bitmap, and the menu bar's ink follows the wallpaper behind it (light or
//! dark bar, in either appearance), so a bitmap glyph is wrong on one of the
//! two bars. An `NSImage` with a drawing handler resolves `labelColor` each
//! time the bar draws it. Windows keeps the full-colour orb tray-icon sets.
//!
//! The geometry is pure and tested anywhere; only `apply` touches AppKit.

use crate::TrayTone;

/// tray-icon draws every icon 18pt tall; the glyph sits in that height.
pub const ICON_HEIGHT: f64 = 18.0;

/// The rows glyph, from `icons/icon-source.svg`'s white path, in its 24-unit
/// box: two bars per row, the long one then the short one.
const ROW_TOPS: [f64; 3] = [5.3, 10.3, 15.3];
const BAR_SPANS: [(f64, f64); 2] = [(5.2, 14.6), (16.0, 18.8)];
const BAR_HEIGHT: f64 = 3.4;
const BAR_RADIUS: f64 = 1.1;
/// The glyph's box in those units, measured from its first bar's corner.
const GLYPH_UNITS: (f64, f64) = (18.8 - 5.2, 15.3 + 3.4 - 5.3);

/// Points per glyph unit: about 13 x 13pt in the 18pt icon.
const SCALE: f64 = 0.97;
const GLYPH_LEFT: f64 = 1.5;

/// The dot, in points from the icon's top-left corner, and the clear ring
/// around it that keeps it apart from the glyph's top-right bar.
pub const DOT_CENTER: (f64, f64) = (16.2, 3.6);
pub const DOT_RADIUS: f64 = 2.9;
pub const RING_RADIUS: f64 = 3.9;

/// A rounded bar, in points from the icon's top-left corner (flipped, as the
/// drawing handler is called).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bar {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub radius: f64,
}

/// The icon's width: the glyph alone while online, room for the dot
/// otherwise. The status item resizes with it.
pub fn width(tone: TrayTone) -> f64 {
    match tone {
        TrayTone::Good => 16.0,
        TrayTone::Warn | TrayTone::Bad | TrayTone::Soft => 20.0,
    }
}

/// The glyph's six bars, vertically centred in the icon.
pub fn glyph_bars() -> impl Iterator<Item = Bar> {
    let top = (ICON_HEIGHT - GLYPH_UNITS.1 * SCALE) / 2.0;
    ROW_TOPS.into_iter().flat_map(move |row| {
        BAR_SPANS.into_iter().map(move |(x0, x1)| Bar {
            x: GLYPH_LEFT + (x0 - BAR_SPANS[0].0) * SCALE,
            y: top + (row - ROW_TOPS[0]) * SCALE,
            w: (x1 - x0) * SCALE,
            h: BAR_HEIGHT * SCALE,
            radius: BAR_RADIUS * SCALE,
        })
    })
}

/// Set `tone`'s icon on the tray's status item. Main thread only: the caller
/// runs it through tauri's `with_inner_tray_icon`.
#[cfg(target_os = "macos")]
pub fn apply(item: &objc2_app_kit::NSStatusItem, tone: TrayTone) -> Result<(), String> {
    use objc2::MainThreadMarker;

    let mtm = MainThreadMarker::new().ok_or("the menu-bar icon requires the main thread")?;
    let button = item.button(mtm).ok_or("the status item has no button")?;
    button.setImage(Some(&image(tone)));
    // tray-icon takes clicks through a subview, `TaoTrayTarget`, that it sizes
    // to the button at each of its own `set_icon` calls (its
    // `update_dimensions`). The button resizes with this image at once, so
    // resize that subview the same way, or the part of a wider icon outside it
    // ignores clicks. Only that view: any other belongs to AppKit.
    let frame = button.frame();
    for view in button.subviews().iter() {
        if view.class().name() == c"TaoTrayTarget" {
            view.setFrame(frame);
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn image(tone: TrayTone) -> objc2::rc::Retained<objc2_app_kit::NSImage> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_app_kit::NSImage;
    use objc2_foundation::{NSRect, NSSize};

    let handler = RcBlock::new(move |_: NSRect| -> Bool {
        draw(tone);
        Bool::YES
    });
    let image = NSImage::imageWithSize_flipped_drawingHandler(
        NSSize::new(width(tone), ICON_HEIGHT),
        true,
        &handler,
    );
    // Online alone is a template: the bar inks it. The dotted tones carry a
    // colour, so they ink their own glyph with `labelColor` in `draw`.
    image.setTemplate(tone == TrayTone::Good);
    image
}

/// Draw `tone`'s icon into the current context: AppKit calls this with the
/// bar's appearance current, so `labelColor` is the bar's ink.
#[cfg(target_os = "macos")]
fn draw(tone: TrayTone) {
    use objc2_app_kit::{NSBezierPath, NSColor, NSCompositingOperation, NSGraphicsContext};
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let glyph = NSBezierPath::bezierPath();
    for bar in glyph_bars() {
        let rect = NSRect::new(NSPoint::new(bar.x, bar.y), NSSize::new(bar.w, bar.h));
        glyph.appendBezierPath(&NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(
            rect, bar.radius, bar.radius,
        ));
    }
    let dot = match tone {
        TrayTone::Good => {
            NSColor::blackColor().setFill();
            glyph.fill();
            return;
        }
        TrayTone::Warn => NSColor::systemOrangeColor(),
        TrayTone::Bad => NSColor::systemRedColor(),
        TrayTone::Soft => NSColor::systemGrayColor(),
    };
    let circle = |radius: f64| {
        NSBezierPath::bezierPathWithOvalInRect(NSRect::new(
            NSPoint::new(DOT_CENTER.0 - radius, DOT_CENTER.1 - radius),
            NSSize::new(radius * 2.0, radius * 2.0),
        ))
    };
    NSColor::labelColor().setFill();
    glyph.fill();
    if let Some(context) = NSGraphicsContext::currentContext() {
        context.setCompositingOperation(NSCompositingOperation::Clear);
        circle(RING_RADIUS).fill();
        context.setCompositingOperation(NSCompositingOperation::SourceOver);
    }
    dot.setFill();
    circle(DOT_RADIUS).fill();
}

#[cfg(test)]
mod tests {
    use super::*;

    const TONES: [TrayTone; 4] = [
        TrayTone::Good,
        TrayTone::Warn,
        TrayTone::Bad,
        TrayTone::Soft,
    ];

    #[test]
    fn the_glyph_fits_every_icon_and_is_centred_in_its_height() {
        let bars: Vec<Bar> = glyph_bars().collect();
        assert_eq!(bars.len(), 6);
        let top = bars.iter().map(|b| b.y).fold(f64::INFINITY, f64::min);
        let bottom = bars.iter().map(|b| b.y + b.h).fold(0.0, f64::max);
        let right = bars.iter().map(|b| b.x + b.w).fold(0.0, f64::max);
        assert!((top - (ICON_HEIGHT - bottom)).abs() < 1e-9);
        for tone in TONES {
            assert!(right < width(tone), "{tone:?}: glyph ends at {right}");
        }
    }

    #[test]
    fn the_dot_sits_inside_its_icon_over_the_glyphs_top_right_bar() {
        for tone in [TrayTone::Warn, TrayTone::Bad, TrayTone::Soft] {
            assert!(DOT_CENTER.0 + DOT_RADIUS <= width(tone));
            assert!(DOT_CENTER.1 - DOT_RADIUS >= 0.0);
        }
        // The ring cuts into the top short bar, which is what keeps the dot
        // legible against the glyph's ink.
        let short = glyph_bars().nth(1).unwrap();
        assert!(DOT_CENTER.0 - RING_RADIUS < short.x + short.w);
        assert!(DOT_CENTER.1 + RING_RADIUS > short.y);
    }

    #[test]
    fn online_is_narrower_than_every_dotted_tone() {
        for tone in [TrayTone::Warn, TrayTone::Bad, TrayTone::Soft] {
            assert!(width(TrayTone::Good) < width(tone));
        }
    }
}
