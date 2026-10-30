import { join } from "node:path";
import {
  fsErrorName,
  loadSecretFileAtBoot,
  removeSecretFile,
  writeSecretEntries,
  writeSecretFile,
} from "@maxprice/usage-core/secrets-file";
import { z } from "zod";
import { CliError, EXIT } from "./cli";
import type { Credstore } from "./credstore";

// The Hub's two secret files in its data dir, kept on Linux (ADR-0126):
//
// - `secrets.json` holds the claude.ai session key with when and by whom it
//   was set (§2, §3). On Linux it is the Hub's only store for the key, in
//   place of the keychain helper (§1); `openCredstore` (credstore.ts) picks
//   it. While the daemon runs, the daemon is its only writer: every push,
//   the console's, a client's heal or `key set`'s, lands here through `set`
//   (§4). With no daemon running, `key set|clear` write it through the same
//   store, under serve.lock (operator.ts, ADR-0127 §7).
// - `operator-token` holds a Headless Hub's per-launch operator secret, for
//   the commands on this machine (§8). It lives from just before the first
//   bind to the shutdown teardown.
//
// The mechanics (the atomic 0600 write, the delete, the boot's
// tighten-or-skip) are `@maxprice/usage-core/secrets-file`'s (§10); this
// module keeps the Hub's schema and its log lines. No line or message from
// here carries any part of a value: the shared module's reasons name a field,
// a type or an errno and never echo the file, and an fs error is named here by
// its errno alone.

export const SECRETS_FILE = "secrets.json";
export const OPERATOR_TOKEN_FILE = "operator-token";

export function secretsPath(dataDir: string): string {
  return join(dataDir, SECRETS_FILE);
}

export function operatorTokenPath(dataDir: string): string {
  return join(dataDir, OPERATOR_TOKEN_FILE);
}

// Strict at both levels, with fixed field names (no z.record): an unknown
// field is refused, an `orgId` included, and the shared describer names a
// field without ever naming a key that could be a pasted secret. `source` is
// `credentialSource`'s: "local" or a healing machine's id.
export const hubSecretsSchema = z
  .object({
    sessionKey: z
      .object({
        value: z.string().min(1),
        setAt: z.string().datetime(),
        source: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type FileCredstoreOptions = {
  // The status line, on stdout.
  log: (line: string) => void;
  // The shared module's tighten and skip lines, on stderr.
  warn: (line: string) => void;
  // The uid the file must belong to; this process's by default. A test
  // passes another to make its own file a foreign one.
  uid?: number;
};

// The Credstore over `secrets.json` (ADR-0126 §2–§5).
//
// `get` is the boot's read, which runReadySequence makes once: a loose file is
// tightened to 0600, and one that is unreadable, owned by another uid or
// invalid is skipped with one line, so the Hub boots keyless and never exits
// for the file's state (§5). Then it always says one status line, so the
// journal shows which file a boot read and what it found. The key comes back
// with its provenance, which the boot puts back on the status (§3).
//
// `set` replaces the whole file, never reading it first, so an invalid file is
// simply replaced; a clear deletes it. A key always comes with its provenance,
// from POST /api/credential or an offline `key set` (operator.ts), whose
// source is "local". The one caller that passes none is the boot's
// pre-#283 rewrite (ADR-0104), which runs only for an entry carrying an orgId,
// and this file's schema refuses one: so a key without provenance is a bug,
// refused rather than written with provenance it does not have.
export function createFileCredstore(
  path: string,
  { log, warn, uid }: FileCredstoreOptions,
): Credstore {
  return {
    async get() {
      const entry =
        loadSecretFileAtBoot(path, hubSecretsSchema, (line) => warn(`[hub] ${line}`), { uid })
          ?.sessionKey ?? null;
      if (entry === null) {
        log(`[hub] session key: none in ${path}`);
        return null;
      }
      log(`[hub] session key: from ${path}, set ${entry.setAt} by ${entry.source}`);
      return {
        sessionKey: entry.value,
        provenance: { setAt: entry.setAt, source: entry.source },
      };
    },
    async set(cred, provenance) {
      if (cred === null) {
        named("remove", () => removeSecretFile(path));
        return;
      }
      if (provenance === undefined) {
        throw new Error(
          `refusing to write ${path}: a session key needs when and by whom it was set`,
        );
      }
      const { setAt, source } = provenance;
      named("write", () =>
        writeSecretEntries(path, { sessionKey: { value: cred.sessionKey, setAt, source } }),
      );
    },
  };

  // An fs failure, named by its errno alone: its message is whatever the
  // fault says.
  function named(verb: string, act: () => unknown): void {
    try {
      act();
    } catch (error) {
      throw new Error(`cannot ${verb} ${path} (${fsErrorName(error)})`);
    }
  }
}

// ADR-0126 §8: a Headless Hub on Linux writes its operator secret before its
// first bind, over any file a crash left. A failure stops the boot, exit 1:
// the commands on this machine could not reach the daemon without it.
export function writeOperatorToken(path: string, secret: string): void {
  try {
    writeSecretFile(path, `${secret}\n`);
  } catch (error) {
    throw new CliError(EXIT.FAILURE, `[hub] cannot write ${path} (${fsErrorName(error)})`);
  }
}

// The teardown's removal: one line when it fails, never a throw, so the
// daemon still exits.
export function removeOperatorToken(path: string, warn: (line: string) => void): void {
  try {
    removeSecretFile(path);
  } catch (error) {
    warn(`[hub] cannot remove ${path} (${fsErrorName(error)})`);
  }
}
