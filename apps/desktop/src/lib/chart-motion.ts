// The glass chart's motion constants (M3, #61). CSS transitions animate rect
// geometry natively, but the ghost bar is a <path> whose `d` must be tweened
// by hand (T9: never `transition: d` — Gecko doesn't interpolate it, so the
// CSS route would snap on Firefox while morphing on Chromium). The rAF tween
// in glass-chart.tsx drives yTop through this easing so the hand-run morph
// and the CSS-run morphs draw the identical curve.

// A CSS `cubic-bezier(p1x, p1y, p2x, p2y)` timing function: progress u ∈ [0,1]
// → eased value. The curve is parametric — x(t) is solved for t at the given
// u (Newton–Raphson, bisection fallback: the standard solver), then y(t)
// evaluated there. Control xs live in [0,1] per the CSS grammar, which makes
// x(t) monotonic and the solve well-defined.
export function cubicBezierEase(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
): (u: number) => number {
  // Horner-form polynomial coefficients: b(t) = ((a·t + b)·t + c)·t.
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  const solveT = (u: number): number => {
    // Newton–Raphson converges in a handful of steps almost everywhere…
    let t = u;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - u;
      if (Math.abs(err) < 1e-7) return t;
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    // …and bisection catches the flat-derivative corners it can't handle.
    let lo = 0;
    let hi = 1;
    t = u;
    for (let i = 0; i < 32; i++) {
      const x = sampleX(t);
      if (Math.abs(x - u) < 1e-7) return t;
      if (u > x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };

  // Clamped at both ends: a rAF tick can land past the duration. (CSS itself
  // extends the curve via endpoint tangents outside [0,1] — css-easing-1 —
  // but our only caller wants progress pinned to the endpoints.)
  return (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : sampleY(solveT(u)));
}

// The one easing every glass morph uses — identical to the CSS
// `cubic-bezier(0.22, 0.8, 0.36, 1)` on the rect transitions in globals.css.
export const GLASS_EASE: (u: number) => number = cubicBezierEase(0.22, 0.8, 0.36, 1);

// The morph duration, ms — matches the 0.45s CSS rect transitions so the
// hand-tweened ghost lands in the same frame as the CSS-tweened segments.
export const MORPH_MS = 450;
