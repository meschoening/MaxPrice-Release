// The acceptance harness's seam over ADR-0096's startup pricing fetch (#353).
//
// Each sidecar stamps its startup attempt's `pricing.lastAttempt.at` from its
// own clock, so two sidecars booted a fraction of a second apart can differ
// there by one clock step for a reason in no code. With
// MAXPRICE_PRICING_STARTUP_FETCH=0 the startup arm reads the pricing cache and
// fetches nothing (`wirePricingRefresh`'s `startupFetch`), so `lastAttempt`
// stays null until a daily, manual or discovery attempt runs. The packaged app
// never sets it.
//
// A process that honours the variable writes to stderr before LISTENING, and
// the harness refuses a side that does not (scripts/acceptance/sidecar-process.ts):
// a tree older than the seam ignores the variable, so passing it proves nothing.
//
// Dependency-free, so the harness can import it.

export const PRICING_STARTUP_FETCH_ENV = "MAXPRICE_PRICING_STARTUP_FETCH";

/** The acknowledgment: one whole stderr line, flushed before stdout's LISTENING. */
export const PRICING_STARTUP_FETCH_SKIPPED_LINE = `[sidecar] startup pricing fetch skipped (${PRICING_STARTUP_FETCH_ENV})`;

/** Whether the startup arm fetches: yes unless the variable reads `0` or `false`. */
export function pricingStartupFetch(value: string | undefined): boolean {
  return !["0", "false"].includes((value ?? "").toLowerCase());
}
