import { useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { applyUpdate, detectUpdate, updatesSupported } from "@/lib/updater";
import { logClientEvent } from "@/lib/client-log";
import { insideTauri } from "@/lib/tauri";
import {
  installArmed,
  unsupportedLine,
  updateSectionView,
  type UpdateSectionState,
} from "@/lib/update-section";

// UpdatesSection — the manual "Check for updates" control in Settings (Task
// 6.8), worn as a glass chip with the outcome on a dim status line.
//
// It used to call a fused `checkForUpdate()` that probed and, finding anything,
// installed it on the spot — the click was read as consent. So the one moment
// worth showing a user (a newer version exists, named) never rendered, and
// there was no way out of a decision they had not knowingly made. The two steps
// are now separate (#150): `detectUpdate` reports, and `applyUpdate` runs only
// after a second, explicit click.
//
// The chosen shape is an in-row SWAP (prototype 2026-08-10, variant D): the one
// chip is replaced in place by `Update to <version>` + `Cancel`, with the
// version and the restart consequence on the line that already said "You're up
// to date". Every string, and the state → strings mapping, lives in
// `lib/update-section.ts`; this file is structure and wiring only.

export function UpdatesSection(): React.ReactElement {
  const [state, setState] = useState<UpdateSectionState>({ kind: "idle" });
  const supported = updatesSupported();

  // The probed handle, held across the two steps. Re-probing to install would
  // double the round-trips and could answer differently in between, so step 2
  // installs exactly the update step 1 named. A ref, not state: it is never
  // rendered, and the plugin handle is not a value to diff on.
  const held = useRef<Update | null>(null);

  // When the current offer appeared. The install is inert for INSTALL_ARM_MS
  // after that, because the chip it lives on is the same DOM node the check
  // click landed on.
  const offeredAt = useRef<number | null>(null);

  const runCheck = (): void => {
    setState({ kind: "checking" });
    detectUpdate()
      .then((probe) => {
        if (probe.status === "available") {
          held.current = probe.update;
          offeredAt.current = Date.now();
          setState({ kind: "available", version: probe.version, offering: true });
          return;
        }
        // `unsupported` reaches here only where `updatesSupported()` is false
        // (outside Tauri, or on Linux), and the button is already disabled in
        // both. Folding it into "up to date" would be a lie in the one
        // direction that matters, so it stays idle — we don't know.
        held.current = null;
        offeredAt.current = null;
        setState(probe.status === "up-to-date" ? { kind: "up-to-date" } : { kind: "idle" });
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        // The durable trace (ADR-0059): a packaged GUI build has no console, and
        // "it just said check failed" is not a report anyone can act on.
        logClientEvent(`updates: check failed — ${detail}`);
        setState({ kind: "error", detail });
      });
  };

  const runInstall = (version: string): void => {
    const update = held.current;
    if (update === null) return;
    setState({ kind: "installing", version });
    // This promise does not resolve on success: `applyUpdate` relaunches, so
    // the process is gone. Only the rejection path is reachable — it returns to
    // `available` with the offer intact and an `.err` line beneath the row.
    applyUpdate(update).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      logClientEvent(`updates: install of ${version} failed — ${detail}`);
      // Re-arm: the chip returns from a disabled "Installing…" to an enabled
      // "Update to X" on the same node — the identical hazard, on the retry.
      offeredAt.current = Date.now();
      setState({ kind: "available", version, offering: true, installError: detail });
    });
  };

  const view = updateSectionView(state);

  // The primary chip is the check UNTIL an update is on the table, at which
  // point the same chip becomes the install. One control, two jobs, decided by
  // the state rather than by a second button appearing.
  const onPrimary = (): void => {
    if (state.kind === "available") {
      // A click this soon after the offer appeared is the tail of the
      // double-click that asked for the CHECK, not consent to install.
      if (!installArmed(offeredAt.current, Date.now())) return;
      runInstall(state.version);
      return;
    }
    runCheck();
  };

  return (
    <>
      <div className="row-line" style={{ width: "auto", gap: 8 }}>
        <button
          type="button"
          className={view.primary.accent ? "chip active" : "chip"}
          disabled={view.primary.disabled || !supported}
          onClick={onPrimary}
        >
          {view.primary.label}
        </button>
        {view.showCancel ? (
          <button
            type="button"
            className="chip ghost-btn"
            onClick={() => {
              if (state.kind === "available") setState({ ...state, offering: false });
            }}
          >
            Cancel
          </button>
        ) : null}
        {/* The failure tint goes on a NESTED span, never as `hint-line err`:
            both are single-class selectors and `.hint-line` is declared later,
            so the combination would silently lose the tint to `--soft`. (The
            pre-#150 section nested it for the same reason.)

            Always mounted, empty when there is nothing to say: a polite live region
            must exist in the a11y tree BEFORE its text changes, or the outcome is
            announced unreliably (or not at all) across NVDA/JAWS/VoiceOver. The
            pre-#150 section rendered it unconditionally with null children for the
            same reason; #150 made it conditional and lost the announcement. It is
            visually inert when empty — `.hint-line` is text styling, no box. */}
        <span className="hint-line" role="status" title={view.statusTitle}>
          {view.statusTone === "err" ? <span className="err">{view.status}</span> : view.status}
        </span>
      </div>

      {/* Progress is a hairline under the row, not a panel — the T6 streaming
          motif at row scale (the UpdateGate dialog uses the same recipe). */}
      {view.track ? (
        <span className="busy-hairline update-track" aria-hidden>
          <i />
        </span>
      ) : null}

      {view.error !== undefined ? (
        // `role="alert"` rather than folding into the status region above: on a
        // failed install `view.status` reverts to the availableLine the user was
        // already told, so the region's text change announces the offer, not the
        // failure. Matches the app's existing `inset danger role="alert"` idiom.
        <p className="err" role="alert" title={view.error.title}>
          {view.error.message}
        </p>
      ) : null}

      {!supported ? <p className="hint-line">{unsupportedLine(insideTauri())}</p> : null}
    </>
  );
}
