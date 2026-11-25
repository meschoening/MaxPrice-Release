// The Scope (GLOSSARY.md, ADR-0136 §6, ADR-0140 §1) as the store sees it: the
// repeated `account` and `organization` query params every report endpoint
// reads, resolved to the store's `accounts` and `organizations` axes
// (`StoreQuery`, `ReportFilters`), whose intersection is the Scope's
// Memberships. The rule is `resolveScope`'s (@maxprice/shared), the one the
// Headless client applies too:
//   - neither param is the Home membership; one named leaves the other axis
//     matching any tracked value;
//   - `all` on the Organization axis is THIS machine's resolved tracked set
//     (`trackedNow()` in bootSidecar()), never every Organization the replica
//     or the store happens to hold (#262 item 4);
//   - an Organization that names nothing tracked is dropped, and an axis left
//     empty is Home's part, so a stale Organization scope still answers as
//     Home; an explicit Account key is kept as named, tracked or not, so a
//     stale Account selection matches no row rather than widening to Home's
//     default (#635);
//   - no Home (`home === null`, the ADR-0098 null set) narrows nothing;
//   - any repeated `membership` param (#637) names the Scope alone, as exact
//     Memberships, and the two axis params beside it are ignored.
//
// A resolved Home organization becomes `[home]`, not "no filter", and the Home
// membership's Account `[account]`. The single-Account, single-Organization
// machine keeps its unfiltered fast path anyway: Home's part covering the
// whole tracked Account set resolves to any (`resolveScope`), and the store's
// "covers everything present" no-op drops `[Home]` (#261/#262), so the answer
// is byte-identical to no filter.
//
// The Quota organization retired with #632 (ADR-0136 §6): no single
// Organization answers for every quota surface. The surfaces that read one
// Organization's usage-limits reading take the Scope's head Organization
// below.

import {
  effectiveScope,
  persistedScopeShown,
  resolveScope,
  scopeHeadOrganization,
  type AccountEntry,
  type ResolvedScope,
  type ScopeHeadResponse,
  type ScopeSetting,
  type ScopeState,
} from "@maxprice/shared";
import type { Presumption } from "./engine/presumption";

export type { ScopeState } from "@maxprice/shared";

// What the Scope resolves against, read live per request: the installed Home
// membership and the two resolved tracked sets. While settings work queues,
// Home remains the installed presumption's Home; the admission sets change at
// arrival. The Home is shared with the store's presumption cell: settings
// arrival can precede its queued installation by an entire rebuild, and reading
// the requested Home would filter owner-less rows under a different Home from
// the one that resolves them.
export function createOrganizationScope(
  getPresumption: () => Presumption,
  trackedNow: () => ReadonlySet<string> | null,
  trackedAccountsNow: () => ReadonlySet<string> | null,
): () => ScopeState {
  return () => ({
    home: getPresumption().selfHome,
    trackedOrganizations: trackedNow(),
    trackedAccounts: trackedAccountsNow(),
  });
}

// A request's raw Scope tokens: the repeated `account`, `organization` and
// `membership` params, each possibly absent (`membership` optional for the
// callers that name axes alone).
export type ScopeTokens = {
  account: readonly string[];
  organization: readonly string[];
  membership?: readonly string[];
};

// The persisted Scope (`Settings.scope`, #637) as the tokens a request with
// the renderer's params for it carries (`scopeQueryParams`): none for the
// default Scope, a Membership list alone when it names one.
export function settingScopeTokens(scope: ScopeSetting | null): ScopeTokens {
  if (scope === null) return { account: [], organization: [] };
  if (scope.membership !== undefined) {
    return { account: [], organization: [], membership: scope.membership };
  }
  return { account: scope.account ?? [], organization: scope.organization ?? [] };
}

// A request's tokens as the persisted Scope they carry: `settingScopeTokens`'
// inverse, empty lists dropped, so no token at all is the default Scope.
export function tokensScopeSetting(tokens: ScopeTokens): ScopeSetting | null {
  const membership = tokens.membership ?? [];
  if (membership.length > 0) return { membership: [...membership] };
  const out: ScopeSetting = {};
  if (tokens.account.length > 0) out.account = [...tokens.account];
  if (tokens.organization.length > 0) out.organization = [...tokens.organization];
  return Object.keys(out).length === 0 ? null : out;
}

// The persisted Scope as a reader applies it (#637): the shared rule
// (`effectiveScope`, @maxprice/shared) over the Account roster's tracked
// entries (GET /api/accounts, the count the renderer's Account filter
// takes). `roster` is asked only when the Scope names Accounts or
// Memberships, the one case the count decides; undefined (not known yet, or
// no roster) applies the Scope as written, as the renderer does before
// /api/accounts answers. The status's head reads it synchronously (boot.ts)
// and the readout through `effectiveScopeTokens`.
export function effectivePersistedScope(
  setting: ScopeSetting | null,
  roster: () => readonly Pick<AccountEntry, "tracked">[] | undefined,
): ScopeSetting | null {
  if (effectiveScope(setting, false) === setting) return setting;
  return effectiveScope(setting, persistedScopeShown(roster()));
}

// `effectivePersistedScope` over a request's tokens, the roster read async.
export async function effectiveScopeTokens(
  tokens: ScopeTokens,
  roster: () => Promise<readonly Pick<AccountEntry, "tracked">[] | undefined>,
): Promise<ScopeTokens> {
  const setting = tokensScopeSetting(tokens);
  if (effectiveScope(setting, false) === setting) return tokens;
  const accounts = await roster();
  return settingScopeTokens(effectivePersistedScope(setting, () => accounts));
}

// Resolve one request's tokens. `[]` on an axis is no narrowing.
export function requestScope(tokens: ScopeTokens, state: ScopeState): ResolvedScope {
  return resolveScope(tokens.account, tokens.organization, state, tokens.membership ?? []);
}

// The Organization the status's usage connection describes (#637): the
// persisted Scope's head, by the app's own head rule (`SidecarApp.scopeHead`)
// over the tokens a request carrying that Scope sends, so the status names
// the Organization /api/scope-head and /api/usage/current name for the
// renderer's requests. Computed at each status publish, synchronously over the
// store as it stands: no cached head to keep in step.
// Before the app exists (`scopeHead` null) no store is readable, so the rule
// runs over no candidates. `null` only with no Home.
export function statusHeadOrganization(
  scopeHead: ((tokens: ScopeTokens) => ScopeHeadResponse) | null,
  setting: ScopeSetting | null,
  state: ScopeState,
): string | null {
  const tokens = settingScopeTokens(setting);
  if (scopeHead !== null) return scopeHead(tokens).organizationUuid;
  return scopeHeadOrganization(requestScope(tokens, state), state.home, []);
}
