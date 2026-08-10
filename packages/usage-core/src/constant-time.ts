import { timingSafeEqual } from "node:crypto";

// Constant-time string equality — the single implementation shared by every
// network auth boundary (the hub's bearer/operator compares, the sidecar's
// usage-auth token). A short-circuiting `!==` on a secret would leak it one
// byte at a time via response timing. `timingSafeEqual` throws on a length
// mismatch, so equal byte length is guarded first (an unequal-length compare is
// trivially not-equal, and returning early there leaks only length, never
// content).
export function constantTimeEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
