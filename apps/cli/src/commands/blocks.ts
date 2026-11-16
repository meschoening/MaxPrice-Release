import {
  aggregateBlocks,
  type BlocksAggregate,
  type BlocksResponse,
  blocksResponseSchema,
  buildReportUrl,
  buildScopeHeadUrl,
  formatMembershipToken,
  type MembershipBlocks,
  normalize,
  scopeHeadResponseSchema,
  unknownAccountUsage,
  blocksHeadAccountNotKnown,
  withAccountNotKnown,
} from "@maxprice/shared";
import { connect, type Daemon } from "../daemon-client";
import { EXIT } from "../exit";
import type { Io, Parsed } from "../main";
import type { Env } from "../paths";
import { renderBlocks, renderMembershipBlocks } from "../render/blocks";
import { rankedMembershipRows } from "../render/membership-limits";
import { terminalOutput } from "../render/table";
import {
  parseReportFlags,
  type ReportRequest,
  resolveReportRequest,
  waitForUsageHistory,
} from "../report-request";
import { readSettings } from "../settings";

// `maxprice blocks`: `/api/blocks` for the shared report flags, as the
// Desktop's Blocks page requests it (`useBlocks`), printed as a table, or
// under `--json` as the route's response, byte for byte. Blocks are
// cross-project (ADR-0017): the page sends no projects, so the command takes
// no `--project`.
//
// While the Scope holds two or more of the Memberships the Desktop's Blocks
// tabs list (`scopeMembershipSet`: two or more tracked Accounts), the table
// is one section per Membership (ADR-0140 §3), each its own Blocks from the
// same answer's `memberships`, which lists every Membership the Scope spans,
// each formed on its own (#632). A Scope of one prints today's table.

export const BLOCKS_HELP_REF = "maxprice blocks --help";

// Each Membership's Blocks. `memberships` is absent while the daemon formed
// one Membership or none: then `blocks` is that one's, the Scope's head,
// which /api/scope-head names for the same params, asked only when there are
// Blocks to place.
async function formations(
  data: BlocksResponse,
  request: ReportRequest,
  daemon: Daemon,
): Promise<MembershipBlocks[]> {
  if (data.memberships !== undefined) return data.memberships;
  if (data.blocks.length === 0) return [];
  const { account, organization } = request.input;
  const head = (
    await daemon.request(
      buildScopeHeadUrl("", {
        ...(account === undefined ? {} : { account }),
        ...(organization === undefined ? {} : { organization }),
      }),
      scopeHeadResponseSchema,
    )
  ).data;
  return head.organizationUuid === null
    ? []
    : [
        {
          organizationUuid: head.organizationUuid,
          accountUuid: head.accountUuid,
          blocks: data.blocks,
        },
      ];
}

// The usage of every Membership whose Account is not known, which no
// section shows (a tracked Membership's Account is always known), else null:
// the head's too, unlike `unknownAccountUsage`, whose table is the head's.
function unknownOutsideSections(formed: readonly MembershipBlocks[]): BlocksAggregate | null {
  const sum = aggregateBlocks(
    formed.filter((m) => m.accountUuid === null).flatMap((m) => m.blocks),
  );
  return sum.totalCost > 0 || sum.totalTokens > 0 ? sum : null;
}

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
  const display = { tz: settings.timezone, timeFormat: settings.timeFormat };
  const now = Date.now();
  const out = terminalOutput(io.stdout, env);
  if (request.memberships.length >= 2) {
    const formed = await formations(data, request, daemon);
    const byToken = new Map(
      formed.map((m) => [formatMembershipToken(m.organizationUuid, m.accountUuid), m.blocks]),
    );
    const rows = rankedMembershipRows(
      request.memberships,
      request.accounts?.accounts ?? [],
      request.labels,
      now,
    );
    io.stdout.write(
      renderMembershipBlocks(
        {
          rangeLabel: request.rangeLabel,
          scopeLabel: request.scopeLabel,
          sections: rows.map((row) => ({ row, blocks: byToken.get(row.token) ?? [] })),
          roster: request.roster,
          display,
          now,
          unknown: unknownOutsideSections(formed),
        },
        out,
      ),
    );
    return EXIT.OK;
  }
  io.stdout.write(
    renderBlocks(
      {
        rows: data.blocks,
        rangeLabel: request.rangeLabel,
        scopeLabel: request.scopeLabel,
        // The Unknown Membership heading in place of an empty Home membership
        // (#644) says so in the title.
        quotaLabel: withAccountNotKnown(
          request.quotaLabel,
          blocksHeadAccountNotKnown(data, request.scopeState.home),
        ),
        display,
        now,
        unknown: unknownAccountUsage(data),
      },
      out,
    ),
  );
  return EXIT.OK;
}
