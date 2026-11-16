import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  MEMBERSHIP_ASSERTION_DIRECTORY_MAX,
  editSupersedes,
  membershipAssertionEntrySchema,
  sessionIdKeySchema,
  type MembershipAssertionEntry,
  type OrganizationAssertionsResponse,
  type OrganizationsResponse,
} from "@maxprice/shared";
import {
  sameAssertions,
  withAssertions,
  type MembershipClaim,
  type Presumption,
} from "./engine/presumption";

// organization-assertions.json — the user's Organization assertions (#310,
// ADR-0107 §11): `{ version: 1, assertions: { [sessionId]: { organizationUuid,
// editedAt } } }`. Durable and user-authored, like organization-labels.json
// beside it, whose mechanics it copies: each entry carries its own `editedAt`,
// a cleared claim stays as a tombstone (`organizationUuid: null`) so an older
// copy can never resurrect it, and the file is salvaged entry by entry. The
// fleet pushes these entries to the Hub's Membership assertion directory and
// adopts its union back through `merge`, so the file also holds claims made on
// other machines; a machine with no Hub works from this file alone. The engine
// never sees an edit time or a tombstone: bootSidecar() installs `claims()`
// into the presumption cell (engine/presumption.ts, `withAssertions`).
//
// Since #631 an entry is a Membership assertion (ADR-0137 §5): a live claim
// may also name an Account, `accountUuid`. Since #635 the Hub's Membership
// assertion directory carries the same entry (ADR-0139 §7), so the file, the
// push and the Hub's union hold one shape, `membershipAssertionEntrySchema`:
// `entries()` is the push's source with each entry whole, Account included,
// and `merge` judges each incoming entry against the held one whole, so a
// newer edit from another machine replaces the entry Account and all, and the
// Hub's echo of this machine's own edit is that edit and changes nothing. A
// claim stored before Accounts names none and loads unchanged, taking its
// Account by ADR-0137 §3 at query time. An entry whose Account is not an
// account uuid (a Pending key or an address, which a #631 build's PUT could
// store) is refused at load like any unreadable entry, so it never reaches
// the push, and so is a tombstone naming an Account: the shared entry
// refuses an Account without an Organization, and #631 never shipped, so no
// file to convert exists.

// Entries stay `unknown` so ONE bad entry can't empty the whole file — each is
// parsed (and dropped) individually at load, under the one entry schema the
// wire and the Hub's file share.
const assertionsFileSchema = z.object({
  version: z.literal(1),
  assertions: z.record(z.unknown()),
});

// What a bulk `set` did: how many sessions' entries it wrote, or "full" when
// it would have grown the file past MEMBERSHIP_ASSERTION_DIRECTORY_MAX — the
// whole batch refused, nothing written.
export type OrganizationAssertionSetResult = { kind: "ok"; changed: number } | { kind: "full" };

export type OrganizationAssertions = {
  // Reads the file. Queued like `set` and `merge`, so an edit or an adoption
  // issued while it runs waits for it. Never rejects.
  load: () => Promise<void>;
  // Every entry, tombstones included, by session id, as stored and as the
  // Hub's directory carries it, Account included (#635). The live map:
  // callers only read it; what the fleet's push sends.
  entries: () => ReadonlyMap<string, Readonly<MembershipAssertionEntry>>;
  // sessionId → organizationUuid for every live claim — no tombstone, no edit
  // time, no Account. A FRESH map per call.
  resolved: () => Map<string, string>;
  // sessionId → the Membership claim for every live claim (ADR-0137 §5), its
  // Account included when it names one. GET /api/organization-assertions
  // answers it (`assertionsResponse`). A FRESH map per call, never mutated
  // afterwards: bootSidecar() installs it into the presumption, whose
  // identity every report cache compares, so its contents must never change
  // under it.
  claims: () => Map<string, MembershipClaim>;
  // Claims every listed session for `organizationUuid` (and, optionally, the
  // Account `accountUuid`, #631), or clears each claim (`null`, which names no
  // Account), with ONE write for the batch. Duplicates collapse. A session
  // that already holds that claim — or, clearing, holds no claim (absent or a
  // tombstone) — is left alone: no write, no tombstone minted, `editedAt`
  // unmoved. Each written entry is stamped max(now, its previous editedAt +
  // 1 ms), so an edit is newer than everything its editor has seen. A write
  // that fails undoes every session of the batch and rejects.
  set: (
    sessionIds: readonly string[],
    organizationUuid: string | null,
    accountUuid?: string,
  ) => Promise<OrganizationAssertionSetResult>;
  // Adopts the Hub directory's union: each incoming entry replaces the held
  // one, whole, Account and all, only when it is the newer edit
  // (@maxprice/shared's newest-wins). The entries must already be parsed with
  // the entry schema. `wrote` when any entry changed (one write);
  // `assertionChanged` when some session's resolved claim did, its
  // Organization or its Account — an `editedAt` that moved alone, or a
  // tombstone for a session with no claim, is not. A write that fails rejects
  // and restores every changed entry.
  merge: (
    incoming: Record<string, MembershipAssertionEntry>,
  ) => Promise<{ wrote: boolean; assertionChanged: boolean }>;
};

export function createOrganizationAssertions(opts: {
  path: string;
  now?: () => number;
}): OrganizationAssertions {
  const now = opts.now ?? Date.now;
  const known = new Map<string, MembershipAssertionEntry>();

  // One load, set or merge at a time — the whole of it: the comparison, the
  // change, the write and, on failure, the undo. An undo is only sound when no
  // other call can land between the change and the write's outcome, and the
  // queue keeps every write off the one fixed `${path}.tmp`. The load rides it
  // too, so nothing can write a file that lacks what the load was about to
  // read. A failed call rejects its own caller and never stalls the queue.
  let chain: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  // Absent: start empty, silently. Unreadable JSON or an envelope that is not
  // `{ version: 1, assertions: {…} }`: keep the bytes as `.bak`, start empty.
  // Otherwise every entry the schema accepts loads and every other is dropped;
  // the file itself is not written here, so a dropped entry leaves the disk at
  // the first write.
  async function applyLoad(): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = await readFile(opts.path);
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
        console.warn(
          `[sidecar] organization-assertions.json could not be read; starting empty: ${err}`,
        );
      }
      return;
    }
    let file: z.infer<typeof assertionsFileSchema> | null = null;
    try {
      const parsed = assertionsFileSchema.safeParse(JSON.parse(bytes.toString("utf8")));
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
      console.warn("[sidecar] organization-assertions.json unreadable; starting empty (kept .bak)");
      return;
    }
    let skipped = 0;
    for (const [sessionId, candidate] of Object.entries(file.assertions)) {
      const parsed = membershipAssertionEntrySchema.safeParse(candidate);
      if (parsed.success && sessionIdKeySchema.safeParse(sessionId).success) {
        known.set(sessionId, parsed.data);
      } else {
        skipped += 1;
      }
    }
    if (skipped > 0) {
      console.warn(
        `[sidecar] organization-assertions.json: skipped ${skipped} unreadable ${skipped === 1 ? "entry" : "entries"}`,
      );
    }
  }

  async function write(): Promise<void> {
    const tmp = `${opts.path}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, assertions: Object.fromEntries(known) }));
    await rename(tmp, opts.path);
  }

  // Puts back every entry a failed write had changed.
  function restore(previous: ReadonlyMap<string, MembershipAssertionEntry | undefined>): void {
    for (const [sessionId, prev] of previous) {
      if (prev === undefined) known.delete(sessionId);
      else known.set(sessionId, prev);
    }
  }

  async function applySet(
    sessionIds: readonly string[],
    organizationUuid: string | null,
    accountUuid: string | undefined,
  ): Promise<OrganizationAssertionSetResult> {
    const nowMs = now();
    // A cleared claim names no Account.
    const account = organizationUuid === null ? undefined : accountUuid;
    const previous = new Map<string, MembershipAssertionEntry | undefined>();
    let added = 0;
    for (const sessionId of new Set(sessionIds)) {
      const prev = known.get(sessionId);
      if (
        (prev?.organizationUuid ?? null) === organizationUuid &&
        (prev?.accountUuid ?? undefined) === account
      ) {
        continue;
      }
      previous.set(sessionId, prev);
      if (prev === undefined) added += 1;
    }
    if (previous.size === 0) return { kind: "ok", changed: 0 };
    // Only a batch that adds sessions can be full. `merge` has no cap, so the
    // file may already be past it; clears and updates of held sessions add
    // nothing and still land there.
    if (added > 0 && known.size + added > MEMBERSHIP_ASSERTION_DIRECTORY_MAX) {
      return { kind: "full" };
    }
    for (const [sessionId, prev] of previous) {
      // An edit is newer than everything its editor has seen: an entry adopted
      // from a machine whose clock runs ahead still loses to this one.
      const floor = prev === undefined ? -Infinity : Date.parse(prev.editedAt) + 1;
      const editedAt = new Date(Math.max(nowMs, floor)).toISOString();
      known.set(
        sessionId,
        account === undefined
          ? { organizationUuid, editedAt }
          : { organizationUuid, accountUuid: account, editedAt },
      );
    }
    try {
      await write();
    } catch (err) {
      restore(previous);
      throw err;
    }
    return { kind: "ok", changed: previous.size };
  }

  async function applyMerge(
    incoming: Record<string, MembershipAssertionEntry>,
  ): Promise<{ wrote: boolean; assertionChanged: boolean }> {
    // Newest-wins (@maxprice/shared) against the held entry whole: the Hub
    // carries the Account since #635, so an echo of this machine's own edit is
    // identical to it and supersedes nothing.
    const changed = Object.entries(incoming).filter(([sessionId, entry]) =>
      editSupersedes(entry, known.get(sessionId)),
    );
    if (changed.length === 0) return { wrote: false, assertionChanged: false };
    const previous = new Map(changed.map(([sessionId]) => [sessionId, known.get(sessionId)]));
    let assertionChanged = false;
    for (const [sessionId, next] of changed) {
      const prev = previous.get(sessionId);
      if (
        (prev?.organizationUuid ?? null) !== next.organizationUuid ||
        prev?.accountUuid !== next.accountUuid
      ) {
        assertionChanged = true;
      }
      known.set(sessionId, next);
    }
    try {
      await write();
    } catch (err) {
      restore(previous);
      throw err;
    }
    return { wrote: true, assertionChanged };
  }

  return {
    load: () => enqueue(applyLoad),
    entries: () => known,
    resolved: () => {
      const live = new Map<string, string>();
      for (const [sessionId, e] of known) {
        if (e.organizationUuid !== null) live.set(sessionId, e.organizationUuid);
      }
      return live;
    },
    claims: () => {
      const live = new Map<string, MembershipClaim>();
      for (const [sessionId, e] of known) {
        if (e.organizationUuid === null) continue;
        live.set(
          sessionId,
          e.accountUuid === undefined
            ? { organizationUuid: e.organizationUuid }
            : { organizationUuid: e.organizationUuid, accountUuid: e.accountUuid },
        );
      }
      return live;
    },
    set: (sessionIds, organizationUuid, accountUuid) =>
      enqueue(() => applySet(sessionIds, organizationUuid, accountUuid)),
    merge: (incoming) => enqueue(() => applyMerge(incoming)),
  };
}

// ── bootSidecar()'s writer, and the PUT's rules (#310) ──

// The assertion writer's swap, asked before it is made (#309's handoff): the
// presumption `current` with `resolved` installed through `withAssertions`, or
// null when `current` already asserts exactly that — so an unchanged pull, a
// no-op boot or an echo mints no identity and clears no report cache.
// `claims` must be a snapshot no one mutates afterwards (`claims()` above
// hands out a fresh map): every cache compares the presumption's identity, so
// its contents may never change under it. A claim with no Account takes its
// Account by ADR-0137 §3 at query time (`eventAccount`); one naming an
// Excluded or never-seen Account makes its session's owner-less rows Dormant
// usage (`dormantSessions`).
export function presumptionWithAssertions(
  current: Presumption,
  claims: ReadonlyMap<string, MembershipClaim>,
): Presumption | null {
  return sameAssertions(current.assertedBySession, claims) ? null : withAssertions(current, claims);
}

// What PUT /api/organization-assertions answers, before HTTP: how many
// sessions' entries it wrote, or which refusal (404 / 409 in the pinned error
// envelope). A failed write rejects instead (500).
export type OrganizationAssertResult =
  | { kind: "ok"; changed: number }
  | { kind: "unknown" }
  | { kind: "full" };

// The bulk set / clear behind PUT /api/organization-assertions (#310). A
// non-null target must be an Organization this machine's roster lists — any
// Organization it has seen, Tracked or Excluded (#306 item 7); a clear names
// none, so it reads no roster. Sessions are opaque: an id need not exist here,
// since archive-only history and other machines' sessions are legitimate
// targets. When the set wrote, bootSidecar()'s writer installs the resolved
// claims (`install`, true when the presumption swapped), a swap is followed by
// the wholesale report invalidation, and `assertionsWritten` pushes the map to
// the Hub. `assertions.set` must wait for the store's boot load
// (bootSidecar()'s `assertionsReady`).
//
// The claim's optional Account (ADR-0137 §5, #631) is checked against no
// roster: an Account this machine has never seen is a legitimate claim, and
// it makes the session's owner-less rows Dormant usage until it is tracked.
export function createOrganizationAssert(deps: {
  roster: () => Promise<OrganizationsResponse>;
  assertions: Pick<OrganizationAssertions, "set">;
  install: () => boolean;
  invalidateReports: () => void;
  assertionsWritten: () => void;
}): (
  sessionIds: readonly string[],
  organizationUuid: string | null,
  accountUuid?: string,
) => Promise<OrganizationAssertResult> {
  return async (sessionIds, organizationUuid, accountUuid) => {
    if (organizationUuid !== null) {
      const roster = await deps.roster();
      if (!roster.organizations.some((o) => o.uuid === organizationUuid)) {
        return { kind: "unknown" };
      }
    }
    const result = await deps.assertions.set(sessionIds, organizationUuid, accountUuid);
    if (result.kind === "full") return { kind: "full" };
    if (result.changed > 0) {
      if (deps.install()) deps.invalidateReports();
      deps.assertionsWritten();
    }
    return { kind: "ok", changed: result.changed };
  };
}

// GET /api/organization-assertions' body from `claims()`: each claimed
// session's Organization, and the Account of each claim that names one (#672).
export function assertionsResponse(
  claims: ReadonlyMap<string, MembershipClaim>,
): OrganizationAssertionsResponse {
  const assertions: Record<string, string> = {};
  const accounts: Record<string, string> = {};
  for (const [sessionId, claim] of claims) {
    assertions[sessionId] = claim.organizationUuid;
    if (claim.accountUuid !== undefined) accounts[sessionId] = claim.accountUuid;
  }
  return { assertions, accounts };
}
