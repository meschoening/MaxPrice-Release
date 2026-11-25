// The release gate's smoke of the compiled Headless Hub (#503; ADR-0129
// section 9; README.md beside this file).
//
//   bun scripts/acceptance/headless-hub/smoke.ts --version <vX.Y.Z|X.Y.Z>
//       [--binary <path>]
//
// It asks one question: does the `maxprice-hub` this release ships start,
// keep its key where ADR-0126 says, serve its Hub page, answer and stop,
// with no keychain helper run and no new real default data dir? Not whether the
// page renders or its answers are right, which the hub-page rigs check
// (`../hub-page/served.ts`). The binary defaults to this host's Headless
// Hub: on Linux apps/hub/binaries/maxprice-hub-x86_64-unknown-linux-gnu,
// which the gate's compile step (`bun --filter @maxprice/hub build:binaries`,
// on the linux-x64 primary) builds with the Hub page embedded (ADR-0124
// section 1); on a Mac apps/hub/binaries/darwin-arm64/maxprice-hub, which
// `bun apps/hub/scripts/build-binaries.ts --headless darwin-arm64` builds with
// the page (ADR-0147 section 2). A darwin binary runs only validly signed, so
// CI's build-headless-macos job smokes the one it signed with Developer ID,
// and the Mac leg one it re-signed ad-hoc (ADR-0147 sections 3, 4 and 7).
// Eight rows, in order:
//
//   1. `maxprice-hub --version` exits 0 and prints the version without its
//      `v`, trimmed, and nothing else: the bare version `maxprice-hub update`
//      (ADR-0129 section 4, #502) checks a downloaded binary against (section
//      2).
//   2. `maxprice-hub serve` comes up over a fresh data dir with no key,
//      hub.json written first as `{port, bind: "loopback", passwordHash:
//      null}` on a free port in 50000-64999, never 47100: it logs `[hub]
//      listening on http://127.0.0.1:<port>`, its serve.lock records its pid
//      and that port (ADR-0127 section 3), and `/healthz` answers 200 with
//      `{ok: true, service: "maxprice-hub"}`.
//   3. Its key custody (ADR-0126 sections 1 and 8), from its boot lines and
//      its data dir read while it runs: exactly one custody line on stdout,
//      `[hub] session key: none in <data dir>/secrets.json`, and no
//      memory-only line ("no credstore helper found") on either stream;
//      `<data dir>/operator-token` there, 0600 and not empty, its secret on
//      neither stream (the row never prints it); the data dir 0700 (ADR-0127
//      section 3); no secrets.json, or one 0600 holding no session key by
//      the Hub's own `hubSecretsSchema`; and the tripwire never run. No key,
//      and none from a keychain.
//   4. `GET /page/` answers 200 as text/html, and every `src` and `href` its
//      index.html names resolves under /page/ (the page build's `base: "./"`
//      makes each relative) and answers 200. A binary with no page embedded
//      answers 404 here: no test suite runs the compiled binary, so this is
//      the one check that catches a missing page (ADR-0129 section 9).
//   5. `GET /page/view` answers 200, its body parses with the shared
//      `hubPageViewSchema`, and its `version` is the expected one.
//   6. `maxprice-hub status --json` exits 0 with an empty stderr, and its
//      stdout parses with `hubStatusReportSchema` in a state the Hub answered
//      in (online, local-only or events-down, never not-responding), at the
//      expected version, with no key, naming the served port, `serve`'s pid
//      and the sandbox's data dir.
//   7. SIGTERM ends `serve` with exit code 0, not by the signal, within 30 s.
//   8. No keychain helper ran and no real data dir appeared: once `serve` has
//      stopped, the tripwire has still never run, operator-token is gone
//      (ADR-0126 section 8: the Hub deletes it at shutdown), and one path,
//      the real default data dir (`realDefaultDataDir`:
//      $XDG_DATA_HOME/maxprice-hub when this process's XDG_DATA_HOME is
//      absolute, else <real home>/.local/share/maxprice-hub, any
//      MAXPRICE_HUB_DATA_DIR in this process's environment ignored), is as it
//      was before the run by existence and top-level entry names: absent if
//      it was absent, else listing the same names. It reads no file there,
//      so it does not prove the real data unchanged: a write into a file
//      already there, or below its top level, is not seen. It runs
//      whenever `serve` was spawned, whatever failed before it, and stops
//      `serve` itself when row 7 did not; a run that broke before `serve`
//      was spawned has no row 8.
//
// The guard. The binary runs only as a copy, alone in the bin/ directory of
// a fresh sandbox under os.tmpdir() (`../hub-page/hub-sandbox.ts`'s
// `makeSandbox`, its root then taken with symlinks resolved), and every
// spawn is refused while anything sits beside the copy: a compiled tray
// app's Hub takes its keychain helper from beside its own executable first
// (apps/hub/src/credstore.ts `resolveCredstorePath`), and build-binaries.ts
// copies the tree's built helper into apps/hub/binaries/, beside the binary
// it compiles. The environment is `hubEnv`'s (`../hub-page/hub-env.ts`),
// built from nothing: PATH, then HOME, the XDG dirs and MAXPRICE_HUB_DATA_DIR
// inside the sandbox, MAXPRICE_CLAUDE_BASE_URL at a fake claude.ai on
// loopback, and HTTPS_PROXY at hub-env's DEAD_HTTPS_PROXY, a loopback port
// the smoke first checks refuses connections (`deadProxyCheck`). The smoke
// adds NO_PROXY, sparing loopback, and the tripwire. So an HTTPS fetch that
// honors the variable goes nowhere: the boot update check a Headless `serve`
// runs on Linux and macOS (ADR-0129 section 6, ADR-0147 section 6), which in
// a compiled production binary asks the real channel on GitHub, is refused on
// loopback. That is protection
// by environment, not OS network confinement: a process that opens its own
// sockets is not stopped by it, and the port is checked when the run starts,
// not for the whole run.
//
// The tripwire. MAXPRICE_CREDSTORE_PATH names
// `<sandbox>/tripwire/maxprice-credstore`, outside bin/ so the copy stays
// alone there: a /bin/sh script that appends a line to
// `<sandbox>/tripwire/ran` and exits 3. `resolveCredstorePath` returns
// MAXPRICE_CREDSTORE_PATH before it considers a helper beside the executable
// or the tree's cargo builds (apps/hub/src/credstore.ts), and
// the helper's spawn is reached only through
// `openKeyStore`, which hands it `resolveCredstorePath`'s result: so while
// the variable names the tripwire, no code path in the binary can execute the
// real helper. For a Headless Hub, on Linux and macOS alike, `openKeyStore`
// returns the secrets.json store before it resolves any helper at all
// (ADR-0126 section 1, ADR-0146 section 4), and the tripwire
// proves that at runtime on the compiled binary: rows 3 and 8 fail if it ever
// ran. It is the marking-helper pattern apps/hub/src/key-custody.test.ts uses
// on a spawned serve, and like that test's control, whatever the variable
// names is run once first and must leave the marker, so a marker never left
// means no helper ran. It never touches a keychain. hubEnv's own rule, no
// MAXPRICE_CREDSTORE_* key, is the hub-page rigs' and is left as it is: the
// smoke adds this one key, naming a file inside its sandbox, and never
// MAXPRICE_CREDSTORE_ACCOUNT. That is why the hub-page rigs' `helperProblems`,
// which refuses whenever the tree's cargo build of the helper exists, is not
// used: the gate builds one just before (`build:credstore`), and with the
// tripwire named no code path reaches it.
//
// The isolation check. Once the environment is built and before the first
// spawn, `isolationProblems` refuses the run (exit 2), naming every problem,
// unless the environment's keys are exactly SMOKE_ENV_KEYS, so no
// DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR, DISPLAY, MAXPRICE_HUB_EMBEDDED or
// MAXPRICE_CREDSTORE_ACCOUNT reaches the binary; the sandbox is strictly
// under the real temp dir and is neither the real home nor under it; HOME,
// the XDG dirs, MAXPRICE_HUB_DATA_DIR and MAXPRICE_CREDSTORE_PATH are absolute
// and strictly inside the sandbox; MAXPRICE_HUB_DATA_DIR is not the real
// default data dir; HTTPS_PROXY is the dead proxy and NO_PROXY spares
// loopback alone; and MAXPRICE_CLAUDE_BASE_URL is http on 127.0.0.1. No
// claim rests on the missing DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR
// keeping a helper off the keychain: the guarantee is that no helper runs,
// which the tripwire checks.
//
// Linux and macOS only, the Headless Hub's platforms: elsewhere it exits 2,
// since a Headless Hub there takes no serve.lock and writes no operator token
// for `status` to read (ADR-0146 section 3). Every wait and
// every run is bounded, the tripwire's control included. The smoke signals
// only the processes it spawned, stops its fake claude.ai and removes its
// sandbox on every path, a thrown error and a SIGINT or SIGTERM to the smoke
// included.
//
// Exit 0 when every row passes, 1 when any fails, 2 when the run could not be
// made: a usage error, not Linux or macOS, no binary, a sandbox or environment the
// isolation check refused, a tripwire that did not trip in its control, a
// copy the guard refused to run, or a `serve` that never served.
//
// `smokeHubBinary` is the core, for the release rehearsal to run on the
// binary it installed. A caller that handles SIGINT or SIGTERM itself calls
// `abandonHubSmokes()` from its handler, as this file's entry does. Its
// result is the Headless client smoke's `SmokeResult`, judged and tabulated
// with that file's helpers (`../headless/smoke.ts`).
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { defaultDataDir, runsHeadlessHub } from "../../../apps/hub/src/config";
import { octal } from "../../../apps/hub/src/data-dir";
import {
  type HubPageView,
  hubPageViewSchema,
  type HubStatusReport,
  hubStatusReportSchema,
} from "../../../packages/shared/src/hub";
import { hubKeyHeld } from "../../../packages/shared/src/hub";
import { createFakeClaude, type FakeClaude } from "../../../packages/usage-core/src/fake-claude";
import { normalizeVersion } from "../../version-files";
import {
  abnormal,
  type Ended,
  exitCodeOf,
  failed,
  firstLine,
  messageOf,
  type Ran,
  type SmokeArgs,
  type SmokeResult,
  type SmokeRow,
  smokeTable,
  stopVerdict,
  type Verdict,
  versionVerdict,
  within,
} from "../headless/smoke";
import {
  hubKeyFilePath,
  keyCustodyFromFile,
  keyCustodyLines,
  keyCustodyText,
  MEMORY_CREDSTORE_LINE,
  OPERATOR_TOKEN_FILE,
  operatorTokenPath,
  readTextOrNull,
  SERVE_LOCK_FILE,
} from "../hub-process";
import { mediaType } from "../hub-page/content-type";
import {
  DEAD_HTTPS_PROXY,
  hubConfig,
  hubEnv,
  redactOperatorToken,
  type SandboxPaths,
  sandboxPaths,
} from "../hub-page/hub-env";
import { hubReadyProblem } from "../hub-page/hub-ready";
import {
  DARWIN_HUB_BINARY,
  freeHighPort,
  LINUX_HUB_BINARY,
  makeSandbox,
} from "../hub-page/hub-sandbox";
import { spawnDrained, type Spawned } from "../hub-page/spawned";

const REPO = resolve(import.meta.dir, "..", "..", "..");
/** This host's Headless Hub, and the build that writes it. */
export const DEFAULT_HUB_BINARY =
  process.platform === "darwin" ? DARWIN_HUB_BINARY : LINUX_HUB_BINARY;
const BUILD_COMMAND =
  process.platform === "darwin"
    ? "bun apps/hub/scripts/build-binaries.ts --headless darwin-arm64"
    : "bun apps/hub/scripts/build-binaries.ts linux-x64";

// The deadline `maxprice-hub update` gives a binary's `--version`, the
// client's (ADR-0129 section 4 is ADR-0123 sections 4-7, unchanged).
const VERSION_MS = 15_000;
// `serve` up: logged, locked and answering /healthz.
const SERVE_MS = 60_000;
// Its custody line, printed by the boot's ready sequence once the first bind
// holds, which may come after /healthz first answers.
const CUSTODY_MS = 10_000;
// One request for a page file, and for the view, which awaits the boot's
// readiness as /api/status does.
const PAGE_MS = 10_000;
const VIEW_MS = 30_000;
// One /healthz probe while `serve` comes up.
const HEALTH_MS = 2_000;
// One `status --json` run: its reach waits up to 10 s for the Hub.
const COMMAND_MS = 30_000;
// SIGTERM to exit, as the client's smoke allows.
const STOP_MS = 30_000;
// A process's output, read to its end once the process has ended.
const STREAMS_MS = 2_000;
// Ports tried when another process takes one between the probe and the bind.
const PORT_ATTEMPTS = 5;
// The tripwire's control run.
const CONTROL_MS = 5_000;

// The dead proxy the boot update check is sent to is hubEnv's HTTPS_PROXY,
// hub-env's DEAD_HTTPS_PROXY: port 9 (discard) on loopback. It is a proxy only
// by the environment: a fetch that honors HTTPS_PROXY connects there and
// nowhere else, and NO_PROXY keeps every loopback request direct, the fake
// claude.ai's and the smoke's own. It is not OS network confinement, so a
// process that opens its own sockets is not stopped by it. Before the first
// spawn `deadProxyProblem` requires a connect there to be refused, so nothing
// listens to forward anything; on Linux only a privileged process can bind a
// port below /proc/sys/net/ipv4/ip_unprivileged_port_start (1024 by default)
// after that.
const NO_PROXY = "127.0.0.1,localhost";
// How long the dead proxy's probe waits for its connect to settle.
const PROBE_MS = 2_000;

/** How a connect to the dead proxy settled. */
export type ProxyProbe =
  | { kind: "refused" }
  | { kind: "accepted" }
  | { kind: "error"; message: string };

/** One TCP connect to `host:port`, settled as refused, accepted or another error. */
export function probeConnect(host: string, port: number, ms = PROBE_MS): Promise<ProxyProbe> {
  return new Promise((done) => {
    const socket = createConnection({ host, port });
    const settle = (probe: ProxyProbe) => {
      clearTimeout(timer);
      socket.destroy();
      done(probe);
    };
    const timer = setTimeout(
      () => settle({ kind: "error", message: `no answer within ${ms / 1000} s` }),
      ms,
    );
    socket.once("connect", () => settle({ kind: "accepted" }));
    socket.once("error", (error: NodeJS.ErrnoException) => settle(probeOfError(error)));
  });
}

/** A failed connect as a probe: refused only on ECONNREFUSED, anything else an error. */
export function probeOfError(error: { code?: string; message: string }): ProxyProbe {
  return error.code === "ECONNREFUSED"
    ? { kind: "refused" }
    : { kind: "error", message: error.code ?? error.message };
}

/**
 * Null when a connect to the dead proxy was refused, so nothing listens
 * there to forward a request onward; else why the run cannot be made.
 */
export function deadProxyProblem(probe: ProxyProbe): string | null {
  if (probe.kind === "refused") return null;
  const what =
    probe.kind === "accepted" ? "something accepted the connect" : `the connect ${probe.message}`;
  return (
    `refusing to run: HTTPS_PROXY is ${DEAD_HTTPS_PROXY}, which must refuse connections so a ` +
    `proxied fetch goes nowhere, but ${what}`
  );
}

/** Probes the dead proxy and judges it, as the smoke and the release rehearsal both do. */
export async function deadProxyCheck(): Promise<string | null> {
  const { hostname, port } = new URL(DEAD_HTTPS_PROXY);
  return deadProxyProblem(await probeConnect(hostname, Number(port)));
}

const USAGE =
  "usage: bun scripts/acceptance/headless-hub/smoke.ts --version <vX.Y.Z|X.Y.Z> [--binary <path>]";

// The bare version, and the binary resolved against `cwd`, or a usage error.
export function parseHubSmokeArgs(
  argv: string[],
  cwd = process.cwd(),
): SmokeArgs | { usage: string } {
  let values: { version?: string; binary?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { version: { type: "string" }, binary: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { usage: `${messageOf(error)}\n${USAGE}` };
  }
  if (values.version === undefined) return { usage: `--version is required\n${USAGE}` };
  if (values.binary === "") return { usage: `--binary names no path\n${USAGE}` };
  let version: string;
  try {
    version = normalizeVersion(values.version);
  } catch (error) {
    return { usage: `${messageOf(error)}\n${USAGE}` };
  }
  return {
    version,
    binary: values.binary === undefined ? DEFAULT_HUB_BINARY : resolve(cwd, values.binary),
  };
}

// --- the guard ----------------------------------------------------------------

/** Every key the copy's environment holds, and no other. */
export const SMOKE_ENV_KEYS = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "MAXPRICE_HUB_DATA_DIR",
  "MAXPRICE_CLAUDE_BASE_URL",
  "HTTPS_PROXY",
  "NO_PROXY",
  "MAXPRICE_CREDSTORE_PATH",
] as const;

// The keys naming a place the Hub may write to or run from: each strictly
// inside the sandbox.
const SANDBOXED_KEYS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "MAXPRICE_HUB_DATA_DIR",
  "MAXPRICE_CREDSTORE_PATH",
] as const;

/**
 * The copy's whole environment: `hubEnv`'s, built from nothing, its dead
 * HTTPS proxy included, plus NO_PROXY sparing loopback and `credstorePath`,
 * the tripwire, as its keychain helper.
 */
export function smokeEnv(input: {
  path: string;
  root: string;
  claudeBaseUrl: string;
  credstorePath: string;
}): Record<string, string> {
  const { path, root, claudeBaseUrl, credstorePath } = input;
  return {
    ...hubEnv({ path, root, claudeBaseUrl }),
    NO_PROXY,
    MAXPRICE_CREDSTORE_PATH: credstorePath,
  };
}

/** The tripwire's directory, the helper MAXPRICE_CREDSTORE_PATH names, and the marker it leaves when run. */
export type Tripwire = { dir: string; helper: string; marker: string };

/** The tripwire of the sandbox at `root`: outside bin/, so the copy stays alone there. */
export function tripwirePaths(root: string): Tripwire {
  const dir = join(root, "tripwire");
  return { dir, helper: join(dir, "maxprice-credstore"), marker: join(dir, "ran") };
}

// `text` as one /bin/sh word: single-quoted, each quote in it closed,
// escaped and reopened.
function shellWord(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * The tripwire: a line of its arguments appended to `marker`, then exit 3, an
 * empty keychain's `get` (credstore.ts `createCredstore`).
 */
export function tripwireScript(marker: string): string {
  return `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellWord(marker)}\nexit 3\n`;
}

/** What `isolationProblems` checks the copy's environment against. */
export type IsolationInput = {
  env: Record<string, string>;
  /** The sandbox's root, symlinks resolved. */
  root: string;
  /** os.homedir(), symlinks resolved. */
  realHome: string;
  /** os.tmpdir(), symlinks resolved. */
  realTmp: string;
  /** `realDefaultDataDir`: the data dir a Hub of this user's would use. */
  realDataDir: string;
};

// Whether `path` is strictly inside `dir`, both absolute: by path.relative,
// so a `..` that climbs out and a sibling whose name begins with `dir`'s are
// both outside, and `dir` itself is not inside.
function strictlyInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Why the copy may not run in `input.env` over the sandbox at `input.root`:
 * every problem, or none. Checked once the environment is built and before
 * the first spawn.
 */
export function isolationProblems(input: IsolationInput): string[] {
  const { env, root, realHome, realTmp, realDataDir } = input;
  const problems: string[] = [];
  const keys = Object.keys(env);
  const expected: readonly string[] = SMOKE_ENV_KEYS;
  for (const key of keys.filter((key) => !expected.includes(key))) {
    problems.push(`the environment holds ${key}, which the smoke never sets`);
  }
  for (const key of expected.filter((key) => !keys.includes(key))) {
    problems.push(`the environment lacks ${key}`);
  }
  if (!isAbsolute(root) || !strictlyInside(realTmp, root)) {
    problems.push(`the sandbox ${root} is not inside the real temp dir ${realTmp}`);
  }
  if (isAbsolute(root) && (relative(realHome, root) === "" || strictlyInside(realHome, root))) {
    problems.push(
      `the sandbox ${root} is the real home ${realHome} or under it; set TMPDIR outside it`,
    );
  }
  // A key the environment lacks is named above, once.
  for (const key of SANDBOXED_KEYS) {
    const value = env[key];
    if (value === undefined) continue;
    if (!isAbsolute(value) || !isAbsolute(root) || !strictlyInside(root, value)) {
      problems.push(`${key}=${value} is not inside the sandbox ${root}`);
    }
  }
  const hubData = env.MAXPRICE_HUB_DATA_DIR;
  if (hubData !== undefined && isAbsolute(hubData) && resolve(hubData) === resolve(realDataDir)) {
    problems.push(`MAXPRICE_HUB_DATA_DIR is the real data dir ${realDataDir}`);
  }
  if (env.HTTPS_PROXY !== undefined && env.HTTPS_PROXY !== DEAD_HTTPS_PROXY) {
    problems.push(`HTTPS_PROXY=${env.HTTPS_PROXY}, not the dead proxy ${DEAD_HTTPS_PROXY}`);
  }
  if (env.NO_PROXY !== undefined && env.NO_PROXY !== NO_PROXY) {
    problems.push(`NO_PROXY=${env.NO_PROXY}, not ${NO_PROXY}`);
  }
  const base = env.MAXPRICE_CLAUDE_BASE_URL;
  if (base !== undefined) {
    let url: URL | null;
    try {
      url = new URL(base);
    } catch {
      url = null;
    }
    if (url?.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      problems.push(`MAXPRICE_CLAUDE_BASE_URL=${base} is not http on 127.0.0.1`);
    }
  }
  return problems;
}

/**
 * The data dir a Headless Hub of this user's would use, on Linux or macOS
 * alike (ADR-0127 section 4, ADR-0146 section 2): config.ts's own
 * `defaultDataDir` for a Headless Hub on Linux, its MAXPRICE_HUB_DATA_DIR
 * override ignored. Importing it is side-effect free: config.ts and what it
 * imports only declare.
 */
export function realDefaultDataDir(
  env: Record<string, string | undefined>,
  realHome: string,
): string {
  return defaultDataDir({ ...env, MAXPRICE_HUB_DATA_DIR: undefined }, "linux", realHome);
}

/**
 * Why the copy at `copy` may not run, given its directory's `entries`: it is
 * not there, or anything is beside it. Empty when it may.
 */
export function copyAloneProblems(copy: string, entries: readonly string[]): string[] {
  const dir = dirname(copy);
  const name = basename(copy);
  return [
    ...(entries.includes(name) ? [] : [`the binary's copy ${copy} is not in ${dir}`]),
    ...entries
      .filter((entry) => entry !== name)
      .map((entry) => `${join(dir, entry)} is beside the binary's copy`),
  ];
}

// --- the verdicts ---------------------------------------------------------------

const pass = (detail: string): Verdict => ({ verdict: "pass", detail });
const fail = (detail: string): Verdict => ({ verdict: "fail", detail });

export function hubVersionVerdict(expected: string, ran: Ran): Verdict {
  return versionVerdict(expected, ran, "maxprice-hub update");
}

/** Null when /healthz answered as a Hub: 200 with `{ok: true, service: "maxprice-hub"}`. */
export function healthzProblem(status: number, body: unknown): string | null {
  if (status !== 200) return `/healthz answered ${status}`;
  const fields = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (fields.ok === true && fields.service === "maxprice-hub") return null;
  return `/healthz answered ${String(JSON.stringify(body)).slice(0, 120)}, not {"ok":true,"service":"maxprice-hub"}`;
}

/** A file as the rows read it: absent (null), its mode and text, or why it could not be read. */
export type FileFacts = null | { mode: number; text: string } | { error: string };

/**
 * What row 3 reads while `serve` runs: its output so far, and its data dir.
 * `token` is `<data dir>/operator-token`, whose text is the secret, never
 * printed.
 */
export type CustodyFacts = {
  /** Whether `serve` was still running when its files were read. */
  running: boolean;
  stdout: string;
  stderr: string;
  token: FileFacts;
  dataDirMode: number | { error: string };
  /** `<data dir>/secrets.json`. */
  secrets: FileFacts;
  /** Whether the tripwire's marker exists. */
  tripwireRan: boolean;
};

const TRIPWIRE_RAN =
  "the tripwire MAXPRICE_CREDSTORE_PATH names ran: something executed a credstore helper";

/**
 * Row 3: exactly one whole custody line on stdout, `none in` this data dir's
 * secrets.json, and no memory-only line on either stream; operator-token
 * there, 0600, not empty, and its secret on neither stream; the data dir
 * 0700; no secrets.json, or one 0600 holding no session key; the tripwire
 * never run. No detail ever holds the secret or a key.
 */
export function custodyVerdict(facts: CustodyFacts, hubData: string): Verdict {
  const { stdout, stderr } = facts;
  const expected = keyCustodyText({ kind: "none", path: hubKeyFilePath(hubData) });
  const { own, foreign } = keyCustodyLines(stdout, hubData);
  const printed = [...own, ...foreign].map(keyCustodyText);
  const problems: string[] = [];
  if (printed.length !== 1 || printed[0] !== expected) {
    problems.push(
      `stdout's session key lines are ${JSON.stringify(printed)}, expected exactly ${JSON.stringify([expected])}`,
    );
  }
  const streams = [
    ["stdout", stdout],
    ["stderr", stderr],
  ] as const;
  for (const [stream, text] of streams) {
    if (text.includes(MEMORY_CREDSTORE_LINE)) {
      problems.push(
        `a "${MEMORY_CREDSTORE_LINE}" line on ${stream}: a Headless Hub keeps its key in its data dir's secrets.json, never in memory alone (ADR-0126 section 1)`,
      );
    }
  }
  if (!facts.running) problems.push("serve had exited before its data dir was read");
  const { token } = facts;
  if (token === null) {
    problems.push(
      `no ${OPERATOR_TOKEN_FILE} in the data dir while serve runs: a Headless Hub keeps its operator secret there (ADR-0126 section 8, ADR-0146 section 3)`,
    );
  } else if ("error" in token) {
    problems.push(`cannot read ${OPERATOR_TOKEN_FILE} (${token.error})`);
  } else {
    if (token.mode !== 0o600) {
      problems.push(`${OPERATOR_TOKEN_FILE} is ${octal(token.mode)}, not 0600`);
    }
    const secret = token.text.trim();
    if (secret === "") problems.push(`${OPERATOR_TOKEN_FILE} is empty`);
    for (const [stream, text] of streams) {
      if (secret !== "" && text.includes(secret)) {
        problems.push(
          `${OPERATOR_TOKEN_FILE}'s secret appears on ${stream}: a Headless Hub prints it nowhere (ADR-0126 section 8)`,
        );
      }
    }
  }
  const mode = facts.dataDirMode;
  if (typeof mode !== "number") problems.push(`cannot stat the data dir (${mode.error})`);
  else if (mode !== 0o700) {
    problems.push(`the data dir is ${octal(mode)}, not 0700 (ADR-0127 section 3)`);
  }
  const { secrets } = facts;
  if (secrets !== null && "error" in secrets) {
    problems.push(`cannot read secrets.json (${secrets.error})`);
  } else if (secrets !== null) {
    if (secrets.mode !== 0o600) problems.push(`secrets.json is ${octal(secrets.mode)}, not 0600`);
    // The Hub's own schema, hubSecretsSchema, as keyCustodyFromFile reads it:
    // one key (`from`) or several.
    if (keyCustodyFromFile(hubKeyFilePath(hubData), secrets.text).kind !== "none") {
      problems.push("secrets.json holds a session key, where the Hub was given none");
    }
  }
  if (facts.tripwireRan) problems.push(TRIPWIRE_RAN);
  if (problems.length > 0) return fail(problems.join("; "));
  const file = secrets === null ? "no secrets.json" : "secrets.json 0600 holding no key";
  return pass(
    `"${expected}" once on stdout; no "${MEMORY_CREDSTORE_LINE}" line; ${OPERATOR_TOKEN_FILE} 0600, never printed; the data dir 0700; ${file}; the tripwire never ran`,
  );
}

/** A directory at one moment: absent, its entries sorted, or why it could not be listed. */
export type DirSnapshot =
  | { exists: false }
  | { exists: true; entries: string[] }
  | { exists: true; error: string };

/** What row 8 reads once `serve` has stopped. */
export type AfterStopFacts = {
  tripwireRan: boolean;
  /** Whether operator-token is still in the sandbox's data dir. */
  tokenLeft: boolean;
  /** Whether `serve` had to be killed, SIGTERM not ending it. */
  killed: boolean;
  realDataDir: string;
  /** The real data dir before the fake claude.ai started, and now. */
  before: DirSnapshot;
  after: DirSnapshot;
};

/**
 * Row 8: the tripwire never ran, operator-token went with `serve`, and the
 * real data dir is as it was before the run: absent if it was absent, else
 * listing the same entries.
 */
export function afterStopVerdict(facts: AfterStopFacts): Verdict {
  const { before, after, realDataDir: real } = facts;
  const problems: string[] = [];
  const unlisted = (when: string) =>
    `the real data dir ${real}, which existed before the run, could not be listed ${when}, so what the run added to it cannot be seen`;
  if (facts.tripwireRan) problems.push(TRIPWIRE_RAN);
  if (facts.tokenLeft) {
    problems.push(
      `${OPERATOR_TOKEN_FILE} is still in the data dir after serve stopped${facts.killed ? ", which was killed when SIGTERM did not end it" : ""}: the Hub deletes it at shutdown (ADR-0126 section 8)`,
    );
  }
  let realDetail = `the real data dir ${real} did not exist before the run and does not now`;
  if (!before.exists) {
    if (after.exists) problems.push(`the real data dir ${real} appeared during the run`);
  } else if (!after.exists) {
    problems.push(`the real data dir ${real} existed before the run and is gone`);
  } else if ("error" in before) {
    problems.push(unlisted(`before the run (${before.error})`));
  } else if ("error" in after) {
    problems.push(unlisted(`after it (${after.error})`));
  } else {
    const added = after.entries.filter((entry) => !before.entries.includes(entry));
    const lost = before.entries.filter((entry) => !after.entries.includes(entry));
    if (added.length > 0) {
      problems.push(
        `the real data dir ${real}, which existed before the run, gained ${added.join(", ")}`,
      );
    }
    if (lost.length > 0) {
      problems.push(
        `the real data dir ${real}, which existed before the run, lost ${lost.join(", ")}`,
      );
    }
    realDetail = `the real data dir ${real} existed before the run and lists the same ${after.entries.length} entries now`;
  }
  if (problems.length > 0) return fail(problems.join("; "));
  return pass(`the tripwire never ran; ${OPERATOR_TOKEN_FILE} removed at the stop; ${realDetail}`);
}

/** One HTTP answer as a row reads it: its status, Content-Type and body, or why there was none. */
export type Answered =
  | { status: number; contentType: string | null; body: string }
  | { error: string };

// What a page reference resolves against. Only the path is ever requested,
// on the Hub's own origin; this origin tells a reference to another apart.
const PAGE_ORIGIN = "http://page.invalid";
const PAGE_BASE = `${PAGE_ORIGIN}/page/`;

/**
 * Every `src` and `href` in `html`'s tags, outside comments, resolved against
 * /page/: `paths` holds each that stays under it, once, in order; `outside`
 * each that leaves it, as written. A `data:` URL needs no request and is in
 * neither.
 */
export function pageAssets(html: string): { paths: string[]; outside: string[] } {
  const paths: string[] = [];
  const outside: string[] = [];
  const text = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of text.match(/<[a-zA-Z][^>]*>/g) ?? []) {
    for (const match of tag.matchAll(
      /\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
    )) {
      const ref = match[1] ?? match[2] ?? match[3] ?? "";
      let url: URL | null;
      try {
        url = new URL(ref, PAGE_BASE);
      } catch {
        url = null;
      }
      if (url?.protocol === "data:") continue;
      if (url === null || url.origin !== PAGE_ORIGIN || !url.pathname.startsWith("/page/")) {
        if (!outside.includes(ref)) outside.push(ref);
        continue;
      }
      const path = `${url.pathname}${url.search}`;
      if (!paths.includes(path)) paths.push(path);
    }
  }
  return { paths, outside };
}

/**
 * Row 4: `index` is the answer to `GET /page/`, and `assets` the answer to
 * each path `pageAssets` finds in its body.
 */
export function pageVerdict(index: Answered, assets: ReadonlyMap<string, Answered>): Verdict {
  if ("error" in index) return fail(`GET /page/: ${index.error}`);
  if (index.status !== 200) {
    const why =
      index.status === 404
        ? ": a binary with no Hub page embedded answers so (ADR-0129 section 9)"
        : "";
    return fail(
      `GET /page/ answered ${index.status} ${JSON.stringify(firstLine(index.body, 80))}, not the page's index.html${why}`,
    );
  }
  const type = index.contentType === null ? null : mediaType(index.contentType);
  if (type !== "text/html") {
    return fail(
      `GET /page/ answered 200 as ${index.contentType === null ? "no Content-Type" : JSON.stringify(index.contentType)}, not text/html`,
    );
  }
  const { paths, outside } = pageAssets(index.body);
  const problems: string[] = [];
  if (outside.length > 0) {
    problems.push(
      `index.html names ${outside.map((ref) => JSON.stringify(ref)).join(", ")} outside /page/, which a web server proxying the page under a prefix of its own would not serve (ADR-0124 section 7)`,
    );
  }
  if (paths.length === 0)
    problems.push("index.html names no asset under /page/: not the built page");
  for (const path of paths) {
    const answer = assets.get(path);
    if (answer === undefined) problems.push(`GET ${path}: never asked`);
    else if ("error" in answer) problems.push(`GET ${path}: ${answer.error}`);
    else if (answer.status !== 200) problems.push(`GET ${path} answered ${answer.status}`);
  }
  if (problems.length > 0) return fail(problems.join("; "));
  return pass(
    `index.html as text/html and the ${paths.length} assets it names, each 200: ${paths.map((path) => path.slice("/page/".length)).join(", ")}`,
  );
}

// A shared Zod schema, as far as a verdict reads it. Structural, since zod
// itself does not resolve from scripts/.
type Schema<T> = {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } };
};

// `text` parsed as JSON and then by `schema`, or what is wrong with it.
function parsedBy<T>(
  text: string,
  schema: Schema<T>,
  name: string,
  what: string,
): { data: T } | { problem: string } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { problem: `${what} is not JSON: ${JSON.stringify(firstLine(text, 80))}` };
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return { data: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue === undefined ? "" : ` at ${issue.path.join(".") || "the root"}`;
  return { problem: `${what} does not parse with ${name}${where}: ${issue?.message ?? ""}` };
}

/** Row 5, over the answer to `GET /page/view`. */
export function viewVerdict(expected: string, answer: Answered): Verdict {
  if ("error" in answer) return fail(`GET /page/view: ${answer.error}`);
  if (answer.status !== 200) {
    return fail(
      `GET /page/view answered ${answer.status} ${JSON.stringify(firstLine(answer.body, 80))}`,
    );
  }
  const parsed = parsedBy<HubPageView>(
    answer.body,
    hubPageViewSchema,
    "hubPageViewSchema",
    "its body",
  );
  if ("problem" in parsed) return fail(parsed.problem);
  const view = parsed.data;
  if (view.version !== expected) {
    return fail(`parses, but its version is ${JSON.stringify(view.version)}, not ${expected}`);
  }
  return pass(
    `parses; version ${view.version}, ${view.keys.anthropic.connected} connected Claude key(s), ${view.liveClients} live clients`,
  );
}

/** What row 6's report must name: the expected version, and the port, pid and data dir served. */
export type ServedFacts = { version: string; port: number; pid: number; dataDir: string };

/** Row 6, over a run of `maxprice-hub status --json`. */
export function hubStatusVerdict(ran: Ran, expected: ServedFacts): Verdict {
  const how = abnormal(ran);
  if (how !== null) return failed(ran, how);
  if (ran.stderr !== "") return failed(ran, "wrote to stderr");
  const parsed = parsedBy<HubStatusReport>(
    ran.stdout,
    hubStatusReportSchema,
    "hubStatusReportSchema",
    "stdout",
  );
  if ("problem" in parsed) return fail(parsed.problem);
  const report = parsed.data;
  if (report.state === "not-responding") {
    return fail(
      `parses, but reports the Hub not-responding (pid ${report.pid}, port ${report.port})`,
    );
  }
  const problems: string[] = [];
  if (report.version !== expected.version) {
    problems.push(`version ${JSON.stringify(report.version)}, not ${expected.version}`);
  }
  // A key it holds: the legacy key, or an Account's with a setAt (ADR-0139 §9).
  if (report.keys.some(hubKeyHeld)) problems.push("a key present, where the Hub was given none");
  if (report.port !== expected.port)
    problems.push(`port ${report.port}, not the served ${expected.port}`);
  if (report.pid !== expected.pid) problems.push(`pid ${report.pid}, not serve's ${expected.pid}`);
  if (report.dataDir !== expected.dataDir) {
    problems.push(`data dir ${report.dataDir}, not the sandbox's ${expected.dataDir}`);
  }
  if (problems.length > 0) return fail(`parses, but reports ${problems.join(", ")}`);
  return pass(
    `parses; state ${report.state}, version ${report.version}, no key, port ${report.port}, pid ${report.pid}`,
  );
}

/** How `serve` ended after SIGTERM, for `stopVerdict`: `inTime` is whether it exited within STOP_MS. */
export function stopEnded(
  exit: { exitCode: number | null; signalCode: string | null },
  inTime: boolean,
): Ended {
  return {
    code: exit.exitCode,
    signal: exit.signalCode,
    error: inTime ? null : `did not exit within ${STOP_MS / 1000} s of SIGTERM`,
  };
}

// --- the run --------------------------------------------------------------------

class RunFailure extends Error {}

// The machine's own home, temp dir and Hub data dir, symlinks resolved, and
// the data dir as it was before the fake claude.ai started.
type Real = { home: string; tmp: string; dataDir: string; before: DirSnapshot };

// One smoke's sandbox and tripwire, its fake claude.ai, every process it
// spawned, its `serve` once spawned, whether that was sent SIGTERM, and the
// real places once read.
type Run = {
  sandbox: SandboxPaths;
  tripwire: Tripwire;
  env: Record<string, string>;
  fake: FakeClaude | null;
  children: Set<Bun.Subprocess>;
  daemon: Spawned | null;
  terminated: boolean;
  real: Real | null;
};

const live = new Set<Run>();

// Synchronous, so a signal handler can call it and exit at once: SIGKILL to
// every process the smoke spawned that has not ended, the fake claude.ai
// stopped, then the sandbox goes. It never signals anything else.
export function abandonHubSmokes(): void {
  for (const run of [...live]) {
    for (const child of run.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    run.fake?.stop();
    rmSync(run.sandbox.root, { recursive: true, force: true, maxRetries: 3 });
    live.delete(run);
  }
}

// The normal teardown: the same, but each process is waited for before the
// sandbox it writes to is removed.
async function stopRun(run: Run): Promise<void> {
  for (const child of run.children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  run.fake?.stop();
  run.fake = null;
  rmSync(run.sandbox.root, { recursive: true, force: true, maxRetries: 3 });
  live.delete(run);
}

// The copy, run with `args` in the sandbox, once the guard allows it.
function spawnCopy(run: Run, args: string[]): Spawned {
  const problems = copyAloneProblems(run.sandbox.binary, readdirSync(run.sandbox.bin));
  if (problems.length > 0) throw new RunFailure(`refusing to run the copy: ${problems.join("; ")}`);
  const child = spawnDrained([run.sandbox.binary, ...args], {
    cwd: run.sandbox.root,
    env: run.env,
    stdin: "ignore",
  });
  run.children.add(child.proc);
  return child;
}

// One run of the copy, killed at `ms`.
async function runCopy(run: Run, args: string[], ms: number): Promise<Ran> {
  let child: Spawned;
  try {
    child = spawnCopy(run, args);
  } catch (error) {
    if (error instanceof RunFailure) throw error;
    return {
      code: null,
      signal: null,
      error: `could not start: ${messageOf(error)}`,
      stdout: "",
      stderr: "",
    };
  }
  const { proc } = child;
  const ended = await within(proc.exited, ms);
  if (ended === null) proc.kill("SIGKILL");
  await proc.exited;
  run.children.delete(proc);
  // Bounded: a process the binary started could still hold its streams.
  const streams = await within(child.drained, STREAMS_MS);
  return {
    code: proc.exitCode,
    signal: proc.signalCode,
    error:
      ended === null
        ? `did not finish within ${ms / 1000} s`
        : streams === null
          ? `exited, but its output did not end within ${STREAMS_MS / 1000} s`
          : null,
    stdout: child.stdout(),
    stderr: child.stderr(),
  };
}

// A GET on loopback, bounded, never following a redirect.
async function get(url: string, ms: number): Promise<Answered> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: "manual" });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.text(),
    };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

async function answersHealthz(origin: string): Promise<boolean> {
  const answer = await get(`${origin}/healthz`, HEALTH_MS);
  if ("error" in answer) return false;
  try {
    return healthzProblem(answer.status, JSON.parse(answer.body)) === null;
  } catch {
    return false;
  }
}

// A fake claude.ai on a free high port, retried when the port is taken first.
async function startFakeClaude(): Promise<FakeClaude> {
  for (let attempt = 0; ; attempt++) {
    try {
      return createFakeClaude({ port: await freeHighPort() });
    } catch (error) {
      if (attempt + 1 >= PORT_ATTEMPTS) {
        throw new RunFailure(`the fake claude.ai would not start: ${messageOf(error)}`);
      }
    }
  }
}

// `serve` on a fresh port, ready as hub-ready.ts reads a Headless Hub: its
// own `listening on` line, its serve.lock naming its pid and the port, and a
// /healthz answer while it still runs. Retried on another port when one is
// taken between the probe and the bind. Throws why it never came up.
async function startServe(run: Run): Promise<{ daemon: Spawned; port: number }> {
  const lockPath = join(run.sandbox.hubData, SERVE_LOCK_FILE);
  let last = "";
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const port = await freeHighPort();
    writeFileSync(
      join(run.sandbox.hubData, "hub.json"),
      `${JSON.stringify(hubConfig(port, "loopback"), null, 2)}\n`,
    );
    const lockBefore = readTextOrNull(lockPath);
    const daemon = spawnCopy(run, ["serve"]);
    run.daemon = daemon;
    const problem = await hubReadyProblem({
      child: daemon,
      port,
      embedded: false,
      lockPath,
      lockBefore,
      timeoutMs: SERVE_MS,
      health: answersHealthz,
    });
    if (problem === null) return { daemon, port };
    last = problem;
    if (!/in use|EADDRINUSE/i.test(problem)) break;
  }
  throw new Error(last);
}

// Until stdout holds a whole custody line, `serve` exits, or CUSTODY_MS pass.
async function custodyPrinted(daemon: Spawned, hubData: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const { own, foreign } = keyCustodyLines(daemon.stdout(), hubData);
    if (own.length + foreign.length > 0 || daemon.exitCode() !== null) return;
    if (Date.now() - started > CUSTODY_MS) return;
    await Bun.sleep(50);
  }
}

// An fs error by its errno, else its message.
function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : messageOf(error);
}

function fileFacts(path: string): FileFacts {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return { error: "not a regular file" };
    return { mode: stat.mode & 0o777, text: readFileSync(path, "utf8") };
  } catch (error) {
    const errno = errnoOf(error);
    return errno === "ENOENT" ? null : { error: errno };
  }
}

function snapshotDir(path: string): DirSnapshot {
  if (!existsSync(path)) return { exists: false };
  try {
    return { exists: true, entries: readdirSync(path).sort() };
  } catch (error) {
    return { exists: true, error: errnoOf(error) };
  }
}

// The machine's own places, or a run that cannot be made.
function realPlaces(): Omit<Real, "before"> {
  try {
    const home = realpathSync(homedir());
    return { home, tmp: realpathSync(tmpdir()), dataDir: realDefaultDataDir(process.env, home) };
  } catch (error) {
    throw new RunFailure(`cannot resolve the real home and temp dir: ${messageOf(error)}`);
  }
}

function writeTripwire(tripwire: Tripwire): void {
  mkdirSync(tripwire.dir);
  writeFileSync(tripwire.helper, tripwireScript(tripwire.marker), { mode: 0o755 });
  chmodSync(tripwire.helper, 0o755);
}

// The control, as key-custody.test.ts runs its marking helper: whatever
// the copy's MAXPRICE_CREDSTORE_PATH names, run once in the copy's
// environment, exits 3 and leaves the marker rows 3 and 8 read, which then
// goes. So a marker never left means no helper ran. Null when it tripped,
// else why the run cannot be made.
function tripwireControl(run: Run): string | null {
  const helper = run.env.MAXPRICE_CREDSTORE_PATH ?? "";
  const { marker } = run.tripwire;
  let code: number | null = null;
  let why = "";
  try {
    const ran = Bun.spawnSync([helper, "get"], {
      cwd: run.sandbox.root,
      env: run.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: CONTROL_MS,
      killSignal: "SIGKILL",
    });
    code = ran.exitCode;
  } catch (error) {
    why = `, could not start: ${messageOf(error)}`;
  }
  const left = existsSync(marker);
  rmSync(marker, { force: true });
  if (code === 3 && left) return null;
  return `the tripwire ${helper} did not trip when run (exit ${code}${why}, ${left ? "its marker left" : "no marker left"}), so its marker could never show a helper ran`;
}

// Row 3's facts, read from disk while `serve` runs.
function custodyFacts(run: Run, daemon: Spawned): CustodyFacts {
  const { hubData } = run.sandbox;
  const { proc } = daemon;
  let dataDirMode: CustodyFacts["dataDirMode"];
  try {
    dataDirMode = statSync(hubData).mode & 0o777;
  } catch (error) {
    dataDirMode = { error: errnoOf(error) };
  }
  return {
    running: proc.exitCode === null && proc.signalCode === null,
    stdout: daemon.stdout(),
    stderr: daemon.stderr(),
    token: fileFacts(operatorTokenPath(hubData)),
    dataDirMode,
    secrets: fileFacts(hubKeyFilePath(hubData)),
    tripwireRan: existsSync(run.tripwire.marker),
  };
}

// `serve` ended, if it has not: SIGTERM, unless row 7 sent it, then SIGKILL
// once STOP_MS pass. True when it had to be killed.
async function stopServe(run: Run, daemon: Spawned): Promise<boolean> {
  const { proc } = daemon;
  const ended = () => proc.exitCode !== null || proc.signalCode !== null;
  if (ended()) return false;
  if (!run.terminated) {
    run.terminated = true;
    proc.kill("SIGTERM");
    if ((await within(proc.exited, STOP_MS)) !== null) return false;
  }
  proc.kill("SIGKILL");
  await within(proc.exited, STOP_MS);
  return true;
}

// Row 8, once `serve` has stopped.
async function afterStopRow(run: Run, daemon: Spawned, real: Real): Promise<SmokeRow> {
  const killed = await stopServe(run, daemon);
  return {
    name: "no keychain helper ran and no real data dir appeared",
    command: `after serve stopped: the tripwire, ${OPERATOR_TOKEN_FILE}, ${real.dataDir}`,
    ...afterStopVerdict({
      tripwireRan: existsSync(run.tripwire.marker),
      tokenLeft: existsSync(operatorTokenPath(run.sandbox.hubData)),
      killed,
      realDataDir: real.dataDir,
      before: real.before,
      after: snapshotDir(real.dataDir),
    }),
  };
}

function serveLogOf(daemon: Spawned | null): string {
  if (daemon === null) return "";
  const block = (name: string, text: string) =>
    text === "" ? "" : `--- ${name}\n${text}${text.endsWith("\n") ? "" : "\n"}`;
  return redactOperatorToken(block("stdout", daemon.stdout()) + block("stderr", daemon.stderr()));
}

const headlessOnly = () =>
  `the Headless Hub smoke runs on Linux and macOS only (this is ${process.platform}), the Headless Hub's platforms`;

export async function smokeHubBinary(options: SmokeArgs): Promise<SmokeResult> {
  const rows: SmokeRow[] = [];
  if (!runsHeadlessHub(process.platform)) {
    return { rows, broken: headlessOnly(), serveLog: "", ok: false };
  }
  const binary = resolve(options.binary);
  const expected = normalizeVersion(options.version);
  if (!existsSync(binary)) {
    const broken = `no binary at ${binary}: build it with \`${BUILD_COMMAND}\`, or pass --binary`;
    return { rows, broken, serveLog: "", ok: false };
  }
  // Every path the copy is told of descends from the root as the kernel
  // resolves it, so `isolationProblems` can read them by path alone.
  const sandbox = sandboxPaths(realpathSync(makeSandbox("headless-hub-smoke", binary).root));
  const run: Run = {
    sandbox,
    tripwire: tripwirePaths(sandbox.root),
    env: {},
    fake: null,
    children: new Set(),
    daemon: null,
    terminated: false,
    real: null,
  };
  live.add(run);
  let broken: string | null;
  try {
    try {
      broken = await smokeRows(run, expected, rows);
    } catch (error) {
      if (!(error instanceof RunFailure)) throw error;
      broken = error.message;
    }
    // Row 8, whenever `serve` was spawned, whatever came before it.
    if (run.daemon !== null && run.real !== null) {
      rows.push(await afterStopRow(run, run.daemon, run.real));
    }
  } finally {
    await stopRun(run);
  }
  // Read once serve's streams have ended, so the log holds its last lines.
  if (run.daemon !== null) await within(run.daemon.drained, STREAMS_MS);
  return {
    rows,
    broken,
    serveLog: serveLogOf(run.daemon),
    ok: exitCodeOf({ rows, broken }) === 0,
  };
}

// Rows 1-7, pushed onto `rows` as each is judged; smokeHubBinary adds row
// 8. Returns why the run could not be made, or null; a guard refusal throws
// a RunFailure.
async function smokeRows(run: Run, expected: string, rows: SmokeRow[]): Promise<string | null> {
  // Before anything starts: whether this user's real data dir exists, and
  // what it holds.
  const places = realPlaces();
  run.real = { ...places, before: snapshotDir(places.dataDir) };
  run.fake = await startFakeClaude();
  writeTripwire(run.tripwire);
  run.env = smokeEnv({
    path: process.env.PATH ?? "/usr/bin:/bin",
    root: run.sandbox.root,
    claudeBaseUrl: run.fake.url,
    credstorePath: run.tripwire.helper,
  });
  const problems = isolationProblems({
    env: run.env,
    root: run.sandbox.root,
    realHome: places.home,
    realTmp: places.tmp,
    realDataDir: places.dataDir,
  });
  if (problems.length > 0) return `refusing to run: ${problems.join("; ")}`;
  const proxy = await deadProxyCheck();
  if (proxy !== null) return proxy;
  const control = tripwireControl(run);
  if (control !== null) return control;

  rows.push({
    name: "--version prints the bare version",
    command: "maxprice-hub --version",
    ...hubVersionVerdict(expected, await runCopy(run, ["--version"], VERSION_MS)),
  });

  const serveRow = { name: "serve comes up", command: "maxprice-hub serve" };
  let daemon: Spawned;
  let port: number;
  try {
    ({ daemon, port } = await startServe(run));
  } catch (error) {
    if (error instanceof RunFailure) throw error;
    const why = messageOf(error);
    rows.push({ ...serveRow, verdict: "fail", detail: why });
    return `serve never served: ${why}`;
  }
  const pid = daemon.proc.pid;
  const origin = `http://127.0.0.1:${port}`;
  rows.push({
    ...serveRow,
    verdict: "pass",
    detail: `"[hub] listening on ${origin}" logged, ${SERVE_LOCK_FILE} records pid ${pid} and port ${port}, /healthz answered {"ok":true,"service":"maxprice-hub"}`,
  });

  await custodyPrinted(daemon, run.sandbox.hubData);
  rows.push({
    name: "no key, none from a keychain, and the operator token kept",
    command: "maxprice-hub serve (its boot lines and data dir)",
    ...custodyVerdict(custodyFacts(run, daemon), run.sandbox.hubData),
  });

  const index = await get(`${origin}/page/`, PAGE_MS);
  const assets = new Map<string, Answered>();
  if (!("error" in index) && index.status === 200) {
    for (const path of pageAssets(index.body).paths) {
      assets.set(path, await get(`${origin}${path}`, PAGE_MS));
    }
  }
  const page = pageVerdict(index, assets);
  // A binary with no page says so at boot; the row quotes it.
  const warned = daemon
    .stderr()
    .split("\n")
    .find((line) => line.includes("embeds no Hub page"));
  rows.push({
    name: "/page/ serves index.html and every asset it names",
    command: `GET ${origin}/page/`,
    ...page,
    ...(page.verdict === "fail" && warned !== undefined
      ? { detail: `${page.detail}; serve logged ${JSON.stringify(warned.trim())}` }
      : {}),
  });

  rows.push({
    name: "/page/view parses at the version",
    command: `GET ${origin}/page/view`,
    ...viewVerdict(expected, await get(`${origin}/page/view`, VIEW_MS)),
  });

  rows.push({
    name: "status --json describes this Hub",
    command: "maxprice-hub status --json",
    ...hubStatusVerdict(await runCopy(run, ["status", "--json"], COMMAND_MS), {
      version: expected,
      port,
      pid,
      dataDir: run.sandbox.hubData,
    }),
  });

  const { proc } = daemon;
  const stopRow = { name: "SIGTERM stops serve with exit 0", command: `kill -TERM ${pid}` };
  if (proc.exitCode !== null || proc.signalCode !== null) {
    const how =
      proc.signalCode === null ? `exited ${proc.exitCode}` : `was ended by ${proc.signalCode}`;
    rows.push({ ...stopRow, verdict: "fail", detail: `serve ${how} before SIGTERM` });
    return null;
  }
  run.terminated = true;
  proc.kill("SIGTERM");
  const stopped = await within(proc.exited, STOP_MS);
  rows.push({ ...stopRow, ...stopVerdict(stopEnded(proc, stopped !== null)) });
  return null;
}

async function main(argv: string[]): Promise<number> {
  const args = parseHubSmokeArgs(argv);
  if ("usage" in args) {
    console.error(args.usage);
    return 2;
  }
  if (!runsHeadlessHub(process.platform)) {
    console.error(`run failed: ${headlessOnly()}`);
    return 2;
  }
  const interrupted = () => {
    abandonHubSmokes();
    process.exit(130);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  process.once("exit", abandonHubSmokes);

  const result = await smokeHubBinary(args);
  const inRepo = relative(REPO, args.binary);
  const shown = inRepo.startsWith("..") ? args.binary : inRepo;
  const header = `# Headless Hub smoke\n\nBinary: \`${shown}\`, version ${args.version}, run ${new Date().toISOString()}`;
  if (result.rows.length === 0) console.error(`run failed: ${result.broken}`);
  else process.stdout.write(smokeTable(result, header));
  const code = exitCodeOf(result);
  if (code !== 0 && result.serveLog !== "") {
    process.stderr.write(`\nserve's log:\n${result.serveLog}`);
  }
  return code;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    return 2;
  });
}
