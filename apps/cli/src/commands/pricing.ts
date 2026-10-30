import {
  PRICING_REFRESH_PATH,
  pricingRefreshResponseSchema,
  type PricingRefreshResponse,
} from "@maxprice/shared";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { connect } from "../daemon-client";
import { CliError, EXIT, usageError } from "../exit";
import type { Io, Parsed } from "../main";
import type { Env } from "../paths";
import { plural } from "../render/count";

// `maxprice pricing <verb>`, of which there is one: `refresh`, a Pricing
// refresh (ADR-0085), the Desktop client's Refresh prices chip. It POSTs
// /api/pricing/refresh with no body, and the daemon's single-flight
// refresher (ADR-0085 §2) runs one fetch of the LiteLLM price list, or joins
// the one in flight, or, within its 10 s cooldown after the last attempt
// settled (`DEFAULT_REFRESH_COOLDOWN_MS`), fetches nothing and answers with
// that attempt's pricing and `newModels: 0`. So a retry right after a failed
// refresh reports the same failure again. The route does not wait for the
// scan, so this connects as `status` does.

function usage(message: string): CliError {
  return usageError(message, "maxprice pricing --help");
}

// The Desktop client's Settings › Pricing words (`pricing-section.ts`).
function refreshedLine({ newModels, pricing }: PricingRefreshResponse): string {
  if (newModels > 0) return `Refreshed · ${plural(newModels, "new model")}`;
  if (pricing.unpricedModels.length === 0) return "Refreshed · up to date";
  return `Refreshed · models still unpriced: ${pricing.unpricedModels.join(", ")}`;
}

export async function pricing(parsed: Parsed, io: Io, env: Env = process.env): Promise<number> {
  const [verb, ...rest] = parsed.positionals;
  if (verb === undefined) throw usage("pricing needs a command: refresh");
  if (verb !== "refresh") throw usage(`unknown pricing command '${verb}'`);
  if (rest.length > 0) throw usage("pricing refresh takes no arguments");

  const daemon = await connect({ env });
  const { data, text } = await daemon.request(PRICING_REFRESH_PATH, pricingRefreshResponseSchema, {
    method: "POST",
  });
  // A 200 is not a success: the attempt it reports may have failed (the
  // Desktop client's `classifyRefreshResponse`), and a failure leaves the
  // active snapshot as it was.
  const failure = data.pricing.lastAttempt?.failure ?? null;
  const json = parsed.values.json === true;
  // ADR-0119 §7 as #463 amends it: the route answered, so under `--json` its
  // answer prints whether or not the attempt failed; a failure is still the
  // one stderr line, and exit 1.
  if (json) io.stdout.write(text);
  if (failure !== null) {
    // `renderError` prints the upstream detail inert, on the error's one line.
    const detail = failure.detail === "" ? "" : `: ${failure.detail}`;
    throw new CliError(EXIT.FAILURE, `the pricing refresh failed (${failure.kind})${detail}`);
  }
  // The line can name an unpriced model, a string from upstream.
  if (!json) io.stdout.write(`${terminalText(refreshedLine(data))}\n`);
  return EXIT.OK;
}
