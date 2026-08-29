import { useAutostart, useSetAutostart } from "@/state/use-autostart";

// The "Start at login" toggle (map #168 / M4; ADR-0077). No settings.json
// field backs this: the OS login entry is the record, `useAutostart` reads it
// fresh (60s poll), and `set_autostart` is the writer — registering with the
// `--hidden` launch arg so a sign-in launch is tray-only (charter decision 8).
// Same switch recipe as BackgroundSection (role="switch", the visible label is
// the accessible name). The parent gates the whole Section on the state being
// known and supported, so this renders only where a login entry can exist.
export function AutostartSection(): React.ReactElement {
  const { data: state } = useAutostart();
  const set = useSetAutostart();
  const on = state === "on";
  // A dev build never owns the login entry (ADR-0051's denylist); the Rust
  // side refuses the write, and disabling here is what keeps the refusal from
  // ever being seen.
  const devBuild = state === "dev-build";
  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={devBuild || set.isPending}
        onClick={() => set.mutate(!on)}
        className="toggle"
      >
        <span className="track" aria-hidden />
        Start at login
      </button>
      <p className="subline">
        {devBuild
          ? "Not available in dev builds — only an installed MaxPrice may own the login entry."
          : state === "disabled-by-user"
            ? "Switched off in Task Manager's Startup tab. Turning this on re-enables it there too."
            : "MaxPrice launches hidden at sign-in — the tray icon is its only presence until you open it."}
      </p>
    </>
  );
}
