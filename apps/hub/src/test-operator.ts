import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HUB_PROTOCOL_VERSION } from "@maxprice/shared";
import type { Env } from "@maxprice/usage-core/home-path";
import { takeServeLock } from "@maxprice/usage-core/serve-lock";
import { clientPath } from "@maxprice/usage-core/test-loopback";
import { CliError, EXIT, type Io } from "./cli";
import { reachHub, type ReachOptions, type RunningHub } from "./operator-client";

// What the in-process tests of the operator commands share
// (operator.test.ts, key-commands.test.ts, label-commands.test.ts): a temp
// data dir holding a Hub, a Hub stub on loopback port 0 reached through the
// real reachHub with this process holding serve.lock as a `serve` would, and
// the captures. Every data dir is a temp dir and every key fake; a test file
// calls `cleanUpOperatorRuns` after each case.

export const UNIT = "maxprice-hub.service";
export const TOKEN = "fake-operator-token-0c41";
export const FAST: ReachOptions = { timeoutMs: 300, pollMs: 20, readCgroup: () => null };

const roots: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const releases: Array<() => void> = [];

export async function cleanUpOperatorRuns(): Promise<void> {
  for (const release of releases.splice(0)) release();
  for (const server of servers.splice(0)) await server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

// A data dir holding a Hub, in a HOME of its own so messages show ~/<name>.
export function hubDir(name = "hub"): { dir: string; env: Env } {
  const root = mkdtempSync(join(tmpdir(), "hub-operator-"));
  roots.push(root);
  const dir = join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(
    join(dir, "hub.json"),
    `${JSON.stringify({ port: 9, bind: "loopback", passwordHash: null }, null, 2)}\n`,
  );
  return { dir, env: { HOME: root, MAXPRICE_HUB_DATA_DIR: dir } };
}

export type Seen = { method: string; path: string; body: string };
export type Stub = {
  port: number;
  // Every request but the reach's own probes.
  seen: Seen[];
  // How many times the reach has probed /api/status.
  probes: () => number;
};

// A running Hub's status as its probe answers it: its Accounts (ADR-0139 §1),
// none by default.
export function hubStatusBody(accounts: unknown[] = []) {
  return {
    service: "maxprice-hub",
    protocolVersion: HUB_PROTOCOL_VERSION,
    accounts,
    samplesStampedAt: null,
    usageLastSampleAt: null,
    sampleCount: 0,
  };
}

// A Hub stub: /api/status answers with the status preamble the reach reads,
// every other request under /api/ is recorded and answered by `answer`. A
// request elsewhere (a prober's `GET /`, #596) is a 404, never recorded and
// never `answer`'s.
export function stub(
  answer: (seen: Seen) => Response | Promise<Response>,
  status: unknown = hubStatusBody(),
): Stub {
  const seen: Seen[] = [];
  let probes = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/status") {
        probes += 1;
        return Response.json(status);
      }
      if (!clientPath(path, ["/api/"])) return new Response("not found", { status: 404 });
      const one = { method: request.method, path, body: await request.text() };
      seen.push(one);
      return await answer(one);
    },
  });
  servers.push(server);
  return { port: server.port!, seen, probes: () => probes };
}

// serve.lock held by this process as a `serve` holds it, with the stub's
// port recorded and its operator token written: a running Hub to reach.
export function runningAt(dir: string, port: number): void {
  const taken = takeServeLock(join(dir, "serve.lock"), UNIT);
  if (taken.kind !== "taken") throw new Error("the test could not take serve.lock");
  taken.lock.recordPort(port);
  releases.push(taken.lock.release);
  writeFileSync(join(dir, "operator-token"), `${TOKEN}\n`, { mode: 0o600 });
}

// A running Hub stub, reached: the Hub a live twin is given.
export async function live(
  answer: (seen: Seen) => Response | Promise<Response>,
  status?: unknown,
): Promise<{ hub: RunningHub } & Stub> {
  const { dir, env } = hubDir();
  const hubStub = stub(answer, status);
  runningAt(dir, hubStub.port);
  const reached = await reachHub(dir, env, FAST);
  if (reached.kind !== "live") throw new Error(`expected live, got ${reached.kind}`);
  return { hub: reached.hub, ...hubStub };
}

// Whether another process could take serve.lock now.
export function lockFree(dir: string): boolean {
  const taken = takeServeLock(join(dir, "serve.lock"), UNIT);
  if (taken.kind === "taken") taken.lock.release();
  return taken.kind === "taken";
}

export const ok = () => Response.json({ ok: true });
export const refused = (status: number, error: string) => () =>
  Response.json({ error }, { status });

export async function rejection(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a CliError, got none");
}

export const usage = (message: string) => new CliError(EXIT.USAGE, message);
export const failure = (message: string) => new CliError(EXIT.FAILURE, message);

// Output written as a command writes it.
export function capture(): Io & { out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    stdout: { write: (text: string) => (out += text) },
    stderr: { write: (text: string) => (err += text) },
    out: () => out,
    err: () => err,
  };
}

// A reader that answers each prompt in turn, and records the prompts.
export function answering(...answers: Array<string | null>) {
  const prompts: string[] = [];
  return {
    prompts,
    readSecret: async (prompt: string) => {
      prompts.push(prompt);
      if (answers.length === 0) throw new Error(`no answer left for ${prompt}`);
      return answers.shift()!;
    },
  };
}

// A CliError, its code and message whole, as a case expects one.
export function expectCliError(error: CliError, code: number, message: string): void {
  expect({ code: error.code as number, message: error.message }).toEqual({ code, message });
}
