import { useCallback, useMemo, useState } from "react";
import type { BlockRow, TimeDisplay } from "@maxprice/shared";
import { resolveDateRange, useFilters } from "@/state/filters";
import { useSettings, useTimeDisplay } from "@/state/use-settings";
import { useBlocks } from "@/state/use-blocks";
import { useMachineAxis } from "@/state/use-machine-axis";
import { useCorpusEmpty } from "@/state/use-corpus-empty";
import { useEscapeToDeselect } from "@/state/use-escape-deselect";
import { useNowTick } from "@/state/use-now-tick";
import { EmptyState } from "@/components/EmptyState";
import { DataTable, type Column } from "@/components/data-table";
import { StripPage } from "@/components/strip-page";
import { DetailStrip, StripIdentity, StripSection, StripStat } from "@/components/detail-strip";
import { ModelBadges } from "@/components/model-badges";
import { aggregateBlocks, typicalBlockTokens, type BlocksAggregate } from "@/lib/aggregate";
import { formatRelativeTime, formatWallDayMonth } from "@maxprice/shared";
import { abbreviate, formatRange } from "@/lib/active-block";
import { formatCost, RANGE_LABEL } from "@/lib/list-format";
import { WINDOW_SOURCE } from "@/components/window-source";
import { useArrangement } from "@/state/use-arrangement";
import { costBarColumn } from "@/components/cost-bar";
import { cn } from "@/lib/utils";

type BlockKind = "active" | "gap" | "done";

function blockKind(b: BlockRow): BlockKind {
  if (b.isGap) return "gap";
  if (b.isActive) return "active";
  return "done";
}

function startMs(b: BlockRow): number {
  return Date.parse(b.startTime) || 0;
}

// "14:00 – 19:00 · May 14" / "2:00 PM – 7:00 PM · May 14" — `display` (ADR-0060)
// carries the Settings timezone, so both the time range and the calendar day
// render in the zone the engine bucketed into, plus the 24h/AM-PM shape.
//
// The `· May 14` half is a calendar date, so `timeFormat` has nothing to say
// about it — but the zone and the English month name do, which is why it goes
// through `formatWallDayMonth` (shared, cached, locale-independent) rather than
// a host-locale `toLocaleDateString`.
function windowLabel(b: BlockRow, display: TimeDisplay): string {
  const s = startMs(b);
  const e = Date.parse(b.endTime) || s;
  return `${formatRange(s, e, display)} · ${formatWallDayMonth(s, display)}`;
}

function remainingLabel(b: BlockRow, now: number): string {
  const ms = (Date.parse(b.endTime) || 0) - now;
  if (ms <= 0) return "";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

function StatusPill({ kind }: { kind: BlockKind }): React.ReactElement {
  if (kind === "active") {
    return (
      <span className="pill live-p">
        <span aria-hidden className="dot" />
        active
      </span>
    );
  }
  if (kind === "gap") {
    return <span className="pill warn-p">gap</span>;
  }
  return <span className="pill">done</span>;
}

const DASH = <span className="text-soft">—</span>;

export function BlocksPage(): React.ReactElement {
  const dateRange = useFilters((s) => s.dateRange);
  // The model filter narrows each block's cost/token sums (ADR-0017); block
  // boundaries and the projection stay all-model (quota truth). The machine
  // filter narrows those same sums (ADR-0041 M5 engine semantics) — FILTERING
  // only, no per-block machine attribution UI in v1.
  const models = useFilters((s) => s.models);
  const machineAxis = useMachineAxis();
  const { data: settings } = useSettings();
  const tz = settings?.timezone;
  const display = useTimeDisplay();
  const { since, until } = resolveDateRange(dateRange, tz);
  const now = useNowTick(60_000);

  const query = useBlocks({
    since,
    until,
    mode: settings?.costMode ?? "auto",
    tz,
    models,
    machines: machineAxis.machineParams,
  });
  const blocks = useMemo(() => query.data?.blocks ?? [], [query.data]);

  const activeBlock = useMemo(() => blocks.find((b) => b.isActive && !b.isGap), [blocks]);
  // The "typical" block — median tokens across the range's completed blocks —
  // the baseline the selected block's "tokens vs typical" bar measures against.
  const typical = useMemo(() => typicalBlockTokens(blocks), [blocks]);

  const [selectedId, setSelectedId] = useState<string>();
  const selected = blocks.find((b) => b.id === selectedId);

  // Click-again toggles the selection off (back to filter totals); Esc and a
  // click on any dead space on the page do too.
  const onSelect = (b: BlockRow): void => {
    setSelectedId((prev) => (prev === b.id ? undefined : b.id));
  };
  const deselect = useCallback(() => setSelectedId(undefined), []);
  useEscapeToDeselect(deselect);

  // Filter totals for the strip's no-selection state (ADR-0016).
  const aggregate = useMemo(() => aggregateBlocks(blocks), [blocks]);

  // First-launch empty state — the engine holds no usage data at all. Captured
  // before the columns memo / early return below so the hook order is stable.
  const corpusEmpty = useCorpusEmpty();

  // Wide's cost bar (ADR-0073) — Blocks is its best case: 15 rows whose ~1600px
  // WINDOW void becomes a spend profile readable at a glance.
  const wide = useArrangement() === "wide";
  const barMax = useMemo(
    () => blocks.reduce((m, b) => (b.costUSD > m ? b.costUSD : m), 0),
    [blocks],
  );

  const columns = useMemo<Column<BlockRow>[]>(
    () => [
      {
        id: "window",
        header: "Window",
        // minmax(0,…) lets the window column shrink to fit so the grid never
        // overflows its container — overflow is what clipped the right columns
        // and left their row background unpainted. The label truncates instead.
        width: "minmax(0,2fr)",
        sortValue: (b) => startMs(b),
        cell: (b) => {
          const rem = b.isActive ? remainingLabel(b, now) : "";
          return (
            <span className="lead">
              <span className="wcell">
                <span className="trunc num">{windowLabel(b, display)}</span>
                {!b.isGap && (
                  <span
                    role="img"
                    aria-label={WINDOW_SOURCE[b.windowSource].aria}
                    title={WINDOW_SOURCE[b.windowSource].title}
                    className={WINDOW_SOURCE[b.windowSource].dot}
                  />
                )}
              </span>
              {rem ? <small className="num">{rem}</small> : null}
            </span>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        width: "100px",
        sortValue: (b) => blockKind(b),
        cell: (b) => <StatusPill kind={blockKind(b)} />,
      },
      {
        id: "burn",
        header: "Burn rate",
        numeric: true,
        width: "110px",
        sortValue: (b) => b.burnRate?.tokensPerMinute ?? -1,
        cell: (b) => (b.burnRate ? `${abbreviate(b.burnRate.tokensPerMinute)}/min` : DASH),
        // A burn rate is a live-block property, so on a done row this is an em
        // dash — and at narrow a labelled "BURN RATE —" slot is what took a done
        // row to a third line against the active row's two (ADR-0073).
        isEmpty: (b) => b.burnRate === null,
      },
      {
        id: "tokens",
        header: "Tokens",
        numeric: true,
        width: "100px",
        sortValue: (b) => b.totalTokens,
        cell: (b) => abbreviate(b.totalTokens),
      },
      // Wide only, immediately left of Cost (ADR-0073).
      ...(wide ? [costBarColumn<BlockRow>({ max: barMax, get: (b) => b.costUSD })] : []),
      {
        id: "cost",
        header: "Cost",
        numeric: true,
        cellClass: "cost",
        width: "90px",
        sortValue: (b) => b.costUSD,
        cell: (b) => formatCost(b.costUSD),
      },
      {
        id: "projected",
        header: "Projected",
        numeric: true,
        width: "100px",
        sortValue: (b) => b.projection?.totalCost ?? -1,
        cell: (b) => (b.projection ? formatCost(b.projection.totalCost) : DASH),
        isEmpty: (b) => b.projection === null,
      },
      {
        id: "5h-limit",
        header: "5h limit",
        numeric: true,
        width: "90px",
        sortValue: (b) => b.fiveHourLimitPct ?? -1,
        cell: (b) => (b.fiveHourLimitPct === null ? DASH : `${Math.round(b.fiveHourLimitPct)}%`),
        // Null on every heuristic-windowed row (ADR-0030), which is most of
        // them in a history hole — the same labelled-slot cost as Burn rate.
        isEmpty: (b) => b.fiveHourLimitPct === null,
      },
    ],
    [now, display, wide, barMax],
  );

  // An empty result while the corpus is non-empty is just a filtered-out date
  // range — that keeps the inline "No blocks in this range." message instead.
  if (corpusEmpty) {
    return (
      <div className="p-6">
        <EmptyState />
      </div>
    );
  }

  return (
    <StripPage
      onBackgroundClick={deselect}
      strip={
        selected ? (
          <BlockDetailStrip block={selected} typical={typical} display={display} />
        ) : query.isPending ? (
          // The blocks query hasn't resolved yet — a quiet shell rather than a
          // false "0 blocks · $0.00" aggregate.
          <DetailStrip selected={false}>
            <span className="text-sm text-soft">Loading…</span>
          </DetailStrip>
        ) : query.isError && blocks.length === 0 ? (
          // A failed query with nothing cached: the zero aggregate would
          // assert a false "0 blocks · $0.00" — say what happened instead
          // (the table body carries the danger inset).
          <DetailStrip selected={false}>
            <span className="text-sm text-soft">Couldn&apos;t load blocks.</span>
          </DetailStrip>
        ) : (
          <BlocksAggregateStrip
            aggregate={aggregate}
            rangeLabel={RANGE_LABEL[dateRange]}
            activeBlock={activeBlock}
          />
        )
      }
      table={
        <section className="panel table-panel h-full" aria-label="Blocks table">
          <DataTable
            title="Blocks"
            rows={blocks}
            columns={columns}
            rowId={(b) => b.id}
            onSelect={onSelect}
            selectedId={selectedId}
            // 590px of fixed columns + ≥160px for the window label. Below this
            // the table scrolls horizontally instead of crushing it — except at
            // narrow, where the row wraps and the floor is dropped (ADR-0073:
            // this table is the surface that fails worst without the wrap, its
            // WINDOW label ellipsised on 16 of 16 rows inside a scroller that
            // could never reveal it).
            minWidth={750}
            defaultSort={{ columnId: "window", dir: "desc" }}
            pinnedRow={activeBlock}
            searchPlaceholder="Search blocks…"
            emptyMessage={query.isPending ? "Loading…" : "No blocks in this range."}
            error={query.error}
          />
        </section>
      }
    />
  );
}

// The selected block's strip. Unlike ActiveBlockTile this strip has no ring;
// every now-derived label it shows (remaining "Hh Mm left", the relative-time
// "ended …") is minute-granular, so a 1-minute tick is enough.
function BlockDetailStrip({
  block,
  typical,
  display,
}: {
  block: BlockRow;
  typical: number;
  display: TimeDisplay;
}): React.ReactElement {
  const now = useNowTick(60_000);
  const kind = blockKind(block);
  const endedIso = block.actualEndTime ?? block.endTime;

  const statusText =
    kind === "active"
      ? remainingLabel(block, now) || "—"
      : kind === "done"
        ? `ended ${formatRelativeTime(endedIso, now)}`
        : "no activity in this window";
  const provenance = kind === "gap" ? "" : ` · ${WINDOW_SOURCE[block.windowSource].strip}`;

  return (
    <DetailStrip selected>
      <StripIdentity title={windowLabel(block, display)} pill={<StatusPill kind={kind} />}>
        <span className="sub num">{statusText + provenance}</span>
      </StripIdentity>

      <StripStat label="spent">{formatCost(block.costUSD)}</StripStat>
      <StripStat label="projected">
        {block.projection ? formatCost(block.projection.totalCost) : "—"}
      </StripStat>
      <StripStat label="burn">
        {block.burnRate ? `${abbreviate(block.burnRate.tokensPerMinute)}/min` : "—"}
      </StripStat>
      <StripStat label="typical">{typical > 0 ? abbreviate(typical) : "—"}</StripStat>
      <StripStat label="entries">{block.entries}</StripStat>

      {block.fiveHourLimitPct === null ? (
        // ADR-0030: heuristic windows have no limit reading — em-dash label
        // over an empty track.
        <StripSection label="5h limit used · —">
          <span className="meter" />
          <ModelBadges models={block.models} />
        </StripSection>
      ) : (
        <StripSection label={`5h limit used · ${Math.round(block.fiveHourLimitPct)}%`}>
          {/* The Aurora gradient + glow is earned by liveness only — the
              active block's tracker (same as the Live tile); settled blocks'
              meters are flat accent. */}
          <span
            className={cn("meter", kind === "active" && "live-m")}
            role="meter"
            aria-valuenow={Math.round(block.fiveHourLimitPct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="5-hour limit used"
          >
            <i style={{ width: `${Math.min(100, block.fiveHourLimitPct)}%` }} />
          </span>
          <ModelBadges models={block.models} />
        </StripSection>
      )}
    </DetailStrip>
  );
}

// Filter totals across every non-gap block in the range, plus the active
// block's live burn rate when one is open.
function BlocksAggregateStrip({
  aggregate,
  rangeLabel,
  activeBlock,
}: {
  aggregate: BlocksAggregate;
  rangeLabel: string;
  activeBlock: BlockRow | undefined;
}): React.ReactElement {
  return (
    <DetailStrip selected={false}>
      <StripIdentity title="All blocks">
        <span className="sub num">
          {aggregate.count} blocks · {rangeLabel}
        </span>
      </StripIdentity>

      <StripStat label="total spent">{formatCost(aggregate.totalCost)}</StripStat>
      <StripStat label="total tokens">{abbreviate(aggregate.totalTokens)}</StripStat>
      <StripStat label="entries">{abbreviate(aggregate.entries)}</StripStat>
      <StripStat label="active burn">
        {activeBlock?.burnRate ? `${abbreviate(activeBlock.burnRate.tokensPerMinute)}/min` : "—"}
      </StripStat>

      <StripSection label="Models">
        {aggregate.models.length > 0 ? (
          <ModelBadges models={aggregate.models} />
        ) : (
          <span className="text-xs text-soft">No model activity in this range.</span>
        )}
      </StripSection>

      <span className="strip-hint">Select a row for details</span>
    </DetailStrip>
  );
}
