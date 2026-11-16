import { join } from "node:path";
import {
  fsErrorName,
  loadSecretFileAtBoot,
  readSecretFile,
  removeSecretFile,
  writeSecretEntries,
  writeSecretFile,
} from "@maxprice/usage-core/secrets-file";
import {
  ACCOUNT_CREDENTIAL_KIND,
  ACCOUNT_UUID_PATTERN,
  GATEWAY_ID_PATTERN,
  gatewayManagementKeySchema,
} from "@maxprice/shared";
import { z } from "zod";
import { CliError, EXIT } from "./cli";
import {
  sortedAccounts,
  type HubGatewayKeyStore,
  type HubKeyListing,
  type HubKeyStore,
} from "./key-store";

// The Hub's two secret files in its data dir, kept on Linux (ADR-0126):
//
// - `secrets.json` holds the claude.ai session keys (ADR-0138 §6): each
//   Account's under its uuid, with its kind and when and by whom it was set;
//   the one legacy key ADR-0138 §12 has not yet moved, as v6 wrote it; and
//   each removed Account's removal time (ADR-0139 §5); and each connected
//   Gateway's management key under its Gateway id (ADR-0141 §7), only once
//   a Gateway is connected. On Linux it is the
//   Hub's only store for keys, in place of the keychain helper (§1);
//   `openKeyStore` (credstore.ts) picks it. While the daemon runs, the daemon
//   is its only writer: every push, the console's, a client's heal or `key
//   set`'s, lands here (§4). With no daemon running, `key set|clear` write it
//   through the same store, under serve.lock (operator.ts, ADR-0127 §7).
// - `operator-token` holds a Headless Hub's per-launch operator secret, for
//   the commands on this machine (§8). It lives from just before the first
//   bind to the shutdown teardown.
//
// The mechanics (the atomic 0600 write, the delete, the boot's
// tighten-or-skip) are `@maxprice/usage-core/secrets-file`'s (§10); this
// module keeps the Hub's schema and its log lines. No line or message from
// here carries any part of a value, nor any key of `sessionKeys`,
// `removedAt` or `gateways` (`RECORD_FIELDS`): the shared module's reasons name a field, a
// type or an errno and never echo the file, and an fs error is named here by
// its errno alone.

export const SECRETS_FILE = "secrets.json";
export const OPERATOR_TOKEN_FILE = "operator-token";

export function secretsPath(dataDir: string): string {
  return join(dataDir, SECRETS_FILE);
}

export function operatorTokenPath(dataDir: string): string {
  return join(dataDir, OPERATOR_TOKEN_FILE);
}

// Strict at every level: an unknown field is refused, an `orgId` included.
// Every object key is a fixed field name but those of `sessionKeys` and
// `removedAt`, which are account uuids, and those of `gateways`, which are
// Gateway ids, so the shared describer is told to name none of them. `sessionKey` is the legacy key, v6's one entry: read for
// the move, never written again but to drop it. `source` is "local" or a
// healing machine's id.
const legacyEntry = z
  .object({
    value: z.string().min(1),
    setAt: z.string().datetime(),
    source: z.string().min(1),
  })
  .strict();
const accountEntry = z
  .object({
    value: z.string().min(1),
    kind: z.literal(ACCOUNT_CREDENTIAL_KIND),
    setAt: z.string().datetime(),
    source: z.string().min(1),
  })
  .strict();
// A Gateway's management key (ADR-0141 §7) and when it was connected. Its
// URL is not secret and lives in `gateways.json` (gateway-registry.ts).
//
// The schema is strict, so a Hub older than #651 reads a file holding
// `gateways` as invalid and boots keyless: a downgrade after connecting a
// Gateway loses every session key until the file is rewritten (ADR-0141's
// residual, D12).
const gatewayEntry = z
  .object({
    value: gatewayManagementKeySchema,
    setAt: z.string().datetime(),
  })
  .strict();
export const hubSecretsSchema = z
  .object({
    sessionKey: legacyEntry.optional(),
    sessionKeys: z.record(z.string().regex(ACCOUNT_UUID_PATTERN), accountEntry).optional(),
    removedAt: z.record(z.string().regex(ACCOUNT_UUID_PATTERN), z.string().datetime()).optional(),
    gateways: z.record(z.string().regex(GATEWAY_ID_PATTERN), gatewayEntry).optional(),
  })
  .strict();
export type HubSecrets = z.infer<typeof hubSecretsSchema>;

export const RECORD_FIELDS = ["sessionKeys", "removedAt", "gateways"] as const;
const FILE_OPTIONS = { recordFields: RECORD_FIELDS };

export type FileKeyStoreOptions = {
  // The status line, on stdout.
  log: (line: string) => void;
  // The shared module's tighten and skip lines, on stderr.
  warn: (line: string) => void;
  // The uid the file must belong to; this process's by default. A test
  // passes another to make its own file a foreign one.
  uid?: number;
};

function listingOf(secrets: HubSecrets): HubKeyListing {
  const legacy = secrets.sessionKey;
  return {
    accounts: sortedAccounts(
      Object.entries(secrets.sessionKeys ?? {}).map(([uuid, e]) => [
        uuid,
        { sessionKey: e.value, kind: e.kind, setAt: e.setAt, source: e.source },
      ]),
    ),
    legacy:
      legacy === undefined
        ? null
        : { sessionKey: legacy.value, setAt: legacy.setAt, source: legacy.source },
    removed: { ...secrets.removedAt },
  };
}

// An empty record is dropped, so the last key and removal time going can
// delete the file (ADR-0121 §4). Every field is carried, so a session-key
// edit keeps the Gateways' keys and a Gateway edit keeps the session keys.
function normalized(secrets: HubSecrets): HubSecrets {
  const empty = (r: Record<string, unknown> | undefined) =>
    r === undefined || Object.keys(r).length === 0;
  return {
    sessionKey: secrets.sessionKey,
    sessionKeys: empty(secrets.sessionKeys) ? undefined : secrets.sessionKeys,
    removedAt: empty(secrets.removedAt) ? undefined : secrets.removedAt,
    gateways: empty(secrets.gateways) ? undefined : secrets.gateways,
  };
}

function without<T>(record: Record<string, T> | undefined, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record ?? {}).filter(([k]) => k !== key));
}

// The key store over `secrets.json` (ADR-0126 §2–§5, ADR-0138 §6).
//
// `list` is the boot's read, which the Hub makes once: a loose file is
// tightened to 0600, and one that is unreadable, owned by another uid or
// invalid is skipped with one line, so the Hub boots keyless and never exits
// for the file's state (§5). Then it always says one status line, so the
// journal shows which file a boot read and what it found, never a uuid.
//
// Every write is one read-modify-write of the whole file, atomic: a file this
// cannot use is replaced, as v6's was (ADR-0126 §2), since it holds nothing
// the Hub can read. The move (ADR-0138 §12) writes the Account's entry and
// drops the legacy key in that one write, so the key is never in neither.
function currentSecrets(path: string, uid: number | undefined): HubSecrets {
  const read = readSecretFile(path, hubSecretsSchema, { ...FILE_OPTIONS, uid });
  return read.kind === "ok" ? read.value : {};
}
function editSecrets(
  path: string,
  uid: number | undefined,
  change: (secrets: HubSecrets) => HubSecrets,
): void {
  const next = normalized(change(currentSecrets(path, uid)));
  try {
    writeSecretEntries(path, next);
  } catch (error) {
    // An fs failure, named by its errno alone: its message is whatever the
    // fault says.
    throw new Error(`cannot write ${path} (${fsErrorName(error)})`);
  }
}

export function createFileKeyStore(
  path: string,
  { log, warn, uid }: FileKeyStoreOptions,
): HubKeyStore {
  const edit = (change: (secrets: HubSecrets) => HubSecrets) => editSecrets(path, uid, change);
  return {
    async list() {
      const secrets =
        loadSecretFileAtBoot(path, hubSecretsSchema, (line) => warn(`[hub] ${line}`), {
          ...FILE_OPTIONS,
          uid,
        }) ?? {};
      const listing = listingOf(secrets);
      const held = [...listing.accounts, ...(listing.legacy === null ? [] : [listing.legacy])];
      if (held.length === 0) log(`[hub] session key: none in ${path}`);
      else if (held.length === 1) {
        const only = held[0]!;
        log(`[hub] session key: from ${path}, set ${only.setAt} by ${only.source}`);
      } else log(`[hub] session keys: ${held.length} from ${path}`);
      return listing;
    },
    async set(uuid, entry) {
      edit((s) => ({
        ...s,
        sessionKeys: {
          ...s.sessionKeys,
          [uuid]: {
            value: entry.sessionKey,
            kind: entry.kind,
            setAt: entry.setAt,
            source: entry.source,
          },
        },
        removedAt: without(s.removedAt, uuid),
      }));
    },
    async remove(uuid, removedAt) {
      edit((s) => ({
        ...s,
        sessionKeys: without(s.sessionKeys, uuid),
        removedAt: { ...s.removedAt, [uuid]: removedAt },
      }));
    },
    async removeLegacy() {
      edit((s) => ({ ...s, sessionKey: undefined }));
    },
    async moveLegacy(uuid, entry) {
      edit((s) => {
        const held = s.sessionKeys?.[uuid] !== undefined;
        return {
          ...s,
          sessionKey: undefined,
          sessionKeys: held
            ? s.sessionKeys
            : {
                ...s.sessionKeys,
                [uuid]: {
                  value: entry.sessionKey,
                  kind: entry.kind,
                  setAt: entry.setAt,
                  source: entry.source,
                },
              },
          removedAt: held ? s.removedAt : without(s.removedAt, uuid),
        };
      });
    },
    // The file's legacy entry never carried an orgId (ADR-0126 §2).
    async dropLegacyOrgId() {},
  };
}

// The Gateways' management keys in the same file (ADR-0141 §7), each under
// `gateways.<id>`. Read as the file stands, never at boot with a line: the
// session-key store's boot read (above) is the one that tightens the file and
// says what it found. A file this cannot use reads as holding no Gateway key,
// and a write replaces it, as the session-key store's does.
export function createFileGatewayKeyStore(
  path: string,
  { uid }: { uid?: number } = {},
): HubGatewayKeyStore {
  return {
    async get(id) {
      return currentSecrets(path, uid).gateways?.[id]?.value ?? null;
    },
    async set(id, managementKey, setAt) {
      editSecrets(path, uid, (s) => ({
        ...s,
        gateways: { ...s.gateways, [id]: { value: managementKey, setAt } },
      }));
    },
    async remove(id) {
      editSecrets(path, uid, (s) => ({ ...s, gateways: without(s.gateways, id) }));
    },
  };
}

// The file as it stands, for `key set|clear` and setup without a daemon: what
// it holds, read without a line and without tightening; nothing for a file
// that is absent or that this cannot use.
export function readHubSecrets(path: string, uid?: number): HubKeyListing {
  const read = readSecretFile(path, hubSecretsSchema, { ...FILE_OPTIONS, uid });
  return listingOf(read.kind === "ok" ? read.value : {});
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
