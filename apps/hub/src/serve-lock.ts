import { closeSync, constants, openSync } from "node:fs";
import { constants as os } from "node:os";
import { join } from "node:path";
import { errnoName, tryLockShared } from "@maxprice/usage-core/flock";
import { displayPath, type Env } from "@maxprice/usage-core/home-path";
import {
  describeHolder,
  readServeLockHolder,
  type ReadCgroup,
  type ServeLock,
  type ServeLockHolder,
  type ServeLockTake,
  takeServeLock as takeLock,
} from "@maxprice/usage-core/serve-lock";
import { CliError, EXIT } from "./cli";
import { SERVE_LOCK_POLL_MS, SERVE_LOCK_RETRY_MS } from "./serve-lock-bound";

// One Hub per data dir (ADR-0127 §3): a non-blocking exclusive flock on
// `<data dir>/serve.lock`, which a Headless Hub on Linux takes before it
// loads hub.json and holds for its whole life, recording its pid and then its
// port. The lock and its record are `@maxprice/usage-core/serve-lock`'s,
// shared with the Headless client (§11); this names the file and
// `maxprice-hub.service`, and turns a lost or failed take into the Hub's
// exits. The operator commands take the same lock to edit the data files
// when it is free, so neither they nor a `serve` ever runs beside the other,
// and reach the daemon that holds it otherwise (§7, operator-client.ts).
// `restore` takes it too, and refuses while it is held; it also asks whether
// a Hub holds its backup's lock (ADR-0130 §5), and `status` whether one
// holds its own, both without writing it (readOnlyLockHolder).

export type { ServeLock };

export const UNIT = "maxprice-hub.service";

export function serveLockPath(dataDir: string): string {
  return join(dataDir, "serve.lock");
}

function flockFailed(path: string, errno: number): CliError {
  return new CliError(EXIT.FAILURE, `cannot lock ${path}: flock failed with ${errnoName(errno)}`);
}

export type LockOrHolder = Exclude<ServeLockTake, { kind: "failed" }>;

// The lock, or who holds it. flock failing for any other reason is exit 1.
function take(
  dataDir: string,
  readCgroup?: ReadCgroup,
  inspect?: (fd: number) => void,
): LockOrHolder {
  const path = serveLockPath(dataDir);
  const taken = takeLock(path, UNIT, readCgroup, inspect);
  if (taken.kind === "failed") throw flockFailed(path, taken.errno);
  return taken;
}

// The operator commands' take (ADR-0127 §7), through reachHub
// (operator-client.ts): a free lock is theirs to edit the files under, and a
// held one names the daemon to reach instead, on the port its record gives.
// Neither refuses here: whether a holder is reachable is reachHub's to say,
// and so is whether a free lock may be taken. `refuse`, when given, runs once
// a free lock is taken and before its record is written, so what it throws
// lets the lock go and leaves the file as it was: reachHub's Hub that
// stopped while the command waited for it.
export function takeLockOrHolder(
  dataDir: string,
  readCgroup?: ReadCgroup,
  refuse?: () => void,
): LockOrHolder {
  return take(dataDir, readCgroup, refuse);
}

export type ServeLockRetry = {
  // The bound, from the first attempt, and the time between attempts.
  retryMs?: number;
  pollMs?: number;
  // For a test: the wait between attempts, and a monotonic clock.
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

// serve's take: exit 5 naming the holder when another process holds it past
// a short bound. `status` holds a free lock for an instant, shared to ask it
// and exclusive in a take it refuses (status.ts), and a `serve` starting in
// that instant would otherwise lose it, exit 5, which the unit does not
// retry (§2). So serve asks again, every SERVE_LOCK_POLL_MS, each attempt as
// non-blocking as the first, until SERVE_LOCK_RETRY_MS from its first, and
// makes one last attempt at the bound itself; held then, it exits 5, naming
// the holder the record gave at that last look. It never blocks and never
// waits past the bound, so a second serve beside a running Hub still exits
// 5, half a second later. The bound is measured on the monotonic clock: a
// wall-clock step, timesyncd's at boot when the unit starts, would stretch
// it or cancel it. Nothing before it reads hub.json or writes a record: a
// serve still waiting here has bound nothing. No command's take retries
// (takeLockOrHolder, takeVerbLock); reachHub looks again on its own poll, as
// before. The Headless client keeps usage-core's single take (ADR-0127's
// banner of 2026-10-24 says why).
export async function takeServeLock(
  dataDir: string,
  env: Env,
  readCgroup?: ReadCgroup,
  {
    retryMs = SERVE_LOCK_RETRY_MS,
    pollMs = SERVE_LOCK_POLL_MS,
    sleep = (ms) => Bun.sleep(ms),
    now = () => performance.now(),
  }: ServeLockRetry = {},
): Promise<ServeLock> {
  const deadline = now() + retryMs;
  for (;;) {
    const taken = take(dataDir, readCgroup);
    if (taken.kind === "taken") return taken.lock;
    const left = deadline - now();
    if (left <= 0) {
      throw new CliError(
        EXIT.ALREADY_RUNNING,
        `maxprice-hub is already running for ${displayPath(dataDir, env)} (${describeHolder(taken.holder, UNIT)})`,
      );
    }
    // Never past the bound: the last wait ends on it, for the last attempt.
    await sleep(Math.min(pollMs, left));
  }
}

// `restore`'s take (ADR-0130 §5): exit 1 naming the holder. A restore never
// runs beside a Hub and has no path through a running one, unlike the
// operator commands, which take the lock through takeLockOrHolder.
export function takeVerbLock(
  dataDir: string,
  env: Env,
  verb: string,
  readCgroup?: ReadCgroup,
  inspect?: (fd: number) => void,
): ServeLock {
  const taken = take(dataDir, readCgroup, inspect);
  if (taken.kind === "held") {
    throw new CliError(
      EXIT.FAILURE,
      `maxprice-hub is running for ${displayPath(dataDir, env)} (${describeHolder(taken.holder, UNIT)}); stop it first: ${verb} edits the data files directly`,
    );
  }
  return taken.lock;
}

// Who holds a data dir's serve.lock, or null when nothing does or there is
// no such file, asked by a command that must never write or create it:
// `restore` of its backup (ADR-0130 §5), and `status` of the data dir it
// describes (ADR-0127 §8, status.ts). A tray Hub's dir has none. Opened
// read-only and never created, and let go at once. The lock asked for is
// shared: what a read-only descriptor may take on NFS too (tryLockShared),
// and still refused while a serve holds the file exclusively. While it is
// free, though, this holds it for that instant, and a `serve` whose own
// exclusive take lands then meets the hold, which takeServeLock's bounded
// retry waits out (ADR-0127 §2). flock failing for any other reason is
// exit 1.
export function readOnlyLockHolder(dir: string, readCgroup?: ReadCgroup): ServeLockHolder | null {
  const path = serveLockPath(dir);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let errno: number;
  try {
    errno = tryLockShared(fd);
  } finally {
    // Closing the descriptor lets go of a lock it took.
    closeSync(fd);
  }
  if (errno === 0) return null;
  if (errno === os.errno.EWOULDBLOCK) return readServeLockHolder(path, UNIT, readCgroup);
  throw flockFailed(path, errno);
}
