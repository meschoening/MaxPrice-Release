// Spawns one headless MaxPrice Hub (`apps/hub/src/index.ts serve`) from one
// checkout, sandboxed, for the acceptance harness's fleet phase (#296).
//
// Each side's Hub runs from its OWN tree: the baseline's Hub speaks protocol 4,
// the candidate's protocol 5, and a sidecar only ever talks to the Hub of its
// own side. The two are never crossed.
//
// Sandboxing, read off both trees' `apps/hub/src/{index,config,credstore}.ts`:
//   - Data directory: `MAXPRICE_HUB_DATA_DIR` (config.ts `defaultDataDir`).
//     Every file the Hub writes — hub.json, events.sqlite, the directories, the
//     roster, usage-history.jsonl — lands there.
//   - Port and interfaces: hub.json's `port` and `bind`. Unless the data
//     directory's hub.json already names a usable port (`hubConfigToWrite`),
//     the harness writes `{ port, bind: "loopback", passwordHash: null }` before
//     the spawn, so the Hub binds 127.0.0.1 alone (bind.ts: "loopback" → one
//     host) and never the production port 47100 or a tailnet address. The port
//     is the caller's, or one found free just before (`freeLoopbackPort`, which
//     never answers 47100), and `startHub` reads no handshake to learn it: a
//     Headless Hub prints no `LISTENING <port>` (ADR-0127 §9), so the port is
//     the one hub.json names.
//   - Lock: a tree with ADR-0127 §3's lock (#495) takes `<dataDir>/serve.lock`
//     on Linux and records its pid in it, then hub.json's port, before it
//     binds. `startHub` requires a record written after the spawn to name the
//     child it spawned and hub.json's port (`serveLockState`). A tree without
//     the lock (the baseline's `main`, which still prints `LISTENING`) writes
//     none, and is read on hub.json's port alone, as is a record an earlier
//     boot left that this child never rewrote.
//   - Bind ownership: before probing status, require this child's exact
//     `[hub] listening on http://127.0.0.1:<port>` line. Both trees print it
//     only after successfully binding. The lock and credential diagnostic
//     precede the bind, and a foreign listener could answer status meanwhile.
//   - Credential, by the Hub's key custody (ADR-0126 §1). Whichever it is, a
//     caller's `env` may set no SANDBOX_ENV_KEYS entry (sidecar-process.ts),
//     `MAXPRICE_CREDSTORE_PATH` among them, and `startHub` refuses to start a
//     Hub that resolves helpers while any of the three other paths
//     `resolveCredstorePath` takes one from (`credstoreHelperPaths`) holds a
//     real one (`reachableHelpers`).
//       - The keychain: off Linux, and on Linux in a tree from before #496 (a
//         `main` without it), the Hub keeps its claude.ai key in the OS
//         keychain through a Rust helper, which `resolveCredstorePath` finds
//         by `MAXPRICE_CREDSTORE_PATH`, then beside the Bun executable, then in
//         the tree's `apps/hub/credstore/target/{release,debug}`. With no helper
//         it falls back to a memory-only credstore and says so on stderr ("no
//         credstore helper found"). `StartHubOptions.credstore` (#348) is the
//         one sanctioned helper: a fake one written INSIDE the Hub's own data
//         directory, whose keychain is one file there, for which `startHub`
//         sets `MAXPRICE_CREDSTORE_PATH` and `MAXPRICE_CREDSTORE_ACCOUNT`
//         itself.
//       - The key file: on Linux since #496 the Hub keeps its key in
//         `<dataDir>/secrets.json` (0600), never resolves a helper (that
//         variable included) and never falls back to memory, so it never
//         prints that line. Once its first bind holds it prints one line on
//         stdout naming the file: `[hub] session key: none in <path>` or
//         `[hub] session key: from <path>, set <setAt> by <source>`.
//         `StartHubOptions.keyFile` seeds the file; the fake credstore does not
//         apply, and `startHub` refuses it on such a Hub at once.
//     Unseeded, `startHub` requires the memory line or the key-file line naming
//     this data directory's own file, and refuses one naming any other. So a
//     real keychain is provably never read or written, and the only key such a
//     Hub holds is one the harness gave it: pushed (`pushHubCredential`), in
//     memory or in its own data directory's file.
//   - Headless: `MAXPRICE_HUB_EMBEDDED` stays unset, so no CORS origin is
//     allowed and no parent watchdog is armed. Off Linux, or before #496, no
//     operator secret is minted; on Linux since #496 a Headless Hub mints one,
//     writes it to `<dataDir>/operator-token` (0600) before its first bind,
//     prints it nowhere, and deletes it at shutdown (ADR-0126 §8). On a tree
//     with the lock it also tightens its data directory to 0700. A headless
//     Hub is meant to outlive its spawner, so `stop()` and the CLI's cleanup
//     are the only things that end it.
//   - Clock and network: the same two preloads as a sidecar. The caller points
//     the Hub's poller at a fake claude.ai through `env`
//     (`MAXPRICE_CLAUDE_BASE_URL`), and every non-loopback fetch is refused.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ACCOUNT_CREDENTIAL_KIND,
  storedUsageCredentialSchema,
  type StoredUsageCredential,
} from "../../packages/shared/src/usage-limits";
import { hubSecretsSchema, OPERATOR_TOKEN_FILE, SECRETS_FILE } from "../../apps/hub/src/secrets";
import { type ClockOrigin } from "./clock";
import { PRODUCTION_HUB_PORT } from "./offline";
import { sandboxEnv, spawnPreloaded, writeFileIfChanged } from "./sidecar-process";

export interface HubHandle {
  readonly url: string; // http://127.0.0.1:<port>
  readonly dataDir: string;
  readonly log: () => string; // stdout+stderr captured so far
  stop(): Promise<void>;
}

/**
 * What `startHub` needs. Before it spawns, it writes exactly these:
 *   - `<dataDir>/` and `<dataDir>/home/` (the Hub's HOME), created if missing;
 *   - `<dataDir>/hub.json`, only when `hubConfigToWrite` says so: absent, or
 *     naming no usable port, or naming another port than `port`. A second boot
 *     on the same directory therefore writes nothing.
 * The Hub itself writes the rest of its directory (events.sqlite, the
 * directories, the roster, its usage history, serve.lock on a tree with the
 * lock, on Linux since #496 operator-token, and secrets.json once a key is
 * pushed, and on Linux since #502 update-check.json, its boot's update check)
 * once it runs.
 *
 * With `credstore`, three more, all inside `dataDir` (see `credstore` below).
 * With `keyFile`, one: `<dataDir>/secrets.json` (see `keyFile` below). Never
 * both: they are refused together before anything is written.
 *
 * Credentials: `MAXPRICE_CREDSTORE_PATH` is refused like every SANDBOX_ENV_KEYS
 * entry, and by default a Hub here holds only a key it is pushed: in memory
 * where it would keep it in a keychain, and in its own data directory's key
 * file on Linux since #496. A caller that needs a key on disk before the boot
 * asks for its custody's sanctioned seed, constrained to `dataDir`, rather than
 * lifting that refusal: `credstore` for a keychain's (an upgrade fixture's
 * legacy entry), `keyFile` for a key file's.
 */
export interface StartHubOptions {
  readonly tree: string; // checkout root: the Hub runs from this tree's code
  readonly dataDir: string; // MAXPRICE_HUB_DATA_DIR
  readonly clock: ClockOrigin;
  readonly env?: Record<string, string>;
  /** Synthetic password already hashed in this sandbox's hub.json, for readiness. */
  readonly password?: string;
  /** Additional sandbox-owned preloads, after the clock and offline guards. */
  readonly preloads?: readonly string[];
  /**
   * The loopback port to serve on. Omitted, an existing hub.json's usable port
   * is kept, and otherwise one is found free (`freeLoopbackPort`). Never the
   * production Hub's port (PRODUCTION_HUB_PORT, 47100): `startHub` refuses it.
   */
  readonly port?: number;
  /**
   * The one entry a fake keychain holds for this Hub (#348), for a fixture whose
   * upgrade starts from a credstore written before #283 — `{ sessionKey, orgId }`,
   * the evidence the Hub's boot stamp needs (ADR-0104). `startHub` then writes
   * the fake helper and its state into `dataDir` (`writeFakeCredstoreHelper`)
   * and points `MAXPRICE_CREDSTORE_PATH` at it itself. Read the entry back
   * afterwards with `readFakeCredstore`.
   *
   * Absent or null: nothing is written, neither variable is set, and the Hub is
   * memory-only exactly as before — the default every other caller gets.
   *
   * Only for a Hub that keeps its key in a keychain: a Linux Hub since #496
   * never resolves a helper (ADR-0126 §1), and `startHub` stops it and fails as
   * soon as it prints its key-file line.
   */
  readonly credstore?: StoredUsageCredential | null;
  /**
   * The one entry a Linux Hub's key file holds before its boot (#496, ADR-0126
   * §2): `startHub` writes `<dataDir>/secrets.json` exactly as the Hub writes it
   * (`hubKeyFileText`), mode 0600, and writes nothing when the file already
   * holds those bytes. The Hub is then ready only once its status holds a key
   * (`hubStatusHoldsKey`) and it prints `[hub] session key: from <that file>,
   * set <setAt> by <source>`, with this entry's setAt and source; a Hub that
   * prints the memory-only line instead keeps no key file, and is stopped at
   * once. The file carries no orgId, so the Hub's pre-#283 boot stamp
   * (ADR-0104) never runs on it. A legacy entry (no `accountUuid`) is moved
   * at boot when the Hub's claude.ai answers `/api/account` for it (ADR-0138
   * §12), rewriting the file; seed the Account's entry where a second boot
   * must find the same bytes.
   *
   * Absent or null: nothing is written. Refused together with `credstore`.
   */
  readonly keyFile?: HubKeyFileEntry | null;
}

/**
 * How long a spawned Hub has to be ready: the 20 s the `LISTENING` handshake
 * had and the 30 s readiness had after it, as one deadline.
 */
export const HUB_READY_TIMEOUT_MS = 50_000;
const HUB_REQUEST_TIMEOUT_MS = 30_000;

/** The stderr line a Hub prints when it holds its credential in memory only. */
export const MEMORY_CREDSTORE_LINE = "no credstore helper found";

/** The lock file a Headless Hub with ADR-0127 §3's lock keeps in its data directory. */
export const SERVE_LOCK_FILE = "serve.lock";

// ---------------------------------------------------------------------------
// A Linux Hub's key file (#496, ADR-0126)
//
// The file names and the schema are the candidate's own
// (`apps/hub/src/secrets.ts`). That holds for every tree the rigs boot today,
// since no released Hub keeps a key file yet. Once one does, an older Hub's
// custody line is still matched against these names, and its file predicted
// by this schema (`keyCustodyFromFile`), so a change to either must give the
// rig a reading per tree.

/** The file a Linux Hub keeps its claude.ai session key in, in its data directory (§1). */
export const HUB_KEY_FILE = SECRETS_FILE;

/** The file a Headless Hub on Linux keeps its per-launch operator secret in while it runs (§8). */
export { OPERATOR_TOKEN_FILE };

/** `<dataDir>/secrets.json`, spelled as the Hub names it in its custody line. */
export function hubKeyFilePath(dataDir: string): string {
  return join(dataDir, HUB_KEY_FILE);
}

/** `<dataDir>/operator-token`. */
export function operatorTokenPath(dataDir: string): string {
  return join(dataDir, OPERATOR_TOKEN_FILE);
}

/**
 * The one entry a Linux Hub's key file holds before a boot (ADR-0126 §2,
 * ADR-0138 §6), its value named as a credential's. With `accountUuid`, the
 * entry a v7 Hub writes for that Account's key; without it, the one legacy
 * key a v6 Hub wrote, which a v7 Hub reads and moves to its Account once
 * claude.ai's `/api/account` answers for it (ADR-0138 §12), so an upgrade
 * scenario seeds it, and a Hub whose fake claude.ai answers rewrites it.
 */
export interface HubKeyFileEntry {
  readonly sessionKey: string;
  /** The key's Account, as `/api/account` names it; absent: the legacy key. */
  readonly accountUuid?: string;
  /** When the key was set, an ISO instant. */
  readonly setAt: string;
  /** Who set it: `"local"` for a console or CLI push, else the healing client's machine id. */
  readonly source: string;
}

/**
 * A key file's bytes as the Hub writes them, indented, one newline: an
 * Account's key as `{ sessionKeys: { <uuid>: { value, kind, setAt, source } } }`
 * (v7), the legacy key as `{ sessionKey: { value, setAt, source } }` (v6).
 */
export function hubKeyFileText(entry: HubKeyFileEntry): string {
  if (entry.accountUuid !== undefined) {
    const sessionKeys = {
      [entry.accountUuid]: {
        value: entry.sessionKey,
        kind: ACCOUNT_CREDENTIAL_KIND,
        setAt: entry.setAt,
        source: entry.source,
      },
    };
    return `${JSON.stringify({ sessionKeys }, null, 2)}\n`;
  }
  const sessionKey = { value: entry.sessionKey, setAt: entry.setAt, source: entry.source };
  return `${JSON.stringify({ sessionKey }, null, 2)}\n`;
}

/**
 * Writes `entry` as `<dataDir>/secrets.json` (`hubKeyFileText`), mode 0600,
 * and nothing when the file already holds those bytes. A file already there is
 * tightened to 0600 before it is rewritten, and every time: chmod moves ctime,
 * not mtime, so "a second boot writes nothing" still holds byte- and
 * mtime-wise.
 */
function writeHubKeyFile(dataDir: string, entry: HubKeyFileEntry): void {
  const path = hubKeyFilePath(dataDir);
  const text = hubKeyFileText(entry);
  if (existsSync(path)) chmodSync(path, 0o600);
  if (readTextOrNull(path) !== text) writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** What every key-file custody line starts with. */
const KEY_CUSTODY_PREFIX = "[hub] session key: ";

/** What a v7 Hub's custody line starts with when its file holds several keys. */
const KEYS_CUSTODY_PREFIX = "[hub] session keys: ";

/**
 * The line a Linux Hub prints on stdout once its first bind holds, before its
 * routes open (ADR-0126 §5): the key file it read, and the key it holds from
 * it, if any; a v7 Hub holding several keys names only their count
 * (`several`). Never any part of a value, nor an Account.
 */
export type KeyCustodyLine =
  | { readonly kind: "none"; readonly path: string }
  | {
      readonly kind: "from";
      readonly path: string;
      readonly setAt: string;
      readonly source: string;
    }
  | { readonly kind: "several"; readonly path: string; readonly count: number };

/** A custody line exactly as the Hub prints it. */
export function keyCustodyText(line: KeyCustodyLine): string {
  if (line.kind === "several") return `${KEYS_CUSTODY_PREFIX}${line.count} from ${line.path}`;
  return line.kind === "none"
    ? `${KEY_CUSTODY_PREFIX}none in ${line.path}`
    : `${KEY_CUSTODY_PREFIX}from ${line.path}, set ${line.setAt} by ${line.source}`;
}

function parseKeyCustodyLine(line: string): KeyCustodyLine | null {
  if (line.startsWith(KEYS_CUSTODY_PREFIX)) {
    const several = /^(\d+) from (.+)$/.exec(line.slice(KEYS_CUSTODY_PREFIX.length));
    return several === null
      ? null
      : { kind: "several", path: several[2]!, count: Number(several[1]) };
  }
  if (!line.startsWith(KEY_CUSTODY_PREFIX)) return null;
  const rest = line.slice(KEY_CUSTODY_PREFIX.length);
  if (rest.startsWith("none in ")) {
    const path = rest.slice("none in ".length);
    return path === "" ? null : { kind: "none", path };
  }
  const from = /^from (.+), set (\S+) by (.+)$/.exec(rest);
  if (from === null) return null;
  return { kind: "from", path: from[1]!, setAt: from[2]!, source: from[3]! };
}

/**
 * Every whole custody line in a Hub's `log`, split by the file it names: `own`
 * names `<dataDir>/secrets.json` exactly, `foreign` any other path. Only whole
 * lines count: the text after the last newline is one the pipe has not
 * finished delivering, and a path cut short there would name another file.
 */
export function keyCustodyLines(
  log: string,
  dataDir: string,
): { own: KeyCustodyLine[]; foreign: KeyCustodyLine[] } {
  const ownPath = hubKeyFilePath(dataDir);
  const own: KeyCustodyLine[] = [];
  const foreign: KeyCustodyLine[] = [];
  for (const raw of log.split("\n").slice(0, -1)) {
    const line = parseKeyCustodyLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    if (line !== null) (line.path === ownPath ? own : foreign).push(line);
  }
  return { own, foreign };
}

/**
 * The custody line a Linux Hub prints at a boot that finds `text` at `path`
 * (null: no file), when the text is a file the Hub's own schema
 * (`hubSecretsSchema`) accepts: `from` with the one key's setAt and source,
 * `several` with the count when it holds more (the legacy key and every
 * Account's), and `none in` when it holds none or is invalid, since the Hub
 * skips an invalid file and boots keyless (ADR-0126 §5). A rig that reads the
 * file before a spawn knows the line that boot must print.
 */
export function keyCustodyFromFile(path: string, text: string | null): KeyCustodyLine {
  const none: KeyCustodyLine = { kind: "none", path };
  if (text === null) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return none;
  }
  const secrets = hubSecretsSchema.safeParse(parsed);
  if (!secrets.success) return none;
  const held = [
    ...Object.values(secrets.data.sessionKeys ?? {}),
    ...(secrets.data.sessionKey === undefined ? [] : [secrets.data.sessionKey]),
  ];
  if (held.length === 0) return none;
  if (held.length > 1) return { kind: "several", path, count: held.length };
  const { setAt, source } = held[0]!;
  return { kind: "from", path, setAt, source };
}

/**
 * What `<dataDir>/serve.lock` says of a Hub spawned as `pid` whose hub.json
 * names `port`, from the file's text now and just before the spawn (null when
 * absent). The holder writes its pid and a newline, then rewrites it as the pid
 * and the port, each on its own line, once it has loaded hub.json, which is
 * before it binds (`packages/usage-core/src/serve-lock.ts`):
 *   - none: absent, or exactly as before the spawn. A tree without the lock
 *     writes none, and one that has not taken it yet has not rewritten it; a
 *     record an earlier boot left is not this child's.
 *   - pending: rewritten, but not yet a whole record with a port: the pid
 *     alone, or a read between the holder's truncate and its write.
 *   - recorded: the child's pid and hub.json's port.
 *   - wrong: a whole record naming another pid, or the child's with another
 *     port.
 */
export type ServeLockState =
  | { readonly kind: "none" }
  | { readonly kind: "pending"; readonly text: string }
  | { readonly kind: "recorded"; readonly port: number }
  | { readonly kind: "wrong"; readonly why: string };

export function serveLockState(
  now: string | null,
  before: string | null,
  pid: number,
  port: number,
): ServeLockState {
  if (now === null || now === before) return { kind: "none" };
  const record = /^(\d+)\n(?:(\d+)\n)?$/.exec(now);
  if (record === null) return { kind: "pending", text: now };
  const holder = Number(record[1]);
  if (holder !== pid) {
    return {
      kind: "wrong",
      why: `${SERVE_LOCK_FILE} names pid ${holder}, not the spawned Hub's ${pid}`,
    };
  }
  if (record[2] === undefined) return { kind: "pending", text: now };
  const recorded = Number(record[2]);
  if (recorded !== port) {
    return {
      kind: "wrong",
      why: `${SERVE_LOCK_FILE} records port ${recorded}, not its hub.json's ${port}`,
    };
  }
  return { kind: "recorded", port: recorded };
}

/** A file's text, or null when it cannot be read (absent, most often). */
export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The three paths the Hub's `resolveCredstorePath` would take a keychain helper
 * from, apart from `MAXPRICE_CREDSTORE_PATH` (never set here): beside the Bun
 * executable that runs it, and the tree's own release and debug cargo builds.
 */
export function credstoreHelperPaths(tree: string): string[] {
  const exe = `maxprice-credstore${process.platform === "win32" ? ".exe" : ""}`;
  return [
    join(dirname(process.execPath), exe),
    ...["release", "debug"].map((profile) =>
      join(tree, "apps", "hub", "credstore", "target", profile, exe),
    ),
  ];
}

/**
 * The keychain helpers that exist where a Hub from `tree` would look for one,
 * which `startHub` refuses. None on a Linux tree since #496: such a Hub keeps
 * its key in its data dir's key file and resolves no helper at all (ADR-0126
 * §1), and `startHub` requires its key-file line naming that file, so a helper
 * built into the tree (the User guide capture runs where `build:credstore` may
 * have) is out of its reach. A tree without the key file (`apps/hub/src/secrets.ts`)
 * is judged by every path `credstoreHelperPaths` names.
 */
export function reachableHelpers(
  tree: string,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): string[] {
  if (platform === "linux" && exists(join(tree, "apps", "hub", "src", "secrets.ts"))) return [];
  return credstoreHelperPaths(tree).filter((path) => exists(path));
}

// ---------------------------------------------------------------------------
// The sanctioned fake credstore (#348)
//
// `MAXPRICE_CREDSTORE_PATH` stays on SANDBOX_ENV_KEYS, so a caller still cannot
// point a Hub at a keychain helper; `startHub` sets it, to a helper it wrote
// itself inside the Hub's own data directory. The helper's "keychain" is one
// file in that directory, so nothing outside it is read or written, and the real
// OS keychain is as untouched as under the memory-only default.

/**
 * The state file: the legacy keychain slot's value verbatim (`usage-credential`,
 * and the bare form that names no account). Absent means no entry.
 */
const FAKE_CREDSTORE_STATE = "fake-credstore.json";
/**
 * Every other entry the fake keychain holds, one per account argument
 * (`usage-credential/<uuid>`, ADR-0138 §6), as one JSON map from account name
 * to value. Absent means none; written only when such an entry is first set.
 */
const FAKE_CREDSTORE_ACCOUNTS = "fake-credstore-accounts.json";
/**
 * With `opsLog`, every call the helper served, one line each, `<verb>
 * <account>` (the bare form as `usage-credential`): the order a rig reads a
 * move in. Names entries only, never a value.
 */
const FAKE_CREDSTORE_OPS = "fake-credstore-ops.log";
/** Successful `get` receipt, cleared before each Hub launch; carries no credential. */
const FAKE_CREDSTORE_READ = "fake-credstore-read";
/** The helper itself, run by Bun. On POSIX it is argv[0] (shebang + 0o755). */
const FAKE_CREDSTORE_SCRIPT = "fake-credstore.ts";
/**
 * win32 only: argv[0] there. `spawnRunner` execs `helperPath` directly
 * (`Bun.spawn([helperPath, ...args])`), and Windows cannot exec a shebang, so a
 * one-line `.cmd` hands the script to Bun. Measured on Windows 11 before this
 * was built on: argv, stdin to EOF, stdout without a trailing newline and the
 * exit codes 0/2/3 all cross the shim intact.
 */
const FAKE_CREDSTORE_SHIM = "fake-credstore.cmd";

/**
 * The keychain account a fake-credstore Hub is given. The fake helper ignores it
 * — the bare form's slot is its own file — so this is defence in depth: were a
 * real `maxprice-credstore` somehow to run in this environment, it would read
 * and write this account rather than the production `usage-credential` slot.
 */
export const FAKE_CREDSTORE_ACCOUNT = "maxprice-acceptance-348";

/** Where the fake credstore keeps its legacy entry: `<dataDir>/fake-credstore.json`. */
export function fakeCredstoreStatePath(dataDir: string): string {
  return join(dataDir, FAKE_CREDSTORE_STATE);
}

/** Where the fake credstore keeps every other entry: `<dataDir>/fake-credstore-accounts.json`. */
export function fakeCredstoreAccountsPath(dataDir: string): string {
  return join(dataDir, FAKE_CREDSTORE_ACCOUNTS);
}

/** Where a helper written with `opsLog` logs each call: `<dataDir>/fake-credstore-ops.log`. */
export function fakeCredstoreOpsPath(dataDir: string): string {
  return join(dataDir, FAKE_CREDSTORE_OPS);
}

/** The read receipt a successful `get` leaves: `<dataDir>/fake-credstore-read`. */
export function fakeCredstoreReadPath(dataDir: string): string {
  return join(dataDir, FAKE_CREDSTORE_READ);
}

/** The files the fake helper itself writes beside its state, for a rig to remove after it. */
export function fakeCredstoreHelperFiles(dataDir: string): string[] {
  return [
    join(dataDir, FAKE_CREDSTORE_SCRIPT),
    join(dataDir, FAKE_CREDSTORE_SHIM),
    fakeCredstoreOpsPath(dataDir),
    fakeCredstoreReadPath(dataDir),
  ];
}

/** What `MAXPRICE_CREDSTORE_PATH` names for a fake credstore in `dir`. */
export function fakeCredstoreHelperPath(dir: string): string {
  return join(dir, process.platform === "win32" ? FAKE_CREDSTORE_SHIM : FAKE_CREDSTORE_SCRIPT);
}

/**
 * The fake helper's source, with its state path baked in.
 *
 * It speaks the Rust helper's protocol exactly (`apps/hub/credstore/src/main.rs`,
 * as `apps/hub/src/credstore.ts` reads it): `<verb> [<account>]`, the account
 * `usage-credential` or `usage-credential/<8-64 hex digits and dashes>`
 * (ADR-0138 §6), the bare form the legacy one;
 *   - `get`: the secret on stdout, no trailing newline, exit 0; exit 3 when
 *     there is no entry (Rust's `keyring::Error::NoEntry`);
 *   - `set`: stdin read to EOF, every trailing newline stripped (Rust's
 *     `trim_end_matches('\n')` strips all of them, not one), stored, exit 0;
 *   - `delete`: the entry removed, exit 0 even when there was none;
 *   - anything else, argv[1] included when absent, or an account the real
 *     helper refuses: usage on stderr, exit 2.
 * The secret never crosses argv, there as here. The legacy entry is the state
 * file itself, as v0.9.2's single-slot fake wrote it, so a fixture's slot is
 * read as it stands; every other account is one key of the accounts map.
 *
 * `statePath` is a parameter only so the confinement guard below can be
 * exercised; `writeFakeCredstoreHelper` defaults it to the sanctioned path.
 */
function fakeCredstoreHelperSource(statePath: string, opsLog: boolean): string {
  return `#!/usr/bin/env bun
// WRITTEN BY scripts/acceptance/hub-process.ts — a fake keychain for ONE
// harness Hub, inside that Hub's data directory. Never part of the product.
import { appendFileSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Baked in at write time, so it is already inside this script's own directory.
const STATE = ${JSON.stringify(statePath)};

// Both sides canonical before they are compared: Bun reports import.meta.dir
// with every symlink resolved, while STATE keeps the spelling it was written
// with — macOS's tmpdir() is /var/folders/..., and /var links to /private/var.
// A directory that cannot be resolved (it does not exist) is null, so it
// matches nothing; this helper's own directory always exists.
const canonical = (path: string): string | null => {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
};

// Defence in depth: a copy of this helper whose baked path was tampered with
// refuses loudly instead of reading or writing a file somewhere else. The real
// helper's MAXPRICE_CREDSTORE_ACCOUNT has no meaning here — the file IS the slot.
const stateDir = canonical(dirname(STATE));
if (stateDir === null || stateDir !== canonical(import.meta.dir)) {
  process.stderr.write(
    \`fake-credstore: refusing \${STATE}: outside this helper's own directory \${import.meta.dir}\\n\`,
  );
  process.exit(2);
}

const LEGACY = "usage-credential";
const ACCOUNTS = join(import.meta.dir, ${JSON.stringify(FAKE_CREDSTORE_ACCOUNTS)});
const usage = (): never => {
  process.stderr.write("usage: fake-credstore <get|set|delete> [<account>]\\n");
  process.exit(2);
};
const op = process.argv[2] ?? "";
if (process.argv.length > 4) usage();
const account = process.argv[3] ?? LEGACY;
if (account !== LEGACY && !/^usage-credential\\/[0-9a-fA-F-]{8,64}$/.test(account)) usage();
if (!["get", "set", "delete"].includes(op)) usage();
${
  opsLog
    ? `appendFileSync(join(import.meta.dir, ${JSON.stringify(FAKE_CREDSTORE_OPS)}), \`\${op} \${account}\\n\`);`
    : "// No ops log for this helper."
}
const readAccounts = (): Record<string, string> =>
  existsSync(ACCOUNTS) ? (JSON.parse(readFileSync(ACCOUNTS, "utf8")) as Record<string, string>) : {};
const writeAccounts = (next: Record<string, string>): void => {
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(ACCOUNTS, JSON.stringify(sorted));
};
if (op === "get") {
  if (account === LEGACY) {
    if (!existsSync(STATE)) process.exit(3); // NoEntry
    await Bun.write(Bun.stdout, readFileSync(STATE));
  } else {
    const value = readAccounts()[account];
    if (value === undefined) process.exit(3); // NoEntry
    await Bun.write(Bun.stdout, value);
  }
  writeFileSync(join(import.meta.dir, ${JSON.stringify(FAKE_CREDSTORE_READ)}), "get\\n");
  process.exit(0);
}
if (op === "set") {
  const secret = (await new Response(Bun.stdin.stream()).text()).replace(/\\n+$/, "");
  if (account === LEGACY) writeFileSync(STATE, secret);
  else writeAccounts({ ...readAccounts(), [account]: secret });
  process.exit(0);
}
// delete
if (account === LEGACY) {
  if (existsSync(STATE)) rmSync(STATE);
} else if (existsSync(ACCOUNTS)) {
  const { [account]: _gone, ...rest } = readAccounts();
  writeAccounts(rest);
}
process.exit(0);
`;
}

/**
 * Writes the fake helper into `dir` and returns the path to exec. Writes no
 * state: an absent state file is a keychain with no entry, which is what the
 * helper's exit 3 means.
 *
 * `statePath` defaults to `<dir>/fake-credstore.json`, the only path the helper
 * accepts; a test passes another to exercise the confinement guard.
 */
export function writeFakeCredstoreHelper(
  dir: string,
  statePath: string = fakeCredstoreStatePath(dir),
  opts: { opsLog?: boolean } = {},
): string {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, FAKE_CREDSTORE_SCRIPT);
  writeFileIfChanged(script, fakeCredstoreHelperSource(statePath, opts.opsLog === true));
  if (process.platform === "win32") {
    // Bun's own absolute path, so the shim does not depend on PATH (the POSIX
    // shebang's `env bun` does, through the PATH `sandboxEnv` passes through).
    // CRLF, `@` so cmd echoes nothing, and `%~dp0` so the shim never carries a
    // literal path of its own. `%*` forwards `get`/`set`/`delete`.
    const shim = join(dir, FAKE_CREDSTORE_SHIM);
    writeFileIfChanged(shim, `@"${process.execPath}" "%~dp0${FAKE_CREDSTORE_SCRIPT}" %*\r\n`);
    return shim;
  }
  // chmod every time: it changes ctime, not mtime, so "a second boot writes
  // nothing" still holds byte- and mtime-wise.
  chmodSync(script, 0o755);
  return script;
}

/**
 * The entry a fake credstore in `dataDir` holds now, parsed the way the Hub's
 * own `credstore.get()` parses it (`storedUsageCredentialSchema`) — so a
 * scenario can assert a legacy `{ sessionKey, orgId }` became key-only after the
 * Hub's boot migration (ADR-0104).
 *
 * No state file means no entry: null. A state file that is not a credential
 * throws instead, because a harness that cannot read what it seeded has a fault,
 * not a verdict (the Hub itself treats that as "not configured").
 */
export function readFakeCredstore(dataDir: string): StoredUsageCredential | null {
  const path = fakeCredstoreStatePath(dataDir);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`readFakeCredstore: ${path} is not JSON: ${text}`);
  }
  const entry = storedUsageCredentialSchema.safeParse(parsed);
  if (!entry.success) {
    throw new Error(`readFakeCredstore: ${path} is not a stored credential: ${text}`);
  }
  return entry.data;
}

/** A port held on 127.0.0.1 until `stop()`. */
export interface LoopbackProbe {
  readonly port: number;
  stop(): Promise<void>;
}

/** Binds 127.0.0.1 on `port` (0: any free port); throws when it cannot. */
export function bindLoopback(port: number): LoopbackProbe {
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
  if (server.port === undefined) throw new Error("bindLoopback: the probe bound no port");
  return { port: server.port, stop: () => server.stop(true) };
}

/** How many ports `freeLoopbackPort` may be handed before it gives up. */
const FREE_PORT_ATTEMPTS = 5;

/**
 * A loopback port free right now: bound once, read, released. Never the
 * production Hub's port (PRODUCTION_HUB_PORT): an OS whose ephemeral range
 * holds 47100 (Linux's does) may hand it out, and a harness Hub there is one a
 * sidecar could mistake for the real one. Such a port is held while another is
 * bound, so it cannot come back, and then released. `bind` is injectable for
 * tests.
 */
export async function freeLoopbackPort(
  bind: (port: number) => LoopbackProbe = bindLoopback,
): Promise<number> {
  const held: LoopbackProbe[] = [];
  try {
    for (let attempt = 0; attempt < FREE_PORT_ATTEMPTS; attempt++) {
      const probe = bind(0);
      held.push(probe);
      if (probe.port !== PRODUCTION_HUB_PORT) return probe.port;
    }
    throw new Error(
      `freeLoopbackPort: handed the production Hub's port ${FREE_PORT_ATTEMPTS} times running`,
    );
  } finally {
    await Promise.all(held.map((probe) => probe.stop()));
  }
}

/** Whether 127.0.0.1:`port` can be bound right now. */
async function loopbackPortFree(port: number): Promise<boolean> {
  let probe: LoopbackProbe;
  try {
    probe = bindLoopback(port);
  } catch {
    return false;
  }
  await probe.stop();
  return true;
}

/** hub.json as `startHub` writes it fresh: loopback only, no password. */
export function freshHubConfig(port: number): Record<string, unknown> {
  return { port, bind: "loopback", passwordHash: null };
}

/** A port a harness Hub may serve on: an integer port, on loopback, and not the production one. */
function usablePort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65535 &&
    value !== PRODUCTION_HUB_PORT
  );
}

/**
 * What `startHub` must write to hub.json, given the file's current text (null
 * when absent), the caller's `port` (if any), and whether a port is free. Null
 * means write nothing: the file already names a usable port on loopback (the
 * caller's own, when given), so a second boot on the same directory leaves it
 * untouched.
 *
 * Otherwise an existing file keeps every key but `port` and `bind` (its
 * password hash included, which is the caller's to keep or not), and a missing
 * one is `freshHubConfig`. A file that is not a JSON object is refused: the Hub
 * would read it as its defaults, port 47100 on the tailnet.
 */
export async function hubConfigToWrite(
  existing: string | null,
  requestedPort: number | undefined,
  isFree: (port: number) => Promise<boolean> = loopbackPortFree,
  freePort: () => Promise<number> = () => freeLoopbackPort(),
): Promise<{ port: number; write: Record<string, unknown> | null }> {
  if (requestedPort !== undefined && !usablePort(requestedPort)) {
    throw new Error(
      `startHub: port ${requestedPort} is not a usable harness port` +
        (requestedPort === PRODUCTION_HUB_PORT ? " (the production Hub's)" : ""),
    );
  }
  if (existing === null) {
    const port = requestedPort ?? (await freePort());
    return { port, write: freshHubConfig(port) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "startHub: the data directory's hub.json is not a JSON object, and the Hub would read " +
        `it as its defaults (port ${PRODUCTION_HUB_PORT} on the tailnet); refusing to start`,
    );
  }
  const config = parsed as Record<string, unknown>;
  const onLoopback = config.bind === "loopback";
  if (requestedPort !== undefined) {
    if (onLoopback && config.port === requestedPort) return { port: requestedPort, write: null };
    return { port: requestedPort, write: { ...config, port: requestedPort, bind: "loopback" } };
  }
  if (onLoopback && usablePort(config.port) && (await isFree(config.port))) {
    return { port: config.port, write: null };
  }
  const port = await freePort();
  return { port, write: { ...config, port, bind: "loopback" } };
}

/**
 * The headers that send a password-protected Hub its Hub password, which it
 * asks of every `/api/*` route (ADR-0037): `Authorization: Bearer <password>`,
 * or none when no password is given. An open Hub ignores a presented one, so a
 * helper given none behaves exactly as it did before the option existed.
 */
export function hubPasswordHeaders(password: string | undefined): Record<string, string> {
  return password === undefined ? {} : { authorization: `Bearer ${password}` };
}

async function getJson(url: string, password?: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(HUB_REQUEST_TIMEOUT_MS),
    headers: hubPasswordHeaders(password),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/**
 * Starts one headless Hub and resolves once it is ready: it is still running,
 * it has logged a successful loopback bind, `GET /api/status` answers on
 * hub.json's port (every `/api/*` route waits on
 * the Hub's boot sequence: history load, archive load, credential seed), a
 * serve.lock it wrote names it and that port, and its credential is provably
 * the harness's — memory-only or its own data directory's key file, the fake
 * credstore's entry, or the seeded key file's. Writes only what
 * `StartHubOptions` lists, and only after the seeds, the caller's `env`, the
 * credstore helpers and the port have passed.
 */
export async function startHub(opts: StartHubOptions): Promise<HubHandle> {
  const seeded = opts.credstore ?? null;
  const keyFile = opts.keyFile ?? null;
  // First, before anything is written: one custody's seed at a time.
  if (seeded !== null && keyFile !== null) {
    throw new Error(
      "startHub: credstore and keyFile were both asked for, but a Hub keeps its key in one " +
        "custody (ADR-0126 §1): a keychain's (credstore) off Linux, its data dir's key file " +
        "(keyFile) on Linux",
    );
  }
  // Then `sandboxEnv` refuses a caller's `env` that sets any SANDBOX_ENV_KEYS
  // entry (MAXPRICE_HUB_DATA_DIR and both MAXPRICE_CREDSTORE_* keys among
  // them); the harness's own are added after.
  const env: Record<string, string> = {
    ...sandboxEnv(opts.dataDir, opts.clock, opts.env),
    MAXPRICE_HUB_DATA_DIR: opts.dataDir,
    // A Headless Hub on Linux checks its update channel at boot (ADR-0129 §6).
    // The Hub runs under the offline preload (spawnPreloaded), which refuses
    // that fetch first, since the channel is not loopback, so it records a
    // failed check; this unroutable proxy is only a backstop, should the
    // preload ever let an HTTPS request through. The fake claude.ai is
    // plain-HTTP loopback, which HTTPS_PROXY does not touch.
    HTTPS_PROXY: "http://127.0.0.1:9",
    // Both inside `dataDir`, and set only when a fake credstore was asked for:
    // without one the Hub resolves no helper at all and stays memory-only.
    // First in `resolveCredstorePath`'s order, so the Hub can reach no other
    // helper even if one appeared beside Bun mid-run.
    ...(seeded === null
      ? {}
      : {
          MAXPRICE_CREDSTORE_PATH: fakeCredstoreHelperPath(opts.dataDir),
          MAXPRICE_CREDSTORE_ACCOUNT: FAKE_CREDSTORE_ACCOUNT,
        }),
  };
  const helpers = reachableHelpers(opts.tree);
  if (helpers.length > 0) {
    throw new Error(
      `refusing to start the Hub from ${opts.tree}: a credstore helper exists at ` +
        `${helpers.join(", ")}, and the Hub would read and write the real OS keychain through it`,
    );
  }
  const configPath = join(opts.dataDir, "hub.json");
  const { port, write } = await hubConfigToWrite(
    existsSync(configPath) ? readFileSync(configPath, "utf8") : null,
    opts.port,
  );
  mkdirSync(opts.dataDir, { recursive: true });
  // Spelled as the Hub's own `loadOrInitConfig` normalizes it, so a fresh file
  // is one the Hub does not rewrite at boot either.
  if (write !== null) writeFileIfChanged(configPath, `${JSON.stringify(write, null, 2)}\n`);
  if (seeded !== null) {
    // The helper, then its one entry: the bytes a keychain slot would hold, which
    // is what the helper's `get` prints and the Hub's `credstore.get()` parses.
    // `writeFileIfChanged` as everywhere else, so a second boot handed the entry
    // the first boot's migration left behind writes nothing.
    writeFakeCredstoreHelper(opts.dataDir);
    writeFileIfChanged(fakeCredstoreStatePath(opts.dataDir), JSON.stringify(seeded));
  }
  if (keyFile !== null) writeHubKeyFile(opts.dataDir, keyFile);
  mkdirSync(env.HOME!, { recursive: true });

  // Read before the spawn: a record already here is an earlier boot's, which
  // this child has not written (`serveLockState`).
  const lockPath = join(opts.dataDir, SERVE_LOCK_FILE);
  const lockBefore = readTextOrNull(lockPath);
  // A previous boot's helper read cannot establish this child's custody.
  const helperReadPath = join(opts.dataDir, FAKE_CREDSTORE_READ);
  if (seeded !== null) rmSync(helperReadPath, { force: true });
  const child = spawnPreloaded({
    entry: join(opts.tree, "apps", "hub", "src", "index.ts"),
    args: ["serve"],
    cwd: opts.tree,
    env,
    preloads: opts.preloads,
  });
  const exit: { code: number | null } = { code: null };
  const exited = child.exited.then((code) => {
    exit.code = code;
  });
  const fail = async (why: string): Promise<never> => {
    await child.stop();
    throw new Error(`Hub from ${opts.tree} ${why}. Its log:\n${child.log()}`);
  };

  // Both trees log this exact line from the successful boot bind snapshot.
  // It comes from the child's captured pipe, so a foreign /api/status cannot
  // substitute for the child's bind. Neither the lock nor the credential
  // diagnostic suffices: both are written before binding. Only probe AFTER
  // this signal; a response already fetched before it might be foreign too.
  const boundLine = `[hub] listening on http://127.0.0.1:${port}`;
  const hasBound = (): boolean => child.log().split(/\r?\n/).includes(boundLine);
  //
  // A child that exits is refused at once, with its code and its log: exit 5 is
  // a lock another Hub holds, exit 1 a failed first bind.
  //
  // The lock is checked on every pass. A tree with the lock records its port
  // before it binds, so after the bind a record it
  // wrote is whole; it must name the child and hub.json's port, and the URL
  // takes the port it records. A record still holding the pid alone is not
  // ready yet. A tree without the lock leaves the file as it was before the
  // spawn, and is read on hub.json's port. A record naming another pid or port
  // is refused as soon as it is seen.
  //
  // Then the credential, three ways.
  //
  // Unseeded (no `credstore`, no `keyFile`): `GET /api/status` answers and the
  // log carries the Hub's own statement of where it keeps its key: either
  // MEMORY_CREDSTORE_LINE (it resolved no helper), or, on Linux since #496, the
  // custody line naming THIS data directory's key file, in either form (`from`
  // is a key an earlier boot here was pushed). The custody line is printed just
  // before the routes open, so the pipe can deliver it after a 200: a 200
  // without it is not ready yet, never a refusal.
  //
  // With a fake credstore the memory line can never appear: a helper WAS
  // resolved. And the Hub logs nothing at all when one resolves
  // (`apps/hub/src/index.ts` warns only when none resolves), so there
  // is no positive line to wait for. Require the fake helper's successful-get
  // receipt from THIS launch as well as the Hub's observable state:
  //   - `GET /api/status` answering 200 means `runReadySequence` has resolved
  //     (every `/api/*` route awaits it, `server.ts`), and that sequence
  //     awaits the selected store's `get()`. A key file can supply that key,
  //     so a status that holds a key alone does not prove a helper read;
  //   - the receipt is written only after the helper reads and prints its
  //     entry, and is cleared before every spawn, including a restart;
  //   - MEMORY_CREDSTORE_LINE and key-file custody lines must be absent;
  //   - the real OS keychain is still provably untouched: every
  //     `credstoreHelperPaths` entry is refused above for a Hub that resolves
  //     helpers (`reachableHelpers`), `MAXPRICE_CREDSTORE_PATH` is first in
  //     `resolveCredstorePath`'s order and names a helper inside `dataDir` whose
  //     only slot is a file there, and `MAXPRICE_CREDSTORE_ACCOUNT` names a
  //     fixture account rather than the production slot.
  //
  // With a key file: a status that holds a key, the custody line `from` this
  // data directory's file with the seeded entry's setAt and source (so it is
  // the seed the Hub read), and no MEMORY_CREDSTORE_LINE.
  //
  // A custody line is printed once per boot, so some are final at once, and
  // the Hub is stopped and refused rather than waited out (`custodyRefusal`):
  // one naming another data directory's key file; any at all with `credstore`
  // asked (a Linux Hub never resolves a helper, so the fake one is never read);
  // and with `keyFile` asked, the memory line (its tree keeps no key file) or a
  // line on its own file other than the seeded entry's.
  const ownKeyFile = hubKeyFilePath(opts.dataDir);
  const seededLine =
    keyFile === null
      ? null
      : keyCustodyText({
          kind: "from",
          path: ownKeyFile,
          setAt: keyFile.setAt,
          source: keyFile.source,
        });
  const custodyRefusal = (): string | null => {
    const log = child.log();
    const { own, foreign } = keyCustodyLines(log, opts.dataDir);
    if (foreign.length > 0) {
      return (
        `printed "${keyCustodyText(foreign[0]!)}", naming another data dir's key file than ` +
        `its own ${ownKeyFile}`
      );
    }
    if (seeded !== null && own.length > 0) {
      return (
        `printed "${keyCustodyText(own[0]!)}" with a fake credstore asked for: a Linux Hub ` +
        `keeps its key in ${HUB_KEY_FILE} and never resolves a credstore helper (ADR-0126 §1), ` +
        "so the fake credstore does not apply; seed `keyFile` instead"
      );
    }
    if (seededLine !== null) {
      if (log.includes(MEMORY_CREDSTORE_LINE)) {
        return (
          `printed "${MEMORY_CREDSTORE_LINE}" with \`keyFile\` asked for: its tree keeps no key ` +
          `file, so it never reads ${ownKeyFile} (ADR-0126 §1 holds on Linux since #496)`
        );
      }
      const other = own.map(keyCustodyText).find((line) => line !== seededLine);
      if (other !== undefined) {
        return `printed "${other}", not "${seededLine}": it did not read the key file seeded at ${ownKeyFile}`;
      }
    }
    return null;
  };
  const custodyReady = (holdsKey: boolean): boolean => {
    const log = child.log();
    const memoryOnly = log.includes(MEMORY_CREDSTORE_LINE);
    const { own } = keyCustodyLines(log, opts.dataDir);
    if (seededLine !== null) {
      return holdsKey && !memoryOnly && own.some((l) => keyCustodyText(l) === seededLine);
    }
    if (seeded !== null) {
      return (
        holdsKey && !memoryOnly && own.length === 0 && readTextOrNull(helperReadPath) === "get\n"
      );
    }
    return memoryOnly || own.length > 0;
  };
  const deadline = Date.now() + HUB_READY_TIMEOUT_MS;
  let answered = false;
  let holdsKey = false;
  let lock: ServeLockState = { kind: "none" };
  while (Date.now() < deadline) {
    if (exit.code !== null) return fail(`exited with code ${exit.code} before it was ready`);
    lock = serveLockState(readTextOrNull(lockPath), lockBefore, child.pid, port);
    if (lock.kind === "wrong") return fail(lock.why);
    const refused = custodyRefusal();
    if (refused !== null) return fail(refused);
    if (!hasBound()) {
      await Promise.race([Bun.sleep(100), exited]);
      continue;
    }
    answered = false;
    holdsKey = false;
    try {
      const probe = await getJson(`http://127.0.0.1:${port}/api/status`, opts.password);
      answered = probe.status === 200;
      holdsKey = answered && hubStatusHoldsKey(probe.body);
    } catch {
      // Not answering yet.
    }
    lock = serveLockState(readTextOrNull(lockPath), lockBefore, child.pid, port);
    if (lock.kind === "wrong") return fail(lock.why);
    if (answered && lock.kind !== "pending" && exit.code === null) {
      if (custodyReady(holdsKey)) {
        return {
          url: `http://127.0.0.1:${lock.kind === "recorded" ? lock.port : port}`,
          dataDir: opts.dataDir,
          log: child.log,
          stop: child.stop,
        };
      }
    }
    await Promise.race([Bun.sleep(100), exited]);
  }
  if (exit.code !== null) return fail(`exited with code ${exit.code} before it was ready`);
  if (!hasBound()) return fail(`never logged "${boundLine}" within ${HUB_READY_TIMEOUT_MS} ms`);
  if (!answered) return fail(`answered no GET /api/status within ${HUB_READY_TIMEOUT_MS} ms`);
  if (lock.kind === "pending") {
    return fail(
      `never recorded pid ${child.pid} and port ${port} in ${SERVE_LOCK_FILE} within ` +
        `${HUB_READY_TIMEOUT_MS} ms: it reads ${JSON.stringify(lock.text)}`,
    );
  }
  const refused = custodyRefusal();
  if (refused !== null) return fail(refused);
  if (seededLine !== null) {
    return fail(
      `never reported a key in its status with "${seededLine}", so it did not read the ` +
        `key file seeded at ${ownKeyFile}`,
    );
  }
  return fail(
    seeded === null
      ? `printed neither "${MEMORY_CREDSTORE_LINE}" nor "${KEY_CUSTODY_PREFIX}none in|from ` +
          `${ownKeyFile}", so its key may be neither memory-only nor in its own data dir`
      : "never reported a key in its status with a successful helper get receipt, " +
          "so it did not read the fake credstore's entry " +
          `at ${fakeCredstoreStatePath(opts.dataDir)} through ` +
          `${fakeCredstoreHelperPath(opts.dataDir)}`,
  );
}

/**
 * The Hub's own status (`GET /api/status`, HubStatus in its own tree's shape).
 * `password`, here, in `pushHubCredential` and in `hubRows`, is a protected
 * Hub's, sent as `Bearer <password>`; a caller of an open Hub gives none.
 */
export async function hubStatus(
  hub: HubHandle,
  password?: string,
): Promise<Record<string, unknown>> {
  const { status, body } = await getJson(`${hub.url}/api/status`, password);
  if (status !== 200) throw new Error(`Hub GET /api/status answered ${status}`);
  return body as Record<string, unknown>;
}

/**
 * Whether a Hub's status, in its own tree's shape, says it holds a key: from
 * protocol 7 an entry of its `accounts` that holds one (the unmoved legacy
 * key, or an Account's with a `setAt`; ADR-0139 §1, §3), before it
 * `credentialPresent: true`. The rigs boot older trees beside the candidate,
 * so this reads either.
 */
export function hubStatusHoldsKey(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const { accounts, credentialPresent } = body as {
    accounts?: unknown;
    credentialPresent?: unknown;
  };
  if (Array.isArray(accounts)) {
    return accounts.some((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return false;
      const { accountUuid, setAt } = entry as { accountUuid?: unknown; setAt?: unknown };
      return accountUuid === null || (typeof setAt === "string" && setAt !== "");
    });
  }
  return credentialPresent === true;
}

/**
 * What a Hub's status, in its own tree's shape, says of its keys: whether it
 * holds one (`hubStatusHoldsKey`), and the one claude.ai state it shows: from
 * protocol 7 its Accounts' summary (connected if any key is, else expired,
 * else error, else disconnected: `hubAccountsConnection`, ADR-0139 §10),
 * before it `usageConnection`. Null when the status carries neither.
 */
export function hubStatusKeyFacts(body: unknown): { holdsKey: boolean; connection: string | null } {
  const holdsKey = hubStatusHoldsKey(body);
  if (typeof body !== "object" || body === null) return { holdsKey, connection: null };
  const { accounts, usageConnection } = body as { accounts?: unknown; usageConnection?: unknown };
  if (Array.isArray(accounts)) {
    const states = accounts.map((entry: unknown) =>
      typeof entry === "object" && entry !== null
        ? (entry as { connection?: unknown }).connection
        : undefined,
    );
    const connection =
      (["connected", "expired", "error"] as const).find((state) => states.includes(state)) ??
      "disconnected";
    return { holdsKey, connection };
  }
  return { holdsKey, connection: typeof usageConnection === "string" ? usageConnection : null };
}

/**
 * Keys the Hub with a claude.ai credential, in the route and shape its own
 * protocol accepts, read off its own status:
 *   - protocol 4: `POST /api/credential {sessionKey, orgId}`, both required
 *     (`usageCredentialSchema` there), so `orgId` must be given;
 *   - protocols 5 and 6: `POST /api/credential {sessionKey}` alone — it
 *     refuses a body naming `orgId` (ADR-0104) and lists the key's
 *     Organizations itself;
 *   - protocol 7 on: `POST /api/credentials {sessionKey}` (ADR-0139 §4): the
 *     Hub asks claude.ai's `/api/account` for the key's Account, so the fake
 *     claude.ai the Hub polls must hold this key (each of its keys answers
 *     `/api/account`), and answers `{ ok, accountUuid }`.
 * Resolves to that Account, or null before protocol 7.
 * A mutating `/api/*` request needs `x-maxprice-protocol` equal to the Hub's
 * version; no `Origin` is sent, and an open Hub needs no `Authorization` (a
 * protected one is given its `password`).
 * Without a working key a Hub is `keyless`, and a sidecar never reaches
 * `connected` with it, so no event is ever pushed (ADR-0039).
 */
export async function pushHubCredential(
  hub: HubHandle,
  credential: { readonly sessionKey: string; readonly orgId?: string },
  password?: string,
): Promise<string | null> {
  const version = (await hubStatus(hub, password)).protocolVersion;
  if (typeof version !== "number") throw new Error("Hub status carries no protocolVersion");
  if (version <= 4 && credential.orgId === undefined) {
    throw new Error(`a protocol ${version} Hub needs the credential's orgId`);
  }
  const body = version <= 4 ? credential : { sessionKey: credential.sessionKey };
  const path = version >= 7 ? "/api/credentials" : "/api/credential";
  const res = await fetch(`${hub.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-maxprice-protocol": String(version),
      ...hubPasswordHeaders(password),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HUB_REQUEST_TIMEOUT_MS),
  });
  if (res.status !== 200) {
    throw new Error(`Hub POST ${path} answered ${res.status}: ${await res.text()}`);
  }
  if (version < 7) return null;
  const ack = (await res.json()) as { ok?: unknown; accountUuid?: unknown };
  if (ack.ok !== true || typeof ack.accountUuid !== "string") {
    throw new Error(`Hub POST ${path} answered 200 without an Account: ${JSON.stringify(ack)}`);
  }
  return ack.accountUuid;
}

/**
 * Makes the Hub announce `hub:machines` to every connected sidecar, changing
 * nothing: the operator console's rename (`POST /api/machines/:id/name`, both
 * trees) of `machineId` to the name the directory already holds. Both trees
 * answer it "ok", rewrite the same entry, and emit the poke.
 *
 * Why it is needed: a sidecar caches the Hub's machine directory, joined with
 * the Hub's live per-machine counts (`eventCount`, `lastPushAt`), and refreshes
 * that cache only when it connects, on this poke, and on a five-minute sweep.
 * At connect the refresh races the sidecar's own first push, so the cache may
 * predate every row: a `--self` run showed `eventCount` 13 on one side and 0 on
 * the other. After the push has settled, one poke makes both caches read the
 * settled Hub. The requests carry no `x-maxprice-machine`, so the Hub does not
 * count them as the machine's own contact (`lastSeenAt`).
 */
export async function pokeMachines(hub: HubHandle, machineId: string): Promise<void> {
  const { status, body } = await getJson(`${hub.url}/api/machines`);
  const machines = (body as { machines?: Array<{ machineId?: unknown; name?: unknown }> }).machines;
  const entry = machines?.find((m) => m.machineId === machineId);
  if (status !== 200 || typeof entry?.name !== "string") {
    throw new Error(`Hub GET /api/machines (${status}) lists no machine ${machineId}`);
  }
  const version = (await hubStatus(hub)).protocolVersion;
  const res = await fetch(`${hub.url}/api/machines/${encodeURIComponent(machineId)}/name`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-maxprice-protocol": String(version) },
    body: JSON.stringify({ name: entry.name }),
    signal: AbortSignal.timeout(HUB_REQUEST_TIMEOUT_MS),
  });
  if (res.status !== 200) {
    throw new Error(`Hub same-name rename answered ${res.status}: ${await res.text()}`);
  }
}

/** How many rows the Hub's archive holds (`HubStatus.events.eventCount`); null without an archive. */
export async function hubEventCount(hub: HubHandle): Promise<number | null> {
  const events = (await hubStatus(hub)).events as { eventCount?: unknown } | undefined;
  return typeof events?.eventCount === "number" ? events.eventCount : null;
}

/** The Hub's natural key for a row (packages/shared/src/fleet-dedup.ts `fleetDedupKey`). */
function naturalKey(row: { messageId?: unknown; requestId?: unknown }): string {
  return JSON.stringify([row.messageId, row.requestId ?? null]);
}

const SNAPSHOT_PAGE = 5000; // EVENT_PULL_LIMIT_MAX in both trees

/**
 * Every row the Hub stored, one JSON line each, sorted by its natural key.
 *
 * Read through the Hub's own snapshot route, `GET /api/events/snapshot`, the
 * full-archive export a replica seeds from (both trees). The archive itself is
 * SQLite opened with `locking_mode=EXCLUSIVE` (ADR-0100), so no second process
 * may read it while the Hub runs. What the route serves is each stored row
 * after the Hub's own Zod parse (`fleetEventSchema`), so a line here is that
 * parse re-serialized: its key order is the schema's, not necessarily the
 * order a sidecar pushed. The `hub stored rows` comparison therefore covers
 * what each Hub stored and serves back, not the request bodies on the wire.
 */
export async function hubRows(hub: HubHandle, password?: string): Promise<string[]> {
  const rows: Array<Record<string, unknown>> = [];
  let snapshot: string | undefined;
  let offset = 0;
  for (;;) {
    const query = new URLSearchParams({ offset: String(offset), limit: String(SNAPSHOT_PAGE) });
    if (snapshot !== undefined) query.set("snapshot", snapshot);
    const { status, body } = await getJson(`${hub.url}/api/events/snapshot?${query}`, password);
    if (status !== 200) {
      throw new Error(`Hub GET /api/events/snapshot answered ${status}: ${JSON.stringify(body)}`);
    }
    const page = body as {
      snapshot: string;
      events: Array<Record<string, unknown>>;
      nextOffset: number;
      complete: boolean;
    };
    rows.push(...page.events);
    if (page.complete) break;
    if (page.nextOffset <= offset) throw new Error("Hub snapshot made no progress");
    snapshot = page.snapshot;
    offset = page.nextOffset;
  }
  const keyed = rows.map((row) => ({ key: naturalKey(row), json: JSON.stringify(row) }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return keyed.map((row) => row.json);
}
