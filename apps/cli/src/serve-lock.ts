import { errnoName } from "@maxprice/usage-core/flock";
import {
  describeHolder,
  type ReadCgroup,
  readServeLockHolder as readHolder,
  type ServeLockHolder,
  takeServeLock as takeLock,
} from "@maxprice/usage-core/serve-lock";
import { CliError, EXIT } from "./exit";
import { displayPath, type Env, serveLockPath } from "./paths";
import { UNIT } from "./service/unit";

// One daemon per data dir (ADR-0120 §3): a non-blocking exclusive flock on
// `<data dir>/serve.lock`, taken before the boot and held for the process's
// whole life. The lock and its record are `@maxprice/usage-core/serve-lock`'s,
// which the Headless Hub shares (ADR-0127 §3, §11); this names the file and
// `maxprice.service`, and turns a lost or failed take into serve's exit. The
// Headless client records no port, so its file holds the pid alone.

export type ServeLock = { path: string; release: () => void };

export type { ReadCgroup };

// The holder as `update` reads it, with no port; `service status` reads it
// through the shared module.
export function readServeLockHolder(
  dir: string,
  readCgroup?: ReadCgroup,
): Omit<ServeLockHolder, "port"> {
  const { pid, running, service } = readHolder(serveLockPath(dir), UNIT, readCgroup);
  return { pid, running, service };
}

// Takes the lock or throws: exit 5 naming the holder when another process
// holds it, exit 1 for any other failure.
export function takeServeLock(dir: string, env: Env, readCgroup?: ReadCgroup): ServeLock {
  const path = serveLockPath(dir);
  const taken = takeLock(path, UNIT, readCgroup);
  if (taken.kind === "held") {
    throw new CliError(
      EXIT.ALREADY_RUNNING,
      `the daemon is already running for ${displayPath(dir, env)} (${describeHolder(taken.holder, UNIT)})`,
    );
  }
  if (taken.kind === "failed") {
    throw new CliError(
      EXIT.FAILURE,
      `cannot lock ${path}: flock failed with ${errnoName(taken.errno)}`,
    );
  }
  return taken.lock;
}
