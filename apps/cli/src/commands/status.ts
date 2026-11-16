import {
  ACCOUNTS_PATH,
  accountsResponseSchema,
  localGatewaysResponseSchema,
  ORGANIZATIONS_PATH,
  organizationsResponseSchema,
  type Settings,
  SIDECAR_GATEWAYS_PATH,
  trackedAccountSet,
  USAGE_KEYS_PATH,
  usageKeysResponseSchema,
} from "@maxprice/shared";
import type { ZodType, ZodTypeDef } from "zod";
import { readUpdateCheck } from "@maxprice/usage-core/update-check";
import { connect, type Daemon, PROBE_TIMEOUT_MS } from "../daemon-client";
import { desktopHubUrl } from "../double-join";
import { CliError, EXIT } from "../exit";
import { displayHubUrl } from "../hub-url";
import type { Io, Parsed } from "../main";
import { dataDir, displayPath, type Env, secretsPath, socketPath } from "../paths";
import { type Read, renderStatus, type StatusInput } from "../render/status";
import { colorEnabled, style } from "../render/style";
import { type SecretsHealth, secretsHealth, sessionKeyCount } from "../secrets";
import { readSettings, settingsHealth } from "../settings";

// `maxprice status`: the daemon's own state as a checklist (#445's Variant B,
// ADR-0119 §5–7). It reads `/api/status`, the probe `connect` makes anyway,
// and never waits for the scan: a scanning daemon is one of the states it
// reports. A down daemon exits 3 and a skewed one 4, from `connect`; once the
// daemon has answered it exits 0, whatever the marks say. The systemd unit's
// state is `maxprice service status`'s (ADR-0120 §5).
//
// Approved for #463 on 2026-10-19, beside the ticket's "reads only
// `/api/status`": once the daemon is ready, text mode also reads the roster,
// `/api/organizations`, for the line per Tracked organization. `/api/status`
// cannot give those lines: its `organizations` map carries no Organization
// label and no Home, and while a Hub owns polling it mirrors the Hub's map,
// which holds every Organization the Hub's key lists, tracked or not
// (`poller.ts`'s `organizations()`). The roster has the label (never the
// upstream name, ADR-0098 §6), `home` and `tracked`; each line's answer still
// comes from the status. On a first boot the roster waits for the scan
// (`homeSettled`, the sidecar's `boot.ts`), so it is read only once `ready`
// is true, and the checklist stays instant while the daemon scans.
// `/api/status` stays the only read under `--json`.
//
// #642 (ADR-0140 §4, ADR-0141 §8): text mode reads three more answers, each
// only where its lines need it (`readExtras`), so a one-Account install with
// one key and no Gateway asks what it asked before: `/api/usage/keys` for a
// line per key, `/api/accounts` once ready for the keys' labels and a line
// per tracked Membership, and `/api/gateways` for a line per Gateway.
//
// `status` is the screen to read when something is wrong, so a read beside
// the status that fails costs only its own lines: an `{error}` envelope, an
// answer that does not parse, or no answer within the probe's 3 s becomes one
// warning row saying why in place of the Organization (Membership) or Gateway
// lines, or the Limits line as it was in place of the key lines; the rest of
// the checklist prints, and the exit stays 0. A daemon gone since the probe
// still exits 3.
//
// Text mode also reads this client's own settings.json, never the daemon's
// view of it, for the Settings lines (ADR-0122 §7): a stored value the schema
// rejects, or a file the next `serve` would refuse. It reads secrets.json too,
// without changing it, for whether the session key and the Hub password are
// set, when the key was, and the Secrets line for a file that is loose or
// cannot be used (ADR-0121 §9); no line carries any part of either value.
// Neither file's trouble is an error: each shows as its line. And it reads
// the daemon's update-check.json for the Update line (ADR-0123 §8), which
// keeps the check out of `/api/status`, a shape the Desktop client shares.
// `--json` stays the route's answer alone, and reads no file.

async function readOr<T>(
  daemon: Daemon,
  path: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
  timeoutMs: number,
): Promise<Read<T>> {
  try {
    return (await daemon.request(path, schema, { timeoutMs })).data;
  } catch (error) {
    if (error instanceof CliError && error.code === EXIT.FAILURE) {
      return { unavailable: error.message };
    }
    throw error;
  }
}

// Whether settings.json tracks two or more Accounts, the gate the reports'
// Scope reads /api/accounts by (`resolveScopeRequest`). A file that cannot
// be read tracks none here; its Settings line says why.
function tracksSeveralAccounts(env: Env): boolean {
  try {
    return (trackedAccountSet(readSettings(env))?.size ?? 0) >= 2;
  } catch {
    return false;
  }
}

// What text mode reads beside the status (ADR-0140 §4, ADR-0141 §8), each
// only where its lines need it, so a one-Account install with one key and no
// Gateway asks what it asked before: the keys' connections while the file
// holds two or more keys or the unfiled one; the Accounts, once the scan is
// done, where two or more are tracked or keyed; the Gateways while the file
// holds one.
async function readExtras(
  daemon: Daemon,
  env: Env,
  health: SecretsHealth,
  timeoutMs: number,
): Promise<Pick<StatusInput, "roster" | "accounts" | "keys" | "gateways">> {
  const secrets = "problem" in health ? null : health.secrets;
  const keyCount = secrets === null ? 0 : sessionKeyCount(secrets);
  const ready = daemon.status.ready;
  const roster = ready
    ? await readOr(daemon, ORGANIZATIONS_PATH, organizationsResponseSchema, timeoutMs)
    : null;
  const accounts =
    ready && (keyCount >= 2 || tracksSeveralAccounts(env))
      ? await readOr(daemon, ACCOUNTS_PATH, accountsResponseSchema, timeoutMs)
      : null;
  const keys =
    keyCount >= 2 || secrets?.sessionKey !== undefined
      ? await readOr(daemon, USAGE_KEYS_PATH, usageKeysResponseSchema, timeoutMs)
      : null;
  const gateways =
    Object.keys(secrets?.gateways ?? {}).length > 0
      ? await readOr(daemon, SIDECAR_GATEWAYS_PATH, localGatewaysResponseSchema, timeoutMs)
      : null;
  return { roster, accounts, keys, gateways };
}

// The Hub this client's settings.json names, with its URL safe to show
// (`displayHubUrl`), as in the serve log. A file that cannot be read names
// none here; its Settings line says why.
function settingsHub(env: Env): StatusInput["hub"] {
  let settings: Settings;
  try {
    settings = readSettings(env);
  } catch {
    return null;
  }
  const url = displayHubUrl(settings.hubUrl);
  return url === null ? null : { url, autoHeal: settings.hubAutoHeal };
}

export async function status(
  parsed: Parsed,
  io: Io,
  env: Env = process.env,
  now: () => number = Date.now,
  rosterTimeoutMs = PROBE_TIMEOUT_MS,
): Promise<number> {
  const daemon = await connect({ env });
  // ADR-0119 §7: the route's answer verbatim, its bytes as sent.
  if (parsed.values.json === true) {
    io.stdout.write(daemon.statusText);
    return EXIT.OK;
  }
  const secrets = secretsHealth(env);
  const extras = await readExtras(daemon, env, secrets, rosterTimeoutMs);
  const dir = dataDir(env);
  io.stdout.write(
    renderStatus({
      status: daemon.status,
      socket: displayPath(socketPath(dir), env),
      ...extras,
      update: readUpdateCheck(dataDir(env)),
      settings: settingsHealth(env),
      hub: settingsHub(env),
      secrets,
      secretsPath: displayPath(secretsPath(dir), env),
      desktopHubUrl: desktopHubUrl(env),
      now: now(),
      style: style(colorEnabled(io.stdout, env)),
    }),
  );
  return EXIT.OK;
}
