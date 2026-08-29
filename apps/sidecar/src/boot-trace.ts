// Boot phase trace (issue #183): what the post-LISTENING fan-out is doing, and
// when it stopped doing it.
//
// #183 reports a freshly built sidecar binary completing its ADR-0002
// handshake in ~100 ms, holding the port, and then answering nothing for
// minutes at 0% CPU — once per binary, recovering on its own. Finding E pins
// the block to +2.5–3.0 s after `LISTENING`, which puts it inside the
// post-handshake fan-out and nowhere near exec or `Bun.serve`. "Inside the
// fan-out" is as far as the shipped logs can go, because every phase there is
// `void`ed and none of them says anything at all until it finishes.
//
// The decisive artifact is NOT a duration. A synchronous block inside phase A
// inflates B's duration too — B was merely awaiting IO across it — so
// durations alone cannot separate a blocker from a victim. What can is a
// heartbeat: a timer cannot fire mid-block any more than the saturation
// sampler's can, so a GAP in the tick sequence *is* the block, and the tick
// before the gap names every phase that was in flight when the loop stopped.
// That is why this ticks, and why each tick prints the in-flight SET rather
// than a count.
//
// Monotonic throughout, for ADR-0056's reason (issue #183, Finding A): on a
// wall clock a suspended machine writes a phantom stall into this log too, and
// a forensic reader has no way to tell it from the real one.
//
// Lines go to stdout, which both Tauri shells tee into `<app-data>/logs`
// (ADR-0056) — the whole point being that a packaged Windows GUI build has no
// console, so the next occurrence leaves a record instead of a memory.

export type BootTraceDeps = {
  monoImpl?: () => number;
  log?: (line: string) => void;
  tickMs?: number;
  maxTicks?: number;
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
};

export type BootTrace = {
  // Wraps one fan-out phase. Returns a promise that settles exactly as `work`
  // does — including rejecting with the same error — so tracking a phase can
  // never change what the caller sees, and an unhandled rejection stays
  // unhandled (index.ts exits on those, deliberately).
  track: <T>(name: string, work: Promise<T>) => Promise<T>;
  // Sub-phase progress, shown inline in the tick line: `scan(412/1253 files)`.
  // Silently ignored for a phase that has already settled.
  detail: (name: string, detail: string) => void;
  // Every phase is registered; start ticking. Separate from `track` because a
  // phase settling before its siblings are registered would otherwise look
  // like the whole fan-out finishing.
  seal: () => void;
  stop: () => void;
};

// A normal boot's fan-out is ~3 s (the fully cold whole-corpus re-parse
// measured for ADR-0059 was 3.4 s on 1253 files / 650 MB), so at 2 s a healthy
// launch costs one or two lines and a stalled one still resolves the gap to
// within a couple of seconds.
export const BOOT_TRACE_TICK_MS = 2_000;
// Five minutes covers #183's whole reported range with room to spare. Past
// that the log holds everything a reader could want and further ticks only
// push it toward rotation.
export const BOOT_TRACE_MAX_TICKS = 150;

export function createBootTrace(deps?: BootTraceDeps): BootTrace {
  const mono = deps?.monoImpl ?? (() => performance.now());
  const log = deps?.log ?? ((line: string) => console.log(line));
  const tickMs = deps?.tickMs ?? BOOT_TRACE_TICK_MS;
  const maxTicks = deps?.maxTicks ?? BOOT_TRACE_MAX_TICKS;
  const setIntervalImpl =
    deps?.setIntervalImpl ?? ((cb: () => void, ms: number): unknown => setInterval(cb, ms));
  const clearIntervalImpl =
    deps?.clearIntervalImpl ??
    ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>));

  const startedAt = mono();
  const inFlight = new Map<string, { at: number; detail: string | null }>();
  let sealed = false;
  let timer: unknown = null;
  let ticks = 0;

  const since = (): number => Math.round(mono() - startedAt);

  const stop = (): void => {
    if (timer === null) return;
    clearIntervalImpl(timer);
    timer = null;
  };

  const pending = (): string =>
    [...inFlight.entries()]
      .map(([name, entry]) => (entry.detail === null ? name : `${name}(${entry.detail})`))
      .join(", ");

  const settle = (name: string, outcome: string): void => {
    const entry = inFlight.get(name);
    if (entry === undefined) return;
    inFlight.delete(name);
    const now = mono();
    log(
      `[boot] ${name} ${outcome} at +${Math.round(now - startedAt)}ms ` +
        `(took ${Math.round(now - entry.at)}ms)`,
    );
    if (sealed && inFlight.size === 0) {
      stop();
      log(`[boot] fan-out complete at +${since()}ms`);
    }
  };

  return {
    track: <T>(name: string, work: Promise<T>): Promise<T> => {
      inFlight.set(name, { at: mono(), detail: null });
      return work.then(
        (value) => {
          settle(name, "settled");
          return value;
        },
        (err: unknown) => {
          settle(name, `FAILED (${String(err)})`);
          throw err;
        },
      );
    },

    detail: (name, detail) => {
      const entry = inFlight.get(name);
      if (entry !== undefined) entry.detail = detail;
    },

    seal: () => {
      sealed = true;
      if (inFlight.size === 0) {
        log(`[boot] fan-out complete at +${since()}ms`);
        return;
      }
      timer = setIntervalImpl(() => {
        ticks += 1;
        if (ticks > maxTicks) {
          stop();
          log(`[boot] +${since()}ms giving up the watch, still in flight: ${pending()}`);
          return;
        }
        log(`[boot] +${since()}ms in flight: ${pending()}`);
      }, tickMs);
    },

    stop,
  };
}
