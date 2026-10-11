import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  checkOrganizationLabel,
  organizationRosterHintsSchema,
  organizationUuidKeySchema,
  orgLimitsAnswerSchema,
  resolveOrganizationLabel,
  type OrganizationEntry,
  type OrganizationRosterHints,
  type OrganizationsResponse,
  type OrgLimitsAnswer,
  type UsageOrganizations,
} from "@maxprice/shared";
import type { OrganizationLabels } from "./organization-labels";

// The Organizations this machine knows about (GLOSSARY.md, ADR-0098): read from
// Claude Code's login files and from a listing — Connect's discovery (#283),
// the Hub's roster on a hub-connected client (#366), or a Hub-less client's own
// listing (#366) — remembered in a small registry so a plan word survives
// logging out, and listed as the Settings roster (#287). The Home
// organization select is one of its readers. UUIDs, `organizationType`,
// first-seen times, and the listings' Limits answers and roster hints only —
// `oauthAccount.emailAddress` and `organizationName` (which embeds the email)
// are never read past the parse, the listing's `name` is never parsed at all,
// and none is written anywhere. The user's renames live in
// ./organization-labels.ts.

// Claude Code keeps the login in `.claude.json`: `$CLAUDE_CONFIG_DIR/.claude.json`
// when the config dir is relocated, else `~/.claude.json` — a SIBLING of
// `~/.claude/`, not inside it. A watched root is `<configDir>/projects`, so the
// candidates are `<configDir>/.claude.json`, then `<configDir>/../.claude.json`.
// readCurrentLogins also tries the home login after all root-specific
// candidates; XDG-only roots do not have a sibling at the default home login
// location.
export function loginFileCandidates(root: string): string[] {
  const configDir = dirname(root);
  return [join(configDir, ".claude.json"), join(dirname(configDir), ".claude.json")];
}

const loginFileSchema = z
  .object({
    oauthAccount: z
      .object({
        organizationUuid: z.string().min(1),
        organizationType: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type CurrentLogin = { organizationUuid: string; organizationType: string | null };

// The Organizations the CLI is logged into RIGHT NOW. Each watched root's
// config dir keeps its own login, so two roots can name two Organizations at
// once (labels decision 2): every candidate is read, and each Organization is
// listed once, in candidate order — the first root in `claudePaths` order
// first, the home login last. A later file naming the same Organization only
// fills a plan word the earlier one lacked. An unreadable or malformed file is
// skipped; empty when none names one. The caller decides when this may be
// consulted — the home seed uses only the first, as a boot tie-break/fallback,
// and never tracks it live (GLOSSARY.md).
export async function readCurrentLogins(
  roots: readonly string[],
  readFileImpl: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
  homeDirectory: string = homedir(),
): Promise<CurrentLogin[]> {
  const candidates = new Set([
    ...roots.flatMap(loginFileCandidates),
    join(homeDirectory, ".claude.json"),
  ]);
  // Keyed by uuid; `Map.set` on a known key keeps its first-seen position.
  const logins = new Map<string, CurrentLogin>();
  for (const candidate of candidates) {
    let text: string;
    try {
      text = await readFileImpl(candidate);
    } catch {
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const parsed = loginFileSchema.safeParse(json);
    const account = parsed.success ? parsed.data.oauthAccount : null;
    if (account === null || account === undefined) continue;
    const organizationUuid = account.organizationUuid;
    const organizationType = account.organizationType ?? null;
    const prev = logins.get(organizationUuid);
    if (prev === undefined || (prev.organizationType === null && organizationType !== null)) {
      logins.set(organizationUuid, { organizationUuid, organizationType });
    }
  }
  return [...logins.values()];
}

// Whether Claude Code will attach Remote Control to every interactive session
// on this machine (ADR-0101): `remoteControlAtStartup: true` in a watched
// root's own `<configDir>/settings.json`, and `disableRemoteControl` not set
// anywhere. That setting is what makes every interactive session write an
// Owner record; Settings hints when it is off. Live-read like the login file;
// nothing here changes the home. Managed and project settings files are out of
// scope — the user file is where the setting is documented to live.
const claudeSettingsSchema = z
  .object({
    remoteControlAtStartup: z.unknown().optional(),
    disableRemoteControl: z.unknown().optional(),
  })
  .passthrough();

export async function readRemoteControlAtStartup(
  roots: readonly string[],
  readFileImpl: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<boolean> {
  let enabled = false;
  for (const file of new Set(roots.map((root) => join(dirname(root), "settings.json")))) {
    let json: unknown;
    try {
      json = JSON.parse(await readFileImpl(file));
    } catch {
      continue;
    }
    const parsed = claudeSettingsSchema.safeParse(json);
    if (!parsed.success) continue;
    if (parsed.data.disableRemoteControl === true) return false;
    if (parsed.data.remoteControlAtStartup === true) enabled = true;
  }
  return enabled;
}

// organizations.json —
// `{ version: 1, organizations: { [uuid]: { organizationType, limits?, hints?, firstSeenAt?, unlisted? } } }`.
// `organizationType` is the plan word `remember()` keeps from a login file;
// `limits` (what the Organization's usage endpoint answered) and `hints` (the
// listing's roster hints) come from a listing: Connect's discovery (#283), the
// Hub's roster (#366), or a Hub-less client's own listing (#366), the latest
// listing winning, except that a listing which has not read the usage
// endpoint leaves a recorded `limits` in place. Both are absent on an
// Organization no listing has named, and `limits` stays absent while every
// listing that named it answered null (a Hub that has not read it yet), so an
// entry with `hints` and no `limits` is well-formed. `unlisted: true` marks an
// entry with `hints` that the latest non-empty listing omitted (#366, #360
// item 3): every listing is its lister's complete one, so the Organization
// has left that key's list. The entry keeps everything it had and stays in
// the roster, reading `Not on this account's list`; the next listing that
// names it drops the mark. `firstSeenAt` (ISO) is
// when this registry first learned of the Organization, stamped on insertion
// and never moved; an entry written before the field keeps it absent — never
// backfilled, so an entry recorded before #287 stays unstamped and can never
// read "New". An Organization known only from usage was never an entry, so it
// is stamped at the first roster read that sees its usage (ADR-0105 §5). No
// Organization `name` is ever stored — no listing parses it (ADR-0098 §6). The
// version stays 1: the new fields are optional, so a file written before them
// still loads.
// Disposable by contract: deleting it costs plan words and Connect's seed until
// a later login or Connect relearns them, and first-seen times, which are lost —
// each Organization is re-stamped at the later moment it is next seen — never
// a number. The user's renames are not kept here — they live in the durable
// `organization-labels.json` (./organization-labels.ts).
const registryEntrySchema = z.object({
  organizationType: z.string().nullable(),
  limits: orgLimitsAnswerSchema.optional(),
  hints: organizationRosterHintsSchema.optional(),
  firstSeenAt: z.string().optional(),
  unlisted: z.literal(true).optional(),
});
export type RegistryEntry = z.infer<typeof registryEntrySchema>;
const registryFileSchema = z.object({
  version: z.literal(1),
  organizations: z.record(registryEntrySchema),
});

// One Organization a listing named, with the answer its usage endpoint gave —
// null when the lister has not read it yet (a Hub's row, #366), which leaves a
// recorded answer in place. Connect's DiscoveredOrg is the non-null case.
export type LearnedOrg = {
  id: string;
  hints: OrganizationRosterHints;
  limits: OrgLimitsAnswer | null;
};

export type OrganizationRegistry = {
  load: () => Promise<void>;
  // Record a plan word for an organization. A known plan word is never
  // downgraded to null (logging out of an org must not erase its label).
  remember: (uuid: string, organizationType: string | null) => Promise<void>;
  // Record a listing: Connect's discovery (#283), the Hub's roster (#366) and
  // a Hub-less client's own listing (#366) all record through here, and each
  // call is its lister's COMPLETE listing. For each Organization it names, the
  // roster hints and a non-null Limits answer replace the previous ones, a
  // null answer leaves a recorded one in place, the plan word is kept, and an
  // `unlisted` mark is cleared. Every other entry some listing once named (it
  // has hints) is marked `unlisted` (#360 item 3) and otherwise left as it
  // was; one known only from a login, usage or a legacy push is never marked,
  // and nothing ever leaves the registry. An empty listing changes nothing.
  // One write, and only when something moved — answered true exactly then.
  recordDiscovery: (orgs: readonly LearnedOrg[]) => Promise<boolean>;
  // Add every Organization the registry does not know yet, with no plan word
  // (#287: one known only from usage still gets a first-seen time). A known
  // one is left as it was. One write, and only when something was added.
  observe: (uuids: Iterable<string>) => Promise<void>;
  // Everything known, by uuid. The live map: callers only read it.
  entries: () => ReadonlyMap<string, Readonly<RegistryEntry>>;
};

export function createOrganizationRegistry(opts: {
  path: string;
  now?: () => number;
}): OrganizationRegistry {
  const now = opts.now ?? Date.now;
  const known = new Map<string, RegistryEntry>();

  // The entry a NEW uuid starts from: the one place `firstSeenAt` is stamped,
  // so every insertion path stamps it and no update path can move it.
  function fresh(): RegistryEntry {
    return { organizationType: null, firstSeenAt: new Date(now()).toISOString() };
  }

  async function load(): Promise<void> {
    try {
      const parsed = registryFileSchema.safeParse(JSON.parse(await readFile(opts.path, "utf8")));
      if (!parsed.success) return;
      for (const [uuid, entry] of Object.entries(parsed.data.organizations)) {
        known.set(uuid, entry);
      }
    } catch {
      // Absent or unreadable: start empty.
    }
  }

  async function write(): Promise<void> {
    const tmp = `${opts.path}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, organizations: Object.fromEntries(known) }));
    await rename(tmp, opts.path);
  }

  // One write at a time: every write goes through the one fixed `${path}.tmp`,
  // so two overlapping writes would rename each other's file away. Each write
  // serializes the map as it stands when the write RUNS, so the last one queued
  // carries every change made before it; a failed write rejects its own caller
  // and never stalls the queue.
  let chain: Promise<void> = Promise.resolve();
  function persist(): Promise<void> {
    chain = chain.then(write, write);
    return chain;
  }

  async function remember(uuid: string, organizationType: string | null): Promise<void> {
    const prev = known.get(uuid);
    if (prev?.organizationType === organizationType) return;
    if (prev !== undefined && prev.organizationType !== null && organizationType === null) return;
    known.set(uuid, { ...(prev ?? fresh()), organizationType });
    await persist();
  }

  async function recordDiscovery(orgs: readonly LearnedOrg[]): Promise<boolean> {
    // An empty listing says nothing about what the key lists.
    if (orgs.length === 0) return false;
    let changed = false;
    const listed = new Set<string>();
    for (const org of orgs) {
      listed.add(org.id);
      const prev = known.get(org.id);
      // A null answer is "not read yet": it never erases a recorded one.
      const limits = org.limits ?? prev?.limits;
      if (
        prev !== undefined &&
        prev.unlisted === undefined &&
        prev.limits === limits &&
        isDeepStrictEqual(prev.hints, org.hints)
      ) {
        continue;
      }
      const next: RegistryEntry = { ...(prev ?? fresh()), hints: org.hints };
      if (limits !== undefined) next.limits = limits;
      delete next.unlisted;
      known.set(org.id, next);
      changed = true;
    }
    // The listing is complete: an entry some listing named that this one
    // omits has left the key's list. Marked, never removed (#360 item 3).
    for (const [uuid, entry] of known) {
      if (listed.has(uuid) || entry.hints === undefined || entry.unlisted === true) continue;
      known.set(uuid, { ...entry, unlisted: true });
      changed = true;
    }
    if (changed) await persist();
    return changed;
  }

  async function observe(uuids: Iterable<string>): Promise<void> {
    let added = false;
    for (const uuid of uuids) {
      if (known.has(uuid)) continue;
      known.set(uuid, fresh());
      added = true;
    }
    if (added) await persist();
  }

  return {
    load,
    remember,
    recordDiscovery,
    observe,
    entries: () => known,
  };
}

// Compose the GET /api/organizations body — the Settings roster (#287). Pure:
// every input is handed in.
//
// The rows are every Organization any source names: a current login, the
// Home, usage seen on this machine or the fleet, the registry (logins
// remembered, Connect's discovery, usage observed), and the tracked set. A
// label alone adds no row — a rename for an Organization nothing else knows
// is dormant text.
//
// Each label is resolved by `resolveOrganizationLabel` (the user's rename,
// else a plan word, else a short id). The plan word comes from a current login
// naming the Organization, else from the registry — a login file that lost its
// plan word must not lose the one remember() kept — else from Connect's hints.
// The Limits answer is the poller's when it has one (`source: "poll"`), else
// the answer a listing recorded (`source: "connect"`) while the latest listing
// still names the Organization, else null. "Your account" (`seenOn.account`)
// asks the same: some listing named it and the latest did not drop it. So a
// dropped row with no poll answer reads `Not on this account's list` (#360
// item 3).
//
// Current logins sort first, then by resolved label, then by uuid: the Home
// organization select renders this order as it always has; the Settings list
// orders its own rows.
export function listOrganizations(input: {
  home: string | null;
  currentLogins: readonly CurrentLogin[];
  remoteControlAtStartup: boolean;
  seen: { machine: ReadonlySet<string>; fleet: ReadonlySet<string> };
  // The resolved tracked set; null excludes nothing, so every row is tracked.
  tracked: ReadonlySet<string> | null;
  // The status snapshot's per-Organization map — this machine's poller's, or
  // the Hub's that a hub-connected client mirrors.
  pollerOrganizations: UsageOrganizations;
  reingesting: ReadonlySet<string>;
  registry: ReadonlyMap<string, Readonly<RegistryEntry>>;
  labels: Pick<OrganizationLabels, "get">;
}): OrganizationsResponse {
  const logins = new Map(input.currentLogins.map((login) => [login.organizationUuid, login]));
  const uuids = new Set<string>(logins.keys());
  if (input.home !== null) uuids.add(input.home);
  for (const uuid of input.seen.machine) uuids.add(uuid);
  for (const uuid of input.seen.fleet) uuids.add(uuid);
  for (const uuid of input.registry.keys()) uuids.add(uuid);
  for (const uuid of input.tracked ?? []) uuids.add(uuid);
  const organizations = [...uuids]
    .map((uuid): OrganizationEntry => {
      const login = logins.get(uuid);
      const entry = input.registry.get(uuid);
      const { label, renamed, plan } = resolveOrganizationLabel({
        uuid,
        rename: input.labels.get(uuid),
        organizationType: login?.organizationType ?? entry?.organizationType,
        hints: entry?.hints,
      });
      // An own key only, like planLabel: a uuid is never a prototype name.
      const polled = Object.hasOwn(input.pollerOrganizations, uuid)
        ? input.pollerOrganizations[uuid]
        : undefined;
      const onAccount = entry?.hints !== undefined && entry.unlisted !== true;
      return {
        uuid,
        label,
        renamed,
        plan,
        currentLogin: login !== undefined,
        tracked: input.tracked === null || input.tracked.has(uuid),
        limits:
          polled !== undefined
            ? {
                answer: polled.limits,
                windowStates: polled.windowStates,
                source: "poll",
                lastReadAt: polled.lastReadAt,
                lastSampleAt: polled.lastSampleAt,
              }
            : entry?.limits !== undefined && entry.unlisted !== true
              ? {
                  answer: entry.limits,
                  windowStates: null,
                  source: "connect",
                  lastReadAt: null,
                  lastSampleAt: null,
                }
              : null,
        seenOn: {
          machine: input.seen.machine.has(uuid) || login !== undefined,
          fleet: input.seen.fleet.has(uuid),
          account: onAccount,
        },
        firstSeenAt: entry?.firstSeenAt ?? null,
        reingesting: input.reingesting.has(uuid),
      };
    })
    .sort((a, b) => {
      if (a.currentLogin !== b.currentLogin) return a.currentLogin ? -1 : 1;
      if (a.label !== b.label) return a.label < b.label ? -1 : 1;
      return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0;
    });
  return {
    home: input.home,
    remoteControlAtStartup: input.remoteControlAtStartup,
    organizations,
  };
}

// What PUT /api/organizations/:uuid answers, before HTTP: the fresh roster, or
// which refusal (404 / 400 / 409 in the pinned error envelope).
export type OrganizationRenameResult =
  | { kind: "ok"; body: OrganizationsResponse }
  | { kind: "unknown" }
  | { kind: "invalid"; reason: "empty" | "too-long" }
  | { kind: "duplicate" };

// The rename rules (#287). `label: null` clears the rename back to the
// resolved default. Otherwise the label is trimmed, 1 to 40 code points
// (`checkOrganizationLabel`), and unique case-insensitively against every
// OTHER Organization's resolved label, defaults included — renaming one to
// the label it already shows is allowed. Only an Organization in the roster
// can be renamed, and only one whose uuid the Organization directory can key
// (`organizationUuidKeySchema`), as the Hub's PUT requires: every push sends
// the whole map, so one unkeyable entry would have the Hub refuse them all
// (#288). A rename that changes the stored label emits the wholesale
// invalidation a Home change emits (labels decision 10), and the roster's own
// `organizations:changed` poke beside it, then `labelsWritten` — main()'s push
// to the Hub's Organization directory (#288); one that changes nothing writes
// nothing and emits nothing, and still answers the roster.
//
// Renames run one at a time through one promise chain: each composes the
// roster, checks, and writes before the next composes, so two concurrent PUTs
// can never both pass the uniqueness check against the same roster. `list` and
// `labels.set` must each await the label store's load (main()'s `labelsReady`).
export function createOrganizationRename(deps: {
  list: () => Promise<OrganizationsResponse>;
  labels: Pick<OrganizationLabels, "set">;
  invalidateReports: () => void;
  rosterChanged: () => void;
  labelsWritten: () => void;
}): (uuid: string, label: string | null) => Promise<OrganizationRenameResult> {
  async function apply(uuid: string, raw: string | null): Promise<OrganizationRenameResult> {
    const roster = await deps.list();
    if (
      !roster.organizations.some((o) => o.uuid === uuid) ||
      !organizationUuidKeySchema.safeParse(uuid).success
    ) {
      return { kind: "unknown" };
    }
    let label: string | null = null;
    if (raw !== null) {
      const check = checkOrganizationLabel(raw);
      if (!check.ok) return { kind: "invalid", reason: check.reason };
      const folded = check.label.toLowerCase();
      if (roster.organizations.some((o) => o.uuid !== uuid && o.label.toLowerCase() === folded)) {
        return { kind: "duplicate" };
      }
      label = check.label;
    }
    if (!(await deps.labels.set(uuid, label))) return { kind: "ok", body: roster };
    deps.invalidateReports();
    deps.rosterChanged();
    deps.labelsWritten();
    return { kind: "ok", body: await deps.list() };
  }

  let chain: Promise<unknown> = Promise.resolve();
  return (uuid, label) => {
    const run = chain.then(() => apply(uuid, label));
    // A failed rename rejects its own caller and never stalls the next.
    chain = run.catch(() => {});
    return run;
  };
}

// The first-launch seed (ADR-0098): the Organization this machine mostly works
// under — the one that owned the most sessions when they ended — with the boot
// login breaking a tie or standing in when no session names an organization.
// With several roots logged in at once, that login is the first root in
// `claudePaths` order that names one (`readCurrentLogins(...)[0]`, labels
// decision 2).
// The login file alone is not a seed: it flips whenever the user signs in
// elsewhere, and on the machine #228 was found on it named the organization that
// owned 12 of 135 attributed sessions. Pure; deterministic on equal counts.
export function chooseHomeSeed(
  counts: ReadonlyMap<string, number>,
  login: string | null,
): string | null {
  const ranked = [...counts.entries()].sort(([uuidA, countA], [uuidB, countB]) => {
    if (countB !== countA) return countB - countA;
    const loginFirst = (uuidB === login ? 1 : 0) - (uuidA === login ? 1 : 0);
    if (loginFirst !== 0) return loginFirst;
    return uuidA < uuidB ? -1 : uuidA > uuidB ? 1 : 0;
  });
  return ranked[0]?.[0] ?? login;
}
