import { join } from "node:path";
import {
  GATEWAY_CHECK_FAILURE_WORDS,
  GATEWAY_STATE_WORDS,
  GATEWAY_WARNING_WORDS,
  formatRelativeTime,
  GATEWAY_ID_PATTERN,
  gatewayConnectResponseSchema,
  gatewayId,
  gatewayManagementKeySchema,
  gatewayUrlHost,
  gatewayUrlSchema,
  HUB_GATEWAYS_PATH,
  hubGatewayPath,
  normalizeGatewayUrl,
  type GatewayState,
  type GatewayWarning,
} from "@maxprice/shared";
import { checkGateway, type FetchLike } from "@maxprice/usage-core";
import { displayPath, type Env } from "@maxprice/usage-core/home-path";
import { EXIT_INTERRUPTED } from "@maxprice/usage-core/secret-input";
import { CliError, EXIT, type Io } from "./cli";
import { requireHub } from "./config";
import { createGatewayRegistry, GATEWAY_REGISTRY_FILE } from "./gateway-registry";
import { liveStatus } from "./hub-names";
import { reachHub, type ReachOptions, refusal, unreadable } from "./operator-client";
import { type SecretDeps, secretReader } from "./operator";
import { createFileGatewayKeyStore, secretsPath } from "./secrets";
import { DASH, headlessOnly, say, terminalJson, terminalTable } from "./terminal-output";

// `maxprice-hub gateway connect|list|remove` (ADR-0141 §7, §8): the Gateways
// the Hub drains, each keyed by its URL, its management key in secrets.json's
// `gateways` (0600) and its URL in gateways.json, both in the data dir. A
// Headless Hub's, on Linux and macOS, as `key` is: elsewhere the hub tray app keeps each key in the
// keychain and its console connects them. Each reaches the Hub as the
// operator commands do (ADR-0127 §7): a running Hub through its own routes,
// `POST /api/gateways` and `DELETE /api/gateways/<id>`, which apply at once;
// with none, the two files, under serve.lock, which the next start reads. No
// line, message or `--json` value carries any part of a management key, and
// a Gateway is named by its URL's host alone, as `HubStatus.gateways` names
// it. The exit codes follow `key`'s (ADR-0140 §6): 1, 2, 4 and 130.

// What the gateway commands take from a test, beside the reader.
export type GatewayDeps = SecretDeps & {
  // Connect's check's fetch (checkGateway), the global one by default.
  fetch?: FetchLike;
  // The clock an offline Connect's `setAt` is read from, and `list`'s
  // relative times.
  now?: () => number;
  // reachHub's bound on the reach and each request, its polling and its
  // cgroup reader.
  reach?: ReachOptions;
};

// ADR-0141 §7, ADR-0146 §4: the Headless Hub keeps the keys in secrets.json;
// elsewhere the hub tray app keeps them in the keychain.
const ELSEWHERE = "connect Gateways from the console";

// The URL as given, normalized, or exit 2 without quoting it: what was typed
// may be the management key, pasted where the URL goes. gatewayUrlSchema
// only checks (its length cap and a URL normalizeGatewayUrl takes) and
// answers the URL as typed, so the normalized form is normalizeGatewayUrl's.
function gatewayUrl(url: string): string {
  const normalized = gatewayUrlSchema.safeParse(url).success ? normalizeGatewayUrl(url) : null;
  if (normalized === null) {
    throw new CliError(
      EXIT.USAGE,
      "not a Gateway URL: give its management address, http:// or https://, with no user, password, query or fragment",
    );
  }
  return normalized;
}

const DRAINED_BY_CLIENTS =
  "A client that connected this Gateway itself keeps its own copy, and drains it while the Hub does not.";

// ── gateway connect ─────────────────────────────────────────────────────────

// `maxprice-hub gateway connect <url>` (ADR-0141 §7, §8). The URL is checked,
// the management key read (on a terminal at a hidden prompt, else all of
// stdin; never argv, which cli.ts refuses) and checked with the Gateway in
// this process, one read of its credential list, and only then is the Hub
// reached, so neither the prompt nor the check is spent holding serve.lock,
// as `key set` reads and checks its key. A running Hub is sent the Gateway,
// `POST /api/gateways`, which checks it again from where it drains, stores
// it and drains it at once; with none, this process writes the key into
// secrets.json and the URL into gateways.json under the lock, in the
// drainer's order (the key, then the list), and the Hub drains it when it
// starts. Connecting a Gateway the Hub holds replaces its key. A passing
// Connect prints both warnings every time (§7's amended note).
export async function gatewayConnect(
  url: string,
  io: Io,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  deps: GatewayDeps = {},
): Promise<number> {
  headlessOnly(platform, ELSEWHERE);
  const dataDir = requireHub(env, platform);
  const normalized = gatewayUrl(url);
  const host = gatewayUrlHost(normalized);
  const managementKey = await secretReader(deps, io)("Management key: ");
  if (managementKey === null) return EXIT_INTERRUPTED;
  if (managementKey === "") throw new CliError(EXIT.USAGE, "no management key was given");
  if (!gatewayManagementKeySchema.safeParse(managementKey).success) {
    throw new CliError(
      EXIT.USAGE,
      "invalid management key: printable ASCII, no spaces, 1 to 512 characters",
    );
  }
  const check = await checkGateway({
    url: normalized,
    managementKey,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  if (!check.ok) {
    throw new CliError(
      EXIT.FAILURE,
      `${GATEWAY_CHECK_FAILURE_WORDS[check.failure]} Nothing was stored.`,
    );
  }
  const secrets = displayPath(secretsPath(dataDir), env);
  const reached = await reachHub(dataDir, env, deps.reach);
  let warnings: readonly GatewayWarning[];
  let stored: string;
  if (reached.kind === "live") {
    const answer = await reached.hub.request("POST", HUB_GATEWAYS_PATH, {
      url: normalized,
      managementKey,
    });
    if (!answer.ok) {
      throw new CliError(
        EXIT.FAILURE,
        `the running Hub refused the Gateway: ${refusal(answer, HUB_GATEWAYS_PATH)}`,
      );
    }
    const parsed = gatewayConnectResponseSchema.safeParse(answer.body);
    if (!parsed.success) throw unreadable(HUB_GATEWAYS_PATH);
    if (!parsed.data.ok) {
      throw new CliError(
        EXIT.FAILURE,
        `the running Hub checked the Gateway: ${GATEWAY_CHECK_FAILURE_WORDS[parsed.data.failure]} Nothing was stored.`,
      );
    }
    warnings = parsed.data.warnings;
    stored = `Stored in ${secrets} (0600); the running Hub drains it at once.`;
  } else {
    try {
      const id = gatewayId(normalized);
      await createFileGatewayKeyStore(secretsPath(dataDir)).set(
        id,
        managementKey,
        new Date((deps.now ?? Date.now)()).toISOString(),
      );
      registryOf(dataDir, io).set({ id, url: normalized });
    } finally {
      reached.lock.release();
    }
    warnings = check.warnings;
    stored =
      `Stored in ${secrets} (0600) and ${displayPath(registryPath(dataDir), env)}; ` +
      "the Hub drains it when it starts.";
  }
  say(io.stdout, `Connected Gateway ${host}`);
  for (const warning of warnings) say(io.stdout, GATEWAY_WARNING_WORDS[warning]);
  say(io.stderr, stored);
  return EXIT.OK;
}

function registryPath(dataDir: string): string {
  return join(dataDir, GATEWAY_REGISTRY_FILE);
}

// The daemon's own registry over the data dir's gateways.json; a line it
// warns (a file it cannot read, kept as .bak) goes to stderr.
function registryOf(dataDir: string, io: Io) {
  return createGatewayRegistry({
    path: registryPath(dataDir),
    warn: (line) => say(io.stderr, line),
  });
}

// ── gateway list ────────────────────────────────────────────────────────────

// One row of `gateway list`, and its `--json` entry: a Gateway by its id and
// its URL's host. `state` and `lastRecordAt` are the running Hub's
// (`HubStatus.gateways`), both null with none running.
export type GatewayListRow = {
  id: string;
  urlHost: string;
  state: GatewayState | null;
  lastRecordAt: string | null;
};

// The table (terminalTable): Gateway, Id, State, Last record.
function table(rows: readonly GatewayListRow[], running: boolean, now: number): string {
  const cells = (row: GatewayListRow) => [
    row.urlHost,
    row.id,
    row.state === null ? DASH : GATEWAY_STATE_WORDS[row.state],
    !running
      ? DASH
      : row.lastRecordAt === null
        ? "No record yet"
        : formatRelativeTime(row.lastRecordAt, now),
  ];
  return terminalTable(["Gateway", "Id", "State", "Last record"], rows.map(cells));
}

// `maxprice-hub gateway list [--json]` (ADR-0141 §8): every Gateway the Hub
// holds, never its key. Through a running Hub, its status's `gateways`, each
// with its state and the age of its last record; with none, the data dir's
// gateways.json under serve.lock, with one stderr line that no Hub runs to
// say how any Gateway drains.
export async function gatewayList(
  json: boolean,
  io: Io,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  deps: Pick<GatewayDeps, "reach" | "now"> = {},
): Promise<number> {
  headlessOnly(platform, ELSEWHERE);
  const dataDir = requireHub(env, platform);
  const reached = await reachHub(dataDir, env, deps.reach);
  let rows: GatewayListRow[];
  if (reached.kind === "live") {
    rows = (liveStatus(reached.hub).gateways ?? []).map((gateway) => ({
      id: gateway.id,
      urlHost: gateway.urlHost,
      state: gateway.state,
      lastRecordAt: gateway.lastRecordAt,
    }));
  } else {
    try {
      rows = registryOf(dataDir, io)
        .list()
        .map(({ id, url }) => ({
          id,
          urlHost: gatewayUrlHost(url),
          state: null,
          lastRecordAt: null,
        }));
    } finally {
      reached.lock.release();
    }
  }
  const running = reached.kind === "live";
  if (json) {
    io.stdout.write(terminalJson({ running, gateways: rows }));
    return EXIT.OK;
  }
  if (!running) {
    say(
      io.stderr,
      `No Hub is running on ${displayPath(dataDir, env)}, so no Gateway's state is known.`,
    );
  }
  if (rows.length === 0) {
    say(io.stdout, "No Gateway on this Hub");
    say(io.stdout, "  Connect one:  maxprice-hub gateway connect <url>");
    return EXIT.OK;
  }
  io.stdout.write(table(rows, running, (deps.now ?? Date.now)()));
  return EXIT.OK;
}

// ── gateway remove ──────────────────────────────────────────────────────────

// `maxprice-hub gateway remove <url>` (ADR-0141 §7, §8), or the Id `gateway
// list` shows, which names the same Gateway. The Hub stops draining it, and
// its key and URL go. A running Hub is sent `DELETE /api/gateways/<id>`, as
// its console sends one; with none, this process removes the URL from
// gateways.json, then the key from secrets.json, under serve.lock, the
// drainer's order. A Gateway on the Hub is removed only here (§7): a client
// that connected it itself keeps its own copy, and drains it while the Hub
// does not (ADR-0141 §5's predicate), never sending it up again.
export async function gatewayRemove(
  given: string,
  io: Io,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  deps: Pick<GatewayDeps, "reach"> = {},
): Promise<number> {
  headlessOnly(platform, ELSEWHERE);
  const dataDir = requireHub(env, platform);
  let id: string;
  // The host when the URL names it; for an Id, the Hub's own entry gives it.
  let host: string | null = null;
  if (GATEWAY_ID_PATTERN.test(given)) {
    id = given;
  } else if (gatewayUrlSchema.safeParse(given).success) {
    id = gatewayId(given);
    host = gatewayUrlHost(given);
  } else {
    throw new CliError(
      EXIT.USAGE,
      "not a Gateway URL or Id: give its URL as it was connected, or its Id as gateway list shows it",
    );
  }
  const reached = await reachHub(dataDir, env, deps.reach);
  if (reached.kind === "live") {
    const { hub } = reached;
    const named =
      host ?? liveStatus(hub).gateways?.find((gateway) => gateway.id === id)?.urlHost ?? id;
    const target = hubGatewayPath(id);
    const answer = await hub.request("DELETE", target);
    if (answer.status === 404) {
      throw new CliError(EXIT.USAGE, `the Hub holds no Gateway ${named}`);
    }
    if (!answer.ok) {
      throw new CliError(
        EXIT.FAILURE,
        `the running Hub refused the removal: ${refusal(answer, target)}`,
      );
    }
    say(io.stdout, `Removed Gateway ${named}: the running Hub stops draining it at once.`);
    say(io.stdout, DRAINED_BY_CLIENTS);
    return EXIT.OK;
  }
  try {
    const registry = registryOf(dataDir, io);
    const keys = createFileGatewayKeyStore(secretsPath(dataDir));
    const entry = registry.get(id);
    const named = host ?? (entry === null ? id : gatewayUrlHost(entry.url));
    if (entry === null && (await keys.get(id)) === null) {
      throw new CliError(EXIT.USAGE, `the Hub holds no Gateway ${named}`);
    }
    registry.remove(id);
    await keys.remove(id);
    say(
      io.stdout,
      `Removed Gateway ${named} from ${displayPath(registryPath(dataDir), env)} and ${displayPath(secretsPath(dataDir), env)}.`,
    );
    say(io.stdout, DRAINED_BY_CLIENTS);
    return EXIT.OK;
  } finally {
    reached.lock.release();
  }
}
