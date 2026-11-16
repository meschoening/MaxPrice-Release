import {
  formatRelativeTime,
  GATEWAY_CHECK_FAILURE_WORDS,
  GATEWAY_STATE_WORDS,
  GATEWAY_WARNING_WORDS,
  gatewayId,
  type GatewayCheckFailure,
  type GatewayDrainer,
  type GatewayState,
  type GatewayWarning,
  type LocalGatewaysResponse,
  normalizeGatewayUrl,
} from "@maxprice/shared";
import type { Secrets } from "../secrets";
import { setAtText } from "./keys";
import { type Column, type Output, renderTable } from "./table";

// `maxprice gateway connect|list` and `status`'s Gateway lines (ADR-0141 §7,
// §8). Pure: the command reads secrets.json and the daemon. Nothing here ever
// holds a management key: a row is built from an entry's URL, id and `setAt`,
// and the daemon's listing, which never carries one.
//
//   Gateways
//   ┌─────────────────────────────┬──────────────────┬──────────────┬─────────────┬──────────────┬─────────────────────┐
//   │ Gateway                     │ Id               │ State        │ Last record │ Drained by   │ Set at              │
//   ├─────────────────────────────┼──────────────────┼──────────────┼─────────────┼──────────────┼─────────────────────┤
//   │ http://gw.example:8317      │ d5c57044f08bc89b │ Draining     │ 2m ago      │ this machine │ 2026-11-10 (1d ago) │
//   │ https://gw-b.example/manage │ 767fd452c49e843f │ Key refused  │ none yet    │ the Hub      │ 2026-11-02 (9d ago) │
//   └─────────────────────────────┴──────────────────┴──────────────┴─────────────┴──────────────┴─────────────────────┘

// The state, warning and check-failure words are packages/shared's
// (`gateway-words.ts`, #673), which the Desktop, the hub tray app and the
// Headless Hub read too; this module frames them.

export const NO_GATEWAYS = "No Gateways connected. 'maxprice gateway connect <url>' connects one.";

const DRAINER_WORDS: Record<GatewayDrainer, string> = {
  hub: "the Hub",
  "this-machine": "this machine",
};

// Why Connect's check failed, as `gateway connect` says it (ADR-0141 §7's
// note): the shared words, then that nothing was stored, as `maxprice-hub`'s
// `gateway connect` says it.
export function gatewayCheckFailureText(failure: GatewayCheckFailure): string {
  return `${GATEWAY_CHECK_FAILURE_WORDS[failure]} Nothing was stored.`;
}

// Connecting tracks nothing (ADR-0141 §7): an Account first seen through the
// Gateway starts Excluded, as any newly seen Account does.
export const GATEWAY_TRACKS_NOTHING =
  "Connecting tracks nothing: an Account first seen through this Gateway starts " +
  "Excluded. 'maxprice account list' lists it, and 'maxprice account track <account>' " +
  "tracks it.";

// One row of `gateway list`, and its `--json` entry: the file's Gateway,
// with what the daemon holds for it. `state`, `lastRecordAt` and `drainedBy`
// are null when the daemon holds no such Gateway (the file changed since the
// daemon last read it).
export type GatewayRow = {
  id: string;
  url: string;
  state: GatewayState | null;
  lastRecordAt: string | null;
  drainedBy: GatewayDrainer | null;
  setAt: string;
};

// `gateway list --json`'s object.
export type GatewayListJson = { gateways: GatewayRow[] };

// `gateway list`'s rows, and `status`'s Gateway lines: each Gateway the file holds, by URL, with what the daemon
// holds for it. An entry filed under an id other than its URL's is skipped,
// as `serve` skips it.
export function gatewayRows(secrets: Secrets, held: LocalGatewaysResponse): GatewayRow[] {
  return Object.entries(secrets.gateways ?? {})
    .filter(([id, entry]) => gatewayId(entry.url) === id)
    .map(([id, entry]) => {
      const daemon = held.gateways.find((g) => g.id === id);
      return {
        id,
        url: normalizeGatewayUrl(entry.url) ?? entry.url,
        state: daemon?.state ?? null,
        lastRecordAt: daemon?.lastRecordAt ?? null,
        drainedBy: daemon?.drainedBy ?? null,
        setAt: entry.setAt,
      };
    })
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

// When a Gateway's last record was drained: its age, or that none has been
// this run.
export function lastRecordText(lastRecordAt: string | null, now: number): string {
  return lastRecordAt === null ? "none yet" : formatRelativeTime(lastRecordAt, now);
}

type Cells = GatewayRow & { now: number };

const COLUMNS: Column<Cells>[] = [
  { header: "Gateway", text: (row) => row.url, min: 20 },
  { header: "Id", text: (row) => row.id },
  {
    header: "State",
    text: (row) => (row.state === null ? "not in use" : GATEWAY_STATE_WORDS[row.state]),
  },
  {
    header: "Last record",
    text: (row) => (row.state === null ? "—" : lastRecordText(row.lastRecordAt, row.now)),
    drop: 2,
  },
  {
    header: "Drained by",
    text: (row) => (row.drainedBy === null ? "—" : DRAINER_WORDS[row.drainedBy]),
    drop: 3,
  },
  { header: "Set at", text: (row) => setAtText(row.setAt, row.now), drop: 1 },
];

export function renderGateways(list: GatewayListJson, now: number, out: Output): string {
  if (list.gateways.length === 0) return `${NO_GATEWAYS}\n`;
  const rows = list.gateways.map((row) => ({ ...row, now }));
  return renderTable({ title: "Gateways", columns: COLUMNS, rows }, out);
}

// `gateway connect`'s report: the Gateway, each warning the check gave, and
// that connecting tracks nothing.
export function renderGatewayConnected(input: {
  host: string;
  id: string;
  warnings: readonly GatewayWarning[];
}): string {
  const lines = [`Connected Gateway ${input.host} (${input.id})`];
  for (const warning of input.warnings) lines.push(`Warning: ${GATEWAY_WARNING_WORDS[warning]}`);
  lines.push(GATEWAY_TRACKS_NOTHING);
  return lines.join("\n") + "\n";
}

// `status`'s words for a Gateway's state, and its remedy where the user has
// one: an unauthorized Gateway's key is entered again with `connect`; a
// Gateway whose queue gives nothing while its credentials serve requests
// has usage statistics off, or another consumer, which its words say how to
// mend.
export function gatewayStatusDetail(
  state: GatewayState,
  url: string,
): { words: string; remedy?: string } {
  const words = GATEWAY_STATE_WORDS[state];
  switch (state) {
    case "unauthorized":
      return { words, remedy: `maxprice gateway connect ${url}` };
    case "statistics-off":
      return {
        words:
          `${words}: its credentials serve requests but its usage queue gives no record; ` +
          "turn on usage-statistics-enabled, and make MaxPrice the queue's only consumer",
      };
    default:
      return { words };
  }
}
