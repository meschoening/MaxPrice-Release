import { existsSync } from "node:fs";
import { errorResponseSchema, statusSnapshotSchema, type StatusSnapshot } from "@maxprice/shared";
import type { ZodType, ZodTypeDef } from "zod";
import { CliError, EXIT, type Hint } from "./exit";
import { dataDir, type Env, socketPath, unitPath } from "./paths";
import { VERSION } from "./version";

// The Headless client's only loopback client (ADR-0118 §1): it reaches the
// daemon `maxprice serve` runs over `<data dir>/daemon.sock` (ADR-0119 §1) and
// parses every answer with the shared Zod schema. Every command that needs the
// daemon starts with `connect`, whose one `GET /api/status` (§5) says whether
// the daemon runs, whether it is this version and whether it has finished
// its scan. No token: the socket's permissions are the authority (§3).

export const PROBE_TIMEOUT_MS = 3000;

export type Stderr = { isTTY?: boolean; write(text: string): unknown };

export type ConnectOptions = {
  env?: Env;
  // The socket to reach; the env's data dir's `daemon.sock` by default.
  socket?: string;
  // How long the probe waits for the whole answer, connect to body (§5).
  timeoutMs?: number;
  // The command is a report: it says `scanning…` while the daemon's initial
  // scan runs. Its request then simply waits, since every report route awaits
  // the scan's end, and Ctrl-C ends the wait.
  report?: boolean;
  stderr?: Stderr;
};

export type RequestOptions = {
  method?: string;
  body?: unknown;
  // How long to wait for the whole answer; no limit by default, since a
  // report waits out the scan.
  timeoutMs?: number;
};

export type Daemon = {
  status: StatusSnapshot;
  // The status body as the daemon sent it, for `status --json` to print
  // verbatim (ADR-0119 §7).
  statusText: string;
  // A request, with no timeout unless `init.timeoutMs` sets one. `data` is
  // the body parsed with `schema`, and `text` the body as sent.
  request<T>(
    path: string,
    schema: ZodType<T, ZodTypeDef, unknown>,
    init?: RequestOptions,
  ): Promise<{ data: T; text: string }>;
};

// ADR-0119 §7's hints use only the default unit path: no subprocess on a
// daemon request's error path. A manager with a custom config home can get
// terminal/install hints instead; `maxprice service status` resolves its
// actual UnitPath (ADR-0120 §4's named residual).
function notRunning(env: Env): CliError {
  return new CliError(
    EXIT.NOT_RUNNING,
    "the daemon is not running.",
    existsSync(unitPath(env))
      ? [
          { label: "Start it:", command: "systemctl --user start maxprice" },
          { label: "Why it stopped:", command: "journalctl --user --user-unit=maxprice -n 50" },
        ]
      : [
          { label: "Install it as a service:", command: "maxprice service install" },
          { label: "Or run it in a terminal:", command: "maxprice serve" },
        ],
  );
}

// How to restart the daemon: through its unit, when the default one exists.
export function restartHints(env: Env): Hint[] {
  return existsSync(unitPath(env))
    ? [{ label: "Restart it:", command: "systemctl --user restart maxprice" }]
    : ["Stop the running 'maxprice serve' and start it again."];
}

function skew(theirs: string, env: Env): CliError {
  return new CliError(
    EXIT.SKEW,
    `the daemon is ${theirs} but this maxprice is ${VERSION}.`,
    restartHints(env),
  );
}

// Bun rejects a connect to a missing socket, a stale one, a path that is no
// socket and one behind a directory it cannot search alike, with
// `FailedToOpenSocket` (Bun 1.3.14); the errno spellings are the same refusal.
const CONNECT_FAILURES = new Set(["FailedToOpenSocket", "ECONNREFUSED", "ENOENT"]);

function isConnectFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && CONNECT_FAILURES.has(code);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Exchange = { status: number; ok: boolean; text: string };

// One request and its whole body. A timeout, when there is one, covers both:
// Bun aborts a body read in progress when the signal fires.
async function exchange(
  socket: string,
  path: string,
  env: Env,
  init: RequestOptions,
  timeoutMs: number | null,
): Promise<Exchange> {
  const signal = timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(`http://localhost${path}`, {
      unix: socket,
      method: init.method ?? "GET",
      ...(init.body === undefined
        ? {}
        : { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } }),
      ...(signal === undefined ? {} : { signal }),
    });
    return { status: response.status, ok: response.ok, text: await response.text() };
  } catch (error) {
    if (signal?.aborted && timeoutMs !== null) {
      throw new CliError(EXIT.FAILURE, `the daemon did not answer within ${timeoutMs / 1000} s`);
    }
    if (isConnectFailure(error)) throw notRunning(env);
    throw new CliError(EXIT.FAILURE, `cannot reach the daemon: ${messageOf(error)}`);
  }
}

function json(path: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(EXIT.FAILURE, `the daemon's ${path} answer is not JSON`);
  }
}

// A non-2xx answer: the daemon's `{error}` envelope as one line, or its status.
function refused(path: string, answer: Exchange): CliError {
  let body: unknown = null;
  try {
    body = JSON.parse(answer.text);
  } catch {
    // Not an envelope; say the status.
  }
  const envelope = errorResponseSchema.safeParse(body);
  return new CliError(
    EXIT.FAILURE,
    envelope.success ? envelope.data.error : `the daemon answered HTTP ${answer.status} on ${path}`,
  );
}

// The version alone, which a skewed daemon's status still carries whatever
// else changed (ADR-0119 §5); `update` reads it the same way while it waits.
export const engineVersionSchema = statusSnapshotSchema.pick({ engineVersion: true });

export async function connect(options: ConnectOptions = {}): Promise<Daemon> {
  const env = options.env ?? process.env;
  const socket = options.socket ?? socketPath(dataDir(env));
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  const probe = await exchange(socket, "/api/status", env, {}, timeoutMs);
  if (!probe.ok) throw refused("/api/status", probe);
  const body = json("/api/status", probe.text);
  // The version alone first (ADR-0119 §5): a skewed daemon's status may no
  // longer match this maxprice's schema, and skew is the answer to give then.
  const version = engineVersionSchema.safeParse(body);
  if (!version.success) {
    throw new CliError(EXIT.FAILURE, "the daemon's /api/status names no engineVersion");
  }
  if (version.data.engineVersion !== VERSION) throw skew(version.data.engineVersion, env);
  const status = statusSnapshotSchema.safeParse(body);
  if (!status.success) {
    throw new CliError(EXIT.FAILURE, "the daemon's /api/status does not match this maxprice");
  }

  if (options.report && !status.data.ready) {
    const stderr = options.stderr ?? process.stderr;
    if (stderr.isTTY) stderr.write("scanning…\n");
  }

  return {
    status: status.data,
    statusText: probe.text,
    async request(path, schema, init = {}) {
      const answer = await exchange(socket, path, env, init, init.timeoutMs ?? null);
      if (!answer.ok) throw refused(path, answer);
      const parsed = schema.safeParse(json(path, answer.text));
      if (!parsed.success) {
        throw new CliError(
          EXIT.FAILURE,
          `the daemon's ${path} answer does not match this maxprice`,
        );
      }
      return { data: parsed.data, text: answer.text };
    },
  };
}

// What a probe found, kept for after the write: a daemon to push to, or the
// CliError it gave.
export type Probed = Daemon | CliError;

// ADR-0121 §7: a command that removes a secret (`key clear`, `hub leave`)
// probes first, writes, then pushes only to a daemon that is up and this
// version.
export async function probeFirst(env: Env): Promise<Probed> {
  try {
    return await connect({ env });
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
}

// After the write: push to a daemon that is up. One that is down, or gone
// since the probe, applies the change when it starts, so that is a note and
// exit 0 (ADR-0119 §5). Anything else, a skewed daemon (4) included, keeps
// its code and hints, plus where the change is, as `settings` says it.
export async function pushIfUp(
  probed: Probed,
  stderr: Stderr,
  savedIn: string,
  push: (daemon: Daemon) => Promise<unknown>,
): Promise<number> {
  let failure: CliError;
  if (probed instanceof CliError) {
    failure = probed;
  } else {
    try {
      await push(probed);
      return EXIT.OK;
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      failure = error;
    }
  }
  if (failure.code === EXIT.NOT_RUNNING) {
    stderr.write("maxprice: the daemon is not running; the change applies when it starts\n");
    return EXIT.OK;
  }
  throw new CliError(failure.code, failure.message, [
    ...failure.hints,
    `The change is saved in ${savedIn}.`,
  ]);
}

// Polls `/api/status` every 100 ms until `field` is true: the initial scan
// (`ready`, which every `org` verb waits for, ADR-0122 §6 as amended by
// #468), this machine's identity probes (`identityReady`, ADR-0119 §5 as
// amended by #464), or the first Usage history load (`usageHistoryReady`,
// ADR-0119 §5 as amended by #466). No deadline: Ctrl-C ends the invocation
// without changing the daemon's work. Its progress is one line, on a
// terminal only.
export async function waitForStatus(
  daemon: Daemon,
  field: "ready" | "identityReady" | "usageHistoryReady",
  progress: string,
  stderr: Stderr,
): Promise<void> {
  let waiting = false;
  while (!(await daemon.request("/api/status", statusSnapshotSchema)).data[field]) {
    if (!waiting && stderr.isTTY) stderr.write(`${progress}\n`);
    waiting = true;
    await Bun.sleep(100);
  }
}
