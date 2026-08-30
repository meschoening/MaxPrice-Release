import { z } from "zod";
import { tzClockParts, zonedInstant } from "./tz-clock";

// The Week (CONTEXT.md; ADR-0083): what "this week" means app-wide.
export const WEEK_MS = 7 * 86_400_000;
export const weekModeSchema = z.enum(["rolling", "limitReset", "custom"]);
export type WeekMode = z.infer<typeof weekModeSchema>;

export const weekSettingSchema = z.object({
  mode: weekModeSchema.default("rolling").catch("rolling"),
  // 0 = Sunday … 6 = Saturday (JS `getDay` numbering). Persisted even while
  // mode ≠ custom so switching back remembers the choice.
  weekday: z.number().int().min(0).max(6).default(1).catch(1),
  // Wall-clock "HH:MM" in the Settings timezone, minute precision.
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default("00:00")
    .catch("00:00"),
});
export type WeekSetting = z.infer<typeof weekSettingSchema>;
export const DEFAULT_WEEK: WeekSetting = { mode: "rolling", weekday: 1, time: "00:00" };

export type WeekWindow =
  | { kind: "rolling"; fallback: boolean } // fallback=true ⇒ limitReset had no reading
  | { kind: "anchored"; mode: "limitReset" | "custom"; startMs: number; prevStartMs: number };

const ROLLING: WeekWindow = { kind: "rolling", fallback: false };
const FALLBACK: WeekWindow = { kind: "rolling", fallback: true };

// The ONLY resolver (ADR-0083 decision 2). Pure: every input is explicit —
// `now` and the timezone are arguments, never read from the environment, so a
// caller can resolve any week at any instant and the tests need no clock stub.
export function resolveWeekWindow(
  setting: WeekSetting,
  weeklyResetAt: string | null, // sample.weekly.resetAt, or null when there is no sample
  now: number,
  tz: string | undefined, // Settings timezone; undefined = host zone
): WeekWindow {
  switch (setting.mode) {
    case "rolling":
      return ROLLING;
    case "limitReset": {
      if (weeklyResetAt === null) return FALLBACK;
      let reset = Date.parse(weeklyResetAt);
      if (Number.isNaN(reset)) return FALLBACK;
      // A stale reading (the app was closed across a reset) rolls forward by
      // whole weeks: the weekly cadence is exactly 7 days (decision 5).
      while (reset <= now) reset += WEEK_MS;
      // A reset more than a week ahead cannot bound a week containing `now`.
      if (reset - WEEK_MS > now) return FALLBACK;
      return {
        kind: "anchored",
        mode: "limitReset",
        startMs: reset - WEEK_MS,
        prevStartMs: reset - 2 * WEEK_MS,
      };
    }
    case "custom": {
      const startMs = lastOccurrence(setting.weekday, setting.time, now, tz);
      return { kind: "anchored", mode: "custom", startMs, prevStartMs: startMs - WEEK_MS };
    }
  }
}

// The most recent instant at or before `now` whose tz-local wall clock reads
// `weekday` @ `HH:MM`. Walks back day by day from today's local date (at most
// 7 steps) and resolves the wall clock through `zonedInstant`, so DST is
// handled the way every other wall-clock time in the app is.
function lastOccurrence(
  weekday: number,
  time: string,
  now: number,
  tz: string | undefined,
): number {
  const zone = tz ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [hh, mm] = time.split(":").map(Number);
  const msSinceMidnight = ((hh ?? 0) * 60 + (mm ?? 0)) * 60_000;
  const today = tzClockParts(now, zone);
  for (let back = 0; back <= 7; back++) {
    // UTC arithmetic on the LOCAL calendar date: a plain civil-date walk, with
    // no zone involved until `zonedInstant` resolves the candidate below.
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day - back));
    if (d.getUTCDay() !== weekday) continue;
    const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    const candidate = zonedInstant(ymd, msSinceMidnight, zone);
    if (candidate <= now) return candidate;
  }
  // Unreachable: within 8 days there is always a matching weekday whose
  // wall-clock time has passed. Kept total for the type system.
  return now;
}

// The wire form of an anchored week (ADR-0083 decision 3): an ISO instant
// `since`, open-ended (the window runs to `now`; there is no `until`).
// `null` for a rolling week — the caller keeps its YYYYMMDD path.
export function weekParamsFor(w: WeekWindow): { since: string } | null {
  if (w.kind !== "anchored") return null;
  return { since: new Date(w.startMs).toISOString() };
}
