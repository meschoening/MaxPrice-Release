import { useMemo, useRef } from "react";
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

// The ONE grid-track definition shared by the header row and every data row.
// Hand-duplicating this string between the two is a real misalignment-bug
// risk, so both reference this single const. Columns (mock .tl-row):
// time · model · in · out · cache-write · cache-read · cost · running.
const GRID_TEMPLATE = "grid-cols-[96px_minmax(88px,1.1fr)_repeat(4,minmax(74px,0.9fr))_92px_100px]";

// Below this width the wrapper scrolls horizontally instead of letting the
// flexible tracks collapse (the mock's .tl-scroll min-width).
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
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  });

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
          style={{ minWidth: MIN_TABLE_WIDTH }}
          className="thin-scroll tl-scroll"
        >
          <div role="table" aria-label="Per-message events">
            {/* The sticky frosted surface — rows visibly blur sliding
                beneath it (the page's material proof, per T5). */}
            <div className="sticky-head">
              <div role="row" className={cn("grid col-head", GRID_TEMPLATE)}>
                <span className="tl-cell">Time</span>
                <span className="tl-cell">Model</span>
                <span className="tl-cell num">In</span>
                <span className="tl-cell num">Out</span>
                <span className="tl-cell num">Cache w</span>
                <span className="tl-cell num">Cache r</span>
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
}: {
  event: SessionEventFrame;
  runningTotal: number;
  now: number;
  display: TimeDisplay;
  fresh: boolean;
  style: React.CSSProperties;
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
        <span className="tl-cell time" title={formatAbsoluteTimestamp(event.timestamp, display)}>
          {formatRelativeTime(event.timestamp, now)}
        </span>
        <span className="tl-cell">
          <span className="fam" style={{ color: familyColor(family) }} title={event.model}>
            {family}
          </span>
        </span>
        <TokenCell value={event.inputTokens} />
        <TokenCell value={event.outputTokens} />
        <TokenCell value={event.cacheCreationTokens} />
        <TokenCell value={event.cacheReadTokens} />
        <span className="tl-cell num cost">{formatCost(event.cost)}</span>
        <span className="tl-cell num running">{formatCost(runningTotal)}</span>
      </div>
    </div>
  );
}

function TokenCell({ value }: { value: number }): React.ReactElement {
  return <span className={cn("tl-cell num", value === 0 && "zero")}>{value.toLocaleString()}</span>;
}
