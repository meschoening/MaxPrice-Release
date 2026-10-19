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

import { msSinceMidnightOf, tzClockParts, tzOffsetMs } from "@maxprice/shared";

// `zonedInstant` (wall clock → instant) now lives beside `tzClockParts` in
// `packages/shared/src/tz-clock.ts`, where the renderer can reach it too. It is
// re-exported here so the engine's callers keep one local-date import.
export { zonedInstant } from "@maxprice/shared";

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
//
// THE RULE that unboundedness rests on: **every caller of the memoized
// `localDate` must pass an immutable corpus timestamp** — a stored
// `UsageRecord.timestamp` or a derived block boundary — never a wall-clock
// reading. A caller passing `Date.now()` mints one distinct key per call, and
// against a long-lived poller (the ADR-0079 tray's 60s `/api/readout` poll)
// that grows an inner map forever: ≥1440 permanently-retained entries a day for
// a process the tray keeps alive indefinitely. Synthetic / wall-clock instants
// go through `localDateUncached` below instead, which is byte-identical and
// simply does not write to the memo.
const MAX_ZONES = 4;
const zoneCaches = new Map<string, Map<string, LocalDate | null>>();
// The zone `zoneCacheFor` last returned, always `zoneCaches`'s last key. A
// request folds every event in its one `tz`, so nearly every read is a hit on
// this zone and returns without touching `zoneCaches` (#382).
let mostRecent: { zone: string; cache: Map<string, LocalDate | null> } | null = null;

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
  mostRecent = null;
}

// Test-only: the zone map itself, so local-date.test.ts can hold an iterator
// over it and see whether a read mints storage (#382).
export function localDateZoneMapForTest(): ReadonlyMap<string, unknown> {
  return zoneCaches;
}

function zoneCacheFor(timeZone: string): Map<string, LocalDate | null> {
  // The most recent zone is already last in the eviction order, so its hit
  // leaves the map alone. Touching it anyway (delete+set) left a deleted slot
  // per read and rehashed `zoneCaches` into a new storage every few reads, and
  // JSC links each outgrown storage to its successor: one reference to an old
  // storage held inside the engine kept every later one alive, 7,036 MiB of
  // 320-byte storages in one of #382's ten-minute budget runs (ADR-0110 §4).
  if (mostRecent?.zone === timeZone) return mostRecent.cache;
  let m = zoneCaches.get(timeZone);
  if (m !== undefined) {
    // LRU touch: re-insertion moves the zone to the back of the eviction order.
    zoneCaches.delete(timeZone);
    zoneCaches.set(timeZone, m);
  } else {
    m = new Map();
    if (zoneCaches.size >= MAX_ZONES) {
      const oldest = zoneCaches.keys().next().value;
      if (oldest !== undefined) zoneCaches.delete(oldest);
    }
    zoneCaches.set(timeZone, m);
  }
  mostRecent = { zone: timeZone, cache: m };
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

  const result = localDateUncached(timestamp, timeZone);
  zoneCache.set(timestamp, result);
  return result;
}

// The same computation as `localDate`, with no memo write — THE entry point for
// a synthetic or wall-clock instant (`deps.now()`, a request's "right now").
// Byte-identical results; the only difference is that it leaves no key behind,
// which is what keeps the memo's unbounded per-zone maps keyed by the corpus
// rather than by request volume (see the STRUCTURE note above).
//
// `timestamp` accepts `string | number | Date` for the same reason `localClock`
// does: the body's `new Date(...)` handles all three identically, so an epoch-ms
// caller can skip a `new Date(now).toISOString()` round-trip this would only
// re-parse.
export function localDateUncached(
  timestamp: string | number | Date,
  timeZone: string,
): LocalDate | null {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  const dashed = formatterFor(timeZone).format(d);
  return { dashed, ymd: dashed.replaceAll("-", "") };
}

// ---------------------------------------------------------------------------
// Wall-clock helpers for the `today` calendar-day intraday span (ADR-0020).
//
// `today` is anchored to LOCAL MIDNIGHT in the request `tz` and bins events by
// their tz-local time-of-day, so the chart's bars reconcile penny-exactly with
// `/api/daily`'s today row (the Today tile). That needs three things the
// `localDate` form above doesn't give: an instant's local time-of-day, the
// previous calendar date, and the UTC instant of a given local wall-clock time
// (for the bucket `bucketStart` labels). All are DST-correct via `Intl`. An
// event's time-of-day comes from `wallClockReader` at the end of this file,
// which reads `Intl` per request rather than per event (ADR-0115).
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

// ---------------------------------------------------------------------------
// `localClock` by arithmetic, for one request's span of instants (ADR-0115).
//
// The `today` classifier needs every event's wall clock, and `localClock` costs
// an `Intl.formatToParts` call and its parts objects per event. A zone's offset
// is constant between transitions, so the reader below reads the offsets from
// `Intl` once across the span and answers each instant with an addition. It is
// built per request and dropped with it: nothing outlives the request, and no
// memo grows with the corpus (ADR-0110).
//
// The answer is a WALL-MS: the epoch-ms the instant's local Y/M/D h:m:s would
// have in UTC, which is what `tzOffsetMs` subtracts the instant from. Its UTC
// date is `localClock`'s `ymd`, and its distance from that date's UTC midnight
// is `localClock`'s `msSinceMidnight`. Like `localClock`, it drops sub-seconds.
// ---------------------------------------------------------------------------

// The reader probes the offset at least this often and assumes it did not change
// between two probes that read the same offset. A zone would have to change its
// offset and change it back within six hours to break that; none in the
// time-zone database does (the shortest run of one offset across every zone in
// 2025-2028 is 35 days, Casablanca's Ramadan suspension).
const OFFSET_PROBE_STEP_MS = 6 * 3_600_000;

// A reader of `timeZone`'s wall clock for every instant in `[fromMs, toMs)`:
// `read(ms)` is the instant's wall-ms, `NaN` outside the span. Building it reads
// `Intl` once per six hours of span plus a bisection of at most 15 reads per
// offset transition; a read reads none and allocates nothing.
//
// The bisection finds each transition to the whole second, which is exact:
// offsets and transitions are whole seconds in the time-zone database, so an
// instant's offset is its whole second's.
export function wallClockReader(
  fromMs: number,
  toMs: number,
  timeZone: string,
): (ms: number) => number {
  const first = Math.floor(fromMs / 1000) * 1000;
  // The whole second holding the span's last instant.
  const last = Math.floor((toMs - 1) / 1000) * 1000;
  // Run `i` of one offset starts at whole second `runStarts[i]` and keeps
  // `runOffsets[i]` until the next run starts.
  const runStarts = [first];
  const runOffsets = [tzOffsetMs(first, timeZone)];

  // `offA` is the offset at second `a` and `offB` at second `b`, and they
  // differ: add a run at every transition in `(a, b]`, in order.
  const addTransitions = (a: number, offA: number, b: number, offB: number): void => {
    if (b - a <= 1000) {
      runStarts.push(b);
      runOffsets.push(offB);
      return;
    }
    const mid = a + Math.floor((b - a) / 2000) * 1000;
    const offMid = tzOffsetMs(mid, timeZone);
    if (offMid !== offA) addTransitions(a, offA, mid, offMid);
    if (offMid !== offB) addTransitions(mid, offMid, b, offB);
  };

  let a = first;
  let offA = runOffsets[0] as number;
  while (a < last) {
    const b = Math.min(a + OFFSET_PROBE_STEP_MS, last);
    const offB = tzOffsetMs(b, timeZone);
    if (offB !== offA) addTransitions(a, offA, b, offB);
    a = b;
    offA = offB;
  }

  return (ms: number): number => {
    if (!(ms >= fromMs && ms < toMs)) return NaN;
    const second = Math.floor(ms / 1000) * 1000;
    let i = runStarts.length - 1;
    while (second < (runStarts[i] as number)) i -= 1;
    return second + (runOffsets[i] as number);
  };
}

// The wall-ms of local midnight on `ymd` (dashless `YYYYMMDD`): the calendar
// date's midnight in UTC, since a wall-ms reads the wall clock as UTC.
export function wallMidnightMs(ymd: string): number {
  return Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
}
