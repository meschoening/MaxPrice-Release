import { useEffect, useRef, useState } from "react";
import {
  NO_TOAST,
  dismissToast,
  presentToast,
  registerToastEmitter,
  runToastAction,
  toastDwellMs,
  type ToastState,
} from "@/lib/toast";
import { cn } from "@/lib/utils";

// The glass toast (T7) — the T1 pill at blur 16, bottom-center, auto-dismissed
// after ~2.2s (8s when it carries an action), ONE at a time (a new message
// replaces the current one and restarts the clock). The recipe lives in
// @maxprice/glass (`.toast`); this is the desktop host, mounted once by
// Layout. A presentation primitive, not a notification system — callers use
// `showToast` from @/lib/toast, which also owns the dwell and the state
// transitions.

// The pill stays in the tree (opacity 0, no pointer events) so the 250ms
// fade/lift transition runs both ways. The action button, when there is one,
// is the pill's only hit target, and only while the toast shows (the recipe
// scopes it to `.show`); disabling it once dismissed also takes the invisible
// button out of the tab order.
export function ToastContent({
  toast,
  onAction,
}: {
  toast: ToastState;
  onAction: () => void;
}): React.ReactElement {
  return (
    <div className={cn("toast", toast.show && "show")} role="status">
      {toast.message}
      {toast.action !== null && (
        <button type="button" className="toast-action" disabled={!toast.show} onClick={onAction}>
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

export function ToastHost(): React.ReactElement {
  const [toast, setToast] = useState(NO_TOAST);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    registerToastEmitter((message, options) => {
      setToast(presentToast(message, options));
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setToast(dismissToast), toastDwellMs(options));
    });
    return () => {
      registerToastEmitter(null);
      window.clearTimeout(timer.current);
    };
  }, []);

  return (
    <ToastContent
      toast={toast}
      onAction={() =>
        // The dismissal lands before the action runs, so a toast the action
        // shows (its timer included) replaces the dismissal, not the reverse.
        runToastAction(toast, (dismissed) => {
          window.clearTimeout(timer.current);
          setToast(dismissed);
        })
      }
    />
  );
}
