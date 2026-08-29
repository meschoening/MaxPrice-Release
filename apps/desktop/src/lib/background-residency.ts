import { insideTauri } from "./tauri";

// Where "keep running in background" is a real choice (map #168; T6 + M7 ruled
// out of scope). Closing the window can only mean "hide to the tray" where a
// tray exists: `create_tray` skips Linux, and with the Linux leg out of scope
// the Rust close gate reads `!cfg!(target_os = "linux") && <settings>` — so on
// Linux the close ALWAYS quits, whatever the toggle says.
//
// This gate is what keeps the Settings page from claiming otherwise. Its
// subline promises the tray by name, so rendering the toggle where no tray can
// exist is not a dead control, it is a false one.
//
// KEEP IN LOCKSTEP with that Rust expression (`on_window_event`'s
// CloseRequested arm in apps/desktop/src-tauri/src/lib.rs). Two gates, one
// rule: if Linux ever gains the tray + Host gate T6 designed, both move.

/** Pure half, so the rule is pinnable without a Tauri host. */
export function backgroundResidencySupportedOn(inTauri: boolean, platform: string): boolean {
  // ALLOWLIST, not a Linux denylist — `updatesSupportedOn`'s posture, and for
  // the same reason: a denylist would have to name every future platform to
  // stay correct, and the failure of an out-of-date denylist is the dishonest
  // direction (a promised tray that isn't there).
  //
  // Deliberately NOT shared with `updatesSupportedOn` despite the identical
  // expression today: they answer different questions that only happen to
  // agree. Updates exclude Linux because ADR-0071 ships no channel for it;
  // residency excludes Linux because no tray is built. Either could move alone.
  return inTauri && /Mac|Win/i.test(platform);
}

export function backgroundResidencySupported(): boolean {
  if (typeof navigator === "undefined") return false;
  return backgroundResidencySupportedOn(insideTauri(), navigator.platform);
}
