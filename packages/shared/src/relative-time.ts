// Human-readable "time since" for display — pricing freshness, hub status rows,
// and similar. Coarse by design (just-now / m / h / d); not for precise
// durations. Returns an em dash for a missing or unparseable timestamp. Shared
// so the desktop and hub-desktop apps render relative times identically from a
// single implementation.
export function formatRelativeTime(iso: string | null, now: number): string {
  if (iso === null) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const age = now - then;
  if (age < 60_000) return "just now";
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return `${Math.floor(age / 86_400_000)}d ago`;
}
