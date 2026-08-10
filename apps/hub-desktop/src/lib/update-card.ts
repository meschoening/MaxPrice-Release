import { formatRelativeTime } from "@maxprice/shared";

// THE COPY CONTRACT for the App info card's Updates row (map #143, T2 #145).
//
// Every user-visible string the card can show lives in this one module, and the
// mapping from state to strings is a pure function — so the seven states are
// pinnable by a test in a repo with no component-test rig, and a review argues
// about words in one place. Transcribed from `UPDATE_STATES` in
// `plans/mocks/redesign/hub-glass.html`, which is the reviewed original.
//
// Two rules from T2 are load-bearing here and are why this is two fields rather
// than one:
//
//   - The BUTTON always says the ACTION; the ROW always says the STATE. No label
//     is ever asked to carry a state — "Checking…" is a state, so it lives in
//     the row while the button merely disables.
//   - The control RELOCATES rather than mutating. Step 1 ("Check for updates")
//     is a cheap, consequence-free probe and lives in the row's value cell; step
//     2 ("Install and restart") is consequential and lives INSIDE the disclosure
//     inset. You cannot reach the install button without the sentence explaining
//     the restart having appeared around it — stronger than a label swap, and
//     the console's own grammar (Compact now, Allow through firewall…, Purge all
//     already sit in insets with their warning).

/**
 * What the card knows right now.
 *
 * `idle` is reached BEFORE the launch probe answers and ALSO wherever a probe
 * that failed silently leaves the card — the hub autostarts at login, so a probe
 * routinely races the network coming up, and that failure is logged to hub.log
 * rather than shown (map #143 Q11). Which is why its copy has to read "we don't
 * know" and not "nothing happened".
 */
export type UpdateCardState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; checkedAt: string }
  | { kind: "available"; version: string; installError?: string }
  | { kind: "installing"; version: string }
  | { kind: "error"; detail: string }
  | { kind: "unsupported" };

/** The disclosure inset: a consequence, its explanation, and the step-2 button. */
export type UpdateBelowInset = {
  kind: "inset";
  lead: string;
  body: string;
  action: { label: string; accent: true; disabled: boolean };
  /** A failed install, rendered as an `.err` line inside the same inset. */
  error?: { message: string; title: string };
};

/** Split around its one `<code>` span so no copy escapes this module. */
export type UpdateBelowHint = { kind: "hint"; before: string; code: string; after: string };

export type UpdateBelow = UpdateBelowInset | { kind: "err"; body: string } | UpdateBelowHint;

export type UpdateCardView = {
  /** The row's state. */
  value: string;
  /** Detail that must not be printed, riding along as the row's `title`. */
  valueTitle?: string;
  /** The dim age line beside the state. */
  sub?: string;
  /** Step 1, in the row's value cell. */
  action?: { label: string; disabled: boolean };
  /** Everything beneath the two rows. */
  below?: UpdateBelow;
};

/**
 * The restart disclosure. Three facts and no false precision: it restarts, the
 * clients self-heal, the archive is untouched — then "pauses until it's back"
 * rather than a duration nobody can promise under an NSIS installer.
 */
const RESTART_LEAD = "Installing restarts the hub.";
const RESTART_BODY =
  "Connected clients reconnect on their own and the event archive is untouched; usage polling pauses until it’s back.";

/**
 * State 5's second sentence is the one string that was conditional on #144, and
 * #144 settled it: Tauri's NSIS updater passes `/P /R`, and `.onInstSuccess`
 * relaunches on `/R`. So the hub does come back on its own.
 */
const INSTALLING_LEAD = "Downloading and installing.";
const INSTALLING_BODY =
  "The hub shuts down to finish and restarts on its own — this window will close.";

/**
 * Written to survive being the COMMON case: `MP-Updates` holds zero releases
 * today, so a real check 404s. "Couldn't get an answer" covers a 404, a dead
 * network and an unparseable manifest alike without claiming which, and it never
 * rounds down to "up to date". The raw message is NOT printed — it rides as the
 * row's `title` tooltip, and hub.log is where the reason is actually read.
 */
const CHECK_FAILED_BODY =
  "Couldn’t get an answer from the update channel. Try again — if it keeps failing, the reason is in hub.log.";

/**
 * The one string T2's table does not cover: `downloadAndInstall()` rejecting.
 * Written in state 6's grammar (short sentence, raw detail as a `title`) and
 * rendered inside the existing inset rather than as an eighth state, which is
 * the console's established shape for a failed action — HubStatusCard's firewall
 * and compact insets keep their button and add an `.err` line beneath it.
 */
const INSTALL_FAILED_BODY =
  "Couldn’t install the update. Try again — if it keeps failing, the reason is in hub.log.";

/**
 * Off Windows. The version row still renders — it is the half of the card that
 * has nothing to do with the platform — and the copy names the ONLY real route,
 * because no macOS hub download exists to point at. Only macOS ever sees this:
 * Linux hub hosts run headless `maxprice-hub serve` and have no console.
 */
const UNSUPPORTED_HINT: UpdateBelowHint = {
  kind: "hint",
  before: "Automatic updates are built for Windows. On macOS, update by rebuilding from source: ",
  code: "bun run build:hub",
  after: ".",
};

/** Map the card's knowledge onto its strings. Pure; `now` is epoch-ms. */
export function updateCardView(state: UpdateCardState, now: number): UpdateCardView {
  switch (state.kind) {
    case "idle":
      return { value: "Not checked", action: { label: "Check for updates", disabled: false } };

    case "checking":
      // The button keeps its own label and merely disables; the row carries the
      // state.
      return { value: "Checking…", action: { label: "Check for updates", disabled: true } };

    case "up-to-date":
      // The age is load-bearing, not decorative: this webview mounts at login
      // and lives for weeks on an always-on host, so a bare "Up to date" left
      // over from a probe nine days ago is a lie by omission. It also makes the
      // state read as a standing fact rather than as the answer to a click
      // nobody made — which is exactly how the launch probe puts it there. The
      // button shortens to "Check again", buying back the width the age costs.
      return {
        value: "Up to date",
        sub: `checked ${formatRelativeTime(state.checkedAt, now)}`,
        action: { label: "Check again", disabled: false },
      };

    case "available":
      // The two-step's landing: the row states the fact and carries NO control.
      return {
        value: `${state.version} available`,
        below: {
          kind: "inset",
          lead: RESTART_LEAD,
          body: RESTART_BODY,
          action: { label: "Install and restart", accent: true, disabled: false },
          ...(state.installError !== undefined
            ? { error: { message: INSTALL_FAILED_BODY, title: state.installError } }
            : {}),
        },
      };

    case "installing":
      // The process is about to die under the operator, so say so — the window
      // vanishing unannounced is the failure mode this sentence prevents.
      return {
        value: `Installing ${state.version}…`,
        below: {
          kind: "inset",
          lead: INSTALLING_LEAD,
          body: INSTALLING_BODY,
          action: { label: "Installing…", accent: true, disabled: true },
        },
      };

    case "error":
      return {
        value: "Check failed",
        valueTitle: state.detail,
        action: { label: "Try again", disabled: false },
        below: { kind: "err", body: CHECK_FAILED_BODY },
      };

    case "unsupported":
      return { value: "Windows only", below: UNSUPPORTED_HINT };
  }
}
