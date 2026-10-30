import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Io, Writer } from "./main";
import { dataDir, type Env, socketPath } from "./paths";
import { VERSION } from "./version";

// In-process stand-ins for the daemon, for the tests of the commands that ask
// it something (`status`, `rescan`, `pricing`, `key`, `hub`). Each case gets a scratch
// HOME, which holds the data dir, so the socket is
// `~/.local/share/maxprice/daemon.sock` under it and nothing reaches the real
// one. The daemon is `Bun.serve({ unix })` on that socket, recording every
// request. Each test file's afterEach calls `stopDaemons()`.

export const HOME_ORG = "3f2a91c0-0000-4000-8000-000000000001";

const stops: Array<() => void> = [];
const roots: string[] = [];

export function scratch(): Env & { HOME: string } {
  const root = mkdtempSync(join(tmpdir(), "mp-cli-cmd-"));
  roots.push(root);
  const env = { HOME: join(root, "home") };
  mkdirSync(env.HOME);
  return env;
}

// A ready status at this version, every field of which the shared schema
// accepts: limits connected, the Home organization's windows read, no Hub.
export function fixtureStatus(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    watchedPaths: ["/srv/claude/projects"],
    engineVersion: VERSION,
    hasData: true,
    usageConnection: "connected",
    usageLastSampleAt: "2026-10-19T11:57:00.000Z",
    organizations: {
      [HOME_ORG]: {
        limits: "windows",
        windowStates: { fiveHour: "active", weekly: "idle" },
        lastReadAt: null,
        lastSampleAt: null,
      },
    },
    hubConnection: "off",
    hubSeed: null,
    usageHistoryReady: true,
    identityReady: true,
    ready: true,
    ...over,
  };
}

export type Seen = { method: string; path: string; type: string | null; body: string };

type StatusAnswer = string | Record<string, unknown>;

export type FakeDaemon = {
  // `/api/status`'s answer: a body sent as it is, or a value sent as JSON;
  // `fixtureStatus()` by default. A function is asked again for each read,
  // so the answer can change between reads, or wait.
  status?: StatusAnswer | (() => StatusAnswer | Promise<StatusAnswer>);
  // Every other path's answer, given the request as `seen` records it; a 404
  // envelope by default.
  respond?: (path: string, request: Seen) => Response | Promise<Response>;
  // Called as `/api/status` is answered.
  onStatus?: () => void;
};

function statusBody(answer: StatusAnswer): string {
  return typeof answer === "string" ? answer : JSON.stringify(answer);
}

// A daemon on `env`'s socket. The returned list fills with each request as it
// arrives.
export function fakeDaemon(env: Env, fake: FakeDaemon = {}): Seen[] {
  const socket = socketPath(dataDir(env));
  mkdirSync(dirname(socket), { recursive: true });
  const status = fake.status ?? fixtureStatus();
  const respond =
    fake.respond ??
    ((path: string) => Response.json({ error: `no route ${path}` }, { status: 404 }));
  const seen: Seen[] = [];
  const server = Bun.serve({
    unix: socket,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const one: Seen = {
        method: request.method,
        path,
        type: request.headers.get("content-type"),
        body: await request.text(),
      };
      seen.push(one);
      if (path !== "/api/status") return await respond(path, one);
      const body = statusBody(typeof status === "function" ? await status() : status);
      fake.onStatus?.();
      return new Response(body);
    },
  });
  stops.push(() => void server.stop(true));
  return seen;
}

// Each request as `<method> <path>`.
export function requestLines(seen: readonly Seen[]): string[] {
  return seen.map((request) => `${request.method} ${request.path}`);
}

// An Io whose streams record what they are written, each with the given
// `isTTY` (or none).
export function capture(stdout: Partial<Writer> = {}, stderr: Partial<Writer> = {}) {
  let out = "";
  let err = "";
  const io: Io = {
    stdout: { ...stdout, write: (text: string) => (out += text) },
    stderr: { ...stderr, write: (text: string) => (err += text) },
  };
  return { io, out: () => out, err: () => err };
}

export function stopDaemons(): void {
  for (const stop of stops.splice(0)) stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
