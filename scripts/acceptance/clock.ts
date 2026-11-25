// The acceptance harness's shared clock origin (#296).
//
// Two sidecars started seconds apart must agree on "now", or every response that
// reads the wall clock (`span=today`, the 30-day intraday span) differs by luck
// rather than by code (review focus 2). So a harness run mints ONE
// origin — a real instant paired with the fake instant it stands for — and hands
// the same env value to every process it spawns. `clock-preload.ts` turns that
// value into one fixed offset applied to every `Date` reading, so time still
// flows in each process, from the same fake start.
//
// Frozen (#350, opt-in). The real-renderer rig fixes its page's clock at one
// instant (`page.clock.setFixedTime`), so its sidecars must read that instant
// and no other for the whole run: an origin from `frozenClock` makes every
// "now" in the process read `fakeMs` exactly, forever. Its env value carries a
// `:frozen` suffix; every origin `clockOrigin` makes, and so every #296, #348
// and #349 harness, writes and reads exactly the value it always did.
// What a frozen sidecar gives up is listed where it is used
// (scripts/acceptance/renderer/sides.ts).

export const ACCEPTANCE_CLOCK_ENV = "MAXPRICE_ACCEPTANCE_CLOCK";

/**
 * The step the shifted clock advances in. A shared origin makes two processes'
 * clocks agree, but a request still reaches the two sides a few milliseconds
 * apart, and a body built from the request instant at millisecond resolution
 * (`/api/intraday?span=30d` aligns its buckets to `now - 30d`) then differs by
 * the skew alone: the first `--self` run showed exactly that. Stepping in whole
 * seconds from the origin makes both sides read the same instant unless the pair
 * straddles a step, which the CLI's re-fetch of a differing pair absorbs. A
 * reading within CLOCK_SKEW_GUARD_MS of a step boundary counts as straddling.
 */
export const CLOCK_STEP_MS = 1000;

/**
 * How far a spawned process's clock may read from the harness's own (#393). The
 * straddle proof assumes the server's reading lies between the harness's send
 * and receive, but the processes read separate clocks: a bare probe on Windows
 * saw a `bun` child read up to 18 ms before its parent's send. So a request sent
 * just after a step boundary can be read in the previous step while all four
 * bracket readings sit on the new one. `pairStraddlesStep` widens each bracket by
 * this much on both sides: comfortably above the 18 ms seen, and small enough
 * that a pair read mid-step is still never fetched again.
 */
export const CLOCK_SKEW_GUARD_MS = 50;

export interface ClockOrigin {
  readonly realMs: number;
  readonly fakeMs: number;
  /** Opt-in: every "now" reads `fakeMs` exactly. Absent, time steps from the origin. */
  readonly frozen?: true;
}

/** Pair `realMs` (default: now) with the instant `fakeIso` names. */
export function clockOrigin(fakeIso: string, realMs: number = Date.now()): ClockOrigin {
  const fakeMs = Date.parse(fakeIso);
  if (!Number.isFinite(fakeMs)) throw new Error(`clockOrigin: not an ISO instant: ${fakeIso}`);
  return { realMs, fakeMs };
}

/** A frozen origin: every process holding it reads the instant `fakeIso` names, always. */
export function frozenClock(fakeIso: string, realMs: number = Date.now()): ClockOrigin {
  return { ...clockOrigin(fakeIso, realMs), frozen: true };
}

/** The origin's fake instant as an ISO string: what a frozen process reads as "now". */
export function clockInstant(origin: ClockOrigin): string {
  return new Date(origin.fakeMs).toISOString();
}

/**
 * The one env entry every spawned process reads: `<realMs>:<fakeMs>`, or
 * `<realMs>:<fakeMs>:frozen` for a frozen origin.
 */
export function clockEnv(origin: ClockOrigin): Record<string, string> {
  const value = `${origin.realMs}:${origin.fakeMs}`;
  return { [ACCEPTANCE_CLOCK_ENV]: origin.frozen === true ? `${value}:frozen` : value };
}

/**
 * Which whole step from the origin a real instant falls in. The preload's shifted
 * "now" is `fakeMs + stepIndex(origin, realNow) * CLOCK_STEP_MS`, so two readings
 * with one index are one instant, in any process holding the same origin.
 */
export function stepIndex(origin: ClockOrigin, realMs: number): number {
  return Math.floor((realMs - origin.realMs) / CLOCK_STEP_MS);
}

/**
 * The harness's own real clock (`Date.now()`, not shifted) read just before a
 * fetch is sent and just after its body arrives. The server read its clock
 * within CLOCK_SKEW_GUARD_MS of this window.
 */
export interface FetchBracket {
  readonly sentMs: number;
  readonly receivedMs: number;
}

/**
 * Whether a baseline/candidate pair may have read two instants. Each server reads
 * its clock within CLOCK_SKEW_GUARD_MS of its own fetch's send..receive window,
 * so each bracket is widened by that margin, `sentMs` earlier and `receivedMs`
 * later, before it is indexed. When all four widened readings share one step,
 * both servers provably read the same instant and a difference between them is
 * real. A pair with a reading in another step, or within the margin of a step
 * boundary, returns true, and only such a pair may be fetched again.
 */
export function pairStraddlesStep(
  origin: ClockOrigin,
  baseline: FetchBracket,
  candidate: FetchBracket,
): boolean {
  const widened = [baseline, candidate].flatMap((bracket) => [
    stepIndex(origin, bracket.sentMs - CLOCK_SKEW_GUARD_MS),
    stepIndex(origin, bracket.receivedMs + CLOCK_SKEW_GUARD_MS),
  ]);
  return widened.some((step) => step !== widened[0]);
}

/** The origin `clockEnv` wrote, or null for anything else. */
export function parseClockEnv(value: string | undefined): ClockOrigin | null {
  if (value === undefined) return null;
  const match = /^(-?\d+):(-?\d+)(:frozen)?$/.exec(value);
  if (match === null) return null;
  const realMs = Number(match[1]);
  const fakeMs = Number(match[2]);
  if (!Number.isSafeInteger(realMs) || !Number.isSafeInteger(fakeMs)) return null;
  return match[3] === undefined ? { realMs, fakeMs } : { realMs, fakeMs, frozen: true };
}
