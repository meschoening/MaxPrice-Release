// Single source of truth for tz-local WALL-CLOCK reads.
//
// Both the engine (`apps/sidecar/src/engine/local-date.ts` `localClock`, used by
// `aggregateToday`) and the renderer (`apps/desktop/src/lib/dates.ts`
// `msSinceLocalMidnight`, driving the adaptive `today`-line granularity, ADR-0022)
// need the SAME quantity: an instant's Y/M/D H:M:S wall clock in a given IANA
// zone. They used to compute it two different ways — the engine via a
// per-zone-cached `en-GB`/`h23` formatter, the renderer via a freshly
// reconstructed `hour12:false` formatter plus a manual `% 24` midnight fold. This
// module unifies them on ONE formatter/parts primitive so the two sides can never
// drift, and caches the formatter per zone (mirroring the engine's former
// `clockFormatterCache`) so the renderer no longer rebuilds it every render.
//
// `hourCycle: "h23"` keeps midnight as hour 0 (never "24" or "12"), so the hour
// part is already a clean 0–23 — the renderer's old `% 24` fold becomes a no-op
// and is dropped.

export type TzClockParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

// One Intl.DateTimeFormat per zone, cached at module scope. The `undefined` key
// is the host zone: the renderer's `msSinceLocalMidnight` passes its optional
// `tz` straight through, and an omitted `tz` must resolve to the runtime zone
// (matching `ymdShift`'s omitted-tz path). Keyed by zone ONLY, so the cache can
// only ever hold the finite set of valid IANA zones (~600) plus the one host
// entry — a fixed ceiling, no cap needed (an invalid zone throws in the
// `Intl.DateTimeFormat` constructor rather than landing here).
const clockFormatterCache = new Map<string | undefined, Intl.DateTimeFormat>();

function clockFormatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  let f = clockFormatterCache.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    clockFormatterCache.set(timeZone, f);
  }
  return f;
}

// An instant's tz-local wall-clock components. `instant` accepts the union both
// callers need: epoch-ms (renderer `now`, engine `aggregateToday`'s `now`), an
// ISO string, or a Date (engine `localClock` / `tzOffsetMs`). `timeZone`
// `undefined` resolves to the host zone.
export function tzClockParts(
  instant: number | string | Date,
  timeZone: string | undefined,
): TzClockParts {
  // Hot path: `aggregateToday` calls this once per event. Iterate `formatToParts`
  // ONCE into a typed lookup instead of running six separate linear `find` scans.
  const parts = clockFormatterFor(timeZone).formatToParts(new Date(instant));
  const lookup: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const p of parts) lookup[p.type] = p.value;
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

// Milliseconds since local midnight for a parts triple. Sub-second precision is
// dropped (whole-second wall-clock resolution) — every consumer bins at ≥ 1-minute
// granularity, so it never changes a bucket assignment.
export function msSinceMidnightOf(parts: TzClockParts): number {
  return ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000;
}
