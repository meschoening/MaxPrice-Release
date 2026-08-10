// Parent-death watchdogs, shared by BOTH binaries that must not outlive their
// spawner: the sidecar (dies with the desktop app) and the EMBEDDED hub daemon
// (dies with the tray shell — ADR-0036). Headless `serve` (Linux) installs
// NEITHER — it must OUTLIVE its spawner (ADR-0035).
//
// Two mechanisms, each catching a different orphan path:
//
//   installParentWatchdog — polls the live ppid via libc getppid(2). When the
//   parent disappears ungracefully (SIGKILL, crash) the kernel reparents us to
//   init (ppid 1); we fire onOrphaned when the ppid changes or hits 1. Bun
//   caches process.ppid at startup and never updates it, so the real source of
//   truth is libc's getppid(2) — wired in libcGetppid(). bun:ffi has no
//   libc.<suffix> to dlopen on win32, so this mechanism is macOS/Linux only.
//   The watchdog is structured so tests can inject a stub getPpid().
//
//   installStdinWatchdog — watches for EOF on process.stdin (F8). When the
//   parent spawns us with a PIPED stdin, the parent's death closes the write
//   end of that pipe and Bun fires 'end' (verified on win32 — where getppid
//   isn't available, this is the ONLY watchdog). Portable across all platforms.

import { dlopen, FFIType, suffix } from "bun:ffi";

export type WatchdogOptions = {
  getPpid: () => number;
  initialPpid: number;
  intervalMs?: number;
  onOrphaned: () => void;
  // Log-prefix label so the shared module names its actual host in errors
  // (e.g. "[hub]" / "[sidecar]"). Defaults to a generic "watchdog".
  label?: string;
};

export type WatchdogHandle = {
  stop: () => void;
  tick: () => void;
};

export function installParentWatchdog(opts: WatchdogOptions): WatchdogHandle {
  const interval = opts.intervalMs ?? 1_000;
  const label = opts.label ?? "watchdog";
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    let current: number;
    try {
      current = opts.getPpid();
    } catch (err) {
      console.error(`[${label}] watchdog getPpid threw:`, err);
      stopped = true;
      opts.onOrphaned();
      return;
    }
    if (current !== opts.initialPpid || current === 1) {
      stopped = true;
      opts.onOrphaned();
    }
  };

  const timer = setInterval(tick, interval);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}

export function libcGetppid(): () => number {
  const libc = dlopen(`libc.${suffix}`, {
    getppid: { args: [], returns: FFIType.i32 },
  });
  return () => libc.symbols.getppid();
}

// The minimal stdin surface installStdinWatchdog needs — `process.stdin`
// satisfies it, and a test can pass a fake emitter (F8).
export type StdinLike = {
  resume: () => void;
  on: (event: "end" | "error", listener: () => void) => void;
};

export type StdinWatchdogOptions = {
  onOrphaned: () => void;
  // The stream to watch. Defaults to process.stdin. Injectable so tests drive a
  // fake emitter without touching the real stdin.
  stdin?: StdinLike;
};

// Fire onOrphaned once when the piped stdin reaches EOF (parent died) or errors.
// Once-guarded across both events — 'end' and a subsequent 'error' (or a repeat
// 'end') must trigger teardown exactly once.
export function installStdinWatchdog(opts: StdinWatchdogOptions): void {
  const stdin = opts.stdin ?? (process.stdin as unknown as StdinLike);
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    opts.onOrphaned();
  };
  // Put stdin into flowing mode so 'end'/'error' can fire; we never read the
  // bytes (the parent writes none — the pipe exists purely for the EOF signal).
  stdin.resume();
  stdin.on("end", fire);
  stdin.on("error", fire);
}
