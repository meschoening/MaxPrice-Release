import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { usageSampleSchema, type UsageSample } from "@maxprice/shared";
import {
  byCapturedAt,
  createSampleStore,
  FleetArchiveUnrestorable,
  restoreHubArchive,
  type RestoredHubArchive,
} from "@maxprice/usage-core";
import { displayPath, type Env } from "@maxprice/usage-core/home-path";
import { fsErrorName } from "@maxprice/usage-core/secrets-file";
import { describeHolder, type ReadCgroup } from "@maxprice/usage-core/serve-lock";
import { CliError, EXIT, type Writer } from "./cli";
import { defaultDataDir, hubFileConfigSchema, parseHubConfigText } from "./config";
import { prepareDataDir } from "./data-dir";
import { readOnlyLockHolder, serveLockPath, takeVerbLock, UNIT } from "./serve-lock";

// `maxprice-hub restore <dir> [--samples <usage-history.jsonl>]...` (ADR-0130):
// a stopped Hub's data dir, or a backup of one, copied into a data dir that
// holds none of a Hub's files, before its first serve. A fleet moves to another
// Hub this way, or a Hub comes back from a backup.
//
// It copies an allowlist and only ever reads <dir>. Every file is staged in
// `<data dir>/.restore-staging`, checked there, and only then renamed into the
// data dir, so a refused restore, or one that fails before its first rename,
// leaves no restored file; one that fails or is killed after it keeps the
// staging dir beside what it placed, the mark serve refuses. The
// archive gets a fresh epoch, always (§3): under the backup's, a client that
// comes back after others have pushed the restored Hub's Fleet change cursor
// past its own stalls for good. `--samples` merges clients' usage histories
// into the restored one, for the Hub's own samples since the backup (§4).
//
// Linux only, with the daemon down (§5): it holds the data dir's serve.lock
// for its whole run, as the verbs that edit the data files do (ADR-0127 §3),
// and has no path through a running Hub. A file copy reads only a stopped
// Hub's archive consistently (§2), so restore also refuses a backup whose
// serve.lock is held, or whose archive changes while it is copied.

// What restore copies, in the order it renames them into the data dir.
// hub.json goes last: a data dir holds a Hub once it holds hub.json (hasHub),
// so the other verbs never act on a restore cut short.
const RESTORED = [
  "machine-directory.json",
  "identity-directory.json",
  "organization-directory.json",
  "organization-assertion-directory.json",
  "organization-roster.json",
  "usage-history.jsonl",
  "events.sqlite",
  "hub.json",
] as const;

const ARCHIVE = "events.sqlite";
const HISTORY = "usage-history.jsonl";
const REQUIRED: ReadonlySet<string> = new Set([ARCHIVE, "hub.json"]);

// The archive's companions SQLite recovers on the copy: its WAL, and a hot
// rollback journal. Folded into the restored file, never placed as files. Its
// wal-index (`-shm`) is never copied: SQLite rebuilds it from the WAL.
const RECOVERED = [`${ARCHIVE}-wal`, `${ARCHIVE}-journal`];

// What the data dir must not hold, in RESTORED's order: every file restore
// writes, and the archive's siblings, which SQLite would read as the restored
// archive's own. Restore never replaces a file.
const HUB_FILES = RESTORED.flatMap((name) =>
  name === ARCHIVE ? [name, `${name}-wal`, `${name}-shm`, `${name}-journal`] : [name],
);

// The staging dir, and the mark of a restore that has not finished: made
// under the lock, and removed only once every file is placed and the data dir
// fsynced, or when nothing was placed. A restore killed, or failed, while it
// placed its files leaves it beside them, hub.json last. restore refuses a
// data dir that holds it beside a Hub file, and removes it alone, the mark of
// a restore that placed nothing; serve refuses any data dir that holds it
// (unfinishedRestore).
export const RESTORE_STAGING = ".restore-staging";

// restore's and serve's refusal of a data dir a killed restore left half
// placed. Only the operator can tell which files are whole, so neither
// removes or completes anything.
export function unfinishedRestore(dataDir: string, env: Env): CliError {
  return new CliError(
    EXIT.FAILURE,
    `${displayPath(dataDir, env)} holds a restore that did not finish (${RESTORE_STAGING}); move the data dir aside and restore again`,
  );
}

const NEXT_STEPS = `Next steps:
  1. Before it starts, check every client of v0.9.0 or earlier: its fleet-forget.json
     must be absent or null. One whose file holds a forget intent first reaches this Hub
     under another URL. A newer client needs no check.
  2. Give it the session key: maxprice-hub key set, or maxprice-hub setup.
  3. Start it: maxprice-hub service install, or maxprice-hub serve.
  4. Redo by hand any operator edit made after the backup: a rename, a merge, a purge
     or a password change.
Every client then reseeds once and re-contributes its usage since the backup, in any order.
`;

export type RestoreOptions = {
  env?: Env;
  platform?: NodeJS.Platform;
  // What a relative <dir> or --samples path resolves against.
  cwd?: string;
  // The report, and the [hub] lines before it.
  stdout?: Writer;
  // How a lock holder's cgroup is read, to name maxprice-hub.service; /proc
  // by default.
  readCgroup?: ReadCgroup;
  // A test's seam: runs after the backup's events.sqlite is copied and
  // before its WAL and journal are, where a writer would tear the pair.
  betweenArchiveCopies?: () => void | Promise<void>;
};

// Whether the backup holds `path` as a regular file. Not there at all
// (ENOENT, or a file where a dir should be) is false; a stat that fails
// otherwise, as a dir restore may not search, is exit 1 naming it, never a
// "no Hub" it cannot know.
function isBackupFile(path: string, shown: (path: string) => string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new CliError(EXIT.FAILURE, `cannot read ${shown(path)}: ${fsErrorName(error)}`);
  }
}

// Whether `path` names anything at all, a link that names nothing included.
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// What a writer changes about the backup's archive, its WAL and its journal:
// whether each is there, and its inode, size and modification time.
function archiveState(source: string): string {
  return [ARCHIVE, ...RECOVERED]
    .map((name) => {
      try {
        const { ino, size, mtimeMs } = statSync(join(source, name));
        return `${name} ${ino} ${size} ${mtimeMs}`;
      } catch (error) {
        return `${name} ${fsErrorName(error)}`;
      }
    })
    .join("\n");
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    // The data dir does not exist yet, so it is not <dir>.
    return false;
  }
}

// realpath for a name restore may create: resolve its nearest existing
// ancestor too, so a not-yet-created staging dir under an aliased data dir
// has the same physical name as an input reached through another alias.
function physicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    let entry;
    try {
      entry = lstatSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    // A dangling alias can become readable when restore creates its target.
    // Preserve that dependency even though realpath cannot resolve it yet.
    if (entry?.isSymbolicLink()) {
      const target = readlinkSync(path);
      return physicalPath(isAbsolute(target) ? target : `${physicalPath(parent)}${sep}${target}`);
    }
    return join(physicalPath(parent), basename(path));
  }
}

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

// Staging cleanup owns no input, including an alias used to reach one.
// Check each component: a path can enter staging through one symlink and
// leave through another, while its final realpath alone looks safe. The
// backup's copied files are inputs too: an external backup can link one of
// them into staging. Refuse before even preparing or locking the data dir.
function refuseStagedInputs(
  inputs: readonly string[],
  staging: string,
  shown: (path: string) => string,
): void {
  const roots = [staging, physicalPath(staging)];
  for (const input of new Set(inputs)) {
    const pending = [input];
    const seen = new Set<string>();
    while (pending.length > 0) {
      for (let entry = pending.pop()!; ; entry = dirname(entry)) {
        if (seen.has(entry)) break;
        seen.add(entry);
        const physical = physicalPath(entry);
        if (roots.some((root) => within(root, entry) || within(root, physical))) {
          throw new CliError(
            EXIT.USAGE,
            `${shown(input)} overlaps restore staging at ${shown(staging)}; move the input outside staging first`,
          );
        }
        try {
          if (lstatSync(entry).isSymbolicLink()) {
            // realpath hides intermediate link targets. Visit every hop
            // from the link's physical parent, preserving raw '..' until
            // its preceding components have also been inspected.
            const target = readlinkSync(entry);
            pending.push(
              isAbsolute(target) ? target : `${physicalPath(dirname(entry))}${sep}${target}`,
            );
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
        }
        if (dirname(entry) === entry) break;
      }
    }
  }
}

function unsafeRestoreLock(path: string, shown: (path: string) => string): CliError {
  return new CliError(
    EXIT.USAGE,
    `${shown(path)} must be a regular file with one link, separate from every restore input`,
  );
}

// Before even creating the lock, refuse aliases of an input's prospective
// target too: O_CREAT must not turn a dangling backup alias into a new file.
function restoreLockEntry(
  path: string,
  inputs: readonly string[],
  shown: (path: string) => string,
) {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  if (entry && (!entry.isFile() || entry.nlink !== 1)) throw unsafeRestoreLock(path, shown);
  const target = physicalPath(path);
  if (inputs.some((input) => physicalPath(input) === target)) throw unsafeRestoreLock(path, shown);
  return entry;
}

// Lock acquisition records a pid by truncating its descriptor. Check that
// descriptor, not only the pathname inspected before it was opened: neither
// a link nor an input itself is a record restore owns.
function inspectRestoreLock(
  fd: number,
  path: string,
  inputs: readonly string[],
  shown: (path: string) => string,
): void {
  const file = fstatSync(fd);
  const entry = restoreLockEntry(path, inputs, shown);
  if (
    !file.isFile() ||
    file.nlink !== 1 ||
    !entry ||
    entry.dev !== file.dev ||
    entry.ino !== file.ino
  )
    throw unsafeRestoreLock(path, shown);
  for (const input of new Set(inputs)) {
    let source;
    try {
      source = statSync(input);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    if (source.dev === file.dev && source.ino === file.ino) throw unsafeRestoreLock(path, shown);
  }
}

// A client's usage history, as the Hub's load reads one: blank lines ignored,
// every other line a Usage sample or skipped.
type ClientHistory = { samples: UsageSample[]; skipped: number };

function readClientHistory(path: string, shown: (path: string) => string): ClientHistory {
  let text: string;
  try {
    const stat = statSync(path);
    // A pipe or a device could block the read, or never end it.
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new CliError(EXIT.USAGE, `cannot read ${shown(path)}: it is not a regular file`);
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(EXIT.USAGE, `cannot read ${shown(path)}: ${fsErrorName(error)}`);
  }
  const samples: UsageSample[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: ReturnType<typeof usageSampleSchema.safeParse> | null = null;
    try {
      parsed = usageSampleSchema.safeParse(JSON.parse(trimmed));
    } catch {
      // not JSON
    }
    if (parsed?.success) samples.push(parsed.data);
    else skipped += 1;
  }
  if (samples.length === 0 && skipped > 0) {
    throw new CliError(EXIT.USAGE, `${shown(path)} holds no usage samples`);
  }
  return { samples, skipped };
}

// Copied 0600 whatever the backup's mode or the umask. The staging dir was
// made empty, so a name already there is a fault, never a file to replace.
function copyIn(from: string, to: string): void {
  copyFileSync(from, to, constants.COPYFILE_EXCL);
  chmodSync(to, 0o600);
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function endsWithNewline(path: string): boolean {
  const size = statSync(path).size;
  if (size === 0) return true;
  const fd = openSync(path, "r");
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

const count = (n: number): string => n.toLocaleString("en-US");

function counted(n: number, noun: string): string {
  return `${count(n)} ${noun}${n === 1 ? "" : "s"}`;
}

// The staged history, with every client history merged in: its report line.
// The Hub's own push-up merge admits each sample by the Usage sample identity
// rules (sample-store.ts), so a sample the history holds is dropped, a
// stamped copy replaces an unstamped one, and every admitted sample's line is
// appended after the backup's, which stay byte for byte. They are merged in
// capturedAt order (a stable sort, so a tie keeps the order of the files), so
// they are appended in it.
async function mergeHistory(path: string, clients: readonly ClientHistory[]): Promise<string> {
  const inBackup = existsSync(path);
  // A Hub killed mid-append leaves its last line cut short; the first merged
  // line must not join it.
  if (clients.length > 0 && inBackup && !endsWithNewline(path)) appendFileSync(path, "\n");
  const store = createSampleStore({ path });
  await store.loadHistory();
  const historySummary = (): string => {
    const latest = store.latest();
    return `${counted(store.all().length, "sample")}${latest === null ? "" : `, the latest at ${latest.capturedAt}`}`;
  };
  if (clients.length === 0) return inBackup ? historySummary() : "none in the backup";

  const incoming = clients.flatMap((client) => client.samples).sort(byCapturedAt);
  let added = 0;
  let latestAdded: string | null = null;
  for (const sample of incoming) {
    if (store.merge([sample]) > 0) {
      added += 1;
      latestAdded = sample.capturedAt;
    }
  }
  await store.flush();
  // The store logs a failed append and goes on, so the file is read back.
  // A stamped replacement changes no count: require the full sample under
  // every identity, independent of the order of samples at the same instant.
  const reread = createSampleStore({ path });
  await reread.loadHistory();
  const byIdentity = (samples: UsageSample[]) =>
    new Map(
      samples.map((sample) => [
        JSON.stringify([sample.organizationUuid ?? null, sample.capturedAt]),
        sample,
      ]),
    );
  if (!isDeepStrictEqual(byIdentity(reread.all()), byIdentity(store.all()))) {
    throw new CliError(EXIT.FAILURE, "the merged usage history did not read back");
  }
  // A history the merge created is the umask's until now.
  if (!inBackup && existsSync(path)) chmodSync(path, 0o600);

  const skipped = clients.reduce((sum, client) => sum + client.skipped, 0);
  return [
    inBackup ? historySummary() : "none in the backup",
    `; --samples added ${count(added)} from ${count(clients.length)} file(s)`,
    latestAdded === null ? "" : `, the latest at ${latestAdded}`,
    skipped === 0 ? "" : `, skipping ${count(skipped)} invalid line(s)`,
  ].join("");
}

type Restore = {
  source: string;
  dataDir: string;
  staging: string;
  clients: readonly ClientHistory[];
  env: Env;
  shown: (path: string) => string;
  betweenArchiveCopies?: () => void | Promise<void>;
  // Set while a restored file may be in the data dir: the caller then keeps
  // the staging dir, the mark of a restore that did not finish.
  placed: boolean;
};

// The files in <dir> restore did not copy, for the report, or why it cannot
// say: a backup it may read files from but not list (mode 0311) is restored
// all the same.
function notCopiedLine(source: string, copied: readonly string[], shown: (path: string) => string) {
  let names: string[];
  try {
    names = readdirSync(source);
  } catch {
    return `  not copied: (could not list ${shown(source)})`;
  }
  const others = names
    .filter((name) => {
      if (copied.includes(name)) return false;
      try {
        return statSync(join(source, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
  return others.length === 0 ? null : `  not copied: ${others.join(", ")}`;
}

// Stages, checks and places the restore; returns its report. A refusal or a
// failure before the first rename leaves the data dir holding no restored
// file; one after it leaves `restore.placed` set unless every file was taken
// back.
async function stageAndPlace(restore: Restore) {
  const { source, dataDir, staging, clients, env, shown } = restore;
  const copied: string[] = [];
  const recovered: string[] = [];
  for (const name of RESTORED) {
    if (!REQUIRED.has(name) && !isBackupFile(join(source, name), shown)) continue;
    // A write or a checkpoint between copying the archive and copying its
    // WAL gives a pair from two moments, which SQLite may read as a valid
    // but wrong database (§2). So the group is read the same before the
    // copy and after it, or refused.
    const before = name === ARCHIVE ? archiveState(source) : null;
    copyIn(join(source, name), join(staging, name));
    copied.push(name);
    if (name !== ARCHIVE) continue;
    await restore.betweenArchiveCopies?.();
    for (const sibling of RECOVERED) {
      if (!isBackupFile(join(source, sibling), shown)) continue;
      copyIn(join(source, sibling), join(staging, sibling));
      recovered.push(sibling);
    }
    if (archiveState(source) !== before) {
      throw new CliError(
        EXIT.FAILURE,
        `${shown(join(source, ARCHIVE))} changed while it was copied: something is writing it; stop it first`,
      );
    }
  }

  const unusable = (name: string, reason: string) =>
    new CliError(EXIT.USAGE, `${shown(join(source, name))} cannot be restored: ${reason}`);

  // hub.json as the Hub reads it: anything else would boot it open
  // (ADR-0037). The directories and the Hub roster must parse; a file the
  // Hub's loader still rejects is its own warn-and-preserve at boot.
  const parsed = new Map<string, unknown>();
  for (const name of copied.filter((name) => name.endsWith(".json"))) {
    const text = readFileSync(join(staging, name), "utf8");
    if (name === "hub.json") {
      const { raw, problem } = parseHubConfigText(text);
      if (problem !== null) throw unusable(name, problem.reason);
      parsed.set(name, raw);
      continue;
    }
    try {
      parsed.set(name, JSON.parse(text));
    } catch {
      throw unusable(name, "it was not valid JSON");
    }
  }

  let archive: RestoredHubArchive;
  try {
    archive = await restoreHubArchive(join(staging, ARCHIVE));
  } catch (error) {
    if (error instanceof FleetArchiveUnrestorable) throw unusable(ARCHIVE, error.message);
    throw error;
  }

  const history = await mergeHistory(join(staging, HISTORY), clients);

  // The report, whole before anything is placed: after the first rename only
  // the placing itself may fail.
  const config = hubFileConfigSchema.parse(parsed.get("hub.json"));
  const directory = parsed.get("machine-directory.json") as { machines?: unknown } | undefined;
  const machines =
    directory === undefined
      ? "none in the backup"
      : `${count(Array.isArray(directory?.machines) ? directory.machines.length : 0)} in the Machine directory`;
  // The archive's WAL and journal are named with it, folded in, not copied.
  const folded = [
    ...(recovered.includes(`${ARCHIVE}-wal`) ? ["its WAL folded in"] : []),
    ...(recovered.includes(`${ARCHIVE}-journal`) ? ["its journal recovered"] : []),
  ];
  const copiedNames = copied.map((name) =>
    name === ARCHIVE && folded.length > 0 ? `${name} (${folded.join(", ")})` : name,
  );
  const notCopied = notCopiedLine(source, [...copied, ...recovered], shown);
  const report = [
    `Restored the Hub at ${shown(source)} into ${shown(dataDir)}.`,
    `  events.sqlite: ${counted(archive.events, "event")}, Fleet change cursor ${count(archive.cursor)}, Deletion generation ${count(archive.deletionGeneration)}`,
    `  epoch: ${archive.epoch}, fresh (the backup's was ${archive.previousEpoch})`,
    `  machines: ${machines}`,
    `  usage history: ${history}`,
    `  hub.json: bind ${config.bind}, port ${config.port}, ${config.passwordHash === null ? "no password" : "password set"}`,
    `  copied: ${copiedNames.join(", ")}`,
    ...(notCopied === null ? [] : [notCopied]),
    NEXT_STEPS,
  ].join("\n");

  // Durable before it is visible, then visible in RESTORED's order. A rename
  // that fails takes back the ones before it; if that fails too, they stay
  // beside the mark.
  const placed = RESTORED.filter((name) => existsSync(join(staging, name)));
  for (const name of placed) fsyncPath(join(staging, name));
  restore.placed = true;
  const renamed: string[] = [];
  try {
    for (const name of placed) {
      renameSync(join(staging, name), join(dataDir, name));
      renamed.push(name);
    }
  } catch (error) {
    try {
      for (const name of renamed) rmSync(join(dataDir, name), { force: true });
    } catch {
      throw new CliError(
        EXIT.FAILURE,
        `cannot place the restored files (${fsErrorName(error)}), nor take back those placed before: ${unfinishedRestore(dataDir, env).message}`,
      );
    }
    restore.placed = false;
    throw error;
  }
  // Every file is placed: until the data dir is durable, the mark stays.
  try {
    fsyncPath(dataDir);
  } catch (error) {
    throw new CliError(
      EXIT.FAILURE,
      `the restored files are placed but not made durable: fsync on ${shown(dataDir)} failed (${fsErrorName(error)}); ${unfinishedRestore(dataDir, env).message}`,
    );
  }
  rmSync(staging, { recursive: true, force: true });
  return report;
}

// The verb. Every refusal throws a CliError with its exit code (ADR-0130 §6);
// any other failure exits 1.
export async function restoreHub(
  dir: string,
  samples: readonly string[],
  options: RestoreOptions = {},
): Promise<number> {
  const {
    env = process.env,
    platform = process.platform,
    cwd = process.cwd(),
    stdout = process.stdout,
    readCgroup,
    betweenArchiveCopies,
  } = options;
  // As `key set` (ADR-0126 §9): the lock and the modes are Linux's, and the
  // tray app has no use for it. Refused before anything is read or created.
  if (platform !== "linux") throw new CliError(EXIT.USAGE, "maxprice-hub restore is Linux only");
  const shown = (path: string) => displayPath(path, env);
  const log = (line: string) => void stdout.write(`${line}\n`);

  // The backup, and the client histories, before the data dir is touched.
  const source = resolve(cwd, dir);
  const noHub = (missing: string) =>
    new CliError(EXIT.USAGE, `no Hub to restore at ${shown(source)}: it has no ${missing}`);
  if (!isBackupFile(join(source, "hub.json"), shown)) throw noHub("hub.json");
  if (!isBackupFile(join(source, ARCHIVE), shown)) {
    throw noHub(
      existsSync(join(source, "events.jsonl"))
        ? `${ARCHIVE} (its events.jsonl needs the manual SQLite cutover first)`
        : ARCHIVE,
    );
  }
  const dataDir = resolve(cwd, defaultDataDir(env, platform));
  if (sameDir(source, dataDir)) {
    throw new CliError(
      EXIT.USAGE,
      `${shown(source)} is the data dir itself; restore copies a backup into another data dir`,
    );
  }
  if (within(source, dataDir) || within(physicalPath(source), physicalPath(dataDir))) {
    throw new CliError(
      EXIT.USAGE,
      `${shown(dataDir)} is inside the backup at ${shown(source)}; restore only reads the backup`,
    );
  }
  const staging = join(dataDir, RESTORE_STAGING);
  const samplePaths = samples.map((file) => resolve(cwd, file));
  const clients = samplePaths.map((file) => readClientHistory(file, shown));
  // The supplied spelling can itself depend on staging before '..' is
  // normalized, just as a symlink target can.
  const rawInputPath = (path: string) => (isAbsolute(path) ? path : `${resolve(cwd)}${sep}${path}`);
  const inputs = [
    rawInputPath(dir),
    source,
    ...[...RESTORED, ...RECOVERED, "serve.lock"].map((name) => join(source, name)),
    ...samples.map(rawInputPath),
    ...samplePaths,
  ];
  refuseStagedInputs(inputs, staging, shown);
  restoreLockEntry(serveLockPath(dataDir), inputs, shown);
  // A running Hub's files are not a backup: its archive moves under the copy.
  const holder = readOnlyLockHolder(source, readCgroup);
  if (holder !== null) {
    throw new CliError(
      EXIT.FAILURE,
      `a Hub is running on ${shown(source)} (${describeHolder(holder, UNIT)}); stop it first: restore copies a stopped Hub's files`,
    );
  }

  // The data dir, made or tightened as serve leaves it (ADR-0127 §3), and
  // held until the end.
  prepareDataDir(dataDir, log);
  const lock = takeVerbLock(dataDir, env, "restore", readCgroup, (fd) =>
    inspectRestoreLock(fd, serveLockPath(dataDir), inputs, shown),
  );
  try {
    const presentHubFiles = HUB_FILES.filter((name) => entryExists(join(dataDir, name)));
    // Only a killed restore leaves one, and the lock says none is running.
    // Killed before it placed a file, it left nothing else to judge.
    if (entryExists(staging)) {
      if (presentHubFiles.length > 0) throw unfinishedRestore(dataDir, env);
      rmSync(staging, { recursive: true, force: true });
      log(`[hub] removed a partial restore at ${staging}`);
    }
    if (presentHubFiles.length > 0) {
      throw new CliError(
        EXIT.USAGE,
        `${shown(dataDir)} already holds ${presentHubFiles.join(", ")}; restore writes only into a data dir that holds none of a Hub's files`,
      );
    }
    const restore: Restore = {
      source,
      dataDir,
      staging,
      clients,
      env,
      shown,
      betweenArchiveCopies,
      placed: false,
    };
    let report: string;
    try {
      mkdirSync(staging, { mode: 0o700 });
      // mkdir's mode is subject to the umask; chmod is not.
      chmodSync(staging, 0o700);
      report = await stageAndPlace(restore);
    } catch (error) {
      // The mark goes only with nothing placed: a restored file left in the
      // data dir keeps it, so serve and the next restore refuse the dir.
      if (!restore.placed) {
        try {
          rmSync(staging, { recursive: true, force: true });
        } catch {
          // The error that matters is the first.
        }
      }
      throw error;
    }
    stdout.write(report);
    return EXIT.OK;
  } finally {
    lock.release();
  }
}
