import {
  byCodeUnit,
  isAccountUuid,
  pendingAccountKey,
  type AccountSourcesResponse,
} from "@maxprice/shared";
import { liveAccountKey } from "./account-tracking";
import type { GatewayCredentialEmails } from "./gateway-client";
import type { CurrentLogin } from "./organizations";

// GET /api/account-sources (#639, ADR-0141 §8): where this machine sees each
// Account, for Settings › Accounts' "Seen through" line and the Accounts each
// Gateway row names.
//
// - `login`: some watched root's current login names the Account (each
//   `CurrentLogin`'s accounts, read live at the request, as GET /api/accounts
//   reads them).
// - `gateways`: each held Gateway whose credential list, as this machine last
//   read it (`GatewayClient.credentialEmails`), names an email whose hash
//   resolves to the Account: through the live pair table to an account uuid,
//   else to the Pending account that hash keys (`liveAccountKey`, the one
//   resolution GET /api/accounts keys its entries by). An email no pair maps
//   and no evidence names yet is a Pending key GET /api/accounts does not
//   list; the renderer shows only the Accounts it knows.
//
// Only Accounts with a source are listed, sorted by key, each Gateway id once
// and sorted. Neither an email nor a bare hash is answered (the shape is
// strict): a Pending account rides as its `pending:<hash>` key, as on GET
// /api/accounts, on the loopback only.
export function composeAccountSources(input: {
  logins: readonly Pick<CurrentLogin, "accounts">[];
  gateways: readonly GatewayCredentialEmails[];
  pairs: ReadonlyMap<string, string>;
}): AccountSourcesResponse {
  const byKey = new Map<string, { login: boolean; gateways: Set<string> }>();
  const entry = (key: string) => {
    let e = byKey.get(key);
    if (e === undefined) {
      e = { login: false, gateways: new Set() };
      byKey.set(key, e);
    }
    return e;
  };
  for (const login of input.logins) {
    // A login file names its Account by any non-empty string; the response's
    // strict key schema takes only an account uuid, so one odd login never
    // spoils the whole answer.
    for (const account of login.accounts) {
      if (isAccountUuid(account.accountUuid)) entry(account.accountUuid).login = true;
    }
  }
  for (const gateway of input.gateways) {
    for (const hash of gateway.emailHashes) {
      entry(liveAccountKey(pendingAccountKey(hash), input.pairs)).gateways.add(gateway.id);
    }
  }
  return {
    accounts: [...byKey.entries()]
      .sort(([a], [b]) => byCodeUnit(a, b))
      .map(([key, e]) => ({ key, login: e.login, gateways: [...e.gateways].sort() })),
  };
}
