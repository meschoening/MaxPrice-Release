import { createInterface } from "node:readline";
import {
  excludeCopy,
  excludePatch,
  excludeTitle,
  isExcludeArmed,
  makeHomePatch,
  type OrganizationEntry,
  ORGANIZATIONS_PATH,
  type OrganizationsResponse,
  organizationsResponseSchema,
  parseSettings,
  type Settings,
  trackPatch,
} from "@maxprice/shared";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { connect, type Daemon, waitForStatus } from "../daemon-client";
import { CliError, EXIT, usageError } from "../exit";
import type { Io, Parsed } from "../main";
import { resolveOrganization, shortId } from "../names";
import { dataDir, displayPath, type Env, settingsPath } from "../paths";
import { organizationName, renderOrganizations } from "../render/organizations";
import { terminalOutput } from "../render/table";
import {
  admissionRejection,
  type EditOptions,
  editSettings,
  readSettingsObject,
} from "../settings";

// `maxprice org list|track|exclude|home` (ADR-0122 §6): the Desktop client's
// Organizations list, on the command line. Only the daemon assembles the
// roster, so every verb connects first (a down daemon exits 3, a skewed one
// 4, before the file is read) and waits out the initial scan, as a report
// does. An edit names its Organization against that roster, then writes the
// Desktop client's patch (`trackPatch`, `excludePatch`, `makeHomePatch`)
// behind its guards, through `editSettings` under the settings lock (§2). The
// daemon applies it through its own watch of the file (§1), and the command
// waits until the roster shows it.

// What a test replaces; production passes none.
export type OrgDeps = {
  edit?: EditOptions;
  // Whether stdin is a terminal, where `exclude` asks for the label.
  stdinIsTTY?: boolean;
  // Asks on the terminal and reads one line; null at the end of input.
  readLine?: (prompt: string) => Promise<string | null>;
};

type Verb = "track" | "exclude" | "home";

const HELP = "maxprice org --help";

// How often the wait asks for the roster (§6).
const POLL_MS = 100;

function usage(message: string): CliError {
  return usageError(message, HELP);
}

type Membership = Pick<Settings, "homeOrganization" | "trackedOrganizations">;

// What an edit comes to against the settings it is built from: a patch to
// write, with the Home it replaces; or nothing to write, which is either a
// line on stdout and exit 0, or exit 1.
type Decision =
  | { kind: "write"; patch: Partial<Membership>; home: string }
  | { kind: "answer"; line: string }
  | { kind: "refuse"; error: CliError };

// The patch helpers' null, told apart by the tests they make: no Home, the
// target is Home, the list's membership, and for `home` the roster's flag.
function decide(verb: Verb, settings: Membership, entry: OrganizationEntry): Decision {
  const name = organizationName(entry);
  const home = settings.homeOrganization;
  // With no Home the daemon resolves no tracked set and excludes nothing, so
  // no edit has anything to change.
  if (home === null) {
    return {
      kind: "refuse",
      error: new CliError(
        EXIT.FAILURE,
        "there is no Home organization yet, so every Organization is counted; an edit needs a Home",
      ),
    };
  }
  switch (verb) {
    case "track": {
      const patch = trackPatch(settings, entry.uuid);
      if (patch !== null) return { kind: "write", patch, home };
      return {
        kind: "answer",
        line:
          entry.uuid === home
            ? `${name} is Home, which is always tracked`
            : `${name} is already tracked`,
      };
    }
    case "exclude": {
      const patch = excludePatch(settings, entry.uuid);
      if (patch !== null) return { kind: "write", patch, home };
      if (entry.uuid !== home) return { kind: "answer", line: `${name} is already excluded` };
      return {
        kind: "refuse",
        error: new CliError(EXIT.FAILURE, `${name} is Home, which is always tracked`, [
          {
            label: "Make another Tracked organization Home first:",
            command: "maxprice org home <org>",
          },
        ]),
      };
    }
    case "home": {
      const patch = makeHomePatch(settings, entry.uuid, entry.tracked);
      if (patch !== null) return { kind: "write", patch, home };
      if (entry.uuid === home) return { kind: "answer", line: `${name} is already Home` };
      return {
        kind: "refuse",
        error: new CliError(EXIT.FAILURE, `${name} is not tracked; track it first`, [
          { label: "Track it:", command: "maxprice org track <org>" },
        ]),
      };
    }
  }
}

function settle(decision: Exclude<Decision, { kind: "write" }>, io: Io): number {
  if (decision.kind === "refuse") throw decision.error;
  io.stdout.write(`${decision.line}\n`);
  return EXIT.OK;
}

// Home and the tracked list as the file holds them. A value the schema
// rejects is refused, not read as its fallback: a patch built on the
// fallback would replace the stored value (ADR-0122 §7).
function membership(raw: Record<string, unknown>, env: Env): Membership {
  const rejection = admissionRejection(raw, env);
  if (rejection !== null) throw new CliError(EXIT.FAILURE, `${rejection}; fix the file`);
  return parseSettings(raw);
}

async function readRoster(daemon: Daemon): Promise<OrganizationsResponse> {
  return (await daemon.request(ORGANIZATIONS_PATH, organizationsResponseSchema)).data;
}

// The daemon and its roster, once the initial scan is done: during it, the
// roster of a machine with a persisted Home is a partial list.
async function connectedRoster(io: Io, env: Env) {
  const daemon = await connect({ env });
  if (!daemon.status.ready) await waitForStatus(daemon, "ready", "scanning…", io.stderr);
  return { daemon, roster: await readRoster(daemon) };
}

// One line from the terminal, the prompt on stderr; null at the end of
// input. Line mode, not readline's raw one: the terminal echoes and edits
// the line, and Ctrl-C is the ordinary SIGINT. Closed once answered, so
// stdin holds the process open no longer.
function readTerminalLine(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    let answered = false;
    rl.on("close", () => {
      if (!answered) resolve(null);
    });
    rl.question(prompt, (line) => {
      answered = true;
      rl.close();
      resolve(line);
    });
  });
}

// ADR-0122 §6: the Desktop client's question, on stderr, then the bare
// label, from `--confirm` or typed on a terminal; there is no blanket
// `--yes`. A label that does not match exits 1 before anything is locked or
// written.
async function confirmExclude(
  entry: OrganizationEntry,
  confirm: string | undefined,
  daemon: Daemon,
  io: Io,
  deps: OrgDeps,
): Promise<void> {
  const title = terminalText(excludeTitle(entry.label, shortId(entry.uuid)));
  // A Hub configured, connected or not, is told its sessions leave it.
  const copy = excludeCopy({ hub: daemon.status.hubConnection !== "off" });
  io.stderr.write([title, ...copy].join("\n\n") + "\n");
  let typed: string | null;
  if (confirm !== undefined) {
    typed = confirm;
  } else if (deps.stdinIsTTY ?? process.stdin.isTTY === true) {
    io.stderr.write("\n");
    typed = await (deps.readLine ?? readTerminalLine)(
      `Type ${terminalText(entry.label)} to exclude it: `,
    );
  } else {
    throw usage("exclude needs --confirm <label> when not on a terminal");
  }
  if (typed === null || !isExcludeArmed(typed, entry.label)) {
    throw new CliError(EXIT.FAILURE, "the label does not match; nothing was excluded");
  }
}

// The roster shows the change: X tracked, X excluded, or X Home. A roster
// without X's row has not shown it yet.
function shows(verb: Verb, uuid: string, roster: OrganizationsResponse): boolean {
  if (verb === "home") return roster.home === uuid;
  const row = roster.organizations.find((entry) => entry.uuid === uuid);
  return row !== undefined && row.tracked === (verb === "track");
}

// The file still holds the change; once it does not, a later edit replaced
// it, and the roster may never show it.
function holds(verb: Verb, uuid: string, settings: Membership): boolean {
  if (verb === "home") return settings.homeOrganization === uuid;
  const named = settings.homeOrganization === uuid || settings.trackedOrganizations.includes(uuid);
  return verb === "track" ? named : !named;
}

// ADR-0122 §6: until the roster shows the change and no Organization is
// re-walking, with no deadline; Ctrl-C ends the wait, and the daemon finishes
// on its own. It does not wait for the repair's Hub forget, which retries on
// its own timer. Returns the last roster read.
async function waitForChange(
  verb: Verb,
  uuid: string,
  daemon: Daemon,
  io: Io,
  env: Env,
): Promise<OrganizationsResponse> {
  let rewalked = false;
  for (;;) {
    const roster = await readRoster(daemon);
    const rewalking = roster.organizations.some((entry) => entry.reingesting);
    if (rewalking && !rewalked) {
      rewalked = true;
      if (io.stderr.isTTY) io.stderr.write("re-walking…\n");
    }
    if (!rewalking && shows(verb, uuid, roster)) return roster;
    // Read through the guards' refusal: a Home or tracked list the schema
    // rejects exits 1, where its fallback could pass for a replaced edit.
    if (!holds(verb, uuid, membership(readSettingsObject(env), env))) {
      io.stderr.write("maxprice: a later change replaced this one; not waiting for it\n");
      return roster;
    }
    await Bun.sleep(POLL_MS);
  }
}

// The wait, after the write: a failure keeps its code and its hints, plus
// where the change is, as `settings set`'s probe does. A daemon gone
// mid-wait exits 3 with the change already in the file, and applies it when
// it starts.
async function waitForChangeOrSayWhereSaved(
  verb: Verb,
  uuid: string,
  daemon: Daemon,
  io: Io,
  env: Env,
): Promise<OrganizationsResponse> {
  try {
    return await waitForChange(verb, uuid, daemon, io, env);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const path = displayPath(settingsPath(dataDir(env)), env);
    throw new CliError(error.code, error.message, [
      ...error.hints,
      `The change is saved in ${path}.`,
    ]);
  }
}

function outcome(
  verb: Verb,
  entry: OrganizationEntry,
  oldHome: string,
  roster: OrganizationsResponse,
): string {
  const name = organizationName(entry);
  if (verb === "track") return `Tracked ${name}`;
  if (verb === "exclude") return `Excluded ${name}`;
  const row = roster.organizations.find((candidate) => candidate.uuid === oldHome);
  const old = row === undefined ? shortId(oldHome) : organizationName(row);
  return `${name} is Home; ${old} stays tracked`;
}

async function list(io: Io, env: Env): Promise<number> {
  const { roster } = await connectedRoster(io, env);
  io.stdout.write(renderOrganizations(roster, terminalOutput(io.stdout, env)));
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
  const { daemon, roster } = await connectedRoster(io, env);
  const entry = resolveOrganization(name, roster.organizations);
  // The guards, against the file as it is now: an answer needs no question
  // and no lock.
  const first = decide(verb, membership(readSettingsObject(env), env), entry);
  if (first.kind !== "write") return settle(first, io);
  if (verb === "exclude") await confirmExclude(entry, confirm, daemon, io, deps);

  // Decided again from the file as read under the lock, so an edit another
  // `maxprice` made meanwhile is built on, not undone: two `org track` runs
  // at once both land. An edit made meanwhile can also leave nothing to
  // write, and the answer is then the locked read's, not the first one's:
  // an `already …` line, or a refusal, such as `exclude X` once X became
  // Home, or a Home or tracked list the schema now rejects.
  let decision = first as Decision;
  await editSettings(
    env,
    (raw) => {
      decision = decide(verb, membership(raw, env), entry);
      if (decision.kind !== "write") return false;
      // Home and the tracked list alone; `organizationScope` is never
      // written (§4).
      Object.assign(raw, decision.patch);
      return true;
    },
    deps.edit,
  );
  if (decision.kind !== "write") return settle(decision, io);

  const last = await waitForChangeOrSayWhereSaved(verb, entry.uuid, daemon, io, env);
  io.stdout.write(`${outcome(verb, entry, decision.home, last)}\n`);
  return EXIT.OK;
}

export async function org(
  parsed: Parsed,
  io: Io,
  env: Env = process.env,
  deps: OrgDeps = {},
): Promise<number> {
  const [verb, ...names] = parsed.positionals;
  const confirm = parsed.values.confirm as string | undefined;
  // Every check that needs no daemon comes first, so a bad command exits 2
  // without connecting.
  if (verb === undefined) throw usage("org needs a command: list, track, exclude or home");
  if (verb !== "list" && verb !== "track" && verb !== "exclude" && verb !== "home") {
    throw usage(`unknown org command '${verb}'`);
  }
  if (confirm !== undefined && verb !== "exclude") throw usage("--confirm is for org exclude only");
  if (verb === "list") {
    if (names.length > 0) throw usage("org list takes no Organization");
    return await list(io, env);
  }
  if (names.length === 0) throw usage(`org ${verb} needs an Organization`);
  if (names.length > 1) throw usage(`org ${verb} takes one Organization`);
  return await edit(verb, names[0]!, confirm, io, env, deps);
}
