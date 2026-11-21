// The `launchctl` calls a headless product's launchd verbs and `update` make,
// and what they read from `launchctl print` (ADR-0143 §7–§8, §10). launchctl
// runs through ./systemctl's runners, found on the PATH of the environment
// the caller passes and run with that environment alone, so a test's fake
// launchctl is the only one it can reach.
//
// `launchctl print` documents no format, so this reads only the lines a
// person reads, and only at the job's own level: one tab, then `key = value`,
// or `key = {` opening a block of one item, or `key => value`, per line.
// A key it does not find reads as unknown, never as an error.
//
// Reachable only via the "./launchctl" subpath, never index.ts.

import { agentTarget, guiDomain, type LaunchAgent } from "./launchd-agent";
import { type Ran, runTool } from "./systemctl";
import type { Env } from "./home-path";

/** What `launchctl print gui/<uid>/<label>` says of a loaded job. */
export type AgentPrint = {
  /** "running", "not running", "spawn scheduled", …; "" when it names none. */
  state: string;
  /** The running process, or null when none runs. */
  pid: number | null;
  /** How many times launchd has spawned it since it was loaded. */
  runs: number | null;
  /**
   * How it last ended: "exit 1", "killed by SIGKILL" (launchd's own words
   * after the signal's name: "Killed: 9"), or null when it has not.
   */
  lastExit: string | null;
  /** ProgramArguments, one per line of the `arguments` block. */
  arguments: string[];
  /** The `environment` block: EnvironmentVariables, plus what launchd adds. */
  environment: Record<string, string>;
};

// launchctl's exit when the domain has no such service (113, "Could not
// find service … in domain"). Any other failure is the domain's or the
// tool's.
export const NO_SUCH_SERVICE = 113;

export type AgentReading =
  // `launchctl print gui/<uid>` failed: no GUI session, or no launchctl.
  | { kind: "no-session"; ran: Ran }
  // `launchctl print gui/<uid>/<label>` failed for another reason than a
  // missing service.
  | { kind: "unreadable"; ran: Ran }
  | { kind: "absent" }
  | { kind: "loaded"; print: AgentPrint };

// The job as launchd has it. The domain is asked first (ADR-0143 §7): its
// failure is every verb's no-session line. A target print that fails for
// another reason than a missing service is unreadable, which a verb refuses
// naming that print.
export async function readAgent(
  agent: Pick<LaunchAgent, "label">,
  uid: number,
  env: Env,
): Promise<AgentReading> {
  const domain = await runTool("launchctl", ["print", guiDomain(uid)], env);
  if (domain.code !== 0) return { kind: "no-session", ran: domain };
  const ran = await runTool("launchctl", ["print", agentTarget(agent, uid)], env);
  if (ran.code === NO_SUCH_SERVICE) return { kind: "absent" };
  if (ran.code !== 0) return { kind: "unreadable", ran };
  return { kind: "loaded", print: parsePrint(ran.stdout) };
}

// The job alone, for `update` and the lock's holder check: null when it is
// not loaded or launchctl cannot be asked, which both read as no agent.
export async function printAgent(
  agent: Pick<LaunchAgent, "label">,
  uid: number,
  env: Env,
): Promise<AgentPrint | null> {
  const ran = await runTool("launchctl", ["print", agentTarget(agent, uid)], env);
  return ran.code === 0 ? parsePrint(ran.stdout) : null;
}

// The same, synchronously, for `serve`'s lock loser, which names the agent
// as the holder (ADR-0143 §8) before it exits.
export function printAgentSync(
  agent: Pick<LaunchAgent, "label">,
  uid: number,
  env: Env,
): AgentPrint | null {
  const path = Bun.which("launchctl", { PATH: env.PATH ?? "" });
  if (path === null) return null;
  const ran = Bun.spawnSync([path, "print", agentTarget(agent, uid)], {
    env: env as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    // A lock loser names the agent only if launchctl answers promptly; a
    // hung one never holds up serve's exit.
    timeout: PRINT_TIMEOUT_MS,
  });
  return ran.exitCode === 0 ? parsePrint(ran.stdout.toString()) : null;
}

const PRINT_TIMEOUT_MS = 3000;

const INTEGER = /^\d+$/;

function integer(value: string | undefined): number | null {
  return value !== undefined && INTEGER.test(value) ? Number(value) : null;
}

// launchd's `last terminating signal = Killed: 9` names the signal by
// strsignal's text; the number after the colon is the signal.
const SIGNALS: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  4: "SIGILL",
  5: "SIGTRAP",
  6: "SIGABRT",
  9: "SIGKILL",
  10: "SIGBUS",
  11: "SIGSEGV",
  13: "SIGPIPE",
  15: "SIGTERM",
};

function lastExit(code: string | undefined, signal: string | undefined): string | null {
  if (signal !== undefined) {
    const number = /:\s*(\d+)$/.exec(signal);
    const name = number === null ? undefined : SIGNALS[Number(number[1])];
    return `killed by ${name ?? signal}`;
  }
  const exit = integer(code);
  return exit === null ? null : `exit ${exit}`;
}

export function parsePrint(text: string): AgentPrint {
  const values = new Map<string, string>();
  const blocks = new Map<string, string[]>();
  let block: string[] | null = null;
  for (const line of text.split("\n")) {
    if (block !== null) {
      if (line === "\t}") block = null;
      else if (line.startsWith("\t\t")) block.push(line.slice(2));
      continue;
    }
    const match = /^\t([^\t=][^=]*?) = (.*)$/.exec(line);
    if (match === null) continue;
    const [, key, value] = match;
    if (value === "{") {
      block = [];
      if (!blocks.has(key!)) blocks.set(key!, block);
    } else if (!values.has(key!)) {
      values.set(key!, value!);
    }
  }
  const environment: Record<string, string> = {};
  for (const line of blocks.get("environment") ?? []) {
    const at = line.indexOf(" => ");
    if (at > 0) environment[line.slice(0, at)] = line.slice(at + 4);
  }
  return {
    state: values.get("state") ?? "",
    pid: integer(values.get("pid")),
    runs: integer(values.get("runs")),
    lastExit: lastExit(values.get("last exit code"), values.get("last terminating signal")),
    arguments: blocks.get("arguments") ?? [],
    environment,
  };
}
