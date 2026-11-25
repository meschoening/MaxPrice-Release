import {
  buildReportUrl,
  buildUsageCurrentUrl,
  corpusIsEmpty,
  type DailyResponse,
  dailyResponseSchema,
  isoFromYmd,
  normalize,
  ORGANIZATIONS_PATH,
  type OrganizationEntry,
  organizationLabel,
  organizationLabelMap,
  organizationsResponseSchema,
  popoutQueryInputs,
  type StatusSnapshot,
  statusSnapshotSchema,
  usageCurrentSchema,
} from "@maxprice/shared";
import { connect, type Daemon } from "../daemon-client";
import { EXIT } from "../exit";
import type { Io, Parsed } from "../main";
import type { Env } from "../paths";
import { type LiveReport, renderLive, renderRankedLive } from "../render/live";
import { rankedMembershipRows } from "../render/membership-limits";
import { terminalOutput } from "../render/table";
import {
  parseReportFlags,
  resolveScopeRequest,
  type ScopeRequest,
  waitForUsageHistory,
} from "../report-request";
import { readSettings } from "../settings";

// `maxprice live`: one snapshot of what the tray popout reads, the limits
// first (ADR-0142 §2, §7). It asks the popout's own questions: Today's
// /api/daily under the scope (`popoutQueryInputs`), and the Head
// membership's usage current. It prints `Limits · <Organization> (<plan>)`, a
// line per window the plan reports, then Today; under `--json`, the two
// answers verbatim, `{"usage":…,"today":…}`. `--account` and `--org` are its
// only filters, as the popout has no filter rail.
//
// While the Scope holds two or more of the Memberships the Desktop's ranked
// Popout lists (`scopeMembershipSet`: two or more tracked Accounts), it asks
// that Popout's questions instead (#638): every Membership's reading off
// /api/accounts, which the Scope's resolution has read, and Today's
// /api/daily, but no usage current. It prints a Limits line per Membership,
// most used first, none folded (ADR-0140 §3), then Today; under `--json`,
// `{"accounts":…,"today":…}`.

export const LIVE_HELP_REF = "maxprice live --help";

const READY_POLL_MS = 100;

// The status once the engine's answers are final. Every report route waits
// for the engine's readiness, but `ready` is patched as that settles, so a
// status read just after the reports can still say false; it is read again
// until it says true. Like the scan wait, Ctrl-C ends this wait.
async function readyStatus(daemon: Daemon): Promise<StatusSnapshot> {
  for (;;) {
    const { data } = await daemon.request("/api/status", statusSnapshotSchema);
    if (data.ready) return data;
    await Bun.sleep(READY_POLL_MS);
  }
}

// Today's cost and tokens: the row whose date is today, never merely the
// first, as the popout picks it. The wire `date` is dashed YYYY-MM-DD,
// `todayYmd` dashless.
function todayOf(daily: DailyResponse, todayYmd: string) {
  const row = daily.daily.find((r) => r.date === isoFromYmd(todayYmd));
  return { cost: row?.totalCost ?? 0, tokens: row?.totalTokens ?? 0 };
}

export async function live(
  parsed: Parsed,
  io: Io,
  env: Env = process.env,
  now?: number,
): Promise<number> {
  const flags = parseReportFlags(parsed.values, LIVE_HELP_REF);
  const daemon = await connect({ env, report: true, stderr: io.stderr });
  const settings = readSettings(env);
  const scope = await resolveScopeRequest(flags, daemon, settings);
  await waitForUsageHistory(daemon, io.stderr);
  // Today is the day the requests are asked on; the panel is dated below,
  // once the answers are final, since a report can first wait out the scan.
  const inputs = popoutQueryInputs({
    mode: settings.costMode,
    tz: settings.timezone,
    scope: scope.params,
    now: now ?? Date.now(),
  });
  const todayUrl = buildReportUrl("/api/daily", normalize(inputs.today));
  const display = { tz: settings.timezone, timeFormat: settings.timeFormat };

  if (scope.memberships.length >= 2) {
    const today = await daemon.request(todayUrl, dailyResponseSchema);
    if (flags.json) {
      io.stdout.write(`{"accounts":${scope.accountsText},"today":${today.text}}`);
      return EXIT.OK;
    }
    const status = await readyStatus(daemon);
    const at = now ?? Date.now();
    io.stdout.write(
      renderRankedLive(
        {
          noData: corpusIsEmpty(status.ready, status.hasData),
          rows: rankedMembershipRows(
            scope.memberships,
            scope.accounts?.accounts ?? [],
            organizationLabelMap(scope.roster),
            at,
          ),
          roster: scope.roster,
          scopeLabel: scope.scopeLabel,
          today: todayOf(today.data, inputs.todayYmd),
          now: at,
          display,
        },
        terminalOutput(io.stdout, env),
      ),
    );
    return EXIT.OK;
  }

  const [today, usage] = await Promise.all([
    daemon.request(todayUrl, dailyResponseSchema),
    daemon.request(buildUsageCurrentUrl("", scope.quotaOrganization), usageCurrentSchema),
  ]);
  if (flags.json) {
    // No one route answers `live`, so its JSON is the two answers it read,
    // each as the daemon sent it.
    io.stdout.write(`{"usage":${usage.text},"today":${today.text}}`);
    return EXIT.OK;
  }

  const status = await readyStatus(daemon);
  const at = now ?? Date.now();
  const report: LiveReport = {
    noData: corpusIsEmpty(status.ready, status.hasData),
    organization: await headOrganization(daemon, scope),
    reading: usage.data.sample,
    connected: status.usageConnection === "connected",
    today: {
      // Under All organizations Today is every tracked Organization's day.
      label: scope.isAll ? "Today · all" : "Today",
      ...todayOf(today.data, inputs.todayYmd),
    },
    now: at,
    display,
  };
  io.stdout.write(renderLive(report, terminalOutput(io.stdout, env)));
  return EXIT.OK;
}

// The Head membership's Organization as the header names it: its label over
// the whole roster, its plan word and its Window states. The roster is read
// here when the Scope's resolution did not need it.
async function headOrganization(
  daemon: Daemon,
  scope: ScopeRequest,
): Promise<LiveReport["organization"]> {
  const uuid = scope.quotaOrganization;
  if (uuid === undefined) return null;
  const roster: readonly OrganizationEntry[] =
    scope.roster.length > 0
      ? scope.roster
      : (await daemon.request(ORGANIZATIONS_PATH, organizationsResponseSchema)).data.organizations;
  const entry = roster.find((o) => o.uuid === uuid);
  return {
    uuid,
    label: organizationLabel(organizationLabelMap(roster), uuid),
    plan: entry?.plan ?? null,
    windowStates: entry?.limits?.windowStates ?? null,
  };
}
