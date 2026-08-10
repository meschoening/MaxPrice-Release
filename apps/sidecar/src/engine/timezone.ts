// Part 6 — IANA timezone validation + default (ADR-0015). The `tz` query param
// is user-derived, so an aggregator must never be handed a zone Intl can't
// construct.

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// The host's resolved zone — the default when a request omits `tz` (a direct
// sidecar call, an older client). Mirrors the renderer's first-launch seed.
export function defaultTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}
