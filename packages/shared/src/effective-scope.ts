import type { AccountEntry } from "./accounts";
import type { ScopeSetting } from "./settings";

// The persisted Scope as the visible controls can show it (#637; ADR-0106's
// #637 parent-decision note: "a saved Account or Membership Scope the visible
// controls cannot show is not applied, and the UI says so"). One rule for
// every reader of `Settings.scope`: the main window and the popout
// (`useScope`), the tray readout (`/api/readout`, whose Scope tokens the
// shell reads off settings.json) and the status's usage connection
// (boot.ts's `statusHeadOrganization` input). Each counts the same thing:
// the tracked entries of the Account roster, GET /api/accounts
// (`accountFilterVisible`).
//
// While fewer than two Accounts are tracked the Account filter is hidden,
// and the only control that writes `scope` is the topbar's Organization
// scope chip, which names the Organization axis alone. So only the default
// Scope (null) and an Organization-axis Scope apply; any other persisted
// Scope (one written while two Accounts were tracked, or a hand-edited file)
// reads as the default. The file is never rewritten by this rule.

// Whether a persisted Scope names the Organization axis alone: what a
// released file's `organizationScope` reads as, and what the topbar's
// Organization scope chip writes. The one non-default Scope a hidden Account
// filter still applies.
export function isOrganizationAxisScope(scope: ScopeSetting | null): boolean {
  return (
    scope !== null &&
    scope.membership === undefined &&
    scope.account === undefined &&
    scope.organization !== undefined
  );
}

// The Account filter shows once the install tracks two or more Accounts
// (#613 §3, #620), counted over the Account roster (GET /api/accounts) by its
// `tracked` flags. A Pending account counts, as the menu lists it.
export function accountFilterVisible(accounts: readonly Pick<AccountEntry, "tracked">[]): boolean {
  return accounts.filter((account) => account.tracked).length >= 2;
}

// Whether the persisted Scope applies as written: the Account filter shows,
// or the roster is not known yet (`undefined`), when it is honoured, so a
// several-Account install does not read every report twice at boot.
export function persistedScopeShown(
  accounts: readonly Pick<AccountEntry, "tracked">[] | undefined,
): boolean {
  return accounts === undefined || accountFilterVisible(accounts);
}

// The Scope a reader applies: the persisted one when `shown`
// (`persistedScopeShown`), else only the default or an Organization-axis
// Scope; any other is the default (null).
export function effectiveScope(scope: ScopeSetting | null, shown: boolean): ScopeSetting | null {
  if (scope === null || shown || isOrganizationAxisScope(scope)) return scope;
  return null;
}
