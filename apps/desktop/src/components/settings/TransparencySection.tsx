import { useReduceTransparency } from "@/lib/transparency";

// The macOS stand-in for the OS Reduce-transparency setting (T4's a11y
// obligation, landed in M8): WebKit never matches
// prefers-reduced-transparency, so this switch is the opaque-material
// fallback's only driver there. Windows and Linux never render this section —
// Chromium/WebView2 map the OS accessibility setting through the media query
// and theme-boot.js stamps it automatically. Same switch recipe as the hub
// section's SwitchRow (role="switch", the visible label is the accessible
// name).
export function TransparencySection(): React.ReactElement {
  const { on, toggle } = useReduceTransparency();
  return (
    <button type="button" role="switch" aria-checked={on} onClick={toggle} className="toggle">
      <span className="track" aria-hidden />
      Opaque surfaces
    </button>
  );
}
