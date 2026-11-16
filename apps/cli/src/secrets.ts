import {
  fsErrorName,
  loadSecretFileAtBoot,
  readSecretFile,
  writeSecretEntries,
} from "@maxprice/usage-core/secrets-file";
import {
  ACCOUNT_CREDENTIAL_KIND,
  ACCOUNT_UUID_PATTERN,
  GATEWAY_ID_PATTERN,
  gatewayId,
  gatewayManagementKeySchema,
  gatewayUrlSchema,
  type GatewayConfigEntry,
  type UsageKeyset,
} from "@maxprice/shared";
import { z } from "zod";
import { CliError, EXIT } from "./exit";
import { dataDir, displayPath, type Env, ensureDataDir, secretsPath } from "./paths";

// The Headless client's secrets, `<data dir>/secrets.json` (ADR-0121): each
// Account's claude.ai session key (#633, ADR-0138 §6), the one legacy key
// until it moves into its Account's (§12), the Hub password, and each held
// Gateway's URL and management key under its Gateway id (ADR-0141 §7,
// #651), each with when it was set. This module is the file's only reader and writer; the
// mechanics (the atomic 0600 write, the delete in place of an empty file, the
// boot's tighten-or-skip) are `@maxprice/usage-core/secrets-file`'s (ADR-0126
// §10).
//
// No message, reason or log line from here carries any part of a value: the
// reasons are the shared module's, which name a field, a type or an errno and
// never echo the file, nor any key of `sessionKeys` (`RECORD_FIELDS`).

const entry = z.object({ value: z.string().min(1), setAt: z.string().datetime() }).strict();

// One Account's key (ADR-0138 §2): the shared stored credential's fields in
// this file's `value` spelling. `orgId` is the pre-#283 stamp evidence a
// legacy key carries into its Account's entry, dropped once a push carrying
// it is acknowledged.
const accountKey = z
  .object({
    value: z.string().min(1),
    kind: z.literal(ACCOUNT_CREDENTIAL_KIND),
    setAt: z.string().datetime(),
    orgId: z.string().min(1).optional(),
  })
  .strict();

export type AccountKey = z.infer<typeof accountKey>;

// One held Gateway (ADR-0141 §7): its URL and management key, keyed by its
// Gateway id. The terminal verbs that write it are #642's; `serve` reads it.
const gatewayEntry = z
  .object({
    url: gatewayUrlSchema,
    value: gatewayManagementKeySchema,
    setAt: z.string().datetime(),
  })
  .strict();

export type GatewayEntry = z.infer<typeof gatewayEntry>;

// Strict at every level: an unknown field is refused. Every object key is a
// fixed field name but those of `sessionKeys`, which are account uuids, and
// of `gateways`, which are Gateway ids, so the shared describer is told to
// name none of them. An older binary refuses a file with `gateways` as
// invalid (ADR-0141's downgrade residual, D12). `sessionKey` is the legacy key: read
// for the move, never written again but to drop it.
export const secretsSchema = z
  .object({
    sessionKey: entry.optional(),
    sessionKeys: z.record(z.string().regex(ACCOUNT_UUID_PATTERN), accountKey).optional(),
    hubPassword: entry.optional(),
    gateways: z.record(z.string().regex(GATEWAY_ID_PATTERN), gatewayEntry).optional(),
  })
  .strict();

const RECORD_FIELDS = ["sessionKeys", "gateways"] as const;
const FILE_OPTIONS = { recordFields: RECORD_FIELDS };

export type Secrets = z.infer<typeof secretsSchema>;
export type SecretName = keyof Secrets;

// How many session keys the file holds: each Account's and the legacy one.
export function sessionKeyCount(secrets: Secrets): number {
  return Object.keys(secrets.sessionKeys ?? {}).length + (secrets.sessionKey ? 1 : 0);
}

// When each held key was set, newest last.
export function sessionKeySetAts(secrets: Secrets): string[] {
  const all = [
    ...Object.values(secrets.sessionKeys ?? {}).map((k) => k.setAt),
    ...(secrets.sessionKey ? [secrets.sessionKey.setAt] : []),
  ];
  return all.sort((a, b) => Date.parse(a) - Date.parse(b));
}

// The keyset the file makes (ADR-0138 §6): every Account's key, its `orgId`
// included, and the legacy key; null when it holds none, which clears the
// sidecar's.
export function keysetOf(secrets: Secrets): UsageKeyset | null {
  const accounts = Object.entries(secrets.sessionKeys ?? {});
  if (accounts.length === 0 && secrets.sessionKey === undefined) return null;
  return {
    keys: accounts.map(([accountUuid, key]) => ({
      accountUuid,
      sessionKey: key.value,
      kind: key.kind,
      setAt: key.setAt,
      ...(key.orgId === undefined ? {} : { orgId: key.orgId }),
    })),
    legacy: secrets.sessionKey === undefined ? null : { sessionKey: secrets.sessionKey.value },
  };
}

// The Gateways the file holds, as `bootSidecar({ gateways })` takes them
// (ADR-0141 §7). An entry filed under an id other than its URL's is skipped:
// the id is the URL's, so such an entry was edited by hand.
export function gatewaysOf(secrets: Secrets): GatewayConfigEntry[] {
  return Object.entries(secrets.gateways ?? {})
    .filter(([id, g]) => gatewayId(g.url) === id)
    .map(([, g]) => ({ url: g.url, managementKey: g.value }));
}

// `secrets` with `accountUuid`'s entry set to `key`, the others kept.
export function withAccountKey(secrets: Secrets, accountUuid: string, key: AccountKey): Secrets {
  return { ...secrets, sessionKeys: { ...secrets.sessionKeys, [accountUuid]: key } };
}

// The move (ADR-0138 §12): the sidecar resolved the legacy key's Account.
// That Account's entry gets the key, set `setAt`; an Account that already has
// an entry keeps its own key, since the legacy one never overwrites it. The
// legacy key is dropped in the same write, so it goes only once its Account's
// entry is on disk. Nothing to move (no legacy key left) is `secrets` itself.
// The legacy entry never held an `orgId` here (ADR-0121's schema had none),
// so there is none to carry.
export function withLegacyMoved(secrets: Secrets, accountUuid: string, setAt: string): Secrets {
  const legacy = secrets.sessionKey;
  if (legacy === undefined) return secrets;
  const moved =
    secrets.sessionKeys?.[accountUuid] !== undefined
      ? secrets
      : withAccountKey(secrets, accountUuid, {
          value: legacy.value,
          kind: ACCOUNT_CREDENTIAL_KIND,
          setAt,
        });
  return { ...moved, sessionKey: undefined };
}

// Every Account's entry without its `orgId`: a push carrying them was
// acknowledged, so the history they name is stamped (#279, ADR-0104).
export function withoutOrgIds(secrets: Secrets): Secrets {
  if (secrets.sessionKeys === undefined) return secrets;
  const keys = Object.entries(secrets.sessionKeys);
  if (keys.every(([, key]) => key.orgId === undefined)) return secrets;
  return {
    ...secrets,
    sessionKeys: Object.fromEntries(
      keys.map(([uuid, key]) => [uuid, { value: key.value, kind: key.kind, setAt: key.setAt }]),
    ),
  };
}

// No key at all: the file loses `sessionKeys` rather than keeping `{}`, so
// clearing the last entry can still delete the file (ADR-0121 §4).
function normalized(secrets: Secrets): Secrets {
  let out = secrets;
  if (out.sessionKeys !== undefined && Object.keys(out.sessionKeys).length === 0) {
    out = { ...out, sessionKeys: undefined };
  }
  if (out.gateways !== undefined && Object.keys(out.gateways).length === 0) {
    out = { ...out, gateways: undefined };
  }
  return out;
}

function fileOf(env: Env): string {
  return secretsPath(dataDir(env));
}

// The file as a command finds it. No file is no secrets. A file it cannot use
// is never rewritten, since that would drop the other secret (ADR-0121 §4),
// so the command stops here with exit 1.
export function readSecretsForEdit(env: Env): Secrets {
  const path = fileOf(env);
  const read = readSecretFile(path, secretsSchema, FILE_OPTIONS);
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
  const next = normalized(edit(secrets));
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
  return loadSecretFileAtBoot(fileOf(env), secretsSchema, log, FILE_OPTIONS) ?? {};
}

export type SecretsHealth =
  // `loose` is the file's mode when group or other can reach it, else null.
  | { secrets: Secrets; loose: number | null }
  // Why the file cannot be used: unreadable, foreign or invalid.
  | { problem: string };

// What `status` says about the file, without changing it: never a throw.
export function secretsHealth(env: Env): SecretsHealth {
  const read = readSecretFile(fileOf(env), secretsSchema, FILE_OPTIONS);
  switch (read.kind) {
    case "absent":
      return { secrets: {}, loose: null };
    case "ok":
      return { secrets: read.value, loose: (read.mode & 0o077) !== 0 ? read.mode : null };
    default:
      return { problem: read.reason };
  }
}
