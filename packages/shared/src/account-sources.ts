import { z } from "zod";
import { isAccountUuid, isPendingAccountKey, pendingHashOf } from "./accounts";
import { gatewayIdSchema, GATEWAYS_HELD_MAX } from "./gateway";

// ── Account sources (ADR-0141 §8, #639) ──
//
// Where this machine sees each Account: GET /api/account-sources, the loopback
// route behind Settings › Accounts' "Seen through" line on each card and the
// Accounts each Gateway row names. Two sources:
//
// - `login`: a watched config root's current login on THIS machine names the
//   Account (the root's `.claude.json` `oauthAccount`, read live at each
//   request, as GET /api/accounts reads it);
// - `gateways`: the ids of the Gateways this machine holds whose credential
//   list, as this machine last read it, names an email that resolves to the
//   Account: through the pair table to an account uuid, else to the Pending
//   account that email keys.
//
// Only an Account with at least one source is listed, sorted by key, each
// Gateway id once and sorted. The key is GET /api/accounts' (an account uuid,
// or `pending:<hash>` for a Pending account), so neither an email nor its hash
// on its own ever rides here: the object is strict, and a key that is neither
// form is refused. Loopback only, like GET /api/accounts' Pending keys.
export const ACCOUNT_SOURCES_PATH = "/api/account-sources";

const PENDING_HASH = /^[0-9a-f]{64}$/;

// An Account key as GET /api/accounts names one: an account uuid, or a Pending
// account's `pending:<sha256-hex>`.
export const accountSourceKeySchema = z
  .string()
  .refine(
    (key) =>
      isPendingAccountKey(key) ? PENDING_HASH.test(pendingHashOf(key) ?? "") : isAccountUuid(key),
    { message: "not an Account key" },
  );

export const accountSourceSchema = z
  .object({
    key: accountSourceKeySchema,
    login: z.boolean(),
    gateways: z.array(gatewayIdSchema).max(GATEWAYS_HELD_MAX),
  })
  .strict();
export type AccountSource = z.infer<typeof accountSourceSchema>;

export const accountSourcesResponseSchema = z
  .object({ accounts: z.array(accountSourceSchema) })
  .strict();
export type AccountSourcesResponse = z.infer<typeof accountSourcesResponseSchema>;

// Its TanStack key and URL (ADR-0004's split), so the SSE pokes reach it from
// outside React. The renderer refetches it on `accounts:changed` (a root's
// login or the pair table moved) and on `gateways:changed` (a held Gateway's
// credential list did).
export function accountSourcesQueryKey(): ["account-sources"] {
  return ["account-sources"];
}
export function buildAccountSourcesUrl(base: string): string {
  return `${base}${ACCOUNT_SOURCES_PATH}`;
}
