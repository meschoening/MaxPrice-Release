import { readFileSync } from "node:fs";
import {
  errorResponseSchema,
  HUB_PROTOCOL_VERSION,
  hubStatusPreambleSchema,
} from "@maxprice/shared";
import { displayPath, type Env } from "@maxprice/usage-core/home-path";
import { fsErrorName } from "@maxprice/usage-core/secrets-file";
import {
  describeHolder,
  type ReadCgroup,
  readServeLockHolder,
  type ServeLock,
  type ServeLockHolder,
} from "@maxprice/usage-core/serve-lock";
import { CliError, EXIT, type Hint } from "./cli";
import { loopbackRequest } from "./loopback-http";
import { operatorTokenPath } from "./secrets";
import { serveLockPath, takeLockOrHolder, UNIT } from "./serve-lock";
import { HUB_PROTOCOL_MISMATCH } from "./server";

// One client for the operator commands (ADR-0127 §7): how `rename`, `merge`,
// `purge-machine`, `compact`, `password set|clear`, `key set|clear`,
// `status` (§8, status.ts) and setup's start (ADR-0128 §2, setup.ts) learn
// whether a Hub runs on their data dir, and reach it when one does. Linux
// only, as serve.lock is (§3).
//
// The lock answers, never a /healthz probe on hub.json's port, which may have
// changed under a running daemon (§3; ADR-0126 §6 as ADR-0127 amends it):
//
// - Free: this call takes it and hands it back, and the command edits the
//   files under it, then lets it go. `status`, which edits nothing, refuses
//   it instead (`refuseFree`), before the take writes its record.
// - Held, with a port recorded: the daemon is reached on 127.0.0.1:<that
//   port>, through the routes the console uses, with `<data dir>/
//   operator-token` as its bearer (ADR-0126 §8). The change applies live,
//   with no restart.
// - Held, with a pid alone: that record reads the same for a `serve` still
//   starting, which has not recorded its port yet, and for another command
//   editing the files, which records none. Neither is guessed past: no port
//   comes from hub.json, and nothing here writes a file while another
//   process holds the lock. The call waits, and the wait ends one of three
//   ways: the port recorded, and the daemon reached; the lock let go by a
//   holder that never recorded a port, and taken here; or the lock let go
//   after this call saw a port, which exits 1 at once (below). So §7's exit 5
//   for another command is not used: one that outlasts the wait is the
//   deadline's exit 1.
//
// A lock freed after a port was seen is a Hub that stopped while the command
// waited, most likely `systemctl --user restart`'s gap between the old daemon
// and the new. Taking it to edit offline would win that gap, and the unit's
// new `serve` would exit 5, which the unit does not retry: the Hub would stay
// down. So the take is refused before it writes its record, and the command
// says to run it again. A `status` asking a free lock in the instant a look
// lands reads the same way (ADR-0127 §8): the look meets its hold and the
// record a Hub that exited left, port and all, and a look later the lock is
// free, so the command exits 1 so, having changed nothing.
//
// The issue's one bound, NO_ANSWER_MS, covers the whole reach, from the lock's
// record and the token to the authenticated `GET /api/status` answer, body
// included. Past it the command exits 1 naming the holder and the last reason
// it waited on, with `maxprice-hub service logs` under the line (WHY): a
// stopped (SIGSTOP) daemon, whose kernel still accepts the connection, lands
// there, as do a missing token and a refused connection (§7).
//
// Then each request the command sends has the same bound again, its own,
// from the moment it is sent to its answer's last byte, so a daemon stopped
// between the probe and the operation cannot hang the command. A purge's
// listing and its delete are bounded apart; the typed-name prompt between
// them is the operator's own time. A request is sent once, whatever comes
// back: every route commits its change before it answers, so one that gets no
// whole answer may have applied, and a stopped daemon reads the request from
// its socket's buffer when it resumes and may apply it then, the command long
// gone. So the command never retries on its own. It exits 1 saying what may
// have happened: a change with no answer may have been applied or may still
// be, and is to be checked before the command runs again; a listing changed
// nothing; a refused connection sent nothing.
//
// No command is let off the bound. A compaction runs VACUUM synchronously
// (fleet-sync-store.ts), so a daemon compacting answers nothing at all, as a
// stopped one does, and the two cannot be told apart from here. A key push
// stores the key before its claude.ai listing and first poll, so a push that
// times out during them has left the key stored, which "may have been
// applied" says truthfully. And every one of these changes, run again, ends
// in the same state.
//
// Every request goes over loopback-http.ts's own socket, never fetch, which
// would send it through a configured proxy.
//
// Setup's ending (ADR-0128 §5) reaches a Hub with the same probe, but only
// watches the lock's record and never takes it: runningHolder and
// awaitRunningHub, at the end.
//
// The probe's answer is read as a Hub's status: its version-invariant
// preamble (`hubStatusPreambleSchema`, as usage-core's hub-client.ts reads
// it), since the protocol check skips GET. A 2xx that is not one is
// something else listening on the port, exit 1; a preamble naming another
// protocol version is skew, exit 4, found before any operation or prompt.
//
// Two answers are this client's to give, on any request: a 401, the token
// refused (exit 1 naming its file, ADR-0126 §8), and the protocol check's own
// 409 (exit 4, §7, ADR-0126 §7). The one 401 read past is a probe's after the
// token file changed: a new daemon's token, which the next look sends. Every
// other answer is the command's to read: a route's 409 is a refusal of its
// own (a name in use, an alias cycle, a purge conflict), not skew.

// The reach's bound, and each request's after it (above).
export const NO_ANSWER_MS = 10_000;
const POLL_MS = 100;

// The journal pointer under every line about a Hub that did not answer, a
// hint as the shared systemd module's own errors carry it
// (systemd-service.ts's `why`), so renderError prints it the same way.
const WHY: Hint = { label: "Why:", command: "maxprice-hub service logs" };

// Under a change that got no whole answer: what to do before running it again.
const MAY_HAVE_APPLIED: Hint[] = ["Check it before running the command again.", WHY];

export type HubAnswer = {
  status: number;
  ok: boolean;
  // The body parsed as JSON, or null when it is none.
  body: unknown;
};

export type RunningHub = {
  port: number;
  holder: ServeLockHolder;
  // The probe's answer, the Hub's `GET /api/status` body, its preamble
  // checked: `status` (ADR-0127 §8) and setup (ADR-0128 §2, §5) read the
  // rest of it, so neither sends a second probe for that reading.
  status: unknown;
  // One request with the operator token and the protocol header, and a JSON
  // body when one is given. Never `x-maxprice-machine`: an operator request
  // is no fleet member, so it stays off the roster, and POST /api/credential
  // records its provenance as "local". Sent once, with the bound of its own
  // (above).
  request(method: string, path: string, body?: unknown): Promise<HubAnswer>;
};

// `offline`: the lock was free, and this call holds it until the caller
// releases it. `live`: the running Hub that holds it, reached.
export type Reached = { kind: "offline"; lock: ServeLock } | { kind: "live"; hub: RunningHub };

export type ReachOptions = {
  // The whole reach's deadline, and each later request's bound;
  // NO_ANSWER_MS by default.
  timeoutMs?: number;
  // How often a held lock is asked again while the reach waits.
  pollMs?: number;
  // Whether the holder runs in maxprice-hub.service; /proc by default.
  readCgroup?: ReadCgroup;
  // Run when the lock is found free before this reach saw a port, once it is
  // taken and before its record is written, so what it throws lets the lock
  // go and leaves serve.lock as it was: `status`'s, which has nothing to edit
  // and answers that no Hub runs (exit 3). A lock found free after a port
  // was seen is still the Hub that stopped while the command waited (above).
  refuseFree?: () => never;
};

// Why a reach or a request ended with no whole answer: the lock recorded no
// port all the wait (`no-port`); the operator token was missing, empty,
// unreadable or replaced as the wait ran out (`token`); or the Hub itself
// sent none, its probe unanswered, refused or unreachable, or a request
// after the reach timed out, refused, reset or cut short (`no-answer`).
export type HubNoAnswerKind = "no-port" | "token" | "no-answer";

// A Hub that sent no whole answer (above): the reach's deadline passed while
// it waited on one of `kind`'s reasons, or a request after it got none. Exit
// 1, with the line and hints every command prints, and the holder and the
// kind for a command that describes it: `status` prints its Not responding
// rows for a `no-answer` alone (ADR-0127 §8). An answer, whatever its
// status, is never one.
export class HubNoAnswer extends CliError {
  constructor(
    readonly kind: HubNoAnswerKind,
    readonly holder: ServeLockHolder,
    message: string,
    hints: readonly Hint[],
  ) {
    super(EXIT.FAILURE, message, hints);
    this.name = "HubNoAnswer";
  }
}

type Target = {
  port: number;
  holder: ServeLockHolder;
  token: string;
  // The token file as messages show it.
  shownToken: string;
};

function at(port: number): string {
  return `127.0.0.1:${port}`;
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

function isRefused(error: unknown): boolean {
  return codeOf(error) === "ECONNREFUSED";
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// One request and its whole body. A signal, when there is one, covers both.
async function exchange(
  target: Target,
  method: string,
  path: string,
  payload: string | undefined,
  signal?: AbortSignal,
): Promise<HubAnswer> {
  const answer = await loopbackRequest({
    port: target.port,
    method,
    path,
    headers: {
      authorization: `Bearer ${target.token}`,
      "x-maxprice-protocol": String(HUB_PROTOCOL_VERSION),
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { body: payload }),
    ...(signal === undefined ? {} : { signal }),
  });
  const ok = answer.status >= 200 && answer.status < 300;
  return { status: answer.status, ok, body: parseBody(answer.body) };
}

// Exit 4, in ADR-0127 §7 and §10's wording: the unit when the holder runs in
// it, else the foreground `serve` to restart.
function skewed(target: Target): CliError {
  const restart = target.holder.service
    ? `restart ${UNIT}`
    : `restart its serve (pid ${target.holder.pid})`;
  return new CliError(
    EXIT.SKEW,
    `the running Hub speaks another Hub protocol: ${restart} to finish the update`,
  );
}

// The two answers no request hands back (above). The protocol check's 409 is
// told by its exact body: any other 409 is the route's.
function checked(target: Target, answer: HubAnswer): HubAnswer {
  if (answer.status === 401) {
    throw new CliError(
      EXIT.FAILURE,
      `the running Hub on ${at(target.port)} refused the operator token in ${target.shownToken}`,
    );
  }
  if (
    answer.status === 409 &&
    JSON.stringify(answer.body) === JSON.stringify(HUB_PROTOCOL_MISMATCH)
  ) {
    throw skewed(target);
  }
  return answer;
}

function runningHub(target: Target, timeoutMs: number, status: unknown): RunningHub {
  const hub = at(target.port);

  // A request sent once that got no whole answer, by what it may have done
  // (above): a refused connection sent nothing, a listing changed nothing,
  // and a change may have been applied.
  function unanswered(
    method: string,
    path: string,
    timedOut: boolean,
    error: unknown,
  ): HubNoAnswer {
    const lost = (message: string, hints: readonly Hint[] = []) =>
      new HubNoAnswer("no-answer", target.holder, message, hints);
    if (!timedOut && isRefused(error)) {
      return lost(`lost the running Hub on ${hub}: it refused the connection, so nothing was sent`);
    }
    const request = `${method} ${path}`;
    const reads = method === "GET" || method === "HEAD";
    if (timedOut) {
      const within = `the running Hub on ${hub} did not answer ${request} within ${timeoutMs / 1000} s`;
      return reads
        ? lost(`${within}; nothing was changed`, [WHY])
        : lost(
            `${within}: the change may have been applied, or may still be when the Hub resumes`,
            MAY_HAVE_APPLIED,
          );
    }
    const during = `lost the running Hub on ${hub} during ${request} (${codeOf(error) ?? "error"})`;
    return reads
      ? lost(`${during}; nothing was changed`)
      : lost(`${during}: the change may have been applied`, MAY_HAVE_APPLIED);
  }

  return {
    port: target.port,
    holder: target.holder,
    status,
    async request(method, path, body) {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      // The bound starts as the request is sent, never with what the reach
      // left, and is a manual timer for the reason the probe's is (below).
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let answer: HubAnswer;
      try {
        answer = await exchange(target, method, path, payload, ctrl.signal);
      } catch (error) {
        throw unanswered(method, path, ctrl.signal.aborted, error);
      } finally {
        clearTimeout(timer);
      }
      return checked(target, answer);
    },
  };
}

// An answer whose shape this binary does not know: a Hub of another build
// that kept the protocol version.
export function unreadable(path: string): CliError {
  return new CliError(
    EXIT.FAILURE,
    `the running Hub's ${path} answer does not match this maxprice-hub`,
  );
}

// A non-2xx answer as one line: the route's `{error}` envelope, else its
// status. A command words its own refusal around it.
export function refusal(answer: HubAnswer, path: string): string {
  const envelope = errorResponseSchema.safeParse(answer.body);
  return envelope.success
    ? envelope.data.error
    : `the running Hub answered HTTP ${answer.status} on ${path}`;
}

// One reach's fixed parts: the token file, as read and as messages show it,
// the deadline every probe's timer ends at, and the bound each request after
// the reach gets.
type Reach = { tokenPath: string; shownToken: string; deadline: number; timeoutMs: number };

function startReach(dataDir: string, env: Env, timeoutMs: number): Reach {
  const tokenPath = operatorTokenPath(dataDir);
  return {
    tokenPath,
    shownToken: displayPath(tokenPath, env),
    deadline: Date.now() + timeoutMs,
    timeoutMs,
  };
}

// The token as the file holds it now, or why there is none.
function readToken({ tokenPath, shownToken }: Reach): { token: string } | { reason: string } {
  let token: string;
  try {
    token = readFileSync(tokenPath, "utf8").trim();
  } catch (error) {
    const name = fsErrorName(error);
    return {
      reason:
        name === "ENOENT" ? `${shownToken} is missing` : `cannot read ${shownToken} (${name})`,
    };
  }
  return token === "" ? { reason: `${shownToken} is empty` } : { token };
}

// What a look waited on, if it did not reach the daemon.
type Waited = { kind: HubNoAnswerKind; reason: string };

// One look at a holder, reachHub's and awaitRunningHub's: the daemon
// reached, or what it waited on; else a CliError for an answer no later
// look can change (above).
async function attempt(holder: ServeLockHolder, reach: Reach): Promise<RunningHub | Waited> {
  if (holder.port === null) {
    return {
      kind: "no-port",
      reason:
        "serve.lock records no port yet (a serve still starting, or another maxprice-hub command at work)",
    };
  }
  const port = holder.port;
  // Read again at every look: a `serve` records its port before it writes
  // its token, and binds only after (ADR-0126 §8). So a token a crashed
  // launch left behind is read only while nothing answers, and the next
  // look reads the new one.
  const read = readToken(reach);
  if ("reason" in read) return { kind: "token", reason: read.reason };
  const { token } = read;
  const target: Target = { port, holder, token, shownToken: reach.shownToken };
  // A manual timer, NOT AbortSignal.timeout: the bun/win32 parked-loop rule
  // index.ts's getHealthz keeps. It fires at the reach's deadline, not
  // after a per-probe allowance, so a daemon that never answers ends the
  // reach on time.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(0, reach.deadline - Date.now()));
  let answer: HubAnswer;
  try {
    answer = await exchange(target, "GET", "/api/status", undefined, ctrl.signal);
  } catch (error) {
    const kind = "no-answer";
    if (ctrl.signal.aborted) return { kind, reason: `${at(port)} sent no answer` };
    if (isRefused(error)) return { kind, reason: `${at(port)} refused the connection` };
    return { kind, reason: `cannot reach ${at(port)} (${codeOf(error) ?? "error"})` };
  } finally {
    clearTimeout(timer);
  }
  // The race the read above leaves: a new daemon writing its token and
  // binding between that read and this answer. A token that changed since
  // is the next look's; one that did not is refused, exit 1.
  if (answer.status === 401) {
    const again = readToken(reach);
    if ("token" in again && again.token !== token) {
      return { kind: "token", reason: `${reach.shownToken} changed` };
    }
  }
  checked(target, answer);
  if (!answer.ok) {
    throw new CliError(
      EXIT.FAILURE,
      `the running Hub answered HTTP ${answer.status} on /api/status`,
    );
  }
  const preamble = hubStatusPreambleSchema.safeParse(answer.body);
  if (!preamble.success) {
    throw new CliError(EXIT.FAILURE, `something that is not a Hub answers on ${at(port)}`);
  }
  if (preamble.data.protocolVersion !== HUB_PROTOCOL_VERSION) throw skewed(target);
  return runningHub(target, reach.timeoutMs, answer.body);
}

// The wait between two looks: a poll, or, with less than two polls left, the
// rest of the deadline, and true for that last wait. So every look starts
// with at least a poll's time to go, and the reason a reach gives up on is
// the daemon's, never a probe cut off by the deadline as it began.
async function pause({ deadline }: Reach, pollMs: number): Promise<boolean> {
  const left = deadline - Date.now();
  const last = left <= 2 * pollMs;
  if (left > 0) await Bun.sleep(last ? left : pollMs);
  return last;
}

// The lock, taken here (`offline`), or the daemon holding it, reached
// (`live`); else a CliError: exit 1 once the deadline passes, or at once on a
// 401 for the token it sent, a probe's other non-2xx, a 2xx that is not a
// Hub's status or a Hub that stopped while it waited, and exit 4 on skew.
export async function reachHub(
  dataDir: string,
  env: Env,
  { timeoutMs = NO_ANSWER_MS, pollMs = POLL_MS, readCgroup, refuseFree }: ReachOptions = {},
): Promise<Reached> {
  const reach = startReach(dataDir, env, timeoutMs);
  const shownDir = displayPath(dataDir, env);

  // Whether this reach has seen a holder with a port: once it has, a free
  // lock is that Hub stopped, not one that never started (above).
  let sawPort = false;
  const stoppedWhileWaiting = () => {
    throw new CliError(
      EXIT.FAILURE,
      `maxprice-hub stopped running for ${shownDir} while the command waited for it; run it again`,
    );
  };
  // What a free lock is refused with, if anything, before its record is
  // written: the Hub that stopped once a port was seen, else the caller's.
  const refuse = () => (sawPort ? stoppedWhileWaiting : refuseFree);

  for (;;) {
    // The lock first, at every look, so a wait also ends when its holder
    // lets go: a `serve` that died before recording its port, or another
    // command that finished. After a port was seen the take is refused
    // before it writes its record, which releases it, so no file changes.
    const taken = takeLockOrHolder(dataDir, readCgroup, refuse());
    if (taken.kind === "taken") return { kind: "offline", lock: taken.lock };
    const { holder } = taken;
    if (holder.port !== null) sawPort = true;
    const reached = await attempt(holder, reach);
    if (!("reason" in reached)) return { kind: "live", hub: reached };
    const waited = reached;
    if (await pause(reach, pollMs)) {
      // One last look at the lock, with no probe, so a holder that let go in
      // the final polls, which pause sleeps out, still ends the wait as it
      // would have earlier.
      const final = takeLockOrHolder(dataDir, readCgroup, refuse());
      if (final.kind === "taken") return { kind: "offline", lock: final.lock };
      throw new HubNoAnswer(
        waited.kind,
        final.holder,
        `maxprice-hub is running for ${shownDir} (${describeHolder(final.holder, UNIT)}) but did not answer within ${timeoutMs / 1000} s: ${waited.reason}`,
        [WHY],
      );
    }
  }
}

// serve.lock's holder while it is a running process other than this one,
// else null: read from the lock's record alone, as `page` and `service
// status`'s Daemon row read it (ADR-0125 §4, ADR-0127 §6), opening the file
// only to read it and never creating it, so never taking the lock. This
// process is never a Hub it waits for: setup, with every offline step it
// runs, leaves its own pid there when it lets the lock go (ADR-0128 §2).
// awaitRunningHub asks it at each look, and setup's ending before it waits,
// whether a Hub is coming and whether it runs in maxprice-hub.service.
export function runningHolder(dataDir: string, readCgroup?: ReadCgroup): ServeLockHolder | null {
  const holder = readServeLockHolder(serveLockPath(dataDir), UNIT, readCgroup);
  return holder.running && holder.pid !== process.pid ? holder : null;
}

// What awaitRunningHub found: the running Hub, reached, or none by the
// deadline, with the last reason it waited on.
export type AwaitedHub = { kind: "live"; hub: RunningHub } | { kind: "none"; reason: string };

// Setup's ending (ADR-0128 §5): waits for the Hub of a unit it may just have
// started, within reachHub's deadline and polls, and reaches it with
// reachHub's probe, its CliErrors included (a 401, a probe's other non-2xx, a
// 2xx that is not a Hub's status, exit 1; skew, exit 4). It never takes
// serve.lock, not even for a moment. A unit just started may not have taken
// it yet, and reachHub answers a free lock by taking it, `offline`: it never
// waits for a Hub on its way, which is the ending's whole question. A wait
// built on takes would also hold the lock against that starting `serve` at
// every look; its 500 ms retry (SERVE_LOCK_RETRY_MS) waits such a hold out,
// but need never meet one. So each look asks runningHolder, which reads the
// lock's record alone. A record that names no
// running process is no Hub yet, waited on as one that names no port is. So
// is a record that names this process, whose port, were one recorded, is
// never probed. At the deadline there is no last look to take a free lock,
// unlike reachHub's: the answer is `none`, with the reason.
export async function awaitRunningHub(
  dataDir: string,
  env: Env,
  { timeoutMs = NO_ANSWER_MS, pollMs = POLL_MS, readCgroup }: ReachOptions = {},
): Promise<AwaitedHub> {
  const reach = startReach(dataDir, env, timeoutMs);
  const noHolder = `no maxprice-hub holds serve.lock in ${displayPath(dataDir, env)}`;
  for (;;) {
    const holder = runningHolder(dataDir, readCgroup);
    const reached = holder === null ? { reason: noHolder } : await attempt(holder, reach);
    if (!("reason" in reached)) return { kind: "live", hub: reached };
    if (await pause(reach, pollMs)) return { kind: "none", reason: reached.reason };
  }
}
