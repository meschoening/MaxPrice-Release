import { useEffect, useState } from "react";

// Re-renders the calling component every `intervalMs` and returns the current
// epoch-ms timestamp. Shared by the time-derived UI of Part 3 — the refresh
// pill's "Ns ago" label and the active-block ring's 1Hz countdown — so each
// keeps a single ticking source rather than its own setInterval.
export function useNowTick(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
