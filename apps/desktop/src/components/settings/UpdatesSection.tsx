import { useState } from "react";
import { checkForUpdate } from "@/lib/updater";
import { insideTauri } from "@/lib/tauri";

// UpdatesSection — the manual "Check for updates" control in the Settings page
// (Task 6.8), worn as a glass chip with the outcome on a dim status line. It
// calls the same `checkForUpdate` helper as the launch check; a manual click is
// treated as consent, so a found update is downloaded and installed immediately
// (the app then relaunches).

type CheckState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "up-to-date" }
  | { phase: "updating" }
  | { phase: "error"; message: string };

export function UpdatesSection(): React.ReactElement {
  const [state, setState] = useState<CheckState>({ phase: "idle" });
  const supported = insideTauri();
  const busy = state.phase === "checking" || state.phase === "updating";

  const onCheck = (): void => {
    setState({ phase: "checking" });
    checkForUpdate()
      .then((outcome) => {
        if (outcome.status === "up-to-date" || outcome.status === "unsupported") {
          setState({ phase: "up-to-date" });
        } else {
          // An update was found — downloadAndInstall + relaunch are underway;
          // the process exits before this resolves in practice.
          setState({ phase: "updating" });
        }
      })
      .catch((err: unknown) => {
        setState({
          phase: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
  };

  return (
    <>
      <div className="row-line" style={{ width: "auto", gap: 10 }}>
        <button type="button" className="chip" disabled={busy || !supported} onClick={onCheck}>
          {state.phase === "checking"
            ? "Checking…"
            : state.phase === "updating"
              ? "Updating…"
              : "Check for updates"}
        </button>
        <span className="hint-line" role="status">
          {state.phase === "up-to-date" ? "You’re up to date." : null}
          {state.phase === "updating" ? "Update found — installing, the app will relaunch." : null}
          {state.phase === "error" ? (
            <span className="err">Check failed: {state.message}</span>
          ) : null}
        </span>
      </div>
      {!supported ? (
        <p className="hint-line">Updates are only available in the desktop app.</p>
      ) : null}
    </>
  );
}
