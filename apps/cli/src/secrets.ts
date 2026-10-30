import {
  fsErrorName,
  loadSecretFileAtBoot,
  readSecretFile,
  writeSecretEntries,
} from "@maxprice/usage-core/secrets-file";
import { z } from "zod";
import { CliError, EXIT } from "./exit";
import { dataDir, displayPath, type Env, ensureDataDir, secretsPath } from "./paths";

// The Headless client's secrets, `<data dir>/secrets.json` (ADR-0121): the
// claude.ai session key and the Hub password, each with when it was set. This
// module is the file's only reader and writer; the mechanics (the atomic 0600
// write, the delete in place of an empty file, the boot's tighten-or-skip)
// are `@maxprice/usage-core/secrets-file`'s (ADR-0126 §10).
//
// No message, reason or log line from here carries any part of a value: the
// reasons are the shared module's, which name a field, a type or an errno and
// never echo the file.

const entry = z.object({ value: z.string().min(1), setAt: z.string().datetime() }).strict();

// Strict at both levels, with fixed field names: an unknown field is refused,
// and the shared describer can name a field without ever naming a key that
// could be a pasted secret.
export const secretsSchema = z
  .object({ sessionKey: entry.optional(), hubPassword: entry.optional() })
  .strict();

export type Secrets = z.infer<typeof secretsSchema>;
export type SecretName = keyof Secrets;

function fileOf(env: Env): string {
  return secretsPath(dataDir(env));
}

// The file as a command finds it. No file is no secrets. A file it cannot use
// is never rewritten, since that would drop the other secret (ADR-0121 §4),
// so the command stops here with exit 1.
export function readSecretsForEdit(env: Env): Secrets {
  const path = fileOf(env);
  const read = readSecretFile(path, secretsSchema);
  if (read.kind === "absent") return {};
  if (read.kind === "ok") return read.value;
  throw new CliError(EXIT.FAILURE, `${displayPath(path, env)} cannot be used: ${read.reason}`, [
    "Fix the file or delete it; maxprice never rewrites one it cannot use.",
  ]);
}

// A command's read-modify-write (ADR-0121 §4). `edit` returns the whole new
// set from the one read, keeping what it does not change; an entry set to
// undefined is dropped, and dropping the last deletes the file. An edit that
// changes nothing writes nothing, and the data dir is made only for a write.
// There is no lock: two concurrent writes race, and the last rename wins.
// Returns whether it wrote.
export function editSecrets(env: Env, edit: (secrets: Secrets) => Secrets): boolean {
  const secrets = readSecretsForEdit(env);
  const next = edit(secrets);
  if (Bun.deepEquals(next, secrets)) return false;
  const path = fileOf(env);
  try {
    ensureDataDir(dataDir(env));
    writeSecretEntries(path, next);
  } catch (error) {
    // Named by its code alone, as the shared module names one: an fs error's
    // message is whatever the fault says.
    throw new CliError(
      EXIT.FAILURE,
      `cannot write ${displayPath(path, env)} (${fsErrorName(error)})`,
    );
  }
  return true;
}

// ADR-0121 §3, §5: what `serve` boots with, read once. A loose file is
// tightened; one that is unreadable, foreign or invalid is skipped, and the
// daemon boots with no secrets. `log` hears each line unprefixed.
export function bootSecrets(env: Env, log: (line: string) => void): Secrets {
  return loadSecretFileAtBoot(fileOf(env), secretsSchema, log) ?? {};
}

export type SecretsHealth =
  // `loose` is the file's mode when group or other can reach it, else null.
  | { secrets: Secrets; loose: number | null }
  // Why the file cannot be used: unreadable, foreign or invalid.
  | { problem: string };

// What `status` says about the file, without changing it: never a throw.
export function secretsHealth(env: Env): SecretsHealth {
  const read = readSecretFile(fileOf(env), secretsSchema);
  switch (read.kind) {
    case "absent":
      return { secrets: {}, loose: null };
    case "ok":
      return { secrets: read.value, loose: (read.mode & 0o077) !== 0 ? read.mode : null };
    default:
      return { problem: read.reason };
  }
}
