import { RESCAN_PATH, rescanResponseSchema, type RescanResponse } from "@maxprice/shared";
import { connect } from "../daemon-client";
import { EXIT } from "../exit";
import type { Io, Parsed } from "../main";
import type { Env } from "../paths";
import { count, plural } from "../render/count";

// `maxprice rescan`: a Manual rescan (ADR-0019), the Desktop client's ⇧R. It
// POSTs /api/rescan with no body; the daemon's POST guard passes it, since
// `serve` runs with no token (ADR-0119 §3). The route awaits the initial
// scan before its own walk, so this connects as a report does and says
// `scanning…` on a terminal while it waits.

// The Desktop pill's "refreshed · +N" and "up to date" (`use-manual-refresh.ts`).
function rescanLine({ added, total }: RescanResponse): string {
  return added > 0
    ? `Rescanned · ${plural(added, "new or updated event")} · ${count(total)} in total`
    : `Rescanned · up to date · ${plural(total, "event")} in total`;
}

export async function rescan(parsed: Parsed, io: Io, env: Env = process.env): Promise<number> {
  const daemon = await connect({ env, report: true, stderr: io.stderr });
  const { data, text } = await daemon.request(RESCAN_PATH, rescanResponseSchema, {
    method: "POST",
  });
  io.stdout.write(parsed.values.json === true ? text : `${rescanLine(data)}\n`);
  return EXIT.OK;
}
