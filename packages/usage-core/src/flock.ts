// The headless products' shared non-blocking flock(2) binding,
// tryLockExclusive. It takes self-update.ts's lock on the binary's directory
// (ADR-0123 §4), serve-lock.ts's one daemon per data dir (ADR-0120 §3,
// ADR-0127 §3) and the Headless client's `settings.lock` (ADR-0122 §2), each
// through this module rather than a copy of its own. tryLockShared asks
// whether a Hub holds a backup's serve.lock, for `maxprice-hub restore`
// (ADR-0130 §5). One
// binding keeps two things in one place: the libc soname rule, which is
// parent-watchdog.ts's LIBC, and reading errno immediately after the call.
//
// Reachable only via the "./flock" subpath, never index.ts, so the sidecar's
// graph does not carry it.

import { dlopen, FFIType, read, type Pointer } from "bun:ffi";
import { constants } from "node:os";

import { LIBC } from "./parent-watchdog";

const LOCK_SH = 1;
const LOCK_EX = 2;
const LOCK_NB = 4;

// errno is per thread: read straight after the call, from glibc's
// __errno_location (macOS's __error).
const ERRNO_LOCATION = process.platform === "linux" ? "__errno_location" : "__error";

function tryLock(fd: number, operation: number): number {
  const libc = dlopen(LIBC, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [ERRNO_LOCATION]: { args: [], returns: FFIType.ptr },
  });
  if (libc.symbols.flock(fd, operation | LOCK_NB) === 0) return 0;
  return read.i32(libc.symbols[ERRNO_LOCATION]!() as Pointer, 0);
}

/**
 * flock(fd, LOCK_EX | LOCK_NB): 0 when the lock is taken, otherwise the
 * call's errno, EWOULDBLOCK while another open file description holds it.
 * Never waits. Throws where there is no libc to open, as on win32.
 */
export function tryLockExclusive(fd: number): number {
  return tryLock(fd, LOCK_EX);
}

/**
 * flock(fd, LOCK_SH | LOCK_NB), as tryLockExclusive: EWOULDBLOCK while
 * another open file description holds the lock exclusively. The lock a
 * read-only descriptor can take everywhere: NFS emulates flock with fcntl,
 * which refuses an exclusive lock on one with EBADF.
 */
export function tryLockShared(fd: number): number {
  return tryLock(fd, LOCK_SH);
}

// An errno as its name, for a failed lock's message: "EACCES", or
// "errno <n>" for one node does not name.
export function errnoName(errno: number): string {
  const entry = Object.entries(constants.errno).find(([, value]) => value === errno);
  return entry === undefined ? `errno ${errno}` : entry[0];
}
