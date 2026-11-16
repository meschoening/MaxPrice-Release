import {
  buildReportUrl,
  foldProjectRows,
  normalize,
  projectsResponseSchema,
} from "@maxprice/shared";
import { accountProbes, rowAccounts } from "../account-column";
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
//
// The Accounts column (ADR-0140 §3) shows while the Scope's Memberships span
// two or more Accounts. Rows carry no Account, so the table then asks the
// route once more per Account in the Scope, and once for the usage whose
// Account is not known when the Scope holds it, each narrowed by the
// `membership` param (`account-column.ts`): a project lists the Accounts
// whose answer holds one of its directories. `--json` asks none of them.

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
  const probes = accountProbes(request);
  const accounts =
    probes === null
      ? null
      : await rowAccounts(
          daemon,
          "/api/projects",
          projectsResponseSchema,
          request.input,
          probes,
          (answer) => answer.projects.map((p) => p.slug),
        );
  io.stdout.write(
    renderProjects(
      {
        ...reportContext(request, Date.now()),
        groups: foldProjectRows(data.projects, identity),
        accounts,
      },
      terminalOutput(io.stdout, env),
    ),
  );
  return EXIT.OK;
}
