// One daemon per data dir, for both headless products (ADR-0120 §3, ADR-0127
// §3, §11): a non-blocking exclusive flock on the product's lock file, taken
// before the boot and held for the process's whole life. The kernel releases
// it at any exit, a SIGKILL included, so it is never stale. The holder writes
// its pid into the file for the loser's message, and `service status` reads
// it the same way. A product that serves a port records it under the pid
// once it knows it, so its commands can reach the running daemon (ADR-0127
// §7); the Headless client records none.
//
// The file holds the pid and a newline, then the port and a newline once one
// is recorded: `4182\n`, or `4182\n47100\n`.
//
// Reachable only via the "./serve-lock" subpath, never index.ts.

import { closeSync, constants, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs";
import { constants as os } from "node:os";

import { tryLockExclusive } from "./flock";

export type ServeLock = {
  path: string;
  // Rewrites the record as the pid and then `port`.
  recordPort: (port: number) => void;
  release: () => void;
};

export type ServeLockTake =
  | { kind: "taken"; lock: ServeLock }
  // Another process holds it: EWOULDBLOCK.
  | { kind: "held"; holder: ServeLockHolder }
  // flock failed for any other reason, with its errno.
  | { kind: "failed"; errno: number };

// What a process's cgroup file says, or null; `/proc` by default.
export type ReadCgroup = (pid: number) => string | null;

function readProcCgroup(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, "utf8");
  } catch {
    return null;
  }
}

export type ServeLockHolder = {
  // The pid the holder wrote, or null when the file names none yet.
  pid: number | null;
  // The port it recorded, or null when it has recorded none.
  port: number | null;
  // Whether a process with that pid exists. The file keeps a holder's pid
  // after it exits, and the kernel may give the pid to another process.
  running: boolean;
  // Whether that pid runs in `unit`'s cgroup.
  service: boolean;
};

export function readServeLockHolder(
  path: string,
  unit: string,
  readCgroup: ReadCgroup = readProcCgroup,
): ServeLockHolder {
  let text = "";
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    // No file, or an unreadable one: no pid to name.
  }
  const record = /^(\d+)(?:\n(\d+))?$/.exec(text);
  if (record === null) return { pid: null, port: null, running: false, service: false };
  const pid = Number(record[1]);
  const port = record[2] === undefined ? null : Number(record[2]);
  const cgroup = readCgroup(pid);
  const service = (cgroup ?? "").split("\n").some((line) => line.trimEnd().endsWith(`/${unit}`));
  return { pid, port, running: cgroup !== null, service };
}

// The parenthetical a lock loser's line ends with: `pid 4182, maxprice.service`.
export function describeHolder(holder: ServeLockHolder, unit: string): string {
  return `pid ${holder.pid ?? "unknown"}${holder.service ? `, ${unit}` : ""}`;
}

// Takes the lock at `path`, or says who holds it or why flock failed; the
// product turns those into its exits. An open error throws.
export function takeServeLock(
  path: string,
  unit: string,
  readCgroup: ReadCgroup = readProcCgroup,
  inspect?: (fd: number) => void,
): ServeLockTake {
  // O_RDWR | O_CREAT, never "w": truncating before the lock is taken would
  // erase a running holder's pid.
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  const errno = tryLockExclusive(fd);
  if (errno !== 0) {
    closeSync(fd);
    if (errno === os.errno.EWOULDBLOCK) {
      return { kind: "held", holder: readServeLockHolder(path, unit, readCgroup) };
    }
    return { kind: "failed", errno };
  }
  try {
    // A caller that must preserve external inputs inspects the descriptor
    // actually locked, before the first record write. A refusal releases it.
    inspect?.(fd);
    ftruncateSync(fd, 0);
    writeSync(fd, `${process.pid}\n`, 0);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return {
    kind: "taken",
    lock: {
      path,
      // Written over the pid, which it begins with, and only then cut to its
      // length, so a reader never finds the file empty while the daemon runs.
      recordPort: (port) => {
        const text = `${process.pid}\n${port}\n`;
        writeSync(fd, text, 0);
        ftruncateSync(fd, Buffer.byteLength(text));
      },
      release: () => closeSync(fd),
    },
  };
}
