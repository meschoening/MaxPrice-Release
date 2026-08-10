// Hub-specific duration formatting. The generic "time since" formatter
// (`formatRelativeTime`) now lives in @maxprice/shared, imported directly
// by both apps; only `formatUptime` — used solely by the Hub status card — stays
// local here.

// Real daemon uptime for the Hub status card. `startMs` is the epoch-ms of
// `HubStatus.startedAt` (the daemon's own boot time, contract §1), parsed at
// the call site; rendered relative to `now`.
export function formatUptime(startMs: number, now: number): string {
  const age = Math.max(0, now - startMs);
  if (age < 60_000) return "up <1m";
  if (age < 3_600_000) return `up ${Math.floor(age / 60_000)}m`;
  if (age < 86_400_000) {
    const hours = Math.floor(age / 3_600_000);
    const mins = Math.floor((age % 3_600_000) / 60_000);
    return `up ${hours}h ${mins}m`;
  }
  return `up ${Math.floor(age / 86_400_000)}d`;
}
