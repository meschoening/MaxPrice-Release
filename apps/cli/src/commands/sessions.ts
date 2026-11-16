import {
  buildReportUrl,
  foldProjectRows,
  normalize,
  projectsResponseSchema,
  sessionsResponseSchema,
} from "@maxprice/shared";
import { accountProbes, rowAccounts } from "../account-column";
import { connect } from "../daemon-client";
import { EXIT } from "../exit";
import type { Io, Parsed } from "../main";
import type { Env } from "../paths";
import { projectsTotal } from "../render/projects";
import { renderSessions } from "../render/sessions";
import { terminalOutput } from "../render/table";
import { parseReportFlags, reportContext, resolveReportRequest } from "../report-request";
import { readSettings } from "../settings";

// `maxprice sessions`: `/api/sessions` for the shared report flags, as the
// Desktop's report hook would request it (`buildReportUrl`), printed as a
// table, or under `--json` as the route's response, byte for byte. The table
// reads the Machine directory while the machine axis is on, for the Machine
// column. `--json` reads it only when `--machine` needs it.
//
// The table's Total row is the Desktop's Projects strip filter total for the
// same range and Scope (ADR-0140 §11's #642 note; the Sessions strip it once
// matched went in #640): `/api/projects` with the same input, folded by the
// Identity directory's index as `pages/Projects.tsx` folds it
// (`foldProjectRows`), totalled by `aggregateProjectsRange` (`projectsTotal`).
// So the table waits for that index as `projects` does. The body rows stay
// `/api/sessions`', and the Total is not their sum: a session whose usage
// crosses `since` counts whole in its row and only its in-range part in the
// Total, and a session with in-range usage under two project slugs counts in
// the Total once per slug (`projects-sessions-strip-totals.test.ts` in the
// sidecar pins both).
//
// The Account column (ADR-0140 §3) shows while the Scope's Memberships span
// two or more Accounts, filled as `projects` fills its Accounts column, by
// session id (`account-column.ts`). `--json` asks none of these.

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
    { machineDirectory: !flags.json, identity: !flags.json },
  );
  const { data, text } = await daemon.request(
    buildReportUrl("/api/sessions", normalize(request.input)),
    sessionsResponseSchema,
  );
  if (flags.json) {
    io.stdout.write(text);
    return EXIT.OK;
  }
  const { identity } = request;
  if (identity === null) throw new Error("the sessions report read no Identity directory index");
  const strip = await daemon.request(
    buildReportUrl("/api/projects", normalize(request.input)),
    projectsResponseSchema,
  );
  const probes = accountProbes(request);
  const accounts =
    probes === null
      ? null
      : await rowAccounts(
          daemon,
          "/api/sessions",
          sessionsResponseSchema,
          request.input,
          probes,
          (answer) => answer.sessions.map((s) => s.sessionId),
        );
  io.stdout.write(
    renderSessions(
      {
        ...reportContext(request, Date.now()),
        rows: data.sessions,
        total: projectsTotal(foldProjectRows(strip.data.projects, identity)),
        accounts,
      },
      terminalOutput(io.stdout, env),
    ),
  );
  return EXIT.OK;
}
