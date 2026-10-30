import {
  buildReportUrl,
  foldProjectRows,
  normalize,
  projectsResponseSchema,
} from "@maxprice/shared";
import { connect } from "../daemon-client";
import { EXIT } from "../exit";
import type { Io, Parsed } from "../main";
import type { Env } from "../paths";
import { renderProjects } from "../render/projects";
import { terminalOutput } from "../render/table";
import { parseReportFlags, reportContext, resolveReportRequest } from "../report-request";
import { readSettings } from "../settings";

// `maxprice projects`: `/api/projects` for the shared report flags, as the
// Desktop's report hook would request it (`buildReportUrl`), printed as a
// table, or under `--json` as the route's response, byte for byte. The table
// folds the rows as the Desktop does (ADR-0061, ADR-0062), so it waits for
// the Identity directory's index as `--project` does, and reads the Machine
// directory while the machine axis is on, for the Machines column. `--json`
// reads neither unless `--project` or `--machine` needs it.

export const PROJECTS_HELP_REF = "maxprice projects --help";

export async function projects(parsed: Parsed, io: Io, env: Env = process.env): Promise<number> {
  const flags = parseReportFlags(parsed.values, PROJECTS_HELP_REF);
  const daemon = await connect({ env, report: true, stderr: io.stderr });
  const request = await resolveReportRequest(
    flags,
    daemon,
    readSettings(env),
    env,
    undefined,
    io.stderr,
    { machineDirectory: !flags.json, identity: !flags.json },
  );
  const { data, text } = await daemon.request(
    buildReportUrl("/api/projects", normalize(request.input)),
    projectsResponseSchema,
  );
  if (flags.json) {
    io.stdout.write(text);
    return EXIT.OK;
  }
  const { identity } = request;
  if (identity === null) throw new Error("the projects report read no Identity directory index");
  io.stdout.write(
    renderProjects(
      { ...reportContext(request, Date.now()), groups: foldProjectRows(data.projects, identity) },
      terminalOutput(io.stdout, env),
    ),
  );
  return EXIT.OK;
}
