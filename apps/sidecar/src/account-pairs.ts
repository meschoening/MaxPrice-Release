import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";

// account-pairs.json — the pair table (ADR-0137 §1): which account uuid each
// email hash (`emailHash`, @maxprice/shared) belongs to, and which kind of
// source taught it,
// `{ version: 2, pairs: { [emailHash]: { accountUuid, source } } }`, `source`
// being `login`, `key` or `transcript`. The parser
// keys an Email record's evidence by the hash, never the address, and the
// store resolves it to an Account through this table at ingest (#631 T4), so a
// pair learned later re-resolves a row with no re-parse (ADR-0137 §6).
//
// LOCAL ONLY. The hash and the table never leave this machine (ADR-0137 §1):
// no wire, Hub, archive or directory carries either, and nothing here is a
// wire, archive or directory value. A key that is not a hash is refused, so a
// clear address can never be keyed or written.
//
// Its sources (ADR-0137 §1), in two ranks. The upper rank: a `login` pair,
// each watched root's `.claude.json` `oauthAccount` (organizations.ts,
// `loginPairs`), and a `key` pair, a held session key's `/api/account` (#633,
// usage-keyset.ts), ranked with it. A `transcript` pair: a usage line read in a main transcript while an Email
// record and an Owner record naming an Account are both in effect
// (engine/jsonl.ts's `onPair`, from the scan and the watcher; never a
// subagent's file, whose own Email record is no evidence, ADR-0137 §2).
//
// A pair learned once is kept: a logout, a login file that names another
// Account, or a transcript deleted removes nothing. A `login` or `key` pair
// outranks a `transcript` one: a transcript pair is learned only for a hash
// the table does not pair yet or paired from a transcript, and a login or key
// pair replaces any. Within a rank the latest observation wins, so an address that moved
// to another Account is followed, not frozen at its first pair. The rank is
// what keeps a login file and a transcript that disagree from flipping the
// table at every read of each (#631 review): a watcher flush re-reports its
// transcript's pair, and every roster read re-reads the logins.
//
// Durable like organization-assertions.json, whose load mechanics it copies:
// salvaged entry by entry, an unreadable file kept as `.bak`. The table is
// written at the first boot that finds none, empty or not, so a later boot
// that finds none, or finds it unreadable, knows the table was LOST (`load`'s
// answer). A lost table costs pairs the scan cache cannot teach again, since
// a cache hit yields no pair: an address whose pair is gone reads as a
// Pending account, and where a fold already replaced that Pending key in the
// tracked list by its Account, its rows are outside the tracked set. So the
// boot re-parses every transcript when the table was lost (bootSidecar()
// discards the scan cache), and every transcript pair is learned again before
// the store is installed, as the root logins' are at every boot. What stays
// lost is a pair whose every source is gone: a login since logged out of
// with no transcript co-positioning that address. Its rows count as the
// Pending account's until a source names the address again.

const HASH = /^[0-9a-f]{64}$/;
const accountUuidSchema = z.string().min(1);

// Which kind of source taught a pair, by rank: `login` and `key` (#633) rank
// together, above `transcript`.
export type PairSource = "login" | "key" | "transcript";
const RANK: Readonly<Record<PairSource, number>> = { login: 1, key: 1, transcript: 0 };

const pairEntrySchema = z.object({
  accountUuid: accountUuidSchema,
  source: z.enum(["login", "key", "transcript"]),
});
type PairEntry = z.infer<typeof pairEntrySchema>;

const pairsFileSchema = z.object({
  version: z.literal(2),
  // `unknown` so one bad entry can't empty the whole file.
  pairs: z.record(z.unknown()),
});

// What the load found: the file read (`present`), none (`absent`, then
// written at once), or one it could not read (`unreadable`, kept as `.bak`).
// Anything but `present` after a first boot means the table was lost.
export type PairsLoad = "present" | "absent" | "unreadable";

export type AccountPairs = {
  // Reads the file. Rides the write queue, so no write can land ahead of it
  // and persist a table missing the file's pairs. A pair learned before the
  // load finished outranks the file's pair for the same hash when its source
  // ranks at least as high: it is the later observation. An absent file is
  // written at once, so a later absence means a loss. Never rejects: a read
  // or write that throws is logged, and answers `unreadable`.
  load: () => Promise<PairsLoad>;
  // The account uuid the hash is paired with, if any.
  resolve: (emailHash: string) => string | undefined;
  // Records an observation, from `source`, of `emailHash` belonging to
  // `accountUuid`. True exactly when it changed which uuid the hash is paired
  // with (a new hash, or a known one now paired with another uuid); then the
  // snapshot is replaced, every change listener hears it, and the file is
  // rewritten in the background. A `transcript` observation of a hash a
  // `login` pairs is refused (false). A `login` observation confirming a
  // `transcript` pair changes no uuid (false), and only raises the pair's
  // rank, which is persisted. A `login` and a `key` observation rank alike,
  // so within that rank the latest wins. A hash that is not 64 lowercase hex
  // characters, or an empty uuid, is refused (false).
  learn: (emailHash: string, accountUuid: string, source: PairSource) => boolean;
  // The table as it stands, hash -> uuid: a map never mutated after it is
  // handed out, with a new identity per change, so a holder (T4's store)
  // takes it as an input and detects a swap by identity, as with
  // engine/presumption.ts's cell.
  snapshot: () => ReadonlyMap<string, string>;
  // Hears each new snapshot, synchronously, as the change lands (a `learn`
  // that changed the table, or a load that added pairs). Boot judges the change
  // from here and queues a rebuild when it moves a row (`checkPairs`,
  // boot.ts). Returns the unsubscribe.
  onChange: (listener: (snapshot: ReadonlyMap<string, string>) => void) => () => void;
  // Settles when every write queued so far has (shutdown, tests). Never
  // rejects: a failed write is logged.
  flushed: () => Promise<void>;
};

export function createAccountPairs(opts: { path: string }): AccountPairs {
  // The table with each pair's source, and its hash -> uuid snapshot.
  let entries: ReadonlyMap<string, PairEntry> = new Map();
  let current: ReadonlyMap<string, string> = new Map();
  const listeners = new Set<(snapshot: ReadonlyMap<string, string>) => void>();

  // One load or write at a time: every write goes through the one fixed
  // `${path}.tmp`, and the load rides the same queue (see `load`). Each write
  // serializes the table as it stands when the write RUNS, so the last one
  // queued carries every change before it.
  let chain: Promise<void> = Promise.resolve();
  function enqueue(task: () => Promise<void>): Promise<void> {
    chain = chain.then(task).catch((err: unknown) => {
      console.error("[sidecar] account-pairs.json:", err);
    });
    return chain;
  }

  // Installs `next`, and publishes a new snapshot when a uuid moved.
  function install(next: ReadonlyMap<string, PairEntry>, uuidsMoved: boolean): void {
    entries = next;
    if (!uuidsMoved) return;
    current = new Map([...next].map(([hash, entry]) => [hash, entry.accountUuid]));
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (err) {
        console.error("[sidecar] account pair listener threw:", err);
      }
    }
  }

  // Absent: write the table as it stands (so a later boot can tell a loss),
  // and answer `absent`. Unreadable JSON or an envelope that is not
  // `{ version: 2, pairs: {…} }`: keep the bytes as `.bak`, start empty.
  // Otherwise every entry with a hash key and a readable value loads and every
  // other is dropped; the file is not written here, so a dropped entry leaves
  // the disk at the next write.
  async function applyLoad(): Promise<PairsLoad> {
    let bytes: Buffer;
    try {
      bytes = await readFile(opts.path);
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
        console.warn(`[sidecar] account-pairs.json could not be read; starting empty: ${err}`);
        return "unreadable";
      }
      await write();
      return "absent";
    }
    let file: z.infer<typeof pairsFileSchema> | null = null;
    try {
      const parsed = pairsFileSchema.safeParse(JSON.parse(bytes.toString("utf8")));
      if (parsed.success) file = parsed.data;
    } catch {
      // fall through to the recovery path
    }
    if (file === null) {
      try {
        await writeFile(`${opts.path}.bak`, bytes);
      } catch {
        // best-effort — never fail the load on the backup copy
      }
      console.warn("[sidecar] account-pairs.json unreadable; starting empty (kept .bak)");
      return "unreadable";
    }
    const next = new Map(entries);
    let moved = false;
    let skipped = 0;
    for (const [emailHash, candidate] of Object.entries(file.pairs)) {
      const entry = pairEntrySchema.safeParse(candidate);
      if (!entry.success || !HASH.test(emailHash)) {
        skipped += 1;
        continue;
      }
      // Learned in this process already, at a rank at least the file's: the
      // later observation stands.
      const learned = next.get(emailHash);
      if (learned !== undefined && RANK[learned.source] >= RANK[entry.data.source]) continue;
      next.set(emailHash, entry.data);
      if (learned?.accountUuid !== entry.data.accountUuid) moved = true;
    }
    if (skipped > 0) {
      console.warn(
        `[sidecar] account-pairs.json: skipped ${skipped} unreadable ${skipped === 1 ? "entry" : "entries"}`,
      );
    }
    install(next, moved);
    return "present";
  }

  async function write(): Promise<void> {
    const tmp = `${opts.path}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 2, pairs: Object.fromEntries(entries) }));
    await rename(tmp, opts.path);
  }

  function learn(emailHash: string, accountUuid: string, source: PairSource): boolean {
    if (!HASH.test(emailHash) || !accountUuidSchema.safeParse(accountUuid).success) return false;
    const held = entries.get(emailHash);
    if (held !== undefined && RANK[source] < RANK[held.source]) return false;
    // The same pair at the same rank changes nothing, whichever source of
    // that rank saw it (a key and a login confirming each other write nothing).
    if (held?.accountUuid === accountUuid && RANK[held.source] === RANK[source]) return false;
    const moved = held?.accountUuid !== accountUuid;
    install(new Map(entries).set(emailHash, { accountUuid, source }), moved);
    void enqueue(write);
    return moved;
  }

  return {
    load: () => {
      let answer: PairsLoad = "unreadable";
      return enqueue(async () => {
        answer = await applyLoad();
      }).then(() => answer);
    },
    resolve: (emailHash) => current.get(emailHash),
    learn,
    snapshot: () => current,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    flushed: () => chain,
  };
}
