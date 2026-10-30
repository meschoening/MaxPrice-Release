import { buildReportUrl, dailyResponseSchema, normalize } from "@maxprice/shared";
import { connect } from "../daemon-client";
import { EXIT } from "../exit";
import type { Io, Parsed } from "../main";
import type { Env } from "../paths";
import { renderDaily } from "../render/daily";
import { terminalOutput } from "../render/table";
import { parseReportFlags, resolveReportRequest } from "../report-request";
import { readSettings } from "../settings";

// `maxprice daily`: `/api/daily` for the shared report flags, as the
// Desktop's report hook would request it (`buildReportUrl`), printed as a
// table, or under `--json` as the route's response, byte for byte.

export const DAILY_HELP_REF = "maxprice daily --help";

export async function daily(parsed: Parsed, io: Io, env: Env = process.env): Promise<number> {
  const flags = parseReportFlags(parsed.values, DAILY_HELP_REF);
  const daemon = await connect({ env, report: true, stderr: io.stderr });
  const request = await resolveReportRequest(
    flags,
    daemon,
    readSettings(env),
    env,
    undefined,
    io.stderr,
  );
  const { data, text } = await daemon.request(
    buildReportUrl("/api/daily", normalize(request.input)),
    dailyResponseSchema,
  );
  if (flags.json) {
    io.stdout.write(text);
    return EXIT.OK;
  }
  io.stdout.write(
    renderDaily(
      { rows: data.daily, rangeLabel: request.rangeLabel, scopeLabel: request.scopeLabel },
      terminalOutput(io.stdout, env),
    ),
  );
  return EXIT.OK;
}
