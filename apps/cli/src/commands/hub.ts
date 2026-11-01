import { existsSync } from "node:fs";
import {
  credentialAckSchema,
  type HubConnection,
  hubConnectionLabel,
  normalizeHubUrl,
  statusSnapshotSchema,
} from "@maxprice/shared";
import { EXIT_INTERRUPTED } from "@maxprice/usage-core/secret-input";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { connect, type Daemon, probeFirst, pushIfUp } from "../daemon-client";
import { desktopHubUrl, doubleJoinWarning } from "../double-join";
import { CliError, EXIT, usageError } from "../exit";
import type { Io, Parsed } from "../main";
import { dataDir, displayPath, type Env, secretsPath, settingsPath } from "../paths";
import { waitForUsageHistory } from "../report-request";
import { type SecretsDeps, secretReader, setAtNow } from "../secret-input";
import { editSecrets, readSecretsForEdit } from "../secrets";
import { editSettings, readSettingsObject } from "../settings";

// `maxprice hub join|leave` (ADR-0121 §7–8): the Hub config, which the
// Desktop client keeps across settings.json and the keychain and this client
// across settings.json (`hubUrl`, `hubAutoHeal`) and secrets.json (the Hub
// password). The order is the Desktop client's: the files, then the push.
// `join` needs the daemon, whose answer it waits on; `leave` needs none,
// since the next boot reads the files.

const HUB_CONFIG_PATH = "/api/hub/config";
// ADR-0121 §8: how long `join` waits, from the POST's answer, for the daemon
// to leave `connecting`, and how often it asks.
export const SETTLE_MS = 10_000;
const POLL_MS = 100;

// What a test replaces; production passes none.
export type HubDeps = SecretsDeps & { settleMs?: number; pollMs?: number };

function usage(message: string): CliError {
  return usageError(message, "maxprice hub --help");
}

function settingsShown(env: Env): string {
  return displayPath(settingsPath(dataDir(env)), env);
}

// The Hub a URL names, normalized as the Desktop client's Settings
// normalizes it (`normalizeHubUrl`), or a usage error that does not echo it:
// a password typed in its place would be.
function hubUrl(typed: string): string {
  let url = "";
  try {
    url = normalizeHubUrl(typed);
  } catch {
    // Reported below.
  }
  if (url === "") throw usage("invalid Hub URL");
  const parsed = new URL(url);
  if (parsed.username !== "" || parsed.password !== "") {
    throw usage("a Hub URL never carries a password; give it with --password");
  }
  return url;
}

function didNotAnswer(): CliError {
  return new CliError(EXIT.FAILURE, "saved, but the Hub did not answer; the daemon keeps retrying");
}

// ADR-0121 §8's table, for a state that is not `connecting`.
function settled(state: Exclude<HubConnection, "connecting">, autoHeal: boolean, io: Io): number {
  switch (state) {
    case "connected":
      return EXIT.OK;
    case "keyless":
      io.stderr.write(
        autoHeal
          ? "maxprice: the Hub has no working Claude key; 'maxprice key set' here heals it\n"
          : "maxprice: the Hub has no working Claude key and auto-heal is off here; " +
              "key it from another client or its console\n",
      );
      return EXIT.OK;
    case "unauthorized":
    case "mismatch":
      throw new CliError(EXIT.FAILURE, hubConnectionLabel(state));
    case "fallback":
      throw didNotAnswer();
    case "off":
      throw new CliError(
        EXIT.FAILURE,
        "the daemon is no longer joined to a Hub; another command changed its config",
      );
  }
}

// Polls `hubConnection` until it leaves `connecting`, for `settleMs` from
// now, the POST's answer. Each read is given the time left, and one the
// deadline cuts short is the wait running out, like a last `connecting`.
async function settle(daemon: Daemon, autoHeal: boolean, io: Io, deps: HubDeps): Promise<number> {
  const deadline = performance.now() + (deps.settleMs ?? SETTLE_MS);
  const pollMs = deps.pollMs ?? POLL_MS;
  for (;;) {
    const left = Math.ceil(deadline - performance.now());
    if (left <= 0) throw didNotAnswer();
    let state: HubConnection;
    try {
      const init = { timeoutMs: left };
      state = (await daemon.request("/api/status", statusSnapshotSchema, init)).data.hubConnection;
    } catch (error) {
      const cut = error instanceof CliError && error.code === EXIT.FAILURE;
      if (cut && performance.now() >= deadline) throw didNotAnswer();
      throw error;
    }
    if (state !== "connecting") return settled(state, autoHeal, io);
    await Bun.sleep(Math.max(0, Math.min(pollMs, deadline - performance.now())));
  }
}

async function join(
  rest: readonly string[],
  values: Parsed["values"],
  io: Io,
  env: Env,
  deps: HubDeps,
): Promise<number> {
  // Never echoed past the URL: a password typed after it could be one.
  if (rest.length === 0) throw usage("hub join needs the Hub's URL");
  if (rest.length > 1) throw usage("hub join takes one URL");
  const url = hubUrl(rest[0]!);
  const autoHeal = values["no-auto-heal"] !== true;

  // The probe before the prompt, so a down or skewed daemon never costs a
  // paste, and before anything is read or written; then both files, so a
  // paste is never spent on one a write would refuse, as `key set` checks
  // its own. These reads refuse an unusable file before either changes;
  // a later settings lock or write failure can still leave secrets changed
  // alone (ADR-0121 §8).
  const daemon = await connect({ env });
  readSecretsForEdit(env);
  readSettingsObject(env);
  let password: string | null = null;
  if (values.password === true) {
    const read = await secretReader(io, deps)("Hub password: ");
    if (read === null) return EXIT_INTERRUPTED;
    if (read === "") throw usage("no Hub password was given");
    password = read;
  }

  // ADR-0121 §8 as amended by #469, the Consequences' residual: the state
  // read after the POST must be the new config's. `configure()` awaits the
  // sample store before it sets `connecting` (`hub-client.ts`'s connect()),
  // so while the store loads, the old config's state stands. The daemon's
  // `usageHistoryReady` turns true as that same store's `ready` settles
  // (`boot.ts`), so once it reads true, connect() passes its await in a
  // microtask and sets `connecting` before the POST's answer leaves the
  // daemon. Waiting here, before either file is written, makes every state
  // read below the new config's. Like a report's wait, it has no deadline.
  await waitForUsageHistory(daemon, io.stderr);

  // The password first, as the Desktop client writes its keychain first. Each
  // join writes the whole config: no --password drops a stored one.
  const setAt = setAtNow(deps);
  editSecrets(env, (secrets) => ({
    ...secrets,
    hubPassword: password === null ? undefined : { value: password, setAt },
  }));
  // Under the settings lock, changing these two keys alone (ADR-0122 §4).
  await editSettings(env, (raw) => {
    if (raw.hubUrl === url && raw.hubAutoHeal === autoHeal) return false;
    raw.hubUrl = url;
    raw.hubAutoHeal = autoHeal;
    return true;
  });

  // ADR-0120 §6: said, never blocking.
  const desktop = desktopHubUrl(env);
  if (desktop !== null) io.stderr.write(`maxprice: ${terminalText(doubleJoinWarning(desktop))}\n`);

  try {
    await daemon.request(HUB_CONFIG_PATH, credentialAckSchema, {
      method: "POST",
      body: { url, password, autoHeal },
    });
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    throw new CliError(EXIT.FAILURE, error.message, [
      ...error.hints,
      `The Hub config is saved in ${settingsShown(env)}; the daemon's next start joins it.`,
    ]);
  }
  return await settle(daemon, autoHeal, io, deps);
}

// ADR-0121 §7, the Desktop client's `disconnectHub` order: the password, the
// URL, then hub-off to a daemon that is up. Auto-heal stays as set.
async function leave(
  rest: readonly string[],
  values: Parsed["values"],
  io: Io,
  env: Env,
): Promise<number> {
  if (rest.length > 0) throw usage("hub leave takes no arguments");
  if (values.password === true || values["no-auto-heal"] === true) {
    throw usage("hub leave takes no options");
  }
  const probed = await probeFirst(env);
  // No data dir, no Hub config: nothing to remove, and nothing is made to say
  // so (`editSettings` would make the dir).
  if (existsSync(dataDir(env))) {
    // Refuse unreadable or invalid settings before changing secrets, as
    // `join` does. Later settings I/O can still fail (ADR-0121 §8).
    readSettingsObject(env);
    editSecrets(env, (secrets) => ({ ...secrets, hubPassword: undefined }));
    // Removed, not emptied: an unset `hubUrl` reads as "".
    await editSettings(env, (raw) => {
      if (!Object.hasOwn(raw, "hubUrl")) return false;
      delete raw.hubUrl;
      return true;
    });
  }
  const saved = `${settingsShown(env)} and ${displayPath(secretsPath(dataDir(env)), env)}`;
  return await pushIfUp(probed, io.stderr, saved, (daemon) =>
    daemon.request(HUB_CONFIG_PATH, credentialAckSchema, {
      method: "POST",
      body: { url: null, password: null, autoHeal: true },
    }),
  );
}

export async function hub(
  parsed: Parsed,
  io: Io,
  env: Env = process.env,
  deps: HubDeps = {},
): Promise<number> {
  const [verb, ...rest] = parsed.positionals;
  switch (verb) {
    case undefined:
      throw usage("hub needs a command: join or leave");
    case "join":
      return await join(rest, parsed.values, io, env, deps);
    case "leave":
      return await leave(rest, parsed.values, io, env);
    default:
      // Not echoed: a password pasted where the verb goes would be.
      throw usage("unknown hub command; the commands are join and leave");
  }
}
