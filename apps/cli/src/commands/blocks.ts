import { blocksResponseSchema, buildReportUrl, normalize } from "@maxprice/shared";
import { connect } from "../daemon-client";
import { EXIT } from "../exit";
import type { Io, Parsed } from "../main";
import type { Env } from "../paths";
import { renderBlocks } from "../render/blocks";
import { terminalOutput } from "../render/table";
import { parseReportFlags, resolveReportRequest, waitForUsageHistory } from "../report-request";
import { readSettings } from "../settings";

// `maxprice blocks`: `/api/blocks` for the shared report flags, as the
// Desktop's Blocks page requests it (`useBlocks`), printed as a table, or
// under `--json` as the route's response, byte for byte. Blocks are
// cross-project (ADR-0017): the page sends no projects, so the command takes
// no `--project`.

export const BLOCKS_HELP_REF = "maxprice blocks --help";

export async function blocks(parsed: Parsed, io: Io, env: Env = process.env): Promise<number> {
  const flags = parseReportFlags(parsed.values, BLOCKS_HELP_REF);
  const daemon = await connect({ env, report: true, stderr: io.stderr });
  const settings = readSettings(env);
  const request = await resolveReportRequest(flags, daemon, settings, env, undefined, io.stderr);
  await waitForUsageHistory(daemon, io.stderr);
  // The URL carries no project: blocks offers no `--project`, so
  // `input.projects` is empty, as the Desktop's Blocks page sends none.
  const { data, text } = await daemon.request(
    buildReportUrl("/api/blocks", normalize(request.input)),
    blocksResponseSchema,
  );
  if (flags.json) {
    io.stdout.write(text);
    return EXIT.OK;
  }
  io.stdout.write(
    renderBlocks(
      {
        rows: data.blocks,
        rangeLabel: request.rangeLabel,
        scopeLabel: request.scopeLabel,
        quotaLabel: request.quotaLabel,
        display: { tz: settings.timezone, timeFormat: settings.timeFormat },
        now: Date.now(),
      },
      terminalOutput(io.stdout, env),
    ),
  );
  return EXIT.OK;
}
