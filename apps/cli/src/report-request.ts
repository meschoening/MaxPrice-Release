import { posix } from "node:path";
import {
  type AccountEntry,
  accountFilterSummary,
  accountFilterVisible,
  ACCOUNTS_PATH,
  type AccountsResponse,
  accountsResponseSchema,
  buildIdentityIndex,
  buildReportUrl,
  buildScopeHeadUrl,
  buildUsageCurrentUrl,
  deriveProjectName,
  expandMachineFilter,
  expandProjectFilter,
  foldMachines,
  foldProjectRows,
  type HomeMembership,
  homeMembershipOf,
  type IdentityIndex,
  isMultiOrganization,
  isoFromYmd,
  machineUiEnabled,
  MODEL_LEGEND_ORDER,
  normalize,
  organizationLabel,
  organizationLabelMap,
  ORGANIZATIONS_PATH,
  organizationsResponseSchema,
  parentProjectSlug,
  PROJECT_IDENTITY_PATH,
  type ProjectGroup,
  projectsResponseSchema,
  RANGE_LABEL,
  type ReportQueryInput,
  type ResolvedScope,
  resolveDateRange,
  resolveScope,
  resolveWeekWindow,
  SCOPE_ALL,
  SCOPE_HOME,
  scopeHasMembership,
  scopeHeadResponseSchema,
  scopeMembershipSet,
  type ScopeQueryParams,
  scopeStateOf,
  type ScopeState,
  type Settings,
  settledHeadOrganization,
  shortMachineId,
  type SidecarMachinesResponse,
  sidecarMachinesResponseSchema,
  sidecarProjectIdentityResponseSchema,
  slugFromPath,
  type OrganizationEntry,
  type TrackedMembership,
  trackedAccountSet,
  trackedScopeMemberships,
  usageCurrentSchema,
} from "@maxprice/shared";
import { type Daemon, type Stderr, waitForStatus } from "./daemon-client";
import { CliError, EXIT, usageError } from "./exit";
import {
  accountArgument,
  organizationArgument,
  resolveAccount,
  resolveName,
  resolveOrganization,
  shellWord,
} from "./names";
import { type Env, home as homeDir } from "./paths";
import type { ReportContext } from "./render/table";

// The flags every report shares (`--since`, `--until`, `--model`,
// `--project`, `--machine`, `--account`, `--org`, `--json`), turned into the
// filter state the Desktop's shared URL builders take (ADR-0118 §7): the same
// since/until, `mode`, `tz`, project, model, machine, `account` and
// `organization` values the renderer would send for the same selection, so a
// report's route answers exactly what it answers the Desktop.
//
// - The range defaults to this week, following the Week setting.
// - The Scope defaults to the Home membership (ADR-0136 §5): no Scope param.
//   The Desktop's persisted `scope` is never read (ADR-0122 §4); `--account`
//   and `--org` name one invocation's (ADR-0140 §1).
// - The time zone is the `timezone` setting, or the invoking shell's when it
//   is unset (ADR-0122 §2; `parseSettings` resolves it in this process).
//
// The request also carries what the reports render with: the resolved Scope
// and its Memberships, the header's scope label, the Organization and
// Account labels, and, when the report asks for them, the Machine directory
// and the Identity directory's index. Each is read at most once, and
// `--machine` and `--project` resolve against the same reading.

export type ReportFlags = {
  // YYYYMMDD local dates; null when neither flag is given, which is this week.
  range: { since?: string; until?: string } | null;
  // Model families, as the Desktop's model filter holds them.
  models: string[];
  projects: string[];
  machines: string[];
  // The Scope's two axes as named (ADR-0140 §1): `all`, `home` or a name,
  // each list in the order given, repeats dropped; empty when unnamed.
  accounts: string[];
  orgs: string[];
  json: boolean;
};

// The Scope half of a report's request (ADR-0140 §1): the params the routes
// take for it, what it resolves to, and what the reports render it with.
export type ScopeRequest = {
  // The daemon's Organization roster, or empty when nothing needed it.
  roster: readonly OrganizationEntry[];
  // Whether more than one Organization is tracked.
  multi: boolean;
  // GET /api/accounts, read when `--account` names an Account or settings
  // track two or more Accounts; null otherwise. Its tracked entries decide
  // the multi-Membership world (`multiAccount`).
  accounts: AccountsResponse | null;
  // That answer's body as the daemon sent it, for a `--json` that prints
  // what it read (`live`'s); null when it was not read.
  accountsText: string | null;
  // Two or more Accounts are tracked (`accountFilterVisible`): the Desktop
  // shows its Account filter, and the per-Membership views switch on.
  multiAccount: boolean;
  // The routes' Scope params: the Account keys and Organization uuids the
  // flags name, `all` and `home` as given, sent only when they name another
  // Scope than the default, so no flag and every spelling of the Home
  // membership send none.
  params: Pick<ScopeQueryParams, "account" | "organization">;
  // What the Scope resolves against, and to, by the daemon's own rule
  // (`resolveScope`).
  state: ScopeState;
  scope: ResolvedScope;
  // The Scope's tracked Memberships while two or more Accounts are tracked
  // (`scopeMembershipSet`), most-used ordering's input; empty otherwise, as
  // on the Desktop.
  memberships: TrackedMembership[];
  // The Account labels by key; empty when /api/accounts was not read.
  accountLabels: ReadonlyMap<string, string>;
  // The Scope's head Organization (`scope-head.ts`): whose usage current
  // and Blocks a one-Membership surface reads. Undefined with no Home.
  quotaOrganization: string | undefined;
  // The Scope holds every tracked Membership, and more than one.
  isAll: boolean;
  // The Scope spans two or more Organizations (`spansOrganizations`): the
  // Organization(s) column of `projects` and `sessions` shows.
  spansOrganizations: boolean;
  // The header's scope label, or null while one Organization and one
  // Account are tracked.
  scopeLabel: string | null;
};

export type ReportRequest = {
  input: ReportQueryInput;
  // The header's range label.
  rangeLabel: string;
  // The header's scope label, or null while one Organization and one
  // Account are tracked.
  scopeLabel: string | null;
  // The Scope holds every tracked Membership; over a one-member tracked set,
  // All is Home.
  isAll: boolean;
  // The Scope spans two or more Organizations: the Organization(s) column
  // shows (ADR-0140 §3).
  spansOrganizations: boolean;
  // Under All, the label of the Home membership's Organization, which a
  // quota-shaped report's header names (ADR-0108: its Blocks are Home's).
  // Null otherwise: a scoped Organization's quota is its own, and the scope
  // label already names it.
  quotaLabel: string | null;
  // The roster's Organization labels by uuid; empty when no roster was read.
  labels: ReadonlyMap<string, string>;
  // The daemon's Organization roster (plans and Window states), or empty
  // when nothing needed it.
  roster: readonly OrganizationEntry[];
  // The Scope as `ScopeRequest` holds it: the resolved Scope, what it
  // resolved against, its tracked Memberships (empty unless two or more
  // Accounts are tracked), the Account labels by key and /api/accounts'
  // answer when it was read, and its head Organization.
  scope: ResolvedScope;
  scopeState: ScopeState;
  memberships: TrackedMembership[];
  multiAccount: boolean;
  accountLabels: ReadonlyMap<string, string>;
  accounts: AccountsResponse | null;
  quotaOrganization: string | undefined;
  // The Machine directory while the machine axis is on and the report or
  // `--machine` needed it; null otherwise.
  machines: SidecarMachinesResponse | null;
  // The Identity directory's index once the probes have settled, when the
  // report or `--project` needed it; null otherwise.
  identity: IdentityIndex | null;
};

// What a report reads beyond its filter state.
export type ReportRequestOptions = {
  // The Machine directory, for a Machine column while the machine axis is on.
  machineDirectory?: boolean;
  // The Identity directory's index, to fold projects.
  identity?: boolean;
};

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function strings(value: unknown): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as string[]) : [value as string];
}

const DATE = /^(\d{4})(\d{2})(\d{2})$|^(\d{4})-(\d{2})-(\d{2})$/;

// `YYYYMMDD` or `YYYY-MM-DD`, a real calendar date, as the YYYYMMDD local
// date the routes take.
function parseDate(flag: string, value: string, help: string): string {
  const m = DATE.exec(value);
  const [y, mo, d] = m === null ? [] : m[1] ? [m[1], m[2], m[3]] : [m[4], m[5], m[6]];
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (
    m === null ||
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(mo) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    throw usageError(`${flag} takes a date, YYYYMMDD or YYYY-MM-DD: '${value}'`, help);
  }
  return `${y}${mo}${d}`;
}

function parseModel(value: string, help: string): string {
  const family = MODEL_LEGEND_ORDER.find((f) => f.toLowerCase() === value.toLowerCase());
  if (family === undefined) {
    throw usageError(
      `--model takes a model family, one of ${MODEL_LEGEND_ORDER.join(", ")}: '${value}'`,
      help,
    );
  }
  return family;
}

function nonEmpty(flag: string, values: string[], help: string): string[] {
  if (values.some((v) => v === "")) throw usageError(`${flag} takes a name`, help);
  return values;
}

// Every check that needs no daemon, so a bad flag exits 2 before connecting.
// `help` is the command's help, which a usage error names.
export function parseReportFlags(values: Record<string, unknown>, help: string): ReportFlags {
  const since =
    values.since === undefined ? undefined : parseDate("--since", values.since as string, help);
  const until =
    values.until === undefined ? undefined : parseDate("--until", values.until as string, help);
  if (since !== undefined && until !== undefined && until < since) {
    throw usageError(`--until ${isoFromYmd(until)} is before --since ${isoFromYmd(since)}`, help);
  }
  return {
    range:
      since === undefined && until === undefined
        ? null
        : { ...(since === undefined ? {} : { since }), ...(until === undefined ? {} : { until }) },
    models: unique(strings(values.model).map((m) => parseModel(m, help))),
    projects: unique(nonEmpty("--project", strings(values.project), help)),
    machines: unique(nonEmpty("--machine", strings(values.machine), help)),
    accounts: unique(nonEmpty("--account", strings(values.account), help)),
    orgs: unique(nonEmpty("--org", strings(values.org), help)),
    json: values.json === true,
  };
}

// The header's range label: the Desktop's `RANGE_LABEL` for this week, else
// the flags' own dates.
export function rangeLabel(range: ReportFlags["range"]): string {
  if (range === null) return RANGE_LABEL.week;
  const { since, until } = range;
  if (since !== undefined && until !== undefined) {
    return since === until ? isoFromYmd(since) : `${isoFromYmd(since)} – ${isoFromYmd(until)}`;
  }
  return since !== undefined ? `since ${isoFromYmd(since)}` : `through ${isoFromYmd(until!)}`;
}

// This week as the Desktop resolves it (`useWeekWindow`): the Week setting,
// anchored on the Quota organization's weekly reset in limit-reset mode.
async function thisWeek(
  daemon: Daemon,
  settings: Settings,
  quotaOrganization: string | undefined,
  now: number,
  stderr: Stderr,
): Promise<{ since?: string; until?: string }> {
  const tz = settings.timezone;
  if (settings.week.mode === "limitReset") await waitForUsageHistory(daemon, stderr);
  const resetAt =
    settings.week.mode === "limitReset"
      ? (await daemon.request(buildUsageCurrentUrl("", quotaOrganization), usageCurrentSchema)).data
          .weeklyResetAt
      : null;
  return resolveDateRange("week", tz, resolveWeekWindow(settings.week, resetAt, now, tz));
}

function isPath(value: string): boolean {
  // Neither a folder name nor a Claude Code slug can contain a POSIX separator.
  return value.includes("/") || value === "~" || value === "." || value === "..";
}

// A project's directory as the parent slug the Desktop's project filter holds
// (ADR-0061): a worktree's path names its project. The Headless client runs
// on Linux, so the path is a POSIX one, wherever its pure tests run.
function projectSlugOfPath(path: string, env: Env): string {
  const expanded = path === "~" || path.startsWith("~/") ? homeDir(env) + path.slice(1) : path;
  return parentProjectSlug(slugFromPath(posix.resolve(expanded)));
}

// A project by its path (`/…`, `~/…`, `./…`, `repos/foo`), its slug, or its folder name
// among the projects with usage in this range, which are the Desktop's
// project filter options (`buildProjectOptions` folds the same rows).
function resolveProject(value: string, groups: readonly ProjectGroup[], env: Env): string {
  if (isPath(value)) return projectSlugOfPath(value, env);
  const bySlug = groups.find((g) => g.row.slug === value);
  if (bySlug !== undefined) return bySlug.row.slug;
  const named = groups.filter((g) => deriveProjectName(g.row.path) === value);
  if (named.length === 1) return named[0]!.row.slug;
  if (named.length > 1) {
    throw new CliError(
      EXIT.USAGE,
      `'${value}' names ${named.length} projects; give its path`,
      named.map((g) => g.row.path),
    );
  }
  throw new CliError(EXIT.USAGE, `no project named '${value}' has usage in this range`, [
    "A project's path names it whether or not it has usage in the range.",
  ]);
}

// First history load only, including failure/absence. Unlike identity probes,
// this flag is never cleared, so connect's settled snapshot is sufficient.
export async function waitForUsageHistory(daemon: Daemon, stderr: Stderr): Promise<void> {
  if (!daemon.status.usageHistoryReady) {
    await waitForStatus(daemon, "usageHistoryReady", "loading usage history…", stderr);
  }
}

// The Identity directory's index, once this machine's identity probes have
// settled (#464).
async function settledIdentity(daemon: Daemon, stderr: Stderr): Promise<IdentityIndex> {
  // Always refresh: a watcher/rescan probe can start after connect's snapshot.
  // Each path has the prober's 30s deadline; whole rounds scale with path count.
  await waitForStatus(daemon, "identityReady", "probing project identity…", stderr);
  const identity = (
    await daemon.request(PROJECT_IDENTITY_PATH, sidecarProjectIdentityResponseSchema)
  ).data;
  return buildIdentityIndex(identity.rows, identity.self, identity.assertions);
}

async function projectParams(
  values: readonly string[],
  index: IdentityIndex,
  daemon: Daemon,
  range: { since?: string; until?: string },
  scope: Pick<ReportQueryInput, "mode" | "tz" | "account" | "organization">,
  env: Env,
): Promise<string[]> {
  if (values.length === 0) return [];
  const groups = values.every(isPath)
    ? []
    : foldProjectRows(
        (
          await daemon.request(
            buildReportUrl("/api/projects", normalize({ ...range, ...scope })),
            projectsResponseSchema,
          )
        ).data.projects,
        index,
      );
  // ADR-0062: the selection widened across Repo identity, as `useProjectAxis` does.
  return expandProjectFilter(
    unique(values.map((value) => resolveProject(value, groups, env))),
    index,
  );
}

// The Machine directory, read only while the machine axis is on, as
// `useMachineAxis` reads it, and only when the report or `--machine` needs
// it. `--machine` with the axis off is refused.
async function machineDirectory(
  values: readonly string[],
  needed: boolean,
  daemon: Daemon,
  settings: Settings,
): Promise<SidecarMachinesResponse | null> {
  const on = machineUiEnabled({
    hubFleetReplica: settings.hubFleetReplica,
    hubUrl: settings.hubUrl,
    hubConnection: daemon.status.hubConnection,
  });
  if (!on && values.length > 0) {
    throw new CliError(
      EXIT.USAGE,
      "--machine needs the Fleet replica, which is off here: no Hub is joined, or fleet-replica is off",
    );
  }
  if (!on || (!needed && values.length === 0)) return null;
  return (await daemon.request("/api/machines", sidecarMachinesResponseSchema)).data;
}

// The machine filter, as `useMachineAxis` builds it: widened across merge
// aliases (ADR-0041).
function machineParams(values: readonly string[], directory: SidecarMachinesResponse): string[] {
  if (values.length === 0) return [];
  const folded = foldMachines(directory.machines, directory.self);
  const ids = values.map(
    (value) =>
      resolveName(value, folded, {
        noun: "machine",
        id: (m) => m.machineId,
        label: (m) => m.name,
        describe: (m) => `${m.name}  ${shortMachineId(m.machineId)}`,
      }).machineId,
  );
  return expandMachineFilter(unique(ids), directory.machines);
}

// --- The Scope (ADR-0140 §1, §2) ---------------------------------------------

const isToken = (name: string): boolean => name === SCOPE_ALL || name === SCOPE_HOME;

// What a Scope resolves against, as the daemon resolves it against the same
// file (`scopeStateOf`, the Desktop's rule): the Home membership, the daemon's
// while the file names none yet, and the tracked sets. Before the file names
// `trackedAccounts`, the daemon's own tracked Accounts, when read.
function scopeStateFor(
  settings: Settings,
  home: HomeMembership | null,
  accounts: AccountsResponse | null,
): ScopeState {
  const state = scopeStateOf(settings, home);
  const reported =
    accounts === null
      ? null
      : new Set(accounts.accounts.filter((a) => a.tracked).map((a) => a.key));
  return { ...state, trackedAccounts: state.trackedAccounts ?? reported };
}

// `<label> is excluded`, with the command that tracks it (ADR-0140 §1).
function excluded(label: string, command: string): CliError {
  return new CliError(EXIT.USAGE, `${label} is excluded`, [{ label: "Track it:", command }]);
}

// One `--org` as the routes' token: `all`, `home`, or a Tracked
// organization's uuid. An Organization that is not tracked here exits 2
// rather than read as Home the way the route's own resolution would; with
// no Home nothing is tracked to narrow to.
function organizationToken(
  name: string,
  roster: readonly OrganizationEntry[],
  state: ScopeState,
): string {
  if (isToken(name)) return name;
  const entry = resolveOrganization(name, roster);
  const label = organizationLabel(organizationLabelMap(roster), entry.uuid);
  if (state.trackedOrganizations === null) {
    throw new CliError(EXIT.USAGE, `${label} is not a Tracked organization on this machine`);
  }
  if (!state.trackedOrganizations.has(entry.uuid)) {
    throw excluded(label, `maxprice org track ${organizationArgument(entry, roster)}`);
  }
  return entry.uuid;
}

// One `--account` as the routes' token: `all`, `home`, or a tracked
// Account's key (its uuid, or a Pending account's `pending:<hash>`).
function accountToken(name: string, accounts: readonly AccountEntry[]): string {
  if (isToken(name)) return name;
  const entry = resolveAccount(name, accounts);
  if (!entry.tracked) {
    throw excluded(entry.label, `maxprice account track ${accountArgument(entry, accounts)}`);
  }
  return entry.key;
}

// An axis's tokens as sent: `all` alone when it is among them, since it
// already holds every other; otherwise each once, in order.
function axisTokens(tokens: readonly string[]): string[] {
  return tokens.includes(SCOPE_ALL) ? [SCOPE_ALL] : unique(tokens);
}

function sameScope(a: ResolvedScope, b: ResolvedScope): boolean {
  return (
    a.unknownAccount === b.unknownAccount &&
    a.organizations.join() === b.organizations.join() &&
    a.accounts.join() === b.accounts.join()
  );
}

// The flags as typed, for an error that names them.
export function scopeFlagsText(flags: Pick<ReportFlags, "accounts" | "orgs">): string {
  return [
    ...flags.accounts.map((a) => `--account ${shellWord(a)}`),
    ...flags.orgs.map((o) => `--org ${shellWord(o)}`),
  ].join(" ");
}

// Every tracked Organization is on the Scope's Organization axis.
function everyOrganization(scope: ResolvedScope, state: ScopeState): boolean {
  if (scope.organizations.length === 0) return true;
  const tracked = state.trackedOrganizations;
  return tracked !== null && [...tracked].every((uuid) => scope.organizations.includes(uuid));
}

// Whether the Scope spans two or more Organizations (ADR-0140 §3): while two
// or more Accounts are tracked, its Memberships do; otherwise, with no
// Membership set to read, its Organization axis covers two or more tracked
// Organizations, every one when it is left any or names `all`. So a
// one-Account install shows the column under `--org all` exactly as it did,
// and never under no flag, `--org home` or one `--org`.
function spansOrganizationsOf(
  scope: ResolvedScope,
  state: ScopeState,
  multi: boolean,
  multiAccount: boolean,
  memberships: readonly TrackedMembership[],
): boolean {
  if (multiAccount) return new Set(memberships.map((m) => m.organizationUuid)).size >= 2;
  return everyOrganization(scope, state) ? multi : scope.organizations.length >= 2;
}

// The header's label for a Scope's Memberships while two or more Accounts
// are tracked: the Desktop's Account filter trigger (`accountFilterSummary`)
// over the same selection, every tracked Account (in /api/accounts' order, as
// the menu lists them) with its tracked Memberships (`universe`).
function membershipsLabel(
  set: readonly TrackedMembership[],
  universe: readonly TrackedMembership[],
  accounts: readonly AccountEntry[],
  organizationLabels: ReadonlyMap<string, string>,
  isAll: boolean,
  unknown: boolean,
): string {
  const tokens = new Set(set.map((m) => m.token));
  return accountFilterSummary(
    accounts
      .filter((a) => a.tracked)
      .map((a) => ({
        label: a.label,
        memberships: universe
          .filter((m) => m.accountKey === a.key)
          .map((m) => ({
            label: organizationLabel(organizationLabels, m.organizationUuid),
            selected: tokens.has(m.token),
          })),
      })),
    isAll,
    unknown,
  );
}

// The header's label for a one-Account install's Scope, by its Organization
// axis alone, as the topbar's Organization chip names it: null while
// one Organization is tracked, All organizations, or the Organizations named.
function organizationsLabel(
  scope: ResolvedScope,
  state: ScopeState,
  multi: boolean,
  isAll: boolean,
  labels: ReadonlyMap<string, string>,
): string | null {
  if (!multi) return null;
  if (isAll || everyOrganization(scope, state)) return "All organizations";
  const named = scope.organizations.map((uuid) => organizationLabel(labels, uuid));
  if (named.length <= 2) return named.join(", ");
  return `${named.length} organizations`;
}

// The Scope `--account` and `--org` name (ADR-0140 §1), as the routes take
// it, checked before anything is asked: a name that matches no Account or
// Organization, or several, an excluded one, and a Scope that holds no
// tracked Membership each exit 2. The Organization roster is read only when
// something needs it, and /api/accounts only for an `--account` name or
// where settings track two or more Accounts, so a one-Account install asks
// what it always asked.
export async function resolveScopeRequest(
  flags: Pick<ReportFlags, "accounts" | "orgs">,
  daemon: Daemon,
  settings: Settings,
): Promise<ScopeRequest> {
  const fileHome = homeMembershipOf(settings);
  const readAccounts =
    flags.accounts.some((name) => !isToken(name)) || (trackedAccountSet(settings)?.size ?? 0) >= 2;
  // The roster supplies an unpersisted Home, and names Organizations for an
  // `--org` name or the header's labels. The daemon tracks Home plus the
  // persisted list, even before the seed has been saved.
  const reported =
    fileHome === null ||
    readAccounts ||
    flags.orgs.some((name) => !isToken(name)) ||
    isMultiOrganization(fileHome.organizationUuid, settings.trackedOrganizations)
      ? (await daemon.request(ORGANIZATIONS_PATH, organizationsResponseSchema)).data
      : null;
  const accountsAnswer = readAccounts
    ? await daemon.request(ACCOUNTS_PATH, accountsResponseSchema)
    : null;
  const accounts = accountsAnswer?.data ?? null;
  const home: HomeMembership | null =
    fileHome ??
    (reported?.home == null ? null : { organizationUuid: reported.home, accountUuid: null });
  const roster = reported?.organizations ?? [];
  const labels = organizationLabelMap(roster);
  const multi = isMultiOrganization(home?.organizationUuid, settings.trackedOrganizations);
  const multiAccount = accounts !== null && accountFilterVisible(accounts.accounts);
  const state = scopeStateFor(settings, home, accounts);

  const account = axisTokens(
    flags.accounts.map((name) => accountToken(name, accounts?.accounts ?? [])),
  );
  const organization = axisTokens(flags.orgs.map((name) => organizationToken(name, roster, state)));
  const scope = resolveScope(account, organization, state);
  // Every spelling of the default Scope sends what no flag sends.
  const named = !sameScope(scope, resolveScope([], [], state));
  const params: ScopeRequest["params"] = !named
    ? {}
    : {
        ...(account.length === 0 ? {} : { account }),
        ...(organization.length === 0 ? {} : { organization }),
      };

  // A Scope of Account keys alone holds no usage whose Account is not known,
  // so it must hold a tracked Membership (ADR-0140 §1); any other holds that
  // usage, as the default does.
  const universe = accounts === null ? [] : trackedScopeMemberships(accounts.accounts, state);
  if (
    !scope.unknownAccount &&
    !universe.some((m) => scopeHasMembership(scope, m.organizationUuid, m.accountKey))
  ) {
    throw new CliError(EXIT.USAGE, `no tracked Membership matches ${scopeFlagsText(flags)}`);
  }

  const memberships = accounts === null ? [] : scopeMembershipSet(accounts.accounts, state, scope);
  const accountLabels = new Map(accounts?.accounts.map((a) => [a.key, a.label]) ?? []);
  // The head (`scope-head.ts`): settled by settings for the common Scopes,
  // else the daemon's answer for the same params, as the Desktop asks it.
  const settled = settledHeadOrganization(scope, home);
  const quotaOrganization =
    settled !== undefined
      ? (settled ?? undefined)
      : ((await daemon.request(buildScopeHeadUrl("", params), scopeHeadResponseSchema)).data
          .organizationUuid ?? undefined);
  const isAll =
    named &&
    everyOrganization(scope, state) &&
    (scope.accounts.length === 0 || !multiAccount) &&
    (multi || multiAccount);
  return {
    roster,
    multi,
    accounts,
    accountsText: accountsAnswer?.text ?? null,
    multiAccount,
    params,
    state,
    scope,
    memberships,
    accountLabels,
    quotaOrganization,
    isAll,
    spansOrganizations: spansOrganizationsOf(scope, state, multi, multiAccount, memberships),
    scopeLabel: multiAccount
      ? membershipsLabel(
          memberships,
          universe,
          accounts?.accounts ?? [],
          labels,
          isAll,
          scope.unknownAccount,
        )
      : organizationsLabel(scope, state, multi, isAll, labels),
  };
}

export async function resolveReportRequest(
  flags: ReportFlags,
  daemon: Daemon,
  settings: Settings,
  env: Env,
  now: number = Date.now(),
  stderr: Stderr = process.stderr,
  options: ReportRequestOptions = {},
): Promise<ReportRequest> {
  const scope = await resolveScopeRequest(flags, daemon, settings);
  const { multi, quotaOrganization, isAll } = scope;
  const labels = organizationLabelMap(scope.roster);

  const range = flags.range ?? (await thisWeek(daemon, settings, quotaOrganization, now, stderr));
  const filter = { mode: settings.costMode, tz: settings.timezone, ...scope.params };
  const identity =
    options.identity === true || flags.projects.length > 0
      ? await settledIdentity(daemon, stderr)
      : null;
  const projects =
    identity === null
      ? []
      : await projectParams(flags.projects, identity, daemon, range, filter, env);
  const machines = await machineDirectory(
    flags.machines,
    options.machineDirectory === true,
    daemon,
    settings,
  );
  const input: ReportQueryInput = {
    ...range,
    ...filter,
    projects,
    models: flags.models,
    machines: machines === null ? [] : machineParams(flags.machines, machines),
  };
  return {
    input,
    rangeLabel: rangeLabel(flags.range),
    scopeLabel: scope.scopeLabel,
    isAll,
    spansOrganizations: scope.spansOrganizations,
    // More than one Organization tracked means a Home, so under All the Home
    // membership's Organization, the head, is known.
    quotaLabel: multi && isAll ? organizationLabel(labels, quotaOrganization!) : null,
    labels,
    roster: scope.roster,
    scope: scope.scope,
    scopeState: scope.state,
    memberships: scope.memberships,
    multiAccount: scope.multiAccount,
    accountLabels: scope.accountLabels,
    accounts: scope.accounts,
    quotaOrganization,
    machines,
    identity,
  };
}

// What a table report renders with besides its rows, from the resolved
// request: `now` is the instant that decides today for Last activity.
export function reportContext(request: ReportRequest, now: number): ReportContext {
  return {
    rangeLabel: request.rangeLabel,
    scopeLabel: request.scopeLabel,
    tz: request.input.tz,
    now,
    spansOrganizations: request.spansOrganizations,
    labels: request.labels,
    machines: request.machines?.machines ?? null,
  };
}
