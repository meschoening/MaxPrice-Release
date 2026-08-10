import { useEffect, useRef, useState } from "react";
import { registerToastEmitter } from "@/lib/toast";
import { cn } from "@/lib/utils";

// The glass toast (T1/T7) — the pill at blur 16, bottom-center, auto-dismissed
// after ~2.2s, ONE at a time (a new message replaces the current one and
// restarts the clock). The recipe lives in @maxprice/glass (`.toast`, tucked to
// bottom 14px by the hub's tray-scale override); this is the hub host, mounted
// once by App. Console mutations land their confirmations here — callers use
// `showToast` from @/lib/toast. Kept in lockstep with the desktop's ToastHost.

const DWELL_MS = 2200;

// The pill stays in the tree (opacity 0, no pointer events) so the 250ms
// fade/lift transition runs both ways.
export function ToastHost(): React.ReactElement {
  const [message, setMessage] = useState("");
  const [show, setShow] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    registerToastEmitter((m) => {
      setMessage(m);
      setShow(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setShow(false), DWELL_MS);
    });
    return () => {
      registerToastEmitter(null);
      window.clearTimeout(timer.current);
    };
  }, []);

  return (
    <div className={cn("toast", show && "show")} role="status">
      {message}
    </div>
  );
}
