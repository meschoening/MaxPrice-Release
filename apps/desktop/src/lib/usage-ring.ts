import type { UsageWindow } from "@maxprice/shared";
import { formatRemaining } from "@/lib/active-block";

// Pure derivation for the usage-limit ring (ADR-0023): the arc fills with
// utilization (the quantity that matters — how close to the cap), the center
// counts down to the real reset. `fallback` tells the caller to render the
// legacy local-block ring instead (disconnected / no sample / bad timestamp /
// a reset that has already elapsed). Expiring at the reset boundary prevents a
// last-known sample from surviving forever as a stale `0:00` account window.
export type UsageRingState =
  | { kind: "fallback" }
  | { kind: "limit"; fillFrac: number; centerLabel: string };

export function usageRingState(
  usageWindow: UsageWindow | null,
  now: number,
  format: (ms: number) => string = formatRemaining,
): UsageRingState {
  if (usageWindow === null) return { kind: "fallback" };
  const resetMs = Date.parse(usageWindow.resetAt);
  if (Number.isNaN(resetMs) || resetMs <= now) return { kind: "fallback" };
  const fillFrac = Math.max(0, Math.min(1, usageWindow.utilizationPct / 100));
  const remainingMs = resetMs - now;
  return { kind: "limit", fillFrac, centerLabel: format(remainingMs) };
}
