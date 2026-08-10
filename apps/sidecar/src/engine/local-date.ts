// Part 6 — local-timezone day grouping, now zone-explicit (ADR-0015).
//
// Through Part 5 this read the *process* timezone via `Date.getFullYear()`
// etc. Part 6 makes the IANA zone an explicit argument: every aggregator and
// the store filter pass the request's `tz`, so the engine buckets into the
// user's chosen Timezone setting rather than the sidecar's runtime zone.
//
// Every report groups by *local* calendar day, and the golden matrix
// is captured under `TZ=America/Chicago`; the engine tests pass
// `timeZone: "America/Chicago"` explicitly so that bucketing reproduces on any
// machine. A midnight-straddling event lands on whichever local date the
// requested zone puts it on — that conversion is correctness-load-bearing and
// lives here once so the store (E4) and all four aggregators (E5–E8) derive
// day grouping from a single function.

import { msSinceMidnightOf, tzClockParts } from "@maxprice/shared";

// One ISO timestamp's local-timezone calendar date, in both the forms the
// engine needs:
//   - `ymd`    — dashless `YYYYMMDD`, for the store's lexical `--since` /
//                `--until` bound comparison.
//   - `dashed` — `YYYY-MM-DD`, the wire `date` field every report row carries.
export type LocalDate = {
  ymd: string; // dashless YYYYMMDD — store since/until comparison
  dashed: string; // YYYY-MM-DD — the wire `date` field
};

// One Intl.DateTimeFormat per zone. `en-CA` renders as YYYY-MM-DD.
//
// Left unbounded by design (f14): this cache (like the shared wall-clock
// formatter cache in `tz-clock.ts`) is keyed by zone ONLY, and an invalid zone
// throws in the `Intl.DateTimeFormat` constructor rather than landing here, so
// it can only ever hold the finite set of valid IANA zones (~600). That is a
// fixed ceiling independent of the corpus or request volume — no FIFO cap
// needed, unlike `zoneCaches` below which also keys on the per-event timestamp.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

// Whether a timestamp parses at all — timezone-independent. Used by callers
// (e.g. session-events) that only need the malformed-timestamp drop, not the
// calendar date.
export function isParseableTimestamp(timestamp: string): boolean {
  return !Number.isNaN(new Date(timestamp).getTime());
}

// Memoize the full (timeZone, timestamp) → LocalDate resolution, keyed by zone
// FIRST. `localDate` is called for the same stored event repeatedly within a
// request and across the reports; stored-event timestamps are immutable and the
// function is purely deterministic, so a cached value is byte-identical to a
// fresh computation.
//
// STRUCTURE (supersedes the old single 50k-entry FIFO — see below): an outer
// zone → (timestamp → LocalDate|null) map, LRU-capped at MAX_ZONES zones; each
// inner map is UNBOUNDED. The old flat FIFO had a cliff: a sequential fold over
// more distinct timestamps than the cap has a 100% miss rate forever (each miss
// evicts the entry the next lap is about to need), so once the corpus crossed
// 50k events every all-time fold paid full Date+Intl per event (~19µs — a
// measured 39x per-event cliff, issue #113). Timestamps are the user's own
// corpus — not attacker-inflatable — so the inner maps may track corpus size;
// `tz` IS an attacker-controllable query param (ADR-0015), so the zone COUNT is
// the capped axis: an adversary cycling zones evicts whole zone maps and the
// worst-case footprint is MAX_ZONES corpus-sized maps. Eviction only ever
// trades CPU for memory — a re-miss recomputes byte-identically.
const MAX_ZONES = 4;
const zoneCaches = new Map<string, Map<string, LocalDate | null>>();

// Test-only visibility (used by local-date.test.ts): how many zones / total
// entries the memo currently holds. Not for shipping-code use.
export function localDateCacheStats(): { zones: number; entries: number } {
  let entries = 0;
  for (const m of zoneCaches.values()) entries += m.size;
  return { zones: zoneCaches.size, entries };
}

// Test-only: drop every cached zone so a test starts from a cold memo.
export function resetLocalDateCacheForTest(): void {
  zoneCaches.clear();
}

function zoneCacheFor(timeZone: string): Map<string, LocalDate | null> {
  let m = zoneCaches.get(timeZone);
  if (m !== undefined) {
    // LRU touch: re-insertion moves the zone to the back of the eviction order.
    zoneCaches.delete(timeZone);
    zoneCaches.set(timeZone, m);
    return m;
  }
  m = new Map();
  if (zoneCaches.size >= MAX_ZONES) {
    const oldest = zoneCaches.keys().next().value;
    if (oldest !== undefined) zoneCaches.delete(oldest);
  }
  zoneCaches.set(timeZone, m);
  return m;
}

// The event's local calendar date in `timeZone`. `null` for an unparseable
// timestamp — callers fail such an event safe (excluded from date-filtered
// queries; dropped by aggregators). `UsageRecord.timestamp` is schema-validated
// as a non-empty string but not as a parseable date, so a malformed value is
// possible-if-rare; "an unparseable timestamp never reaches the wire" stays an
// invariant because every caller drops a `null` result.
export function localDate(timestamp: string, timeZone: string): LocalDate | null {
  const zoneCache = zoneCacheFor(timeZone);
  // `Map.get` returns `undefined` for an absent key but the stored value `null`
  // for a previously-cached unparseable timestamp, so `!== undefined` reads a
  // cached `null` as a hit rather than recomputing it.
  const cached = zoneCache.get(timestamp);
  if (cached !== undefined) return cached;

  const d = new Date(timestamp);
  let result: LocalDate | null;
  if (Number.isNaN(d.getTime())) {
    result = null;
  } else {
    const dashed = formatterFor(timeZone).format(d);
    result = { dashed, ymd: dashed.replaceAll("-", "") };
  }
  zoneCache.set(timestamp, result);
  return result;
}

// ---------------------------------------------------------------------------
// Wall-clock helpers for the `today` calendar-day intraday span (ADR-0020).
//
// `today` is anchored to LOCAL MIDNIGHT in the request `tz` and bins events by
// their tz-local time-of-day, so the chart's bars reconcile penny-exactly with
// `/api/daily`'s today row (the Today tile). That needs three things the
// `localDate` form above doesn't give: an event's local time-of-day, the
// previous calendar date, and the UTC instant of a given local wall-clock time
// (for the bucket `bucketStart` labels). All are DST-correct via `Intl`.
// ---------------------------------------------------------------------------

// The full Y/M/D H:M:S wall-clock read comes from the shared `tzClockParts`
// primitive (`packages/shared/src/tz-clock.ts`) — one per-zone-cached
// `en-GB`/`h23` formatter shared with the renderer's `msSinceLocalMidnight`, so
// the two sides can't drift. `hourCycle: "h23"` keeps midnight as hour 0 (never
// "24"), so the parts are a clean 0–23 hour.

const pad2 = (n: number): string => String(n).padStart(2, "0");
const pad4 = (n: number): string => String(n).padStart(4, "0");

// An instant's local calendar date (dashless `YYYYMMDD`) and milliseconds since
// local midnight, in `timeZone`. `null` for an unparseable timestamp (same
// fail-safe contract as `localDate`). Sub-second precision is dropped — every
// `today` bucket size is ≥ 1 minute, so it never changes a bucket assignment.
//
// `timestamp` accepts `string | number | Date` (f21): the body's `new Date(...)`
// already handles all three identically, and the additive widening lets the
// numeric caller (`aggregateToday`'s `now` epoch-ms) skip a wasteful
// `new Date(now).toISOString()` round-trip that this function would only
// re-parse. String behavior is unchanged.
export function localClock(
  timestamp: string | number | Date,
  timeZone: string,
): { ymd: string; msSinceMidnight: number } | null {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  const parts = tzClockParts(d, timeZone);
  return {
    ymd: `${pad4(parts.year)}${pad2(parts.month)}${pad2(parts.day)}`,
    msSinceMidnight: msSinceMidnightOf(parts),
  };
}

// The calendar date `days` away from `ymd` (dashless `YYYYMMDD`). Pure UTC
// arithmetic on the date components — DST-independent, since it never touches a
// wall-clock offset (a calendar date has no offset). `shiftYmd("20261101", -1)`
// → `"20261031"`.
export function shiftYmd(ymd: string, days: number): string {
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(4, 6));
  const day = Number(ymd.slice(6, 8));
  const d = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  return `${pad4(d.getUTCFullYear())}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

// `timeZone`'s UTC offset (ms) at `instant`: the zone's wall clock at that
// instant read as if it were UTC, minus the instant. Positive east of UTC.
function tzOffsetMs(instant: number, timeZone: string): number {
  const { year, month, day, hour, minute, second } = tzClockParts(instant, timeZone);
  return Date.UTC(year, month - 1, day, hour, minute, second) - instant;
}

// The UTC instant (epoch-ms) of local wall-clock time `ymd` (dashless) +
// `msSinceMidnight`, in `timeZone`. The canonical "zoned time → instant"
// algorithm: guess by treating the wall clock as UTC, correct by the zone's
// offset, then re-check once for a DST transition straddle. Used to label each
// `today` bucket's `bucketStart` with the correct local hour even across a
// spring-forward / fall-back boundary.
export function zonedInstant(ymd: string, msSinceMidnight: number, timeZone: string): number {
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(4, 6));
  const day = Number(ymd.slice(6, 8));
  const wallAsUtc = Date.UTC(year, month - 1, day) + msSinceMidnight;
  const off1 = tzOffsetMs(wallAsUtc, timeZone);
  let instant = wallAsUtc - off1;
  const off2 = tzOffsetMs(instant, timeZone);
  if (off2 !== off1) instant = wallAsUtc - off2;
  return instant;
}
