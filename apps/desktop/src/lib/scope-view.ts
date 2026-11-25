import {
  effectiveScope,
  formatMembershipToken,
  headOrganization,
  homeMembershipOf,
  isMultiOrganization,
  MEMBERSHIP_NONE,
  parseMembershipToken,
  persistedScopeShown,
  resolveScope,
  SCOPE_ALL,
  SCOPE_HOME,
  scopeHasMembership,
  scopeQueryParams,
  scopeStateOf,
  settledHeadOrganization,
  trackedAccountSet,
  trackedOrganizationSet,
  trackedScopeMemberships,
  type AccountEntry,
  type ResolvedScope,
  type ScopeQueryParams,
  type ScopeSetting,
  type Settings,
  type TrackedMembership,
} from "@maxprice/shared";

// The persisted Scope (`Settings.scope`, #637) as the renderer reads it. Pure,
// so every rule here is testable without the query hooks; `useScope` is the
// hook over `scopeView`, and the Account menu (#637's later tasks) builds on
// the Membership helpers below.
//
// The renderer never resolves the Scope for the wire: `params` passes the
// persisted tokens through (`scopeQueryParams`) and the sidecar alone resolves
// them. The rest is presentation, read off settings alone, so it costs no
// fetch: which Organization a one-Membership surface (usage current, the
// quota tiles) reads, and whether the Scope can hold more than one Membership
// or Organization.

type ScopeSettings = Pick<
  Settings,
  "scope" | "homeMemberships" | "trackedOrganizations" | "trackedAccounts"
>;

export interface ScopeView {
  // The persisted selection, as written: null is the default Scope.
  selection: ScopeSetting | null;
  // The report inputs' Scope fields (`ReportQueryInput`, `IntradayHookInput`).
  params: ScopeQueryParams;
  // The Scope's head Organization (the shared head rule, `scope-head.ts` in
  // @maxprice/shared): whose usage current a one-Membership surface shows,
  // the Organization the sidecar's `/api/usage/current` head reads for the
  // same params. Settings head the default
  // Scope, every Scope holding the Home membership and every one-Organization
  // Scope (`settledHeadOrganization`); any other is the sidecar's to say
  // (`headPending`), and until `useScope` has its answer this is the rule's
  // no-candidate fallback (`headOrganization`). Undefined with no Home.
  quotaOrganization: string | undefined;
  // Settings alone cannot head the Scope: `useScope` asks the sidecar
  // (`/api/scope-head`) and reads its answer into `quotaOrganization`.
  headPending: boolean;
  // A persisted Scope the visible controls cannot show is being read as the
  // default: the Account filter is hidden and `settings.scope` names
  // Accounts or Memberships (`scopeView`'s `filterVisible`). The topbar says
  // so (`ScopeHiddenNote`); the file keeps the selection.
  hiddenSelection: boolean;
  // The Scope may hold more than one Membership.
  isWide: boolean;
  // The Scope may hold more than one Organization: the Organization column of
  // Sessions and Projects shows, and the quota surfaces name the Organization
  // whose limits they read (`quotaSurface`).
  spansOrganizations: boolean;
  // The Scope is every tracked Membership (all accounts, or a released
  // file's All organizations) and holds more than one: the popout's Today row
  // says "all". A Membership list never is, however much it names.
  isAll: boolean;
  // More than one Organization is tracked (#312 ruling 7).
  multi: boolean;
}

const isKey = (token: string): boolean => token !== SCOPE_ALL && token !== SCOPE_HOME;

// `filterVisible` is `persistedScopeShown`'s answer, and the selection is the
// shared effective-Scope rule's (`effectiveScope`, @maxprice/shared), which
// the tray readout and the status's head apply too: while the Account filter
// is hidden only the default Scope and an Organization-axis Scope (which the
// topbar's Organization scope chip shows and writes) are read; any other
// persisted Scope, a selection made while the filter showed or one left in a
// hand-edited file, reads as the default Scope (no params), so it never
// narrows an install that offers no control to undo it, and
// `hiddenSelection` says so. The file is never rewritten here.
export function scopeView(settings: ScopeSettings | undefined, filterVisible = true): ScopeView {
  const persisted = settings?.scope ?? null;
  const selection = effectiveScope(persisted, filterVisible);
  const hiddenSelection = selection !== persisted;
  const home = settings ? homeMembershipOf(settings) : null;
  const homeOrganization = home?.organizationUuid;
  const multi = isMultiOrganization(homeOrganization, settings?.trackedOrganizations);
  const params = scopeQueryParams(selection);
  // The head: the shared rule over the Scope as the sidecar resolves it,
  // against the same settings (`scopeStateOf`).
  const resolved =
    settings === undefined
      ? null
      : resolveScope(
          params.account ?? [],
          params.organization ?? [],
          scopeStateOf(settings),
          params.memberships ?? [],
        );
  const settled = resolved === null ? null : settledHeadOrganization(resolved, home);
  const headPending = settled === undefined;
  const quotaOrganization =
    (resolved !== null && headPending ? headOrganization(resolved, home) : settled) ?? undefined;
  if (selection === null || settings === undefined) {
    return {
      selection,
      params,
      quotaOrganization,
      headPending,
      hiddenSelection,
      isWide: false,
      spansOrganizations: false,
      isAll: false,
      multi,
    };
  }

  if (selection.membership !== undefined) {
    const memberships = new Set<string>();
    const organizations = new Set<string>();
    for (const token of selection.membership) {
      const m = parseMembershipToken(token);
      if (m === null) continue;
      memberships.add(formatMembershipToken(m.organizationUuid, m.accountUuid));
      organizations.add(m.organizationUuid);
    }
    return {
      selection,
      params,
      quotaOrganization,
      headPending,
      hiddenSelection,
      isWide: memberships.size >= 2,
      spansOrganizations: organizations.size >= 2,
      isAll: false,
      multi,
    };
  }

  // Named by its axes. An axis left unnamed beside a named one matches any
  // tracked value, as `all` does; `home` is Home's part.
  const tracked = trackedOrganizationSet(settings);
  const organizationTokens = selection.organization ?? [];
  const accountTokens = selection.account ?? [];
  const organizations = new Set<string>();
  let everyOrganization = organizationTokens.length === 0;
  for (const token of organizationTokens) {
    if (token === SCOPE_ALL) everyOrganization = true;
    else if (token === SCOPE_HOME) {
      if (homeOrganization !== undefined) organizations.add(homeOrganization);
    } else if (tracked === null || tracked.has(token)) organizations.add(token);
  }
  const accounts = new Set(accountTokens.filter(isKey));
  const everyAccount = accountTokens.length === 0 || accountTokens.includes(SCOPE_ALL);
  if (accountTokens.includes(SCOPE_HOME)) accounts.add(home?.accountUuid ?? SCOPE_HOME);
  const accountCount = trackedAccountSet(settings)?.size ?? 1;

  const spansOrganizations = everyOrganization ? multi : organizations.size >= 2;
  const spansAccounts = everyAccount ? accountCount >= 2 : accounts.size >= 2;
  return {
    selection,
    params,
    quotaOrganization,
    headPending,
    hiddenSelection,
    isWide: spansOrganizations || spansAccounts,
    spansOrganizations,
    isAll: everyOrganization && everyAccount && (spansOrganizations || spansAccounts),
    multi,
  };
}

// --- The Account menu's Memberships (#637) ----------------------------------

// The tracked Memberships of the tracked Accounts (`/api/accounts`), Home's
// first: the shared rule (`trackedScopeMemberships`) over the tracked sets
// settings name. With no Home every Organization counts as tracked, as the
// sidecar's null set excludes nothing.
export function trackedMemberships(
  accounts: readonly Pick<AccountEntry, "key" | "tracked" | "memberships">[],
  settings: Pick<Settings, "homeMemberships" | "trackedOrganizations">,
): TrackedMembership[] {
  return trackedScopeMemberships(accounts, {
    home: homeMembershipOf(settings),
    trackedOrganizations: trackedOrganizationSet(settings),
  });
}

// The Scope the main window and the popout read (`useScope`): `scopeView`
// gated by the Account filter's visibility over `/api/accounts`' tracked
// entries (`persistedScopeShown`, the count every reader of the persisted
// Scope takes). While `/api/accounts` has not answered (`accounts`
// undefined) the persisted Scope is honoured, so a several-Account install
// does not fetch every report twice at boot.
export function visibleScopeView(
  settings: ScopeSettings | undefined,
  accounts: readonly Pick<AccountEntry, "tracked">[] | undefined,
): ScopeView {
  return scopeView(settings, persistedScopeShown(accounts));
}

// What the Account menu selects: the default Scope (the Home membership), all
// accounts, or a list of Memberships.
export type ScopeSelection =
  | { kind: "default" }
  | { kind: "all" }
  | { kind: "memberships"; tokens: readonly string[] };

// The `scope` a selection writes. `all` is both axes' `all`: every tracked
// Membership AND the Unknown ones (rows with no Account). A list is strict: it
// holds exactly the Memberships it names, Unknown only where named (#635).
// So a list that names every tracked Membership is NOT collapsed into `all`:
// the two answer differently whenever there is usage of an Account not known,
// and the menu keeps them distinct. An empty list is written as
// `[MEMBERSHIP_NONE]`, the empty Scope, since an absent list is the default.
export function scopeForSelection(selection: ScopeSelection): ScopeSetting | null {
  switch (selection.kind) {
    case "default":
      return null;
    case "all":
      return { account: [SCOPE_ALL], organization: [SCOPE_ALL] };
    case "memberships": {
      const tokens = [...new Set(selection.tokens)].filter((t) => t !== MEMBERSHIP_NONE).sort();
      return { membership: tokens.length === 0 ? [MEMBERSHIP_NONE] : tokens };
    }
  }
}

// The tracked Memberships a Scope holds, for display: the default Scope's Home
// membership, all accounts' every tracked Membership, a list's listed ones
// that are tracked, and an axis-named Scope (a released file's Organization
// scope) the ones its axes reach. Resolved by the shared rule against
// settings, so the menu shows what the sidecar sums, Unknown aside.
export function selectedMemberships(
  scope: ScopeSetting | null,
  memberships: readonly TrackedMembership[],
  settings: Omit<ScopeSettings, "scope">,
): TrackedMembership[] {
  const resolved = resolvedScopeOf(scope, settings);
  return memberships.filter((m) => scopeHasMembership(resolved, m.organizationUuid, m.accountKey));
}

// A persisted Scope resolved by the shared rule against settings, as the
// sidecar resolves the same tokens against the same file.
export function resolvedScopeOf(
  scope: ScopeSetting | null,
  settings: Omit<ScopeSettings, "scope">,
): ResolvedScope {
  const params = scopeQueryParams(scope);
  return resolveScope(
    params.account ?? [],
    params.organization ?? [],
    scopeStateOf(settings),
    params.memberships ?? [],
  );
}

// --- Settings transitions ----------------------------------------------------

// The persisted Scope after a settings write (`useUpdateSettings`), against
// the tracked sets that write leaves: every token naming an Organization or
// Account that is no longer tracked is dropped, so excluding an Organization
// or an Account rewrites the selection that named it. A list or axis that
// loses every token returns the whole Scope to the default (null) rather than
// widening: an axis left empty would match any value, and a Membership list
// left empty would be the empty Scope. `all`, `home`, a malformed token and
// `MEMBERSHIP_NONE` are kept as written. The same value is returned when
// nothing is dropped, so an unrelated write leaves the selection alone.
//
// Only the persisted selection is pruned: the wire stays strict (#635). A
// request naming an Account this machine no longer tracks still matches that
// Account alone, and a hand-edited file keeps its stale token until the next
// write. With no Home nothing is excluded on the Organization level, and with
// no `trackedAccounts` nothing on the Account level (ADR-0098's null sets).
export function pruneScope(
  scope: ScopeSetting | null,
  settings: Omit<ScopeSettings, "scope">,
): ScopeSetting | null {
  if (scope === null) return null;
  const organizations = trackedOrganizationSet(settings);
  const accounts = trackedAccountSet(settings);
  const organizationKept = (token: string): boolean =>
    !isKey(token) || organizations === null || organizations.has(token);
  const accountKept = (token: string): boolean =>
    !isKey(token) || accounts === null || accounts.has(token);
  const membershipKept = (token: string): boolean => {
    const m = parseMembershipToken(token);
    if (m === null) return true;
    return (
      organizationKept(m.organizationUuid) && (m.accountUuid === null || accountKept(m.accountUuid))
    );
  };

  let changed = false;
  const next: ScopeSetting = {};
  const prune = (field: keyof ScopeSetting, kept: (token: string) => boolean): boolean => {
    const list = scope[field];
    if (list === undefined) return true;
    const out = list.filter(kept);
    if (out.length !== list.length) changed = true;
    if (out.length === 0) return false;
    next[field] = out;
    return true;
  };
  const survives =
    prune("account", accountKept) &&
    prune("organization", organizationKept) &&
    prune("membership", membershipKept);
  if (!changed) return scope;
  return survives ? next : null;
}
