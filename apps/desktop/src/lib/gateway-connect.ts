import {
  GATEWAY_CHECK_FAILURE_WORDS,
  GATEWAY_WARNING_WORDS,
  gatewayManagementKeySchema,
  gatewayUrlHost,
  normalizeGatewayUrl,
  type GatewayCheckResponse,
} from "@maxprice/shared";

// Settings › Accounts' "Connect a Gateway" (ADR-0141 §7, as amended on
// 2026-11-10; #639): Connect's check runs first (the sidecar reads the
// Gateway's credential list once and holds nothing), and the URL and key are
// stored, which pushes them to the sidecar, only once it passes. A failed
// check stores nothing and says why. A passing check shows both warnings:
// keep the queue's retention at 3600 s, and MaxPrice must be the queue's only
// consumer. Connecting tracks nothing (an Account first seen through the
// Gateway starts Excluded); the Hub send-up is the sidecar's (§7's note).

export const GATEWAY_INPUT_ERRORS = {
  url: "Enter the Gateway's address, e.g. http://gateway.example:8317.",
  key: "Paste the Gateway's management key: printable characters, no spaces.",
} as const;

export interface GatewayConnectDeps {
  // POST /api/gateways/check (`checkGateway`).
  check: (url: string, managementKey: string) => Promise<GatewayCheckResponse>;
  // The keychain entry and URL list, then the push (`setGatewayCredential`).
  store: (url: string, managementKey: string) => Promise<unknown>;
}

export type GatewayConnectOutcome =
  | { ok: false; error: string }
  | { ok: true; host: string; warnings: string[] };

export async function connectGateway(
  deps: GatewayConnectDeps,
  rawUrl: string,
  rawKey: string,
): Promise<GatewayConnectOutcome> {
  const url = normalizeGatewayUrl(rawUrl);
  if (url === null) return { ok: false, error: GATEWAY_INPUT_ERRORS.url };
  const key = rawKey.trim();
  if (!gatewayManagementKeySchema.safeParse(key).success) {
    return { ok: false, error: GATEWAY_INPUT_ERRORS.key };
  }
  try {
    const check = await deps.check(url, key);
    if (!check.ok) return { ok: false, error: GATEWAY_CHECK_FAILURE_WORDS[check.failure] };
    await deps.store(url, key);
    return {
      ok: true,
      host: gatewayUrlHost(url),
      warnings: check.warnings.map((w) => GATEWAY_WARNING_WORDS[w]),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
