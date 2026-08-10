/*!
 * THIRD-PARTY NOTICE
 *
 * Portions of this file — the RESIDUAL (heuristic) 5-hour block walk — are a
 * port of ccusage's `identifySessionBlocks`.
 * https://github.com/ryoppippi/ccusage
 *
 * This notice is a `/*!` legal comment so that it survives
 * `bun build --compile` into the shipped sidecar binary; a plain `//` comment
 * is stripped by the bundler. Keep it that way.
 *
 * MIT License
 *
 * Copyright (c) 2025 ryoppippi
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type {
  BlockRow,
  BlocksResponse,
  BurnRate,
  CostMode,
  Projection,
  TokenCounts,
  UsageSample,
} from "@maxprice/shared";
import { computeCost } from "@maxprice/shared";
import {
  FIVE_HOURS_MS,
  peakInWindow,
  precomputeSamples,
  resolveWindows,
  type ResolvedBlockSpan,
  type ResolvedWindow,
  type WindowSpan,
} from "./block-windows";
import { localDate } from "./local-date";
import { byTimestamp } from "./model-rollup";
import { defaultTimeZone } from "./timezone";
import { lowerModelNeedles, matchesLoweredModelFilter } from "./store";
import type { StoredEvent } from "./store";

// Part 4.5 — E8: the blocks aggregator. THE HEADLINE RISK.
//
// One pure function over a store query result:
//   - `aggregateBlocks` → `/api/blocks` ({ blocks: BlockRow[] })
//
// With NO usage history (the empty-samples path) it reproduces `/api/blocks`'s
// wire shape byte-for-byte against the E1 golden; with samples present,
// observed reset windows partition formation and the output deliberately
// diverges from ccusage (ADR-0028).
//
// Unlike E5–E7's calendar-keyed folds, blocks have their own algorithm —
// ccusage's 5-hour session-block model. The RESIDUAL (heuristic) walk below is
// a faithful port of ccusage's own `identifySessionBlocks` (its bundled
// `Xn`/`Zn`/`Qn`/`$n`/`er` helpers in
// `node_modules/ccusage/dist/data-loader-*.js`); the SPIKE section documents
// what the port reproduces and why.
//
// ===========================================================================
// SPIKE — ccusage's session-block algorithm, reverse-engineered from source
// ===========================================================================
//
// THE 5-HOUR WINDOW. A block spans a fixed 5-hour wall-clock window. The
// constant is `5 * 60 * 60 * 1000` ms; ccusage exposes a `sessionDurationHours`
// override but `/api/blocks` never passes one, so 5h is the only value E8
// needs.
//
// WINDOW-START FLOORING. The first event of a HEURISTIC block sets the block's
// `startTime` = that event's epoch-ms floored to the hour, IN UTC
// (`Math.floor(ms / 3600000) * 3600000`). This is a pure epoch-arithmetic
// floor — NOT a local-calendar operation — so a heuristic `startTime` is always
// `...:00:00.000Z`. `endTime` = `startTime + 5h`. `id` = `startTime` — for
// every regime (the ADR-0025 relabel quirk where `id` kept the heuristic floor
// is retired; ADR-0028). NOTE (ADR-0028/0029): resolved reset windows
// PARTITION block formation — an event inside a resolved window (the real
// `[reset−5h, reset)`, minute-rounded, truncated at its successor's start
// when an out-of-band reset annulled it) forms that window's block; only the
// residual events get this hour-floored heuristic. The date post-filter runs
// on the FINAL `startTime`, observed or heuristic (the old f3 pre-snap
// ordering note no longer applies — there is no relabel step left to order).
// `local-date.ts` does NOT apply to block FORMATION (confirmed against
// the golden: every `startTime` is a whole UTC hour regardless of the
// `TZ=America/Chicago` capture). It DOES apply to the window post-filter (see
// WINDOWING below).
//
// THE GAP RULE — two thresholds, one constant. Walking events in timestamp
// order, the current block is closed and a new one opened when EITHER:
//   (a) the event is >5h after the *current block's floored start*, OR
//   (b) the event is >5h after the *previous event* in the block.
// Both comparisons are strict `>` against the same 5h constant. When it is
// rule (b) that fired — a >5h inter-event gap — a GAP ROW is also emitted
// between the closed block and the new one. (Rule (a) alone — an event still
// within 5h of the previous event but past the block's 5h span — closes the
// block WITHOUT a gap row.)
//
// GAP ROWS. A gap row is a real row in the `blocks` array:
//   - `id`         = `gap-<prevEvent.endTime>` where `prevEvent.endTime` is the
//                    last in-block event's epoch + 5h, ISO-stringified.
//   - `startTime`  = previous event's timestamp + 5h.
//   - `endTime`    = the NEXT event's *raw* timestamp (NOT floored).
//   - `isGap: true`, `entries: 0`, all-zero `tokenCounts`, `costUSD: 0`,
//     `models: []`, `actualEndTime: null`, `isActive: false`,
//     `burnRate: null`, `projection: null`.
// A gap row is only emitted when `next - prev > 5h` (the same strict `>`).
//
// `actualEndTime`. On a real (non-gap) block, `actualEndTime` = the LAST
// in-block event's raw timestamp. The golden's single-event blocks prove it:
// `actualEndTime` == that event's timestamp, not the floored `startTime`.
// `null` on gap rows.
//
// PER-BLOCK AGGREGATION. `entries` = the in-block event count. `tokenCounts`
// sums the four token counts across in-block events. `models` is the set of
// distinct model strings in *first-seen* order (a `Set` over timestamp-sorted
// events). `totalTokens` = the four `tokenCounts` summed. `costUSD` = the sum
// of each event's `computeCost(model, tokenCounts, mode, costUSD)` — ccusage
// pre-computes per-event cost and the block just sums `costUSD ?? 0`, so the
// engine costs per event and sums (verified: per-event-summed cost reproduces
// every golden `costUSD`, float artifacts and all — DO NOT round).
// Under a model filter (ADR-0017), these per-block sums count only matching
// events; block formation, isActive, burnRate, and projection stay all-model.
//
// ACTIVE-BLOCK DETECTION. ccusage's `Zn` marks a block active when BOTH:
//   (a) `now - lastEvent.timestamp < 5h`  (recent activity), AND
//   (b) `now < block.endTime`             (still inside the 5h window).
// The fixture corpus is entirely historical (last event 2026-05-15), so EVERY
// golden block is `isActive: false` — the golden does not exercise this path.
// It is unit-tested separately with synthetic events near a pinned `now`.
//
// BURN RATE — present only on the active block, `null` otherwise. Over the
// block's first→last in-block event span in MINUTES (`durationMinutes`;
// `null`/`<= 0` ⇒ no burn rate):
//   - `tokensPerMinute`             = (all four tokenCounts summed) / minutes
//   - `tokensPerMinuteForIndicator` = (input + output only) / minutes
//   - `costPerHour`                 = costUSD / minutes * 60
//
// PROJECTION — present only on the active block, `null` otherwise. With
// `remainingMs = block.endTime - now`, `remainingMinutes = max(0, remainingMs
// / 60000)`:
//   - `totalTokens`     = round( currentTotalTokens + tokensPerMinute *
//                                remainingMinutes )
//   - `totalCost`       = round( (costUSD + costPerHour/60 * remainingMinutes)
//                                * 100 ) / 100
//   - `remainingMinutes`= round( remainingMinutes )
//
// WINDOWING. `--since`/`--until` do NOT window the EVENTS before block
// formation — ccusage builds blocks over the full event set, THEN drops rows
// whose `startTime`, formatted to a *local-timezone* `YYYYMMDD`, falls outside
// `[since, until]`. Gap rows are filtered the same way (by their own
// `startTime`). So the aggregator must be fed the *unwindowed* event set and
// post-filter — `applyWindow` below. This is the one place `local-date.ts`
// applies to blocks.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internal block model
// ---------------------------------------------------------------------------

// A block under construction/formed: its window bounds, provenance, and the
// timestamp-sorted events folded into it. Heuristic blocks have
// endMs = startMs + 5h; observed blocks carry the real [reset−5h, reset).
type PendingBlock = {
  startMs: number;
  endMs: number;
  source: BlockRow["windowSource"];
  events: StoredEvent[];
};

// Floor an epoch-ms instant to the start of its UTC hour. Pure epoch
// arithmetic — NOT a local-calendar operation (see SPIKE / WINDOW-START
// FLOORING). The result is always a whole `...:00:00.000Z` instant.
function floorToHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

// One event's epoch-ms timestamp. An unparseable timestamp yields `NaN`;
// callers must drop such events before block formation (see `aggregateBlocks`).
function eventMs(event: StoredEvent): number {
  return new Date(event.timestamp).getTime();
}

// ---------------------------------------------------------------------------
// Token-count helpers
// ---------------------------------------------------------------------------

// The four token counts summed — the wire `totalTokens` figure.
function totalOf(counts: TokenCounts): number {
  return (
    counts.inputTokens +
    counts.outputTokens +
    counts.cacheCreationInputTokens +
    counts.cacheReadInputTokens
  );
}

// ---------------------------------------------------------------------------
// burnRate / projection — the active-block sub-objects
// ---------------------------------------------------------------------------

// The active block's burn rate, or `null` when the first→last in-block event
// span is non-positive (a single-event block, or all events at one instant).
// Ports the `$n` helper (see SPIKE): rates are computed over the event-span MINUTES, not
// the block's 5h window.
function computeBurnRate(
  events: StoredEvent[],
  counts: TokenCounts,
  costUSD: number,
  msOf: (event: StoredEvent) => number,
): BurnRate | null {
  if (events.length === 0) return null;
  const first = events[0];
  const last = events[events.length - 1];
  if (first === undefined || last === undefined) return null;
  const durationMinutes = (msOf(last) - msOf(first)) / (1000 * 60);
  if (durationMinutes <= 0) return null;
  return {
    tokensPerMinute: totalOf(counts) / durationMinutes,
    tokensPerMinuteForIndicator: (counts.inputTokens + counts.outputTokens) / durationMinutes,
    costPerHour: (costUSD / durationMinutes) * 60,
  };
}

// The active block's end-of-window projection, or `null` when it has no burn
// rate. Ports the `er` helper (see SPIKE): projects current totals forward over the
// minutes remaining in the block's 5h window at the current burn rate.
function computeProjection(
  endMs: number,
  now: number,
  counts: TokenCounts,
  costUSD: number,
  burnRate: BurnRate | null,
): Projection | null {
  if (burnRate === null) return null;
  const remainingMinutes = Math.max(0, (endMs - now) / (1000 * 60));
  return {
    totalTokens: Math.round(totalOf(counts) + burnRate.tokensPerMinute * remainingMinutes),
    totalCost: Math.round((costUSD + (burnRate.costPerHour / 60) * remainingMinutes) * 100) / 100,
    remainingMinutes: Math.round(remainingMinutes),
  };
}

// Exact-match machine filter (ADR-0041): empty = no filter. Ids are opaque —
// no substring semantics (contrast matchesModelFilter).
function matchesMachineFilter(machineId: string, machines: string[]): boolean {
  return machines.length === 0 || machines.includes(machineId);
}

// ---------------------------------------------------------------------------
// Row flushing
// ---------------------------------------------------------------------------

// Flush a finished `PendingBlock` into a wire `BlockRow`. `mode` selects the
// cost basis; `now` drives active-block detection and the projection;
// `loweredModels` is the ADR-0017 filter, its needles ALREADY lowered by
// `lowerModelNeedles` at the `aggregateBlocks` options site (hoisted out of the
// per-event loop). It never reaches the wire: the row's `models` come from
// `modelNames`, a Set of real event model strings.
//
// TWO AGGREGATIONS, ONE EVENT WALK. The block's QUOTA-level figures —
// `isActive`, `burnRate`, `projection` — are computed over ALL events (the
// real 5h window). The block's WIRE sums — `costUSD`, `tokenCounts`,
// `totalTokens`, `models`, `entries` — are computed over only the events
// matching the model filter. `computeCost` runs exactly once per event.
//
// A heuristic block is active when there is recent activity (`now -
// lastEventMs < 5h`) AND `now` is still inside the 5h window (`now < endMs`)
// — the `Zn` rule (see SPIKE); observed blocks key off the real window alone (ADR-0028,
// see below). Active-block detection is itself all-model (the 5h quota window
// counts every model).
function flushBlock(
  block: PendingBlock,
  mode: CostMode,
  now: number,
  loweredModels: string[],
  machines: string[],
  resolvedActiveExists: boolean,
  msOf: (event: StoredEvent) => number,
): BlockRow {
  const { startMs, endMs, events, source } = block;
  const last = events[events.length - 1];
  // `actualEndTime` is the last in-block event's raw timestamp. A block always
  // has >= 1 event (it is only created when an event opens it), so `last` is
  // defined; the fallback keeps the type total.
  const actualEndTime = last !== undefined ? last.timestamp : new Date(startMs).toISOString();
  const lastMs = last !== undefined ? msOf(last) : startMs;

  // Observed/annulled blocks are active iff their real window hasn't ended
  // (their events are ≤5h old by construction, so the recent-activity
  // condition is implied; an annulled window's end is its successor's start,
  // so it can never be active beside a live successor — ADR-0029). Heuristic
  // blocks keep the dual condition — but are demoted when a resolved
  // block is live: disjoint real windows mean a residual event's unobserved
  // window provably ended by the live window's start (ADR-0028).
  const isActive =
    source === "heuristic"
      ? !resolvedActiveExists && now - lastMs < FIVE_HOURS_MS && now < endMs
      : now < endMs;

  // Quota-level accumulators (all events) + filtered wire accumulators.
  const allCounts: TokenCounts = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  let allCost = 0;
  const counts: TokenCounts = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  let costUSD = 0;
  let entries = 0;
  // `models` (wire) in first-seen order over the (timestamp-sorted) matching
  // events — a Set preserves insertion order.
  const modelNames = new Set<string>();
  // `machines` (wire) in first-seen order over the same matching events
  // (ADR-0041) — parallel to `modelNames`.
  const machineNames = new Set<string>();

  for (const event of events) {
    const cost = computeCost(
      event.model,
      {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheCreationTokens: event.cacheCreationTokens,
        cacheReadTokens: event.cacheReadTokens,
      },
      mode,
      event.costUSD,
    );

    allCounts.inputTokens += event.inputTokens;
    allCounts.outputTokens += event.outputTokens;
    allCounts.cacheCreationInputTokens += event.cacheCreationTokens;
    allCounts.cacheReadInputTokens += event.cacheReadTokens;
    allCost += cost;

    if (
      matchesLoweredModelFilter(event.model, loweredModels) &&
      matchesMachineFilter(event.machineId, machines)
    ) {
      counts.inputTokens += event.inputTokens;
      counts.outputTokens += event.outputTokens;
      counts.cacheCreationInputTokens += event.cacheCreationTokens;
      counts.cacheReadInputTokens += event.cacheReadTokens;
      costUSD += cost;
      entries += 1;
      modelNames.add(event.model);
      machineNames.add(event.machineId);
    }
  }

  // burnRate / projection are quota-level (all events) — ADR-0017.
  const burnRate = isActive ? computeBurnRate(events, allCounts, allCost, msOf) : null;
  const projection = isActive ? computeProjection(endMs, now, allCounts, allCost, burnRate) : null;

  return {
    id: new Date(startMs).toISOString(),
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(endMs).toISOString(),
    actualEndTime,
    isActive,
    isGap: false,
    entries,
    tokenCounts: counts,
    totalTokens: totalOf(counts),
    costUSD,
    models: Array.from(modelNames),
    machines: Array.from(machineNames),
    burnRate,
    projection,
    // Placeholder — the limit pass inside `aggregateBlocks` (ADR-0028) fills
    // this when a usage history is present; with no samples every row stays
    // null (never fabricated).
    fiveHourLimitPct: null,
    windowSource: source,
  };
}

// Build the gap row between a closed block and the next one — the `Qn`
// helper (see SPIKE). `prevLastEventMs` is the previous block's *last event* raw epoch;
// `nextMs` is the next event's raw epoch. The gap row spans
// `[prevLastEventMs + 5h, nextMs]` and exists only when
// `nextMs - prevLastEventMs > 5h` (the caller already checked the >5h
// inter-event gap, but the ported walk re-checks it here — keep the guard).
function makeGapRow(prevLastEventMs: number, nextMs: number): BlockRow | null {
  const startMs = prevLastEventMs + FIVE_HOURS_MS;
  if (nextMs - prevLastEventMs <= FIVE_HOURS_MS) return null;
  return {
    id: `gap-${new Date(startMs).toISOString()}`,
    startTime: new Date(startMs).toISOString(),
    // The gap row's `endTime` is the next event's RAW timestamp — not floored.
    endTime: new Date(nextMs).toISOString(),
    actualEndTime: null,
    isActive: false,
    isGap: true,
    entries: 0,
    tokenCounts: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    totalTokens: 0,
    costUSD: 0,
    models: [],
    // Gap rows carry no events, so no machines matched (ADR-0041).
    machines: [],
    burnRate: null,
    projection: null,
    fiveHourLimitPct: null,
    // ADR-0028: gap rows always derive their bounds from neighboring events —
    // always heuristic.
    windowSource: "heuristic",
  };
}

// ---------------------------------------------------------------------------
// Window post-filter
// ---------------------------------------------------------------------------

// Drop rows whose `startTime`, formatted to a `YYYYMMDD` in `timeZone` (the
// request's `tz`, ADR-0015), falls outside `[since, until]` — we window
// the *built* blocks (gap rows included), not the events (see SPIKE /
// WINDOWING). `since` / `until` are dashless `YYYYMMDD`; an omitted bound is
// unbounded on that side. A row whose `startTime` is unparseable is dropped
// (fails safe — it cannot happen in practice since `startTime` is
// engine-constructed).
function applyWindow(
  rows: BlockRow[],
  timeZone: string,
  since?: string,
  until?: string,
): BlockRow[] {
  if (since === undefined && until === undefined) return rows;
  return rows.filter((row) => {
    const date = localDate(row.startTime, timeZone);
    if (date === null) return false;
    if (since !== undefined && date.ymd < since) return false;
    if (until !== undefined && date.ymd > until) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Formation — shared by aggregateBlocks and resolveBlockSpanWindow (ADR-0031)
// ---------------------------------------------------------------------------

// The formation walk, steps 1–4 of the aggregateBlocks algorithm: parse/sort,
// partition by resolved windows, hour-floor heuristic over the residual stream,
// chronological merge. Extracted so the block-span window resolver and the
// blocks aggregator share ONE implementation — the /api/intraday block frame
// must be the same window /api/blocks reports active, by construction.
function formPendingBlocks(
  events: StoredEvent[],
  samples: UsageSample[],
): { formed: PendingBlock[]; windows: ResolvedWindow[]; msOf: (event: StoredEvent) => number } {
  // Parse each event's timestamp exactly once and reuse it everywhere below
  // (the window partition walk, the heuristic walk, the gap check, and
  // flushBlock/computeBurnRate). Events whose timestamp doesn't parse are
  // dropped here — an unparseable timestamp never reaches the wire (it would
  // throw in `new Date(NaN).toISOString()` downstream). `byTimestamp`
  // (`./model-rollup`) returns the same object references, so the identity map
  // stays valid after sorting.
  const msByEvent = new Map<StoredEvent, number>();
  const parsed: StoredEvent[] = [];
  for (const event of events) {
    const t = eventMs(event);
    if (Number.isNaN(t)) continue;
    msByEvent.set(event, t);
    parsed.push(event);
  }
  const msOf = (event: StoredEvent): number => msByEvent.get(event) as number;
  const sorted = byTimestamp(parsed);

  // ADR-0028/0029 — resolved windows partition formation: the util>0 windows
  // (an overlapping pair means an out-of-band reset — the annulled earlier
  // window truncates at its successor's start), plus the live-window grace
  // clipped to its uncovered extent. Pairwise disjoint and ascending by
  // construction (see resolveWindows).
  const windows: ResolvedWindow[] = resolveWindows(
    samples,
    sorted.map((e) => msOf(e)),
  );

  // Partition each event into the window containing it (unique — windows are
  // disjoint), or the residual stream. Both sides are timestamp-sorted, so one
  // pointer walk suffices: disjoint + ascending means once windows[wi] starts
  // after t, no later window can contain t.
  const perWindow: StoredEvent[][] = windows.map(() => []);
  const residual: StoredEvent[] = [];
  let wi = 0;
  for (const event of sorted) {
    const t = msOf(event);
    while (wi < windows.length && (windows[wi] as ResolvedWindow).end <= t) wi++;
    const w = windows[wi];
    if (w !== undefined && w.start <= t) {
      (perWindow[wi] as StoredEvent[]).push(event);
    } else {
      residual.push(event);
    }
  }

  // The residual stream gets the untouched heuristic walk (close on a >5h block
  // span or a >5h inter-event gap). Gap rows are NOT emitted here — they are
  // recomputed over the final merged sequence below, which fires on exactly
  // the same event pairs when there are no observed windows (byte-for-byte
  // golden parity).
  const heuristic: PendingBlock[] = [];
  let pending: { startMs: number; events: StoredEvent[] } | null = null;
  const flushPending = (): void => {
    if (pending !== null && pending.events.length > 0) {
      heuristic.push({
        startMs: pending.startMs,
        endMs: pending.startMs + FIVE_HOURS_MS,
        source: "heuristic",
        events: pending.events,
      });
    }
  };
  for (const event of residual) {
    const ms = msOf(event);
    if (pending === null) {
      pending = { startMs: floorToHour(ms), events: [event] };
      continue;
    }
    const prevEvent = pending.events[pending.events.length - 1];
    if (prevEvent === undefined) continue;
    const prevMs = msOf(prevEvent);
    if (ms - pending.startMs > FIVE_HOURS_MS || ms - prevMs > FIVE_HOURS_MS) {
      flushPending();
      pending = { startMs: floorToHour(ms), events: [event] };
    } else {
      pending.events.push(event);
    }
  }
  flushPending();

  // Merge regimes chronologically. A window with no events emits no row —
  // blocks still form from events (an annulled window drained of every event
  // by its successor simply disappears).
  const formed: PendingBlock[] = [
    ...windows.flatMap((w, i): PendingBlock[] => {
      const evs = perWindow[i];
      return evs !== undefined && evs.length > 0
        ? [{ startMs: w.start, endMs: w.end, source: w.source, events: evs }]
        : [];
    }),
    ...heuristic,
  ].sort((a, b) => a.startMs - b.startMs);

  return { formed, windows, msOf };
}

// `WindowSpan` / `ResolvedBlockSpan` live in `./block-windows` (the lower-level
// module both this aggregator and intraday.ts depend on) — imported above.

// Resolve the ACTIVE block's window for the /api/intraday `block` span
// (ADR-0031). `events` must be the UNFILTERED store query — boundaries are
// all-model/all-project (ADR-0017/0028) — and the active predicates mirror
// flushBlock's exactly (parity-tested): a resolved window is active while
// `now < end`, the latest-ending one winning — disjointness does NOT make the
// winner unique (an annulled window's truncated end is its successor's start,
// so before that instant both satisfy `now < end`); aggregateBlocks settles
// the same tie with its rows-level demotion, and both implementations
// converge on the latest-ending window. With none live, a heuristic block is
// active on recent activity inside its window, the latest-ending one winning
// (the same demotion rule).
export function resolveBlockSpanWindow(
  events: StoredEvent[],
  samples: UsageSample[],
  now: number,
): ResolvedBlockSpan | null {
  const { formed, windows, msOf } = formPendingBlocks(events, samples);

  // The active gate walks FORMED blocks — not resolved windows — deliberately:
  // a live util>0 window with NO local events emits no PendingBlock, so it
  // neither frames the span nor demotes a heuristic block. This mirrors
  // aggregateBlocks, whose `resolvedActive` is likewise computed over `formed`.
  let active: PendingBlock | null = null;
  for (const block of formed) {
    if (
      block.source !== "heuristic" &&
      now < block.endMs &&
      (active === null || block.endMs > active.endMs)
    ) {
      active = block;
    }
  }
  if (active === null) {
    for (const block of formed) {
      if (block.source !== "heuristic") continue;
      const last = block.events[block.events.length - 1];
      if (last === undefined) continue;
      if (now - msOf(last) < FIVE_HOURS_MS && now < block.endMs) {
        if (active === null || block.endMs > active.endMs) active = block;
      }
    }
  }
  if (active === null) return null;

  const exclusionsFor = (block: PendingBlock): WindowSpan[] =>
    block.source !== "heuristic"
      ? []
      : windows
          .filter((w) => w.start < block.endMs && w.end > block.startMs)
          .map((w) => ({ startMs: w.start, endMs: w.end }));

  const idx = formed.indexOf(active);
  const prev = idx > 0 ? (formed[idx - 1] as PendingBlock) : null;
  return {
    startMs: active.startMs,
    endMs: active.endMs,
    source: active.source,
    exclusions: exclusionsFor(active),
    previous:
      prev === null
        ? null
        : { startMs: prev.startMs, endMs: prev.endMs, exclusions: exclusionsFor(prev) },
  };
}

// ---------------------------------------------------------------------------
// /api/blocks
// ---------------------------------------------------------------------------

// Controls beyond the cost mode that shape the `/api/blocks` body.
export type AggregateBlocksOptions = {
  // Inclusive date window, dashless `YYYYMMDD`. Filters which *built* blocks
  // appear by each block's `startTime` (local-timezone date) — NOT a filter
  // on the events fed into block formation (see SPIKE / WINDOWING). An omitted
  // bound is unbounded on that side.
  since?: string;
  until?: string;
  // The wall-clock instant (epoch ms) used for active-block detection and the
  // projection. Injected so the active path is testable; defaults to
  // `Date.now()`.
  now?: number;
  // The model filter (ADR-0017). Blocks FORM from all events — the 5-hour
  // quota window is a fact about Claude's rate limit, so boundaries, gaps,
  // `isActive`, `burnRate`, and `projection` ignore this filter. Only the
  // per-block SUMS narrow: `costUSD`, `tokenCounts`, `totalTokens`, `models`,
  // and `entries` count matching events only. Empty / omitted = no filter.
  models?: string[];
  // The machine filter (ADR-0041) — the sum-narrowing axis, exactly parallel to
  // `models`: blocks FORM from all events, so boundaries, gaps, `isActive`,
  // `burnRate`, `projection`, and `fiveHourLimitPct` NEVER narrow (quota truth
  // is account-wide). Only each block's SUMS narrow: `costUSD`, `tokenCounts`,
  // `totalTokens`, `models`, `machines`, and `entries` count matching events
  // only. Exact-match on machineId (opaque ids — no substring semantics).
  // Empty / omitted = no filter.
  machines?: string[];
  // The IANA zone the window post-filter interprets `startTime` in (ADR-0015)
  // — the request's `tz`. Only consulted when a date bound is set; omitted =
  // the host zone.
  timeZone?: string;
  // The usage history, capturedAt-sorted (the sample store's `all()`). When
  // present, resolved reset windows PARTITION block formation (ADR-0028/0029)
  // and fiveHourLimitPct is filled on observed/annulled rows only (live latest
  // for the active block, peak-in-window for completed; heuristic rows are
  // always null — ADR-0030). Omitted/empty → the pure hour-floor heuristic and
  // all-null limit % — the golden-parity path.
  samples?: UsageSample[];
};

// Aggregate a store query result into the `/api/blocks` response body.
//
// `events` must be the *unwindowed* event set — `/api/blocks` is cross-project
// (the project filter never reaches it), and the store query carries NO
// filters; the model filter (ADR-0017) narrows per-block sums via
// `options.models`, never the store query. The date window is a post-filter on
// each built block's `startTime` (`options.since` / `options.until`); see the
// module SPIKE.
//
// The algorithm (ADR-0028/0029 — resolved windows partition the heuristic walk):
//   1. Sort events by timestamp ascending (drop unparseable timestamps).
//   2. Partition each event into the RESOLVED window containing it (derived
//      from `options.samples`; disjoint — annulled windows truncate at their
//      successor's start, the grace window is clipped to its uncovered
//      extent), or the residual stream. With no samples every event is
//      residual.
//   3. Walk the residual stream with the untouched hour-floor heuristic —
//      a faithful port of `identifySessionBlocks` (open on the first event,
//      start = floor-to-hour, close + reopen on a >5h block-span OR >5h
//      inter-event gap).
//   4. Merge both regimes chronologically; flush each block to a wire row
//      (`flushBlock`), emitting a gap row between consecutive blocks whose
//      boundary events are >5h apart (the same strict rule, on the same event
//      pairs, as the ported in-walk emission — byte-for-byte parity with no
//      samples). Active-block detection, burnRate, and projection key off
//      `options.now`; at most one block is active.
//   5. Fill `fiveHourLimitPct` over the FINAL windows when samples exist.
//   6. Post-filter the row list by the date window on the FINAL `startTime`.
export function aggregateBlocks(
  events: StoredEvent[],
  mode: CostMode,
  options: AggregateBlocksOptions = {},
): BlocksResponse {
  const now = options.now ?? Date.now();
  // Lower the model needles ONCE here, not once per event inside `flushBlock`'s
  // walk (`lowerModelNeedles` — byte-identical, `toLowerCase` is
  // locale-independent). These lowered needles are a MATCHING input only: the
  // wire `models` on each row come from the events themselves (`modelNames`),
  // never from this array.
  const models = lowerModelNeedles(options.models ?? []);
  const machines = options.machines ?? [];

  const samples = options.samples ?? [];
  const { formed, msOf } = formPendingBlocks(events, samples);

  // At most one active block (ADR-0028/0029): when a resolved window is live,
  // every heuristic block is demoted in flushBlock. Disjointness means only
  // the LAST resolved window can satisfy now < end (an annulled window's end
  // is its live successor's start), so this is structural, not a tie-break.
  const resolvedActive = formed.some((f) => f.source !== "heuristic" && now < f.endMs);

  // Flush, emitting a gap row between consecutive blocks whose boundary events
  // are >5h apart — the same strict rule, on the same event pair, as the
  // ported in-walk emission.
  const rows: BlockRow[] = [];
  let prev: PendingBlock | null = null;
  for (const block of formed) {
    if (prev !== null) {
      const prevLast = prev.events[prev.events.length - 1];
      const first = block.events[0];
      if (prevLast !== undefined && first !== undefined) {
        const prevMs = msOf(prevLast);
        const nextMs = msOf(first);
        if (nextMs - prevMs > FIVE_HOURS_MS) {
          const gap = makeGapRow(prevMs, nextMs);
          if (gap !== null) rows.push(gap);
        }
      }
    }
    rows.push(flushBlock(block, mode, now, models, machines, resolvedActive, msOf));
    prev = block;
  }

  // At most one active block (structural). flushBlock already demotes heuristic
  // blocks beside a live resolved window, but future-dated events with no
  // samples can still form two heuristic blocks that each satisfy the active
  // predicate (now < endMs AND now − lastEvent < 5h). Keep only the
  // latest-ending one active; demote the rest (a gap row is never active).
  const actives = rows.filter((r) => r.isActive);
  if (actives.length > 1) {
    let latest = actives[0] as BlockRow;
    for (const r of actives) {
      if (Date.parse(r.endTime) > Date.parse(latest.endTime)) latest = r;
    }
    for (const r of actives) {
      if (r === latest) continue;
      r.isActive = false;
      r.burnRate = null;
      r.projection = null;
    }
  }

  // The 5h limit % over the FINAL windows — a REAL-WINDOW property (ADR-0030):
  // only observed/annulled rows carry one (live latest for the active block,
  // peak-in-window for completed; null when no sample covers the window —
  // never fabricated). Heuristic and gap rows stay null always: an estimated
  // row has no real window to have a % of, its seam-overlapping span would
  // leak the neighboring window's samples into a peak query (the retired
  // ADR-0028 corollary), and an ACTIVE heuristic row only exists when the
  // history is stale — so the "live" latest util describes a dead window.
  const view = samples.length > 0 ? precomputeSamples(samples) : null;
  const withLimits =
    view === null
      ? rows
      : rows.map((r) => {
          if (r.isGap || r.windowSource === "heuristic") return r;
          const fiveHourLimitPct = r.isActive
            ? view.latestUtil
            : peakInWindow(view, Date.parse(r.startTime), Date.parse(r.endTime));
          return { ...r, fiveHourLimitPct };
        });

  // Post-filter by the date window on each block's FINAL `startTime` —
  // observed or heuristic (ADR-0028; the old f3 pre-snap ordering note no
  // longer applies — there is no relabel step left to order).
  return {
    blocks: applyWindow(
      withLimits,
      options.timeZone ?? defaultTimeZone(),
      options.since,
      options.until,
    ),
  };
}
