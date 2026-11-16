import {
  excludePatch,
  excludeTitle,
  homeOrganizationOf,
  type OrganizationEntry,
  organizationPath,
  ORGANIZATIONS_PATH,
  type OrganizationsResponse,
  organizationsResponseSchema,
  type Settings,
  trackPatch,
} from "@maxprice/shared";
import type { Daemon } from "../daemon-client";
import { CliError, EXIT, usageError } from "../exit";
import type { Io, Parsed } from "../main";
import { resolveOrganization, shortId } from "../names";
import type { Env } from "../paths";
import { organizationText, renderOrganizations } from "../render/organizations";
import { terminalOutput } from "../render/table";
import { editSettings } from "../settings";
import {
  confirmExclude,
  type Decision as EditDecision,
  editAndWait,
  type EditDeps,
  labelArguments,
  labelOutcome,
  putLabel,
  read,
  readyDaemon,
  settle,
  trackingSettings,
  waitForEdit,
  type Watch,
} from "../tracking-edit";

// `maxprice org list|track|exclude|label` (ADR-0122 §6, ADR-0140 §5): the
// Desktop client's Organizations (Settings › Accounts since #639), on the
// command line. Only the daemon assembles the roster, so every verb connects
// first (a down daemon exits 3, a skewed one 4, before the file is read) and
// waits out the initial scan, as a report does. An edit names its
// Organization against that roster, then writes the Desktop client's patch
// (`trackPatch`, `excludePatch`) behind its guards, through `editSettings`
// under the settings lock (§2). The daemon applies it through its own watch
// of the file (§1), and the command waits until the roster shows it. Home is
// `maxprice home`'s (ADR-0140 §5); a label is the daemon's rename route's, as
// the Desktop's Rename is.

export type OrgDeps = EditDeps;

type Verb = "track" | "exclude";

const HELP = "maxprice org --help";

function usage(message: string): CliError {
  return usageError(message, HELP);
}

type Membership = Pick<Settings, "homeMemberships" | "trackedOrganizations">;

type Decision = EditDecision<Partial<Membership>>;

// The patch helpers' null, told apart by the tests they make: no Home, the
// target is Home, and the list's membership.
type Named = Pick<OrganizationEntry, "uuid" | "label">;

function decide(verb: Verb, settings: Membership, entry: Named): Decision {
  const name = organizationText(entry);
  const home = homeOrganizationOf(settings);
  // With no Home the daemon resolves no tracked set and excludes nothing, so
  // no edit has anything to change.
  if (home === null) {
    return {
      kind: "refuse",
      error: new CliError(
        EXIT.FAILURE,
        "there is no Home membership yet, so every Organization is counted; an edit needs a Home",
      ),
    };
  }
  if (verb === "track") {
    const patch = trackPatch(settings, entry.uuid);
    if (patch !== null) return { kind: "write", patch };
    return {
      kind: "answer",
      line:
        entry.uuid === home
          ? `${name} is Home, which is always tracked`
          : `${name} is already tracked`,
    };
  }
  const patch = excludePatch(settings, entry.uuid);
  if (patch !== null) return { kind: "write", patch };
  if (entry.uuid !== home) return { kind: "answer", line: `${name} is already excluded` };
  return {
    kind: "refuse",
    error: new CliError(EXIT.FAILURE, `${name} is Home, which is always tracked`, [
      {
        label: "Make a Membership in another Organization Home first:",
        command: "maxprice home set --org <org>",
      },
    ]),
  };
}

function readRoster(daemon: Daemon): Promise<OrganizationsResponse> {
  return read(daemon, ORGANIZATIONS_PATH, organizationsResponseSchema);
}

// ADR-0122 §6's wait: until the roster shows the change, X tracked or X
// excluded, and no Organization is re-walking. A roster without X's row has
// not shown it yet. Once the file no longer names X as the change left it,
// a later edit replaced it.
function rosterWatch(verb: Verb, uuid: string, daemon: Daemon): Watch<OrganizationsResponse> {
  return {
    read: () => readRoster(daemon),
    rewalking: (roster) => roster.organizations.some((entry) => entry.reingesting),
    shows: (roster) => {
      const row = roster.organizations.find((entry) => entry.uuid === uuid);
      return row !== undefined && row.tracked === (verb === "track");
    },
    holds: (settings) => {
      const home = homeOrganizationOf(settings);
      const named = home === uuid || settings.trackedOrganizations.includes(uuid);
      return verb === "track" ? named : !named;
    },
  };
}

async function list(json: boolean, io: Io, env: Env): Promise<number> {
  const daemon = await readyDaemon(io, env);
  const { data, text } = await daemon.request(ORGANIZATIONS_PATH, organizationsResponseSchema);
  io.stdout.write(json ? text : renderOrganizations(data, terminalOutput(io.stdout, env)));
  return EXIT.OK;
}

async function edit(
  verb: Verb,
  name: string,
  confirm: string | undefined,
  io: Io,
  env: Env,
  deps: OrgDeps,
): Promise<number> {
  const daemon = await readyDaemon(io, env);
  const entry = resolveOrganization(name, (await readRoster(daemon)).organizations);
  // The tracked list alone is written; `scope` never is (§4). Two `org
  // track` runs at once both land, since the second decides again under the
  // lock; one can find `exclude X` refused once X became Home meanwhile.
  const written = await editAndWait(
    {
      decide: (settings) => decide(verb, settings, entry),
      ...(verb === "exclude"
        ? {
            confirm: () =>
              confirmExclude({
                title: excludeTitle(entry.label, shortId(entry.uuid)),
                bareLabel: entry.label,
                confirm,
                help: HELP,
                daemon,
                io,
                deps,
              }),
          }
        : {}),
      apply: (raw, patch) => Object.assign(raw, patch),
      watch: rosterWatch(verb, entry.uuid, daemon),
    },
    io,
    env,
    deps,
  );
  if (written === null) return EXIT.OK;
  const outcome = verb === "track" ? "Tracked" : "Excluded";
  io.stdout.write(`${outcome} ${organizationText(entry)}\n`);
  return EXIT.OK;
}

// `key set`'s Track answers (ADR-0140 §7): every Organization answered yes,
// tracked in one write under the lock, each by `org track`'s own decision
// against the settings the ones before it leave, then waited for as
// `org track` waits, with its line for each. A locked read that leaves one
// nothing to write says so as `org track` does; a refusal (no Home) exits 1
// with nothing written.
export async function trackOrganizations(
  entries: readonly Named[],
  daemon: Daemon,
  io: Io,
  env: Env,
  deps: OrgDeps = {},
): Promise<void> {
  let decisions: Decision[] = [];
  await editSettings(
    env,
    (raw) => {
      let settings: Membership = trackingSettings(raw, env);
      decisions = entries.map((entry) => {
        const decision = decide("track", settings, entry);
        if (decision.kind === "write") settings = { ...settings, ...decision.patch };
        return decision;
      });
      if (decisions.some((d) => d.kind === "refuse")) return false;
      if (!decisions.some((d) => d.kind === "write")) return false;
      raw.trackedOrganizations = settings.trackedOrganizations;
      return true;
    },
    deps.edit,
  );
  const refusal = decisions.find((d) => d.kind === "refuse");
  if (refusal !== undefined) settle(refusal, io);
  for (const [i, entry] of entries.entries()) {
    const decision = decisions[i]!;
    if (decision.kind !== "write") {
      settle(decision, io);
      continue;
    }
    await waitForEdit(rosterWatch("track", entry.uuid, daemon), io, env);
    io.stdout.write(`Tracked ${organizationText(entry)}\n`);
  }
}

// ADR-0140 §5: the Organization label, through the daemon's rename route,
// which rides the fleet's Label directory as the Desktop's Rename does.
// `null` removes it, back to the resolved default.
async function label(name: string, value: string | null, io: Io, env: Env): Promise<number> {
  const daemon = await readyDaemon(io, env);
  const entry = resolveOrganization(name, (await readRoster(daemon)).organizations);
  const answer = await putLabel(
    daemon,
    organizationPath(entry.uuid),
    value,
    organizationsResponseSchema,
    organizationText(entry),
  );
  const now = answer.organizations.find((row) => row.uuid === entry.uuid) ?? entry;
  io.stdout.write(`${labelOutcome(organizationText(entry), now.label, entry.label)}\n`);
  return EXIT.OK;
}

const VERBS = ["list", "track", "exclude", "label"] as const;

export async function org(
  parsed: Parsed,
  io: Io,
  env: Env = process.env,
  deps: OrgDeps = {},
): Promise<number> {
  const [verb, ...names] = parsed.positionals;
  const confirm = parsed.values.confirm as string | undefined;
  const json = parsed.values.json === true;
  const unset = parsed.values.unset === true;
  // Every check that needs no daemon comes first, so a bad command exits 2
  // without connecting.
  if (verb === undefined) throw usage("org needs a command: list, track, exclude or label");
  if (!(VERBS as readonly string[]).includes(verb)) throw usage(`unknown org command '${verb}'`);
  if (confirm !== undefined && verb !== "exclude") throw usage("--confirm is for org exclude only");
  if (json && verb !== "list") throw usage("--json is for org list only");
  if (unset && verb !== "label") throw usage("--unset is for org label only");
  if (verb === "list") {
    if (names.length > 0) throw usage("org list takes no Organization");
    return await list(json, io, env);
  }
  if (verb === "label") {
    const args = labelArguments(names, unset, "org", "Organization", HELP);
    return await label(args.name, args.label, io, env);
  }
  if (names.length === 0) throw usage(`org ${verb} needs an Organization`);
  if (names.length > 1) throw usage(`org ${verb} takes one Organization`);
  return await edit(verb as Verb, names[0]!, confirm, io, env, deps);
}
