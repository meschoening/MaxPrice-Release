import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  formatAbsoluteTimestamp,
  formatRelativeTime,
  normalizeModelName,
  type SessionEventFrame,
  type TimeDisplay,
} from "@maxprice/shared";
import { useNowTick } from "@/state/use-now-tick";
import { useTimeDisplay } from "@/state/use-settings";
import { formatCost, familyColor } from "@/lib/list-format";
import { cn } from "@/lib/utils";
import { useArrangement } from "@/state/use-arrangement";
import { CostBar } from "@/components/cost-bar";

// M5 (T6 `lens`) — the per-message timeline as ONE tall frosted panel: the
// T5 lists table language (sticky frosted column head inside the panel,
// hairline rows, inner scroll + bottom fade) mapped onto the frozen
// fixed-row virtualized scroll container. The head-bar carries the streaming
// affordances: the accent hairline riding its bottom edge while the NDJSON
// stream is open, beside the live `streaming · n / N` pill.

// Timeline rows are a fixed height — the mock's uniform 38px row grid. This
// is deliberate (the plan's "streaming + virtualization" gotcha): a fixed
// `estimateSize` means appending rows mid-stream never re-measures and never
// thrashes layout.
const ROW_HEIGHT = 38;
// Narrow's stacked row (map #151 / T13 #164, ADR-0073). This constant is the
// ONE named exception to "an arrangement is CSS": the three list tables get
// their taller rows for free because `DataTable`'s virtualizer calls
// `measureElement`, and this one deliberately does not — so the height a CSS
// rule produces has to be told to the virtualizer as well.
//
// Measured rather than chosen: an 18px identity line, the 2px row gap, a 17px
// value run and the hairline — 38, with 2px of cushion. It is also the one
// number on this map a row could outgrow, since the value run takes a third
// line if its six labelled cells ever exceed the row's width (measured at
// content 604 with ~45px to spare, which is well past seven-digit token
// counts). Such a row would crowd its neighbour rather than clip, and the fix
// would be this constant — never a re-measure.
const ROW_HEIGHT_STACKED = 40;

// The ONE grid-track definition shared by the header row and every data row.
// Hand-duplicating this string between the two is a real misalignment-bug
// risk, so both reference this single const. Columns (mock .tl-row):
// time · model · in · out · cache-write · cache-read · cost · running.
const GRID_TEMPLATE = "grid-cols-[96px_minmax(88px,1.1fr)_repeat(4,minmax(74px,0.9fr))_92px_100px]";

// Below this width the wrapper scrolls horizontally instead of letting the
// flexible tracks collapse (the mock's .tl-scroll min-width). It travels as a
// custom property so the narrow arrangement can drop it without `!important` —
// see `.tl-scroll` in globals.css and the same seam in data-table.tsx.
const MIN_TABLE_WIDTH = 780;

// Relative timestamps must keep ageing while the page is open ("just now" →
// "1m ago"). A 30s cadence is plenty for a minute-granularity label.
const NOW_TICK_MS = 30_000;

export function SessionTimeline({
  events,
  totalEvents,
  streaming,
  freshFrom,
}: {
  events: SessionEventFrame[];
  // The summary frame's authoritative count — null until it arrives.
  totalEvents: number | null;
  // True while the NDJSON stream is open (the query is fetching).
  streaming: boolean;
  // Rows at this index and beyond entered after the last settled stream —
  // they wear the arrival rise + accent flash. Null = nothing is fresh.
  freshFrom: number | null;
}): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Subscribe to a coarse tick so `formatRelativeTime` re-evaluates as time
  // passes rather than freezing at first render.
  const now = useNowTick(NOW_TICK_MS);
  const display = useTimeDisplay();

  // The arrangement, at both ends (ADR-0073). The timeline's one ~800px gap
  // (model → in) at wide is the same defect the list tables have and gets the
  // same answer — the difference being that this template is a Tailwind class,
  // so the extra TRACK comes from CSS and only the CELL is TypeScript. At narrow
  // the row wraps like theirs, but its height is this file's constant.
  const arrangement = useArrangement();
  const wide = arrangement === "wide";
  const stacked = arrangement === "narrow";
  const barMax = useMemo(() => events.reduce((m, e) => (e.cost > m ? e.cost : m), 0), [events]);

  // Running cost total through each row — cumulative sum of `event.cost`.
  const runningTotals = useMemo(() => {
    const out: number[] = [];
    let sum = 0;
    for (const e of events) {
      sum += e.cost;
      out.push(sum);
    }
    return out;
  }, [events]);

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (stacked ? ROW_HEIGHT_STACKED : ROW_HEIGHT),
    overscan: 16,
  });

  // A NEW `estimateSize` does not invalidate the virtualizer's measurement
  // memo on its own — that memo keys on the count and the size cache, not on
  // the option — so crossing the narrow boundary re-rendered every row at the
  // old height and left the rows overlapping their slots (measured: slots stayed
  // 38 while the stacked row wanted 40). `measure()` drops the cache and lets
  // the current estimate answer. It is free here precisely because this
  // virtualizer never measures elements: there is nothing to re-measure, only a
  // constant to re-read.
  useEffect(() => {
    virtualizer.measure();
  }, [stacked, virtualizer]);

  return (
    <section className="panel table-panel tl-wrap" aria-label="Per-message timeline">
      <div className="head-bar">
        <h2>Timeline</h2>
        {!streaming && totalEvents !== null ? (
          <span className="count-chip num">{totalEvents.toLocaleString()} events</span>
        ) : null}
        {streaming ? (
          <span className="pill live-p ml-auto">
            <span className="dot" aria-hidden />
            streaming
            {totalEvents !== null ? (
              <span className="num">
                {" "}
                · {events.length.toLocaleString()} / {totalEvents.toLocaleString()}
              </span>
            ) : null}
          </span>
        ) : null}
        {/* The streaming hairline rides the head-bar's bottom edge; `done`
            fades it out in place so settling never shifts the layout. */}
        <div
          className={cn("stream-bar", !streaming && "done")}
          role="progressbar"
          aria-label="Loading session events"
          aria-hidden={!streaming}
        >
          <i />
        </div>
      </div>

      <div className="overflow-x-auto flex-1 min-h-0 flex flex-col">
        <div
          ref={scrollRef}
          style={{ "--row-floor": `${MIN_TABLE_WIDTH}px` } as React.CSSProperties}
          className="thin-scroll tl-scroll"
        >
          <div role="table" aria-label="Per-message events">
            {/* The sticky frosted surface — rows visibly blur sliding
                beneath it (the page's material proof, per T5). */}
            <div className="sticky-head">
              {/* The wide track comes from CSS (globals.css re-tracks
                  `.tl-row` and this head), so the class stays the base
                  template at every width and only the cell is conditional. */}
              <div role="row" className={cn("grid col-head", GRID_TEMPLATE)}>
                <span className="tl-cell">Time</span>
                <span className="tl-cell">Model</span>
                <span className="tl-cell num">In</span>
                <span className="tl-cell num">Out</span>
                <span className="tl-cell num">Cache w</span>
                <span className="tl-cell num">Cache r</span>
                {wide ? <span className="tl-cell">Cost share</span> : null}
                <span className="tl-cell num">Cost</span>
                <span className="tl-cell num">Running</span>
              </div>
            </div>

            {events.length === 0 ? (
              <div className="tl-wait">Waiting for events…</div>
            ) : (
              <div
                role="rowgroup"
                className="tl-rows"
                style={{ height: virtualizer.getTotalSize(), position: "relative" }}
              >
                {virtualizer.getVirtualItems().map((vi) => {
                  const event = events[vi.index];
                  if (!event) return null;
                  return (
                    // Key on the virtualizer's positional `vi.key`, not
                    // `messageId`: the store dedups events on `(messageId,
                    // requestId)`, so a `messageId` is not unique in the frame
                    // stream (and the frame contract carries no requestId).
                    // `events` is append-only while streaming and fully
                    // rebuilt on the summary-reset, so the positional index is
                    // a stable, collision-free key.
                    <TimelineRow
                      key={vi.key}
                      event={event}
                      runningTotal={runningTotals[vi.index] ?? 0}
                      wide={wide}
                      barMax={barMax}
                      now={now}
                      display={display}
                      fresh={freshFrom !== null && vi.index >= freshFrom}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: vi.size,
                        transform: `translateY(${vi.start}px)`,
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>
          <div className="fade" aria-hidden />
        </div>
      </div>
    </section>
  );
}

function TimelineRow({
  event,
  runningTotal,
  now,
  display,
  fresh,
  style,
  wide,
  barMax,
}: {
  event: SessionEventFrame;
  runningTotal: number;
  now: number;
  display: TimeDisplay;
  fresh: boolean;
  style: React.CSSProperties;
  // Wide only: the cost bar's cell (ADR-0073). Its track comes from CSS.
  wide: boolean;
  barMax: number;
}): React.ReactElement {
  const family = normalizeModelName(event.model);
  return (
    // Two layers: the outer div belongs to the virtualizer (its transform
    // positions the row), the inner .tl-row carries the arrival animation —
    // `arrive` animates transform, which would fight the positioning
    // transform if both lived on one element.
    <div style={style}>
      <div
        role="row"
        className={cn("tl-row grid h-full items-center", GRID_TEMPLATE, fresh && "new")}
      >
        <span
          className="tl-cell time"
          data-col="time"
          title={formatAbsoluteTimestamp(event.timestamp, display)}
        >
          {formatRelativeTime(event.timestamp, now)}
        </span>
        <span className="tl-cell">
          <span className="fam" style={{ color: familyColor(family) }} title={event.model}>
            {family}
          </span>
        </span>
        <TokenCell value={event.inputTokens} col="in" />
        <TokenCell value={event.outputTokens} col="out" />
        <TokenCell value={event.cacheCreationTokens} col="cache w" />
        <TokenCell value={event.cacheReadTokens} col="cache r" />
        {wide ? (
          <span className="tl-cell">
            <CostBar value={event.cost} max={barMax} />
          </span>
        ) : null}
        <span className="tl-cell num cost" data-col="cost">
          {formatCost(event.cost)}
        </span>
        <span className="tl-cell num running" data-col="running">
          {formatCost(runningTotal)}
        </span>
      </div>
    </div>
  );
}

function TokenCell({ value, col }: { value: number; col: string }): React.ReactElement {
  return (
    // PROTOTYPE — map #151 / T7 (#159), variant C: `data-col`. Throwaway.
    <span className={cn("tl-cell num", value === 0 && "zero")} data-col={col}>
      {value.toLocaleString()}
    </span>
  );
}
