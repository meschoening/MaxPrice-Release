// THE COPY CONTRACT for Settings › Updates (#150).
//
// Every user-visible string the section can show lives here, and the mapping
// from state to strings is a pure function — the `lib/app-info.ts` /
// `lib/foot-status.ts` shape, so the six states are pinnable in a repo with no
// component-test rig and a review argues about words in one place.
//
// The shape was chosen from a four-variant prototype (2026-08-10): an in-row
// SWAP, where the single chip is replaced in place by an accented
// `Update to <version>` beside a quiet `Cancel`, and the consequence rides the
// status line that already said "You're up to date". Nothing discloses, nothing
// opens, and the section never grows past one line plus a hairline. The three
// rejected alternatives were the hub's two-step inset (map #143), folding the
// whole feature into the App info pairs, and escalating into the UpdateGate
// dialog.
//
// One rule from the hub's card (`update-card.ts`) is deliberately NOT carried
// over: there, the button always says the action and the row always says the
// state, because the row is a permanent status line the launch probe writes
// into. Here the line is empty until you press something, so a transient
// "Checking…" on the button is the shortest true thing the section can say —
// and it is what today's section already does.

/**
 * What the section knows right now.
 *
 * `offering` is the two-chip pair being shown. Cancelling clears it WITHOUT
 * discarding the finding: the state stays `available`, so the chip keeps
 * offering the update rather than reverting to a check whose answer you have
 * already been told.
 *
 * There is no terminal "installed" state, and there cannot be: `applyUpdate`
 * relaunches, so the process is gone before any such state could render. Only
 * the rejection path is reachable, and it lands back on `available`.
 */
export type UpdateSectionState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "available"; version: string; offering: boolean; installError?: string }
  | { kind: "installing"; version: string }
  | { kind: "error"; detail: string };

export type UpdateSectionView = {
  /** The one chip that is always present. `accent` marks an install offer. */
  primary: { label: string; accent: boolean; disabled: boolean };
  /** The quiet second chip, present only while the pair is offered. */
  showCancel: boolean;
  /** The line beside the chips. */
  status: string | null;
  statusTone: "" | "err";
  /** Detail that must not be printed, riding along as the line's `title`. */
  statusTitle?: string;
  /** The indeterminate track under the row — work is in flight. */
  track: boolean;
  /** A failed install, beneath the row, keeping the offer alive above it. */
  error?: { message: string; title: string };
};

/**
 * Written for the case that actually happens on a channel that can 404: it
 * never rounds down to "up to date", and it does not print the raw message —
 * that rides as the line's `title`, and the durable log (ADR-0059) is where the
 * reason is really read.
 */
const CHECK_FAILED = "Check failed — couldn’t reach the update channel.";
const INSTALL_FAILED = "Couldn’t install the update. Try again.";

/**
 * The consequence, on the status line rather than in a disclosure. It is one
 * clause because it has to survive sharing a row with two chips — "restarts the
 * app" is the whole of what a user needs to weigh, and the settings/history
 * reassurance the inset variant spelled out is noise for an app that has never
 * lost either across an update.
 */
function availableLine(version: string): string {
  return `MaxPrice ${version} is available — installing restarts the app.`;
}

/** The trailing line where updates cannot be delivered at all. */
export function unsupportedLine(inTauri: boolean): string {
  return inTauri
    ? "Updates aren’t delivered on Linux — install the latest .deb from the Releases page."
    : "Updates are only available in the desktop app.";
}

/**
 * How long an install offer stays inert after it appears (#150 review F1).
 *
 * The primary chip is reconciled IN PLACE — the node clicked as "Check for
 * updates" becomes "Update to <version>" under a stationary cursor — so the
 * second click of a double-click, landing after the probe resolves, would
 * install and relaunch without the version ever having been read. 500 ms is
 * Windows' default double-click threshold, and it is also the floor for
 * reading a version string: the same reasoning that says the click was not
 * consent says a click this fast was not a decision.
 *
 * The window is invisible — no `.chip:disabled` styling exists — and it always
 * extends a disabled span that was already open (`checking` / `installing`),
 * so nothing flickers and no focus moves.
 */
export const INSTALL_ARM_MS = 500;

/** Whether an install offer stamped at `offeredAt` may be acted on at `now`. */
export function installArmed(offeredAt: number | null, now: number): boolean {
  return offeredAt !== null && now - offeredAt >= INSTALL_ARM_MS;
}

/** Map the section's knowledge onto its strings. Pure. */
export function updateSectionView(state: UpdateSectionState): UpdateSectionView {
  switch (state.kind) {
    case "idle":
      return {
        primary: { label: "Check for updates", accent: false, disabled: false },
        showCancel: false,
        status: null,
        statusTone: "",
        track: false,
      };

    case "checking":
      return {
        primary: { label: "Checking…", accent: false, disabled: true },
        showCancel: false,
        status: null,
        statusTone: "",
        track: true,
      };

    case "up-to-date":
      // "Check again" rather than the idle label: you just asked, and the
      // answer is on the line beside it.
      return {
        primary: { label: "Check again", accent: false, disabled: false },
        showCancel: false,
        status: "You’re up to date.",
        statusTone: "",
        track: false,
      };

    case "available":
      return {
        primary: { label: `Update to ${state.version}`, accent: true, disabled: false },
        showCancel: state.offering,
        status: availableLine(state.version),
        statusTone: "",
        track: false,
        // The failure belongs to the offered pair: Cancel is the gesture that
        // dismisses the attempt, so it must be able to dismiss its error line
        // too. The finding stays alive on the chip either way.
        ...(state.offering && state.installError !== undefined
          ? { error: { message: INSTALL_FAILED, title: state.installError } }
          : {}),
      };

    case "installing":
      // The app is about to vanish under the user, so the line says so — a
      // window disappearing unannounced is the failure this sentence prevents.
      return {
        primary: { label: "Installing…", accent: true, disabled: true },
        showCancel: false,
        status: "Downloading — MaxPrice will reopen on its own.",
        statusTone: "",
        track: true,
      };

    case "error":
      return {
        primary: { label: "Try again", accent: false, disabled: false },
        showCancel: false,
        status: CHECK_FAILED,
        statusTone: "err",
        statusTitle: state.detail,
        track: false,
      };
  }
}
