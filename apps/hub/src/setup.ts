import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { clientFacingHost, type HubStatus, hubStatusSchema, isoFromDate } from "@maxprice/shared";
import { displayPath, type Env } from "@maxprice/usage-core/home-path";
import { EXIT_INTERRUPTED } from "@maxprice/usage-core/secret-input";
import { lingerOff, readLinger, type UnitReading } from "@maxprice/usage-core/systemd-service";
import { terminalText } from "@maxprice/usage-core/terminal-text";
import { CliError, EXIT, type Hint, type Io, renderError, type Writer } from "./cli";
import { defaultDataDir, hasHub, loadOrInitConfig, readHubConfig } from "./config";
import { octal, prepareDataDir } from "./data-dir";
import { keySet, type KeyDeps, type ReadSecret } from "./operator";
import {
  awaitRunningHub,
  NO_ANSWER_MS,
  reachHub,
  type ReachOptions,
  type RunningHub,
  runningHolder,
} from "./operator-client";
import {
  cliPageClear,
  PAGE_APACHE_LINES,
  probePage,
  type ProbeDeps,
  readingLine,
  setHubPageUrl,
} from "./page-publish";
import { hostAndPort } from "./rebind";
import { RESTORE_STAGING, unfinishedRestore } from "./restore";
import { createFileCredstore, secretsPath } from "./secrets";
import { UNIT } from "./serve-lock";
import { type HubAnswers, hubDataDirOnInstall, hubService, hubUnit } from "./service";
import type { SetupTerminal } from "./setup-terminal";
import { VERSION } from "./version";

// `maxprice-hub setup` (ADR-0128 §1–§5): the Headless Hub's first setup,
// walked on a terminal. It adds no operation of its own. Each of its four
// steps calls the code its command runs and has that command's effect: step
// 1 is `key set`'s keySet, step 2 `password set`'s runPasswordSet or the
// `password clear` verb, which index.ts hands in (setupPasswordSteps), step
// 3 `page set`'s setHubPageUrl, its snippet left out (§3), or `page clear`,
// and step 4 `service install`, its linger advice withheld for the ending.
// Setup's own logic is the gates it passes before anything is created, the
// unit's data dir among them (§1, §2), the prompting around the steps (§3),
// the data dir and hub.json it makes first, as serve does (§2), and the
// ending, which reads the Hub page, lists the sudo steps a human has to run
// and prints how clients join (§5).
//
// The lock discipline is the commands'. Setup's init holds serve.lock only
// while it makes hub.json and reads the state, and each offline step takes
// it only inside its command, so no prompt is ever answered with the lock
// held: a serve starting meanwhile waits a hold out for 500 ms
// (SERVE_LOCK_RETRY_MS), not a prompt's, and then exits 5, which the unit
// never retries. The ending never takes it, not even for a moment, since it
// waits for a Hub that may not have taken it yet, which reachHub's take of a
// free lock would answer `offline` instead: it asks
// runningHolder whether a Hub is coming and waits through awaitRunningHub,
// both of which read the lock's record alone (operator-client.ts).
//
// Everything setup says and asks goes to stdout, and a step's failure to
// stderr, rendered as the top level renders an error; a command's own lines
// are indented four spaces under the step that ran it, on the stream the
// command chose. Every line carrying outside text goes through
// `terminalText` (ADR-0127 §11).

export type SetupDeps = {
  // The prompts (setup-terminal.ts).
  terminal: SetupTerminal;
  // `password set`, reading through `read` and printing its line to `out`,
  // and `password clear`, printing to `out`: index.ts's code, handed in by
  // its setupPasswordSteps, since setup cannot import index.ts, which
  // imports setup.
  passwordSet: (read: ReadSecret, out: Writer) => Promise<number>;
  passwordClear: (out: Writer) => Promise<number>;
  // What `service install` and the unit's reading take beside the
  // environment; production passes hubAnswers alone.
  service: { hubAnswers: HubAnswers; self?: readonly string[]; cwd?: string };
  // What a test replaces; production passes none. `reach` is every reach's:
  // the init's, key set's and the ending's polls and cgroup reader.
  env?: Env;
  platform?: NodeJS.Platform;
  uid?: number;
  isTTY?: boolean;
  // /etc/passwd's text, which names the uid in the linger line; null when
  // it cannot be read.
  passwd?: string | null;
  key?: Pick<KeyDeps, "discover" | "now">;
  reach?: ReachOptions;
  // How long the ending waits for the Hub; NO_ANSWER_MS by default.
  waitMs?: number;
  probe?: Omit<ProbeDeps, "env" | "platform">;
};

// The discrete commands in setup's order, which an off-TTY setup lists
// (§1): `service install` first, since its serve makes hub.json, which the
// others refuse to run without (ADR-0127 §4).
const COMMANDS: Hint[] = [
  "maxprice-hub service install  starts serve, which makes hub.json",
  "maxprice-hub key set < key.txt",
  "maxprice-hub password set < password.txt",
  "maxprice-hub page set <url>",
  "maxprice-hub page",
];

const WHY: Hint = { label: "Why:", command: "maxprice-hub service logs" };

const STATUS_PATH = "/api/status";

// Ctrl-C, or Ctrl-D on an empty line, at a prompt: setup stops with exit
// 130, keeping every step it completed.
class Interrupted extends Error {}

// An empty first entry at step 2's `New Hub password:`, which skips the
// step; thrown out of runPasswordSet by setup's reader.
class Skipped extends Error {}

// A Writer whose every line starts with four spaces, wherever the chunks it
// is handed break: a command's output under the step that ran it. An empty
// line stays empty.
export function indented(writer: Writer): Writer {
  let lineStart = true;
  return {
    write(text: string) {
      let out = "";
      for (const [index, part] of text.split("\n").entries()) {
        if (index > 0) {
          out += "\n";
          lineStart = true;
        }
        if (part === "") continue;
        out += lineStart ? `    ${part}` : part;
        lineStart = false;
      }
      return writer.write(out);
    },
  };
}

// When the key was set, as the re-run's question shows it: local time to the
// minute, the date as daily rows write theirs (isoFromDate), or null for a
// timestamp that does not parse.
export function localMinute(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${isoFromDate(at)} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

// How clients join (§5): the host the hub Popout's Listening row shows,
// clientFacingHost's one rule for both, on the daemon's port, an IPv6 one
// bracketed; with none, the Hub is local only, and the line names the key
// that changes it. `--password` only when a Hub password is set.
export function joinLines(
  status: Pick<HubStatus, "bindHosts" | "passwordProtected">,
  port: number,
  shownDir: string,
): string[] {
  const host = clientFacingHost(status.bindHosts);
  if (host === undefined) {
    return [
      `The Hub listens on loopback only, so no client can join it. Set "bind" in ${shownDir}/hub.json (apps/hub/README.md), then restart the Hub.`,
    ];
  }
  const url = `http://${hostAndPort(host, port)}`;
  const guarded = status.passwordProtected === true;
  return [
    `Clients join ${url} (${guarded ? "password protected" : "no password"})`,
    "    Desktop client:  Settings › Usage hub",
    `    Headless client: maxprice hub join ${url}${guarded ? " --password" : ""}`,
  ];
}

// What the steps show as the current state (§3): the key's provenance,
// when and by whom it was set, and whether a Hub password is set.
type HubState = {
  key: { setAt: string | null; source: string | null } | null;
  password: boolean;
};

// One run's fixed parts, which every step reads.
type Walk = {
  io: Io;
  // The same streams, indented under the step.
  sub: Io;
  deps: SetupDeps;
  env: Env;
  platform: NodeJS.Platform;
  uid: number;
  dataDir: string;
  // The data dir as lines show it.
  shown: string;
};

// One of setup's own lines, on stdout, any outside text in it made inert.
function say(walk: Walk, line: string): void {
  walk.io.stdout.write(`${terminalText(line)}\n`);
}

// A step's failure, as the top level would print it, under the step.
function failed(walk: Walk, error: unknown): void {
  walk.sub.stderr.write(renderError(error));
}

// A visible answer; Ctrl-C ends the run.
async function ask(walk: Walk, prompt: string): Promise<string> {
  const answer = await walk.deps.terminal.line(prompt);
  if (answer === null) throw new Interrupted();
  return answer;
}

// A [y/N] or [Y/n] question, asked again until it is answered: Enter is the
// default, `fallback`.
async function yesNo(walk: Walk, prompt: string, fallback: boolean): Promise<boolean> {
  for (;;) {
    const answer = (await ask(walk, prompt)).toLowerCase();
    if (answer === "") return fallback;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
  }
}

// Read the reach's own GET /api/status body whole by this binary's schema.
// Another request would give startup a second full timeout, and could fail
// after the reach already received a usable answer.
function readStatus(hub: RunningHub): HubStatus {
  const status = hubStatusSchema.safeParse(hub.status);
  if (!status.success) {
    throw new CliError(
      EXIT.FAILURE,
      `the running Hub's ${STATUS_PATH} answer does not match this maxprice-hub`,
    );
  }
  return status.data;
}

// The gate on the unit's data dir (§2), before anything is created:
// configuring one data dir while the unit serves another is ADR-0126's
// hazard. With a user manager, step 4 installs the unit, so two refusals:
// an installed unit that serves another data dir than this shell's, and a
// unit installed from this shell that would, whether or not one is
// installed now, since step 4's install would move it there. The second is
// a shell whose XDG_DATA_HOME alone moves its data dir: the unit never sees
// that variable, so it would serve the default dir, a Hub with no key or
// password (ADR-0127 §5). With no user manager nothing is installed, and
// neither applies. The shell's dir is read against `cwd`, as `service
// status` reads it.
function refuseOtherDataDir(unit: UnitReading, dataDir: string, env: Env, cwd: string): void {
  if (unit.kind !== "unit") return;
  const shellDir = resolve(cwd, dataDir);
  const shellShown = displayPath(shellDir, env);
  if (unit.installed && unit.dataDir !== shellDir) {
    throw new CliError(
      EXIT.USAGE,
      `${UNIT} serves ${displayPath(unit.dataDir, env)}, not this shell's ${shellShown}`,
      [
        `Set MAXPRICE_HUB_DATA_DIR=${unit.dataDir} and run setup again, or point the unit here: MAXPRICE_HUB_DATA_DIR=${shellDir} maxprice-hub service install`,
      ],
    );
  }
  const wouldServe = hubDataDirOnInstall({ env, cwd });
  if (wouldServe !== shellDir) {
    throw new CliError(
      EXIT.USAGE,
      `${UNIT} would serve ${displayPath(wouldServe, env)}, not this shell's ${shellShown}: the unit never sees XDG_DATA_HOME`,
      [`Set MAXPRICE_HUB_DATA_DIR=${shellDir} and run setup again`],
    );
  }
}

// §2: the data dir and hub.json, as serve makes them at boot, and the state
// the steps start from. With the lock free it is held only for this, around
// the refusal serve makes of a half-restored dir, loadOrInitConfig and the
// reading of the key's file and hub.json; `created` says whether hub.json is
// this run's. With a Hub running, the state is its own status.
async function init(walk: Walk): Promise<{ created: boolean; state: HubState }> {
  const { dataDir, env } = walk;
  const reached = await reachHub(dataDir, env, walk.deps.reach);
  if (reached.kind === "live") {
    const status = readStatus(reached.hub);
    return {
      created: false,
      state: {
        key: status.credentialPresent
          ? {
              setAt: status.credentialUpdatedAt ?? null,
              source: status.credentialSource ?? null,
            }
          : null,
        password: status.passwordProtected === true,
      },
    };
  }
  try {
    if (existsSync(join(dataDir, RESTORE_STAGING))) throw unfinishedRestore(dataDir, env);
    const created = !hasHub(dataDir);
    loadOrInitConfig(dataDir);
    // The boot's read, with its lines unsaid: setup's question says what
    // it found.
    const stored = await createFileCredstore(secretsPath(dataDir), {
      log: () => {},
      warn: () => {},
    }).get();
    return {
      created,
      state: {
        key:
          stored === null
            ? null
            : {
                setAt: stored.provenance?.setAt ?? null,
                source: stored.provenance?.source ?? null,
              },
        password: readHubConfig(dataDir).config.passwordHash !== null,
      },
    };
  } finally {
    reached.lock.release();
  }
}

// Step 1, the claude.ai session key: `key set`'s code with the key read
// here, behind setup's own prompt, so Enter can skip it. A stored key is
// replaced only on a yes. A refusal (no Organizations, claude.ai unreachable,
// an OAuth token, a Hub refusing it) prints its reason and asks again.
async function stepKey(walk: Walk, state: HubState): Promise<void> {
  let skipped = "Skipped: a client that joins with auto-heal on pushes its key.";
  if (state.key === null) {
    say(walk, "1/4 claude.ai session key");
  } else {
    const at = state.key.setAt === null ? null : localMinute(state.key.setAt);
    const set = `set${at === null ? "" : ` ${at}`}${state.key.source === null ? "" : `, ${state.key.source}`}`;
    if (!(await yesNo(walk, terminalText(`1/4 Session key: ${set}. Replace? [y/N] `), false))) {
      return;
    }
    skipped = "Kept.";
  }
  for (;;) {
    const key = await walk.deps.terminal.secret(
      "    Paste the sessionKey cookie (hidden; Enter skips): ",
    );
    if (key === null) throw new Interrupted();
    if (key === "") {
      say(walk, `    ${skipped}`);
      return;
    }
    try {
      await keySet(walk.sub, walk.env, walk.platform, {
        ...walk.deps.key,
        readSecret: async () => key,
        reach: walk.deps.reach,
      });
      return;
    } catch (error) {
      failed(walk, error);
    }
  }
}

// `password set` through setup's reader: readNewPassword's own prompts,
// indented, hidden. An empty first entry skips; an empty second one is a
// mismatch, as `password set` reads it. Its outcome: set, skipped, or a
// failure already printed, which asks again.
async function setPassword(walk: Walk): Promise<"set" | "skipped" | "failed"> {
  let first = true;
  const read: ReadSecret = async (prompt) => {
    const answer = await walk.deps.terminal.secret(`    ${prompt}`);
    if (first && answer === "") throw new Skipped();
    first = false;
    return answer;
  };
  try {
    const code = await walk.deps.passwordSet(read, walk.sub.stdout);
    if (code === EXIT_INTERRUPTED) throw new Interrupted();
    return "set";
  } catch (error) {
    if (error instanceof Interrupted) throw error;
    if (error instanceof Skipped) return "skipped";
    failed(walk, error);
    return "failed";
  }
}

// Step 2, the Hub password: none by default, ADR-0037's open Hub. Set or
// changed through `password set`, asked twice; cleared through `password
// clear`. A failure (a mismatch, an invalid password, a Hub that refused
// it) prints its reason and asks again.
async function stepPassword(walk: Walk, state: HubState): Promise<void> {
  if (!state.password) {
    say(walk, "2/4 Hub password. Clients enter it once.");
    if (!(await yesNo(walk, "    Set one? [y/N] ", false))) return;
  } else {
    for (;;) {
      const answer = (
        await ask(walk, "2/4 Hub password: set. Keep, change or clear? [K/c/x] ")
      ).toLowerCase();
      if (answer === "" || answer === "k" || answer === "keep") return;
      if (answer === "x" || answer === "clear") {
        try {
          await walk.deps.passwordClear(walk.sub.stdout);
          return;
        } catch (error) {
          failed(walk, error);
          continue;
        }
      }
      if (answer === "c" || answer === "change") break;
    }
  }
  for (;;) {
    const outcome = await setPassword(walk);
    if (outcome === "set") return;
    if (outcome === "skipped") {
      say(walk, state.password ? "    Kept." : "    Skipped: no Hub password.");
      return;
    }
  }
}

// Step 3, the Hub page URL, read from hub.json as it stands: `page set`'s
// check and save, with no snippet, which the ending's install lines carry
// (§3, §5); `-` clears a set one through `page clear`; Enter keeps whatever
// is there. A rejected URL prints why and asks again.
async function stepPageUrl(walk: Walk): Promise<void> {
  const current = readHubConfig(walk.dataDir).config.pageUrl ?? null;
  say(
    walk,
    current === null
      ? "3/4 Hub page URL: where your web server will publish it (Enter skips)"
      : `3/4 Hub page URL: ${current}  (Enter keeps, - clears)`,
  );
  for (;;) {
    const input = await ask(walk, "    > ");
    if (input === "") return;
    try {
      if (current !== null && input === "-") {
        await cliPageClear({ io: walk.sub, env: walk.env, platform: walk.platform });
      } else {
        const url = setHubPageUrl(walk.dataDir, input);
        say(walk, `    Hub page URL set to ${url}; the end of setup checks it.`);
      }
      return;
    } catch (error) {
      failed(walk, error);
    }
  }
}

// What step 4 leaves for the ending: whether the unit is installed, which
// brings the linger line; whether this run's install succeeded, which makes
// the ending wait for the Hub it started; and whether it failed and was
// given up on, after which the ending points back to `service install`
// rather than to another init.
type ServiceOutcome = { installed: boolean; started: boolean; failed: boolean };

// Step 4, `maxprice-hub.service`, from the gate's reading of it. With no
// user manager there is nothing to install, and the step says where a unit
// for another init is. An installed unit is installed again, with no
// question: install rewrites nothing that did not change and restarts only
// what did. Install's lines are its own, its linger advice withheld; then
// the state it left. A failure prints why and offers to try again.
async function stepService(walk: Walk, unit: UnitReading): Promise<ServiceOutcome> {
  if (unit.kind === "no-manager") {
    say(walk, "4/4 Service: no systemd user manager");
    say(walk, `    ${unit.message}`);
    say(walk, "    apps/hub/README.md shows a unit for other inits.");
    return { installed: false, started: false, failed: false };
  }
  if (unit.installed) {
    say(walk, `4/4 Service: ${UNIT} is installed`);
  } else if (!(await yesNo(walk, `4/4 Install and start ${UNIT}? [Y/n] `, true))) {
    say(walk, "    Skipped.");
    return { installed: false, started: false, failed: false };
  }
  const { hubAnswers, self, cwd } = walk.deps.service;
  const readCgroup = walk.deps.reach?.readCgroup;
  for (;;) {
    try {
      await hubService({ positionals: ["install"], follow: false, lines: undefined }, walk.sub, {
        env: walk.env,
        platform: walk.platform,
        hubAnswers,
        adviseLinger: false,
        self,
        cwd,
        uid: walk.uid,
        readCgroup,
      });
    } catch (error) {
      failed(walk, error);
      if (await yesNo(walk, "    Try again? [y/N] ", false)) continue;
      return { installed: unit.installed, started: false, failed: true };
    }
    const now = await hubUnit({ env: walk.env, hubAnswers, readCgroup });
    if (now.kind === "unit" && now.activeState !== "") {
      say(
        walk,
        now.mainPid > 0 ? `    ${now.activeState} (pid ${now.mainPid})` : `    ${now.activeState}`,
      );
    }
    return { installed: true, started: true, failed: false };
  }
}

// /etc/passwd's text, or null when it cannot be read.
function readPasswd(): string | null {
  try {
    return readFileSync("/etc/passwd", "utf8");
  } catch {
    return null;
  }
}

// The name the linger line gives `loginctl enable-linger` (§5): the passwd
// entry for this uid, else the uid itself, which loginctl takes too. Not
// os.userInfo(), whose name Bun reads from $USER and answers "unknown"
// without it, as under `env -i` or a shell that never set it.
export function loginName(uid: number, passwd: string | null): string {
  for (const line of (passwd ?? "").split("\n")) {
    const [name, , id] = line.split(":");
    if (name !== undefined && name !== "" && id === String(uid)) return name;
  }
  return String(uid);
}

// The sudo steps still missing (§5): the linger line while the unit is
// installed and logind reads `Linger=no` (lingerOff, install's own rule),
// then ADR-0125 §7's Apache lines while a Hub page URL is set and the page
// is not published there, without `page`'s check, which the Enter makes.
async function sudoLines(
  walk: Walk,
  installed: boolean,
  published: boolean | null,
): Promise<string[]> {
  const lines: string[] = [];
  if (installed && lingerOff(await readLinger(walk.env, walk.uid))) {
    const passwd = walk.deps.passwd === undefined ? readPasswd() : walk.deps.passwd;
    lines.push(`sudo loginctl enable-linger ${loginName(walk.uid, passwd)}`);
  }
  if (published === false) lines.push(...PAGE_APACHE_LINES);
  return lines;
}

// The ending (§5). It waits for a Hub only when one is coming: step 4
// started the unit, or serve.lock names a running process other than this
// one (runningHolder), which every offline step leaves its own pid in. With
// neither, it says how to start serve and exits 0. A Hub that never answers
// is exit 1 with the reason, and `maxprice-hub service logs` under it only
// for a Hub the unit runs, whose journal holds why: the unit step 4 started,
// or a holder, as read before the wait, in maxprice-hub.service. A `serve`
// run by hand logs to its own terminal. Reached, it reads the Hub page at
// hub.json's URL, lists the sudo steps until they are all done or `q`, and
// prints how clients join.
async function ending(walk: Walk, service: ServiceOutcome): Promise<number> {
  const { dataDir, env, deps } = walk;
  say(walk, "");
  const holder = runningHolder(dataDir, deps.reach?.readCgroup);
  if (!service.started && holder === null) {
    say(
      walk,
      service.failed
        ? `No Hub is running: ${UNIT} did not start. Once what stopped it is fixed, run maxprice-hub service install, then check it with maxprice-hub page and maxprice-hub status.`
        : "No Hub is running. Start 'maxprice-hub serve' under your own init (apps/hub/README.md shows a unit), then check it with maxprice-hub page and maxprice-hub status.",
    );
    return EXIT.OK;
  }
  const waitMs = deps.waitMs ?? NO_ANSWER_MS;
  async function currentHub() {
    const awaited = await awaitRunningHub(dataDir, env, {
      timeoutMs: waitMs,
      pollMs: deps.reach?.pollMs,
      readCgroup: deps.reach?.readCgroup,
    });
    if (awaited.kind === "none") {
      const unitRuns = service.started || holder?.service === true;
      throw new CliError(
        EXIT.FAILURE,
        `the Hub did not answer within ${waitMs / 1000} s: ${awaited.reason}`,
        unitRuns ? [WHY] : [],
      );
    }
    return { hub: awaited.hub, status: readStatus(awaited.hub) };
  }
  let { hub, status } = await currentHub();

  const url = readHubConfig(dataDir).config.pageUrl ?? null;
  const version = deps.probe?.version ?? VERSION;
  // Whether a blank line is due before the join lines: not right after the
  // Enter or `q`, whose own line already ends the block.
  let separate = false;
  for (;;) {
    let published: boolean | null = null;
    if (url !== null) {
      const reading = await probePage(dataDir, url, hub.port, {
        env,
        platform: walk.platform,
        ...deps.probe,
      });
      published = reading.kind === "published";
      say(
        walk,
        published
          ? `Hub page: published at ${url}`
          : `Hub page: not published: ${readingLine(reading, `${url}view`, version)}`,
      );
      separate = true;
    }
    const lines = await sudoLines(walk, service.installed, published);
    if (lines.length === 0) break;
    say(walk, "Run these, then press Enter to check again (q finishes):");
    for (const line of lines) say(walk, `    ${line}`);
    const answer = await ask(walk, "");
    separate = false;
    if (answer.toLowerCase() === "q") break;
  }
  // Page and logind checks, especially the human's sudo work, can outlast
  // a rebind or restart. Reach again only after that work, with a new bound
  // of its own, rereading the holder's port and token. Without either check
  // the startup response is already the final reading: no second request.
  if (url !== null || service.installed) ({ hub, status } = await currentHub());
  if (separate) say(walk, "");
  for (const line of joinLines(status, hub.port, walk.shown)) say(walk, line);
  return EXIT.OK;
}

// `maxprice-hub setup`: the gates, in §1's and §2's order and before
// anything is created, then the data dir, the four steps and the ending.
// Exit 0 once the steps ran, the page published or not; 130 for Ctrl-C at
// any prompt, every completed step kept; anything else a CliError the top
// level prints.
export async function runSetup(io: Io, deps: SetupDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") {
    throw new CliError(EXIT.USAGE, "Linux only; the hub tray app sets itself up");
  }
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  if (uid === 0) {
    throw new CliError(EXIT.USAGE, "run setup as the user the Hub runs as, not as root");
  }
  if (!(deps.isTTY ?? process.stdin.isTTY === true)) {
    throw new CliError(
      EXIT.USAGE,
      "setup needs a terminal; without one, run its steps as commands, in this order:",
      COMMANDS,
    );
  }
  const dataDir = defaultDataDir(env, platform);
  const unit = await hubUnit({
    env,
    hubAnswers: deps.service.hubAnswers,
    readCgroup: deps.reach?.readCgroup,
  });
  refuseOtherDataDir(unit, dataDir, env, deps.service.cwd ?? process.cwd());

  const shown = displayPath(dataDir, env);
  const walk: Walk = {
    io,
    sub: { stdout: indented(io.stdout), stderr: indented(io.stderr) },
    deps,
    env,
    platform,
    uid,
    dataDir,
    shown,
  };
  // Setup words the tightening itself, under its first line.
  const prepared = prepareDataDir(dataDir, () => {});
  const { created, state } = await init(walk);
  say(walk, `MaxPrice Hub ${VERSION} · data dir ${shown}${created ? " (new)" : ""}`);
  if (prepared.tightenedFrom !== null) {
    say(walk, `    tightened ${shown} from ${octal(prepared.tightenedFrom)} to 0700`);
  }
  try {
    await stepKey(walk, state);
    await stepPassword(walk, state);
    await stepPageUrl(walk);
    const service = await stepService(walk, unit);
    return await ending(walk, service);
  } catch (error) {
    if (error instanceof Interrupted) return EXIT_INTERRUPTED;
    throw error;
  }
}
