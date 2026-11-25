// The figure formatters the limit surfaces and reports share: a countdown to a
// reset, and an abbreviated count. Shared with the Headless client (ADR-0118
// §7), so the terminal prints the Desktop's own countdowns and abbreviations.

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// "1:05": a duration's whole hours and zero-padded minutes.
export function formatRemaining(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${pad(m)}`;
}

// A duration's whole minutes split into days, hours of the day and minutes of
// the hour: the arithmetic every "3d 4h" / "2h 04m" / "3h 18m" readout shares
// (`formatRemainingLong`, `resetIn`), each
// keeping its own output format. Unclamped: a caller that prints a negative
// duration as zero clamps `ms` first.
export function minuteParts(ms: number): { days: number; hours: number; mins: number } {
  const totalMin = Math.floor(ms / 60_000);
  return {
    days: Math.floor(totalMin / (60 * 24)),
    hours: Math.floor((totalMin % (60 * 24)) / 60),
    mins: totalMin % 60,
  };
}

// Like formatRemaining but for windows that can span days (the weekly usage
// limit) — "3d 4h" / "5h" / "23m". Minute precision is dropped above an hour
// because a multi-day countdown doesn't need it.
export function formatRemainingLong(ms: number): string {
  const { days, hours, mins } = minuteParts(ms);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

export function abbreviate(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return value.toFixed(0);
}
