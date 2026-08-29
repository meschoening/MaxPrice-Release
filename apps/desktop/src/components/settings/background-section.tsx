import { useSettings, useUpdateSettings } from "@/state/use-settings";

// Background residency toggle (map #168 / M1): whether closing the main window
// hides it to the tray (default) or quits. Governs the CLOSE BUTTON only —
// Quit (tray menu, macOS Cmd+Q) always exits. The Rust shell reads the field
// straight from settings.json at close time, so the write below is the whole
// wiring: no push, no relaunch. Same switch recipe as the hub section's
// SwitchRow (role="switch", the visible label is the accessible name).
//
// NOT rendered on Linux: the parent gates the whole Section on
// `backgroundResidencySupported()`. T6 planned to render it there with a
// Rust-side Host gate as a silent AND, but the Linux leg was ruled out of
// scope — no tray is built, so the close always quits and the subline below
// would promise a tray that cannot exist.
export function BackgroundSection(): React.ReactElement {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const on = settings?.keepRunningInBackground ?? true;
  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => void update({ keepRunningInBackground: !on })}
        className="toggle"
      >
        <span className="track" aria-hidden />
        Keep running in background
      </button>
      <p className="subline">
        Closing the window keeps MaxPrice in the system tray — usage tracking, limit polling, and
        hub sync continue. Quit from the tray to exit. Off: closing the window quits the app.
      </p>
    </>
  );
}
