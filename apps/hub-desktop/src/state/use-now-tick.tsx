import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const NowTickContext = createContext<number | null>(null);

// A SINGLE now-tick shared by the whole console via context — one interval for
// the app, not one per consumer (the three status cards previously each ran
// their own 1Hz timer). The interval PAUSES while the window is hidden: the
// tray app hides (never destroys) on close, so a backgrounded console would
// otherwise burn a wakeup every second with no viewer. On return to visible we
// resnap `now` immediately (so nothing renders stale) and resume ticking.
//
// This gates ONLY the cosmetic relative-time re-render. Data flow — the
// TanStack queries, the SSE stream, and the tray tooltip fed from this webview
// while hidden — is deliberately NOT visibility-gated.
export function NowTickProvider({
  intervalMs = 1000,
  children,
}: {
  intervalMs?: number;
  children: ReactNode;
}): React.ReactElement {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    const start = (): void => {
      if (id === undefined) id = setInterval(() => setNow(Date.now()), intervalMs);
    };
    const stop = (): void => {
      if (id !== undefined) {
        clearInterval(id);
        id = undefined;
      }
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        setNow(Date.now()); // resnap so the UI isn't stale on return
        start();
      }
    };

    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [intervalMs]);

  return <NowTickContext.Provider value={now}>{children}</NowTickContext.Provider>;
}

// The current epoch-ms from the shared tick. Must be called under a
// NowTickProvider (App renders exactly one).
export function useNowTick(): number {
  const now = useContext(NowTickContext);
  if (now === null) throw new Error("useNowTick must be used within a NowTickProvider");
  return now;
}
