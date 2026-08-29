import { useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { insideTauri } from "@/lib/tauri";
import { detectUpdate, applyUpdate, type UpdateProbe } from "@/lib/updater";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

// UpdateGate — the update prompt, worn as the glass system's first modal (T7):
// ONE glass panel (radius 20, blur 24) centered over a FLAT tint scrim
// (`--scrim` — never a frosted scrim: a full-viewport backdrop-filter is the
// blur budget's one forbidden move). Mounted by `Layout`. Since map #168 M3
// the CHECK SCHEDULE lives Rust-side (the ambient module: boot + ~6h — a
// long-running background app would never learn of an update from a
// mount-time-only check), and this gate is TRIGGERED rather than
// self-scheduled: by the Rust `update:available` broadcast, by the pending
// verdict already held in Rust state at mount (`get_pending_update` — the
// check may land before this webview parses), and by the popout's update row
// (`update:open-gate` — which must re-raise a gate dismissed with "Later").
// The INSTALL flow is untouched (T5 decision 7): on each trigger the gate
// runs its own `detectUpdate()` — the plugin's `check()` is what yields the
// `Update` handle `downloadAndInstall` needs — then prompts; the user
// installs on their own terms. Mid-install every dismiss affordance locks
// (Later / × / Esc / scrim) and an indeterminate accent track runs beneath
// the description copy (the T6 streaming hairline motif, given a body-track
// home per M6 gate feedback). Outside a Tauri host (`detectUpdate` returns
// `unsupported`) every trigger no-ops and nothing renders.

type GateState =
  | { phase: "idle" }
  | { phase: "available"; probe: Extract<UpdateProbe, { status: "available" }> }
  | { phase: "installing" };

// Keep in lockstep with ambient.rs's UPDATE_AVAILABLE_EVENT and the popout's
// UpdateRow (Popout.tsx).
const UPDATE_AVAILABLE_EVENT = "update:available";
const UPDATE_OPEN_GATE_EVENT = "update:open-gate";

export function UpdateGate(): React.ReactElement | null {
  const [state, setState] = useState<GateState>({ phase: "idle" });
  // The mock opens focus on the primary action, not the × (the first tabbable
  // Radix would otherwise pick). Declared before the idle early-return — hooks
  // must run on every render.
  const installBtn = useRef<HTMLButtonElement>(null);
  // Read by the stable trigger callback so a probe can't stomp an install in
  // progress; state itself stays the render source of truth.
  const phaseRef = useRef<GateState["phase"]>("idle");
  phaseRef.current = state.phase;

  useEffect(() => {
    if (!insideTauri()) return;
    let cancelled = false;

    // One probe body for all three triggers. Never while installing; a
    // re-trigger while already prompting just refreshes the probe (harmless —
    // same version, fresh Update handle).
    const probe = (): void => {
      if (phaseRef.current === "installing") return;
      detectUpdate()
        .then((result) => {
          if (cancelled || result.status !== "available") return;
          if (phaseRef.current === "installing") return;
          setState({ phase: "available", probe: result });
        })
        .catch((err: unknown) => {
          // A failed probe must never block the app — log and move on.
          console.warn("[updater] update probe failed:", err);
        });
    };

    // The mount-time seed: Rust may have found the update before this webview
    // parsed (or during a previous hide), so ask its held verdict once.
    invoke<string | null>("get_pending_update")
      .then((pending) => {
        if (!cancelled && pending !== null) probe();
      })
      .catch((err: unknown) => {
        console.warn("[updater] get_pending_update failed:", err);
      });

    const unlistenAvailable = listen(UPDATE_AVAILABLE_EVENT, probe);
    const unlistenOpen = listen(UPDATE_OPEN_GATE_EVENT, probe);
    return () => {
      cancelled = true;
      void unlistenAvailable.then((off) => off());
      void unlistenOpen.then((off) => off());
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
