import { useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { detectUpdate, applyUpdate, type UpdateProbe } from "@/lib/updater";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

// UpdateGate — the once-on-launch update check (Task 6.8), worn as the glass
// system's first modal (T7): ONE glass panel (radius 20, blur 24) centered
// over a FLAT tint scrim (`--scrim` — never a frosted scrim: a full-viewport
// backdrop-filter is the blur budget's one forbidden move). Mounted by
// `Layout`, it probes the updater endpoint once and, if a newer release
// exists, surfaces a non-blocking dialog. The user installs on their own
// terms; dismissing it is a no-op until the next launch. Mid-install every
// dismiss affordance locks (Later / × / Esc / scrim) and an indeterminate
// accent track runs beneath the description copy (the T6 streaming hairline
// motif, given a body-track home per M6 gate feedback — the mock's top-edge
// placement read as a page-load bar, not an install). Outside a Tauri host
// (`detectUpdate` returns `unsupported`) the probe is skipped and nothing
// renders.

type GateState =
  | { phase: "idle" }
  | { phase: "available"; probe: Extract<UpdateProbe, { status: "available" }> }
  | { phase: "installing" };

export function UpdateGate(): React.ReactElement | null {
  const [state, setState] = useState<GateState>({ phase: "idle" });
  // The mock opens focus on the primary action, not the × (the first tabbable
  // Radix would otherwise pick). Declared before the idle early-return — hooks
  // must run on every render.
  const installBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    detectUpdate()
      .then((probe) => {
        if (cancelled || probe.status !== "available") return;
        setState({ phase: "available", probe });
      })
      .catch((err: unknown) => {
        // A failed probe must never block app launch — log and move on.
        console.warn("[updater] launch check failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === "idle") return null;

  const version = state.phase === "available" ? state.probe.version : undefined;
  const installing = state.phase === "installing";

  const install = (): void => {
    if (state.phase !== "available") return;
    const { update } = state.probe;
    setState({ phase: "installing" });
    // applyUpdate relaunches the app on success, so there is no resolved
    // branch to handle here; only surface a failure.
    applyUpdate(update).catch((err: unknown) => {
      console.error("[updater] install failed:", err);
      setState({ phase: "available", probe: state.probe });
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Dismiss only when idle — block close mid-install (Esc + scrim).
        if (!next && !installing) setState({ phase: "idle" });
      }}
    >
      <DialogContent
        className="gate-dialog"
        overlayClassName="gate-scrim"
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          installBtn.current?.focus();
        }}
      >
        {!installing && (
          <DialogClose asChild>
            <button type="button" className="gate-x" aria-label="Close">
              <XIcon aria-hidden />
            </button>
          </DialogClose>
        )}
        <DialogTitle asChild>
          <h3>Update available</h3>
        </DialogTitle>
        <DialogDescription className="gate-desc">
          {installing
            ? "Downloading and installing the update. The app will relaunch automatically."
            : `MaxPrice ${version ?? ""} is available. Install it now and relaunch?`}
        </DialogDescription>
        {installing && (
          <span className="busy-hairline" aria-hidden>
            <i />
          </span>
        )}
        <div className="btns">
          <button
            type="button"
            className="chip"
            disabled={installing}
            onClick={() => setState({ phase: "idle" })}
          >
            Later
          </button>
          <button
            ref={installBtn}
            type="button"
            className="chip active"
            disabled={installing}
            onClick={install}
          >
            {installing ? "Installing…" : "Install and relaunch"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
