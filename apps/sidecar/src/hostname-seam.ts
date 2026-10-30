// The User guide capture's seam over the roster hostname (ADR-0134 §6).
//
// A sidecar joined to a Hub sends its machine's name as `x-maxprice-hostname`,
// and the Hub shows it as the machine's roster label (ADR-0036). The capture
// script boots several sidecars on one host and photographs what the Hub shows,
// so without this every machine would carry the real host's name, and the
// guide is public. With MAXPRICE_TEST_HOSTNAME set, that value is sent instead.
// The packaged app never sets it.
//
// A process that honours the variable writes to stderr before LISTENING, and
// the capture script refuses a sidecar that does not (scripts/guide-screenshots/
// fleet.ts): a tree older than the seam would send the real name.
//
// Dependency-free, so the capture script can import it.

export const HOSTNAME_ENV = "MAXPRICE_TEST_HOSTNAME";

/** The acknowledgment: one whole stderr line, flushed before stdout's LISTENING. */
export function hostnameSeamLine(name: string): string {
  return `[sidecar] roster hostname ${JSON.stringify(name)} (${HOSTNAME_ENV})`;
}

/** The variable's value when it names a hostname, else null: unset or blank sends the real one. */
export function seamHostname(value: string | undefined): string | null {
  const name = value?.trim() ?? "";
  return name === "" ? null : name;
}
