import { posix } from "node:path";
import {
  ALL_ORGANIZATIONS,
  buildIdentityIndex,
  buildReportUrl,
  buildUsageCurrentUrl,
  deriveProjectName,
  expandMachineFilter,
  expandProjectFilter,
  foldMachines,
  foldProjectRows,
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
  resolveDateRange,
  resolveOrganizationScope,
  resolveWeekWindow,
  scopeParams,
  type Settings,
  shortMachineId,
  type SidecarMachinesResponse,
  sidecarMachinesResponseSchema,
  sidecarProjectIdentityResponseSchema,
  slugFromPath,
  type OrganizationEntry,
  usageCurrentSchema,
} from "@maxprice/shared";
import { type Daemon, type Stderr, waitForStatus } from "./daemon-client";
import { CliError, EXIT, usageError } from "./exit";
import { resolveName, resolveOrganization } from "./names";
import { type Env, home as homeDir } from "./paths";
import type { ReportContext } from "./render/table";

// The flags every report shares (`--since`, `--until`, `--model`,
// `--project`, `--machine`, `--org`, `--json`), turned into the filter state
// the Desktop's shared URL builders take (ADR-0118 §7): the same since/until,
// `mode`, `tz`, project, model, machine and `organization` values the renderer
// would send for the same selection, so a report's route answers exactly what
// it answers the Desktop.
//
// - The range defaults to this week, following the Week setting.
// - The Organization defaults to Home from settings, or the daemon's seeded
//   Home while none is persisted. `organizationScope` is never read
//   (ADR-0122 §4); `--org` narrows one invocation.
// - The time zone is the `timezone` setting, or the invoking shell's when it
//   is unset (ADR-0122 §2; `parseSettings` resolves it in this process).
//
// The request also carries what the table reports render with: whether the
// scope is All organizations, the Organization labels, and, when the report
// asks for them, the Machine directory and the Identity directory's index.
// Each is read at most once, and `--machine` and `--project` resolve against
// the same reading.

export type OrgFlag = { kind: "home" } | { kind: "all" } | { kind: "name"; name: string };

export type ReportFlags = {
  // YYYYMMDD local dates; null when neither flag is given, which is this week.
  range: { since?: string; until?: string } | null;
  // Model families, as the Desktop's model filter holds them.
  models: string[];
  projects: string[];
  machines: string[];
  org: OrgFlag;
  json: boolean;
};

// The Organization half of a report's request: the params the routes take
// for the resolved scope, and the header's label.
export type ScopeRequest = {
  // The daemon's roster, or empty when nothing needed it.
  roster: readonly OrganizationEntry[];
  // Whether more than one Organization is tracked.
  multi: boolean;
  // The routes' `organization` param, and the Quota organization (ADR-0108):
  // the scoped Organization, or Home under All organizations.
  organization: string | undefined;
  quotaOrganization: string | undefined;
  isAll: boolean;
  // The header's scope label, or null while only one Organization is tracked.
  scopeLabel: string | null;
};

export type ReportRequest = {
  input: ReportQueryInput;
  // The header's range label.
  rangeLabel: string;
  // The header's scope label, or null while only one Organization is tracked.
  scopeLabel: string | null;
  // The scope is All organizations; over a one-member tracked set, All is Home.
  isAll: boolean;
  // Under All organizations, the Quota organization's label, which a
  // quota-shaped report's header names (ADR-0108: its Blocks are Home's).
  // Null otherwise: a scoped Organization is its own Quota organization, and
  // the scope label already names it.
  quotaLabel: string | null;
  // The roster's Organization labels by uuid; empty when no roster was read.
  labels: ReadonlyMap<string, string>;
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

function parseOrg(value: unknown, help: string): OrgFlag {
  if (value === undefined || value === "home") return { kind: "home" };
  if (value === ALL_ORGANIZATIONS) return { kind: "all" };
  if (value === "") throw usageError("--org takes a name", help);
  return { kind: "name", name: value as string };
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
    org: parseOrg(values.org, help),
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

// The resolved Organization scope (`null` is Home), as `parseSettings` would
// resolve a stored one: All over a one-member set is Home. An Organization
// that is not tracked here cannot be narrowed to, and says so rather than
// read as Home the way the route's own resolution would.
function resolveScope(
  flag: OrgFlag,
  home: string | null,
  tracked: readonly string[],
  roster: readonly OrganizationEntry[],
): string | null {
  if (flag.kind === "home") return null;
  if (flag.kind === "all") return resolveOrganizationScope(ALL_ORGANIZATIONS, home, tracked);
  const entry = resolveOrganization(flag.name, roster);
  if (entry.uuid === home) return null;
  const scope = resolveOrganizationScope(entry.uuid, home, tracked);
  if (scope === null) {
    const label = organizationLabel(organizationLabelMap(roster), entry.uuid);
    throw new CliError(EXIT.USAGE, `${label} is not a Tracked organization on this machine`);
  }
  return scope;
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
  scope: Pick<ReportQueryInput, "mode" | "tz" | "organization">,
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

// The Organization `--org` names, as the routes take it. The roster is read
// only when something needs it.
export async function resolveScopeRequest(
  org: OrgFlag,
  daemon: Daemon,
  settings: Settings,
): Promise<ScopeRequest> {
  // The roster supplies an unpersisted Home, and names Organizations for a
  // `--org` name or the header's label. The daemon tracks Home plus the
  // persisted list, even before the seed has been saved.
  const reported =
    settings.homeOrganization === null ||
    org.kind === "name" ||
    isMultiOrganization(settings.homeOrganization, settings.trackedOrganizations)
      ? (await daemon.request(ORGANIZATIONS_PATH, organizationsResponseSchema)).data
      : null;
  const home = settings.homeOrganization ?? reported?.home ?? null;
  const roster = reported?.organizations ?? [];
  const multi = isMultiOrganization(home, settings.trackedOrganizations);
  const scope = resolveScope(org, home, settings.trackedOrganizations, roster);
  const { organization, quotaOrganization, isAll } = scopeParams(scope, home);
  return {
    roster,
    multi,
    organization,
    quotaOrganization,
    isAll,
    scopeLabel: !multi
      ? null
      : isAll
        ? "All organizations"
        : organizationLabel(organizationLabelMap(roster), scope ?? home!),
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
  const { roster, multi, organization, quotaOrganization, isAll, scopeLabel } =
    await resolveScopeRequest(flags.org, daemon, settings);
  const labels = organizationLabelMap(roster);

  const range = flags.range ?? (await thisWeek(daemon, settings, quotaOrganization, now, stderr));
  const filter = { mode: settings.costMode, tz: settings.timezone, organization };
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
    scopeLabel,
    isAll,
    // More than one Organization tracked means a Home, so under All the
    // Quota organization, Home, is known.
    quotaLabel: multi && isAll ? organizationLabel(labels, quotaOrganization!) : null,
    labels,
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
    isAll: request.isAll,
    labels: request.labels,
    machines: request.machines?.machines ?? null,
  };
}
