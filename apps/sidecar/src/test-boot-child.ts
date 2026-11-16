import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatusSnapshot, UsageKeyset } from "@maxprice/shared";

// The real sidecar (`bootSidecar`, through `boot-child.ts`) in a child
// process on a scratch HOME, config root and data dir, for the #639 tests
// that drive its routes end to end: GET /api/account-sources against a root's
// login and a fake CLIProxyAPI, and Connect against fake-claude. A test-only
// module (only `*.test.ts` files import it), the minimal subset of
// boot.test.ts's own `bootChild`: TCP, no held probes. `bootSidecar` installs
// process handlers and timers and returns no stop, so it cannot run in the
// test's own process. It imports nothing of the sidecar's (boot-child.ts is
// spawned by path, and its options are restated here as `ChildBootOptions`),
// so scripts/acceptance/connect-flow.test.ts, under the scripts' tsconfig,
// can use it too without type-checking the sidecar.

// boot-child.ts's `BootChildOptions`, the subset these tests pass.
type ChildBootOptions = {
  settingsPath: string;
  listen: { port: number };
  usageKeyset: UsageKeyset | null;
};

export const CHILD_TIMEOUT_MS = 20_000;

export type ChildScratch = {
  dir: string;
  home: string;
  // CLAUDE_CONFIG_DIR: its `projects/` is the watched root, its `.claude.json`
  // the root's login file.
  config: string;
  settingsPath: string;
  cleanup: () => void;
};

export function childScratch(prefix: string): ChildScratch {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const home = join(dir, "home");
  const config = join(dir, "claude");
  mkdirSync(home);
  mkdirSync(join(config, "projects"), { recursive: true });
  mkdirSync(join(dir, "data"));
  return {
    dir,
    home,
    config,
    settingsPath: join(dir, "data", "settings.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// A root's login file naming `account` in `organization`, its address `email`.
export function writeRootLogin(
  s: ChildScratch,
  organization: string,
  account: string,
  email: string,
): void {
  writeFileSync(
    join(s.config, ".claude.json"),
    JSON.stringify({
      oauthAccount: { organizationUuid: organization, accountUuid: account, emailAddress: email },
    }),
  );
}

export async function until(
  probe: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = CHILD_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs} ms`);
    await Bun.sleep(25);
  }
}

export type SidecarChild = {
  url: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  json: <T>(path: string) => Promise<T>;
  ready: () => Promise<void>;
  stop: () => Promise<void>;
};

export async function startSidecarChild(
  s: ChildScratch,
  opts: { claudeBaseUrl?: string; usageKeyset?: UsageKeyset | null } = {},
): Promise<SidecarChild> {
  const options: ChildBootOptions = {
    settingsPath: s.settingsPath,
    listen: { port: 0 },
    usageKeyset: opts.usageKeyset ?? null,
  };
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, "boot-child.ts"), JSON.stringify(options)],
    {
      cwd: s.dir,
      env: {
        ...process.env,
        HOME: s.home,
        USERPROFILE: s.home,
        XDG_DATA_HOME: join(s.dir, "xdg-data"),
        XDG_CONFIG_HOME: join(s.dir, "xdg-config"),
        XDG_CACHE_HOME: join(s.dir, "xdg-cache"),
        XDG_STATE_HOME: join(s.dir, "xdg-state"),
        XDG_RUNTIME_DIR: join(s.dir, "xdg-runtime"),
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
        CLAUDE_CONFIG_DIR: s.config,
        MAXPRICE_PRICING_STARTUP_FETCH: "0",
        // Refused at once unless a case names its fake: nothing here may reach
        // the real claude.ai.
        MAXPRICE_CLAUDE_BASE_URL: opts.claudeBaseUrl ?? "http://127.0.0.1:9/api",
        MAXPRICE_USAGE_HISTORY_PATH: undefined,
        MAXPRICE_SETTINGS_PATH: undefined,
        MAXPRICE_HUB_URL: undefined,
        MAXPRICE_HUB_PASSWORD: undefined,
        MAXPRICE_AUTH_TOKEN: undefined,
        MAXPRICE_WEBVIEW_PROFILE_DIR: undefined,
        VITE_SIDECAR_ORIGIN: undefined,
        PORT: undefined,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderr = new Response(proc.stderr).text();
  const lines: string[] = [];
  const stdoutDone = (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of proc.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      lines.push(...parts);
    }
  })();
  try {
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`boot child exited: ${await stderr}`);
      return lines.includes("BOOTED");
    }, "the boot");
  } catch (err) {
    proc.kill("SIGKILL");
    throw err;
  }
  const announced = lines.find((line) => line.startsWith("LISTENING "));
  const url = `http://127.0.0.1:${Number(announced?.slice("LISTENING ".length))}`;
  const request = (path: string, init?: RequestInit) => fetch(`${url}${path}`, init);
  const json = async <T>(path: string): Promise<T> => {
    const response = await request(path);
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return (await response.json()) as T;
  };
  return {
    url,
    request,
    json,
    ready: () => until(async () => (await json<StatusSnapshot>("/api/status")).ready, "readiness"),
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
      await stdoutDone;
    },
  };
}
