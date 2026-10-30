import {
  CLAUDE_CODE_TOKEN_REFUSAL,
  credentialAckSchema,
  discoverOrgsResponseSchema,
  isClaudeCodeToken,
  sessionKeyListingFailure,
} from "@maxprice/shared";
import { EXIT_INTERRUPTED } from "@maxprice/usage-core/secret-input";
import { connect, probeFirst, pushIfUp, restartHints } from "../daemon-client";
import { CliError, EXIT, usageError } from "../exit";
import type { Io, Parsed } from "../main";
import { dataDir, displayPath, type Env, secretsPath } from "../paths";
import { plural } from "../render/count";
import { type SecretsDeps, secretReader, setAtNow } from "../secret-input";
import { editSecrets, readSecretsForEdit } from "../secrets";

// `maxprice key set|clear` (ADR-0121 §6–7): the claude.ai session key, which
// the Desktop client keeps in the keychain and this client in secrets.json.
// The order is the Desktop client's, with the file standing in for the
// keychain: check the key, write it, then push it, so a failed push keeps it
// for the daemon's next boot. `set` needs the daemon, which checks the key
// with claude.ai; `clear` needs none, since a removal needs no check.
//
// No message from here carries any part of the key: not a usage error about
// one given as an argument, not a verb that might be one pasted in its place.

const DISCOVER_PATH = "/api/usage/discover-orgs";
const CREDENTIAL_PATH = "/api/usage/credential";

function usage(message: string): CliError {
  return usageError(message, "maxprice key --help");
}

// ADR-0121 §6, in its order.
async function set(rest: readonly string[], io: Io, env: Env, deps: SecretsDeps): Promise<number> {
  // argv lands in shell history and `ps`; the value is never echoed.
  if (rest.length > 0) {
    throw usage(
      "the key is never an argument: argv lands in shell history and ps; " +
        "paste it at the prompt or pipe it on stdin",
    );
  }
  // The probe before the prompt, so a down or skewed daemon never costs a
  // paste; then the file, so a paste is never spent on one the write would
  // refuse (§6 as amended by #469).
  const daemon = await connect({ env });
  readSecretsForEdit(env);
  const sessionKey = await secretReader(io, deps)("Session key: ");
  if (sessionKey === null) return EXIT_INTERRUPTED;
  if (sessionKey === "") throw usage("no session key was given");
  // ADR-0121 §10: Claude Code's credential is named, never sent to claude.ai.
  if (isClaudeCodeToken(sessionKey)) {
    throw new CliError(EXIT.FAILURE, CLAUDE_CODE_TOKEN_REFUSAL, [
      "'maxprice key --help' says where to copy a session key from.",
    ]);
  }
  const { data } = await daemon.request(DISCOVER_PATH, discoverOrgsResponseSchema, {
    method: "POST",
    body: { sessionKey },
  });
  // The Desktop client's words, shared.
  if (data.orgs.length === 0) {
    throw new CliError(EXIT.FAILURE, sessionKeyListingFailure(data.failureKind));
  }
  const setAt = setAtNow(deps);
  editSecrets(env, (secrets) => ({ ...secrets, sessionKey: { value: sessionKey, setAt } }));
  try {
    await daemon.request(CREDENTIAL_PATH, credentialAckSchema, {
      method: "POST",
      body: { sessionKey },
    });
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    // The key is on disk, so the daemon's next boot reads it.
    throw new CliError(
      EXIT.FAILURE,
      "saved, but the daemon did not accept it; restart it",
      restartHints(env),
    );
  }
  io.stdout.write(
    `Connected: ${plural(data.orgs.length, "Organization")} found (maxprice org list shows them).\n`,
  );
  io.stderr.write(`Stored in ${displayPath(secretsPath(dataDir(env)), env)} (0600).\n`);
  return EXIT.OK;
}

// ADR-0121 §7. The daemon may hold a key the file no longer does (one deleted
// by hand), so the clear is pushed even when the file held none.
async function clear(rest: readonly string[], io: Io, env: Env): Promise<number> {
  if (rest.length > 0) throw usage("key clear takes no arguments");
  const probed = await probeFirst(env);
  // A file with no key is left as it is, and no data dir is made for one.
  editSecrets(env, (secrets) => ({ ...secrets, sessionKey: undefined }));
  const shown = displayPath(secretsPath(dataDir(env)), env);
  return await pushIfUp(probed, io.stderr, shown, (daemon) =>
    daemon.request(CREDENTIAL_PATH, credentialAckSchema, { method: "POST", body: null }),
  );
}

export async function key(
  parsed: Parsed,
  io: Io,
  env: Env = process.env,
  deps: SecretsDeps = {},
): Promise<number> {
  const [verb, ...rest] = parsed.positionals;
  switch (verb) {
    case undefined:
      throw usage("key needs a command: set or clear");
    case "set":
      return await set(rest, io, env, deps);
    case "clear":
      return await clear(rest, io, env);
    default:
      // Not echoed: a key pasted where the verb goes would be.
      throw usage("unknown key command; the commands are set and clear");
  }
}
