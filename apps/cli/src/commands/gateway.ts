import {
  GATEWAY_ID_PATTERN,
  gatewayCheckResponseSchema,
  gatewayId,
  gatewayManagementKeySchema,
  gatewaysConfigAckSchema,
  gatewayUrlHost,
  localGatewaysResponseSchema,
  normalizeGatewayUrl,
  SIDECAR_GATEWAYS_CHECK_PATH,
  SIDECAR_GATEWAYS_CONFIG_PATH,
  SIDECAR_GATEWAYS_PATH,
} from "@maxprice/shared";
import { EXIT_INTERRUPTED } from "@maxprice/usage-core/secret-input";
import { connect, type Daemon, probeFirst, pushIfUp, pushSaved } from "../daemon-client";
import { CliError, EXIT, usageError } from "../exit";
import type { Io, Parsed } from "../main";
import { dataDir, displayPath, type Env, secretsPath } from "../paths";
import {
  gatewayCheckFailureText,
  type GatewayListJson,
  gatewayRows,
  renderGatewayConnected,
  renderGateways,
} from "../render/gateways";
import { terminalOutput } from "../render/table";
import { type SecretsDeps, secretReader, setAtNow } from "../secret-input";
import { editSecrets, gatewaysOf, readSecretsForEdit, type Secrets } from "../secrets";
import { hubNamed } from "../settings";

// `maxprice gateway connect|list|remove` (ADR-0141 §7, §8): the Gateways
// this client drains in fallback, each kept in secrets.json's `gateways`
// under its Gateway id with its URL, its management key and when it was set.
//
// `connect` is the Desktop client's Connect, with the file standing in for
// the keychain: the daemon checks the URL and key (`POST /api/gateways/check`,
// which holds nothing), then the file is written and the whole held set is
// pushed (`POST /api/gateways/config`). A failed push keeps the Gateway for
// the daemon's next boot. `list` joins the file to the daemon's own listing
// (`GET /api/gateways`). `remove` drops one from the file and pushes the held
// set to a daemon that runs; it needs none, and never touches a Hub, where a
// Gateway is removed only at the Hub (§7).
//
// No message from here carries any part of the key: not a usage error about
// one given as an argument, not a URL or a verb that might be one pasted in
// its place.

const HELP = "maxprice gateway --help";

function usage(message: string): CliError {
  return usageError(message, HELP);
}

// What `gateway` takes from a test: the secret reader and the clock.
export type GatewayDeps = SecretsDeps;

// The URL a Gateway is named by, normalized (`normalizeGatewayUrl`), never
// echoed when refused: a key pasted in its place would be.
function gatewayUrl(raw: string): string {
  const url = normalizeGatewayUrl(raw);
  if (url === null) {
    throw usage("not a Gateway URL: give its http or https URL, with no username or password");
  }
  return url;
}

// The whole held set, as the file now holds it.
function sendGateways(daemon: Daemon, secrets: Secrets): Promise<unknown> {
  return daemon.request(SIDECAR_GATEWAYS_CONFIG_PATH, gatewaysConfigAckSchema, {
    method: "POST",
    body: { gateways: gatewaysOf(secrets) },
  });
}

async function connectGateway(
  rest: readonly string[],
  io: Io,
  env: Env,
  deps: GatewayDeps,
): Promise<number> {
  // argv lands in shell history and `ps`; nothing given here is echoed.
  if (rest.length === 0) throw usage("gateway connect needs the Gateway's URL");
  if (rest.length > 1) {
    throw usage(
      "gateway connect takes one URL; the management key is never an argument: argv lands " +
        "in shell history and ps; paste it at the prompt or pipe it on stdin",
    );
  }
  const url = gatewayUrl(rest[0]!);
  const id = gatewayId(url);
  // The probe, then the file, before the prompt (ADR-0121 §6's order): a
  // down or skewed daemon, or a file the write would refuse, never costs a
  // paste. The check needs no scan, so it is not waited for.
  const daemon = await connect({ env });
  readSecretsForEdit(env);
  const managementKey = await secretReader(io, deps)("Management key: ");
  if (managementKey === null) return EXIT_INTERRUPTED;
  if (managementKey === "") throw usage("no management key was given");
  if (!gatewayManagementKeySchema.safeParse(managementKey).success) {
    throw usage("a management key is printable ASCII with no spaces, at most 512 characters");
  }
  const { data } = await daemon.request(SIDECAR_GATEWAYS_CHECK_PATH, gatewayCheckResponseSchema, {
    method: "POST",
    body: { url, managementKey },
  });
  if (!data.ok) throw new CliError(EXIT.FAILURE, gatewayCheckFailureText(data.failure));

  // Connecting a held Gateway again replaces its key.
  const setAt = setAtNow(deps);
  let next: Secrets = {};
  editSecrets(env, (secrets) => {
    next = {
      ...secrets,
      gateways: { ...secrets.gateways, [id]: { url, value: managementKey, setAt } },
    };
    return next;
  });
  await pushSaved(env, () => sendGateways(daemon, next));
  io.stdout.write(
    renderGatewayConnected({ host: gatewayUrlHost(url), id, warnings: data.warnings }),
  );
  io.stderr.write(`Stored in ${displayPath(secretsPath(dataDir(env)), env)} (0600).\n`);
  return EXIT.OK;
}

// Needs the daemon, as `key list` does: a Gateway's state is the daemon's.
async function list(json: boolean, io: Io, env: Env, deps: GatewayDeps): Promise<number> {
  const daemon = await connect({ env });
  const secrets = readSecretsForEdit(env);
  const held = (await daemon.request(SIDECAR_GATEWAYS_PATH, localGatewaysResponseSchema)).data;
  const answer: GatewayListJson = { gateways: gatewayRows(secrets, held) };
  if (json) {
    io.stdout.write(JSON.stringify(answer, null, 2) + "\n");
    return EXIT.OK;
  }
  const now = (deps.now ?? Date.now)();
  io.stdout.write(renderGateways(answer, now, terminalOutput(io.stdout, env)));
  return EXIT.OK;
}

// One Gateway out of the file, by its URL or its id; then the held set
// pushed to a daemon that runs. A Gateway on the Hub stays there (§7).
async function remove(rest: readonly string[], io: Io, env: Env): Promise<number> {
  if (rest.length === 0) throw usage("gateway remove needs the Gateway's URL or id");
  if (rest.length > 1) throw usage("gateway remove takes one Gateway");
  const name = rest[0]!;
  const id = GATEWAY_ID_PATTERN.test(name) ? name : gatewayId(gatewayUrl(name));
  const probed = await probeFirst(env);
  const secrets = readSecretsForEdit(env);
  const entry = secrets.gateways?.[id];
  // A name that names nothing here is a usage error, as at the Hub.
  if (entry === undefined) {
    throw new CliError(EXIT.USAGE, "no Gateway with that URL or id is connected", [
      { label: "The connected Gateways:", command: "maxprice gateway list" },
    ]);
  }
  let next: Secrets = {};
  editSecrets(env, (s) => {
    const kept = { ...s.gateways };
    delete kept[id];
    next = { ...s, gateways: kept };
    return next;
  });
  const shown = displayPath(secretsPath(dataDir(env)), env);
  const code = await pushIfUp(probed, io.stderr, shown, (d) => sendGateways(d, next));
  io.stdout.write(`Removed Gateway ${gatewayUrlHost(entry.url)} (${id})\n`);
  if (hubNamed(env)) {
    io.stdout.write(
      "The Hub keeps this Gateway if this client sent it there: a Gateway on the Hub is " +
        "removed only at the Hub.\n",
    );
  }
  return code;
}

const VERBS = ["connect", "list", "remove"] as const;

export async function gateway(
  parsed: Parsed,
  io: Io,
  env: Env = process.env,
  deps: GatewayDeps = {},
): Promise<number> {
  const [verb, ...rest] = parsed.positionals;
  const json = parsed.values.json === true;
  if (verb === undefined) throw usage("gateway needs a command: connect, list or remove");
  // Not echoed: a key pasted where the verb goes would be.
  if (!(VERBS as readonly string[]).includes(verb)) {
    throw usage("unknown gateway command; the commands are connect, list and remove");
  }
  if (json && verb !== "list") throw usage("--json is for gateway list only");
  switch (verb) {
    case "connect":
      return await connectGateway(rest, io, env, deps);
    case "list":
      if (rest.length > 0) throw usage("gateway list takes no arguments");
      return await list(json, io, env, deps);
    default:
      return await remove(rest, io, env);
  }
}
