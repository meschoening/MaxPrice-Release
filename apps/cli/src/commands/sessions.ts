import { buildReportUrl, normalize, sessionsResponseSchema } from "@maxprice/shared";
import { connect } from "../daemon-client";
import { EXIT } from "../exit";
import type { Io, Parsed } from "../main";
import type { Env } from "../paths";
import { renderSessions } from "../render/sessions";
import { terminalOutput } from "../render/table";
import { parseReportFlags, reportContext, resolveReportRequest } from "../report-request";
import { readSettings } from "../settings";

// `maxprice sessions`: `/api/sessions` for the shared report flags, as the
// Desktop's report hook would request it (`buildReportUrl`), printed as a
// table, or under `--json` as the route's response, byte for byte. The table
// reads the Machine directory while the machine axis is on, for the Machine
// column. `--json` reads it only when `--machine` needs it.

export const SESSIONS_HELP_REF = "maxprice sessions --help";

export async function sessions(parsed: Parsed, io: Io, env: Env = process.env): Promise<number> {
  const flags = parseReportFlags(parsed.values, SESSIONS_HELP_REF);
  const daemon = await connect({ env, report: true, stderr: io.stderr });
  const request = await resolveReportRequest(
    flags,
    daemon,
    readSettings(env),
    env,
    undefined,
    io.stderr,
    { machineDirectory: !flags.json },
  );
  const { data, text } = await daemon.request(
    buildReportUrl("/api/sessions", normalize(request.input)),
    sessionsResponseSchema,
  );
  if (flags.json) {
    io.stdout.write(text);
    return EXIT.OK;
  }
  io.stdout.write(
    renderSessions(
      { ...reportContext(request, Date.now()), rows: data.sessions },
      terminalOutput(io.stdout, env),
    ),
  );
  return EXIT.OK;
}
