import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { organizationLabel, type OrganizationsResponse } from "@maxprice/shared";

// The Organizations this machine knows about (CONTEXT.md, ADR-0098): read from
// Claude Code's login file, remembered in a small registry so a plan word
// survives logging out, and listed for Settings' Home organization select.
// UUIDs and `organizationType` only — `oauthAccount.emailAddress` and
// `organizationName` (which embeds the email) are never read past the parse
// and never written anywhere.

// Claude Code keeps the login in `.claude.json`: `$CLAUDE_CONFIG_DIR/.claude.json`
// when the config dir is relocated, else `~/.claude.json` — a SIBLING of
// `~/.claude/`, not inside it. A watched root is `<configDir>/projects`, so the
// candidates are `<configDir>/.claude.json`, then `<configDir>/../.claude.json`.
// readCurrentLogin also tries the home login after all root-specific candidates;
// XDG-only roots do not have a sibling at the default home login location.
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

// The Organization the CLI is logged into RIGHT NOW, from the first readable
// login file across the watched roots; null when none names one. The caller
// decides when this may be consulted — the home seed uses it only as a boot
// tie-break/fallback and never tracks it live (CONTEXT.md).
export async function readCurrentLogin(
  roots: readonly string[],
  readFileImpl: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
  homeDirectory: string = homedir(),
): Promise<CurrentLogin | null> {
  const candidates = new Set([
    ...roots.flatMap(loginFileCandidates),
    join(homeDirectory, ".claude.json"),
  ]);
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
    if (account !== null && account !== undefined) {
      return {
        organizationUuid: account.organizationUuid,
        organizationType: account.organizationType ?? null,
      };
    }
  }
  return null;
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

// organizations.json — `{ version: 1, organizations: { [uuid]: { organizationType } } }`.
// Disposable by contract: deleting it costs a label, never a number.
const registryFileSchema = z.object({
  version: z.literal(1),
  organizations: z.record(z.object({ organizationType: z.string().nullable() })),
});

export type OrganizationRegistry = {
  load: () => Promise<void>;
  // Record a plan word for an organization. A known plan word is never
  // downgraded to null (logging out of an org must not erase its label).
  remember: (uuid: string, organizationType: string | null) => Promise<void>;
  // `undefined` = never seen; `null` = seen with no plan word.
  typeOf: (uuid: string) => string | null | undefined;
  all: () => ReadonlyMap<string, string | null>;
};

export function createOrganizationRegistry(opts: { path: string }): OrganizationRegistry {
  const known = new Map<string, string | null>();

  async function load(): Promise<void> {
    try {
      const parsed = registryFileSchema.safeParse(JSON.parse(await readFile(opts.path, "utf8")));
      if (!parsed.success) return;
      for (const [uuid, entry] of Object.entries(parsed.data.organizations)) {
        known.set(uuid, entry.organizationType);
      }
    } catch {
      // Absent or unreadable: start empty.
    }
  }

  async function persist(): Promise<void> {
    const organizations: Record<string, { organizationType: string | null }> = {};
    for (const [uuid, organizationType] of known) organizations[uuid] = { organizationType };
    const tmp = `${opts.path}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, organizations }));
    await rename(tmp, opts.path);
  }

  async function remember(uuid: string, organizationType: string | null): Promise<void> {
    const prev = known.get(uuid);
    if (prev === organizationType) return;
    if (prev !== undefined && prev !== null && organizationType === null) return;
    known.set(uuid, organizationType);
    await persist();
  }

  return { load, remember, typeOf: (uuid) => known.get(uuid), all: () => known };
}

// Compose the GET /api/organizations body. The current login sorts first; the
// rest by label. Pure — every input is handed in.
// The current login's plan word comes from the live file, else from the
// registry — a login file that lost its plan word must not lose the label
// remember() kept.
export function listOrganizations(input: {
  home: string | null;
  currentLogin: CurrentLogin | null;
  trackedLimits: string | null;
  remoteControlAtStartup: boolean;
  seen: ReadonlySet<string>;
  registry: OrganizationRegistry;
}): OrganizationsResponse {
  const current = input.currentLogin?.organizationUuid ?? null;
  const uuids = new Set<string>();
  if (current !== null) uuids.add(current);
  if (input.home !== null) uuids.add(input.home);
  if (input.trackedLimits !== null) uuids.add(input.trackedLimits);
  for (const uuid of input.seen) uuids.add(uuid);
  for (const uuid of input.registry.all().keys()) uuids.add(uuid);
  const organizations = [...uuids]
    .map((uuid) => ({
      uuid,
      label: organizationLabel(
        uuid,
        uuid === current
          ? (input.currentLogin?.organizationType ?? input.registry.typeOf(uuid))
          : input.registry.typeOf(uuid),
      ),
      currentLogin: uuid === current,
    }))
    .sort((a, b) => {
      if (a.currentLogin !== b.currentLogin) return a.currentLogin ? -1 : 1;
      return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
    });
  return {
    home: input.home,
    currentLogin: current,
    trackedLimits: input.trackedLimits,
    remoteControlAtStartup: input.remoteControlAtStartup,
    organizations,
  };
}

// The first-launch seed (ADR-0098): the Organization this machine mostly works
// under — the one that owned the most sessions when they ended — with the boot
// login breaking a tie or standing in when no session names an organization.
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
