import {
  blocksResponseSchema,
  buildReportUrl,
  buildUsageCurrentUrl,
  dailyResponseSchema,
  normalize,
  popoutQueryInputs,
  popoutQuotaTag,
  popoutReadings,
  popoutView,
  type StatusSnapshot,
  statusSnapshotSchema,
  usageCurrentSchema,
} from "@maxprice/shared";
import { connect, type Daemon } from "../daemon-client";
import { CliError, EXIT } from "../exit";
import type { Io, Parsed } from "../main";
import type { Env } from "../paths";
import { renderLive } from "../render/live";
import { terminalOutput } from "../render/table";
import { parseReportFlags, resolveScopeRequest, waitForUsageHistory } from "../report-request";
import { readSettings } from "../settings";

// `maxprice live`: one snapshot of the tray popout. It asks the routes the
// popout's own questions (`popoutQueryInputs`): Today's /api/daily and the
// blocks window's /api/blocks under the scope, and the Quota organization's
// usage current. It reads the answers through the popout's `popoutReadings`
// and `popoutView`, so its numbers are the popout's, and prints #445's
// Variant A panel; under `--json`, the three answers verbatim in one object.
// `--org` is its only filter, as the popout has no filter rail.

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

export async function live(
  parsed: Parsed,
  io: Io,
  env: Env = process.env,
  now?: number,
): Promise<number> {
  const flags = parseReportFlags(parsed.values, LIVE_HELP_REF);
  const daemon = await connect({ env, report: true, stderr: io.stderr });
  const settings = readSettings(env);
  const scope = await resolveScopeRequest(flags.org, daemon, settings);
  await waitForUsageHistory(daemon, io.stderr);
  // Today is the day the requests are asked on; the panel is dated below,
  // once the answers are final, since a report can first wait out the scan.
  const asked = now ?? Date.now();
  const inputs = popoutQueryInputs({
    mode: settings.costMode,
    tz: settings.timezone,
    organization: scope.organization,
    now: asked,
  });
  const [today, blocks, usage] = await Promise.all([
    daemon.request(buildReportUrl("/api/daily", normalize(inputs.today)), dailyResponseSchema),
    daemon.request(buildReportUrl("/api/blocks", normalize(inputs.blocks)), blocksResponseSchema),
    daemon.request(buildUsageCurrentUrl("", scope.quotaOrganization), usageCurrentSchema),
  ]);
  if (flags.json) {
    // No one route answers `live`, so its JSON is the three answers it read,
    // each as the daemon sent it.
    io.stdout.write(`{"blocks":${blocks.text},"usage":${usage.text},"today":${today.text}}`);
    return EXIT.OK;
  }

  const status = await readyStatus(daemon);
  const at = now ?? Date.now();
  const readings = popoutReadings(
    { status, today: today.data, blocks: blocks.data, usage: usage.data },
    inputs.todayYmd,
    scope.quotaOrganization,
  );
  const display = { tz: settings.timezone, timeFormat: settings.timeFormat };
  const view = popoutView({
    anyError: false,
    engineStopped: false,
    settled: true,
    ...readings,
    // The wire alone decides the Model-scoped weekly limit's line here. The
    // Desktop's `showModelLimit` opt-in exists to size the popout's window,
    // which a terminal has not.
    showModelLimit: true,
    now: at,
    display,
    // More than one Organization tracked means the roster was read.
    quotaTag: popoutQuotaTag(scope.multi, scope.quotaOrganization, scope.roster),
    allOrganizations: scope.isAll,
  });
  // Neither can happen: every answer is in, `ready` is true, and a failed
  // request has already thrown.
  if (view.kind === "loading") {
    throw new CliError(EXIT.FAILURE, "the daemon has not finished its scan");
  }
  if (view.kind === "down") throw new CliError(EXIT.FAILURE, "the daemon is not answering");
  io.stdout.write(
    renderLive(
      {
        view,
        block: readings.block,
        fiveHour: readings.usageWindow,
        weekly: readings.weeklyWindow,
        now: at,
        display,
      },
      terminalOutput(io.stdout, env),
    ),
  );
  return EXIT.OK;
}
