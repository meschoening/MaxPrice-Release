import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronDown } from "lucide-react";
import { deriveProjectName, deriveProjectPath } from "@maxprice/shared";
import { useFilters, type ChartStyle, type Metric, type Span } from "@/state/filters";
import { useLiveData } from "@/state/use-live-data";
import { useMachineAxis } from "@/state/use-machine-axis";
import { AXIS_LABELS, GROUP_BY_AXES, selectionLabel, type GroupByAxis } from "@/lib/group-by";
import { useCorpusEmpty } from "@/state/use-corpus-empty";
import { useBootPaintPublisher } from "@/lib/boot-paint";
import { EmptyState } from "@/components/EmptyState";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TodayTile } from "@/components/today-tile";
import { ThisWeekTile } from "@/components/this-week-tile";
import { ActiveBlockTile } from "@/components/active-block-tile";
import { CostChartCard } from "@/components/cost-chart-card";
import { ListRow } from "@/components/list-row";
import { useFlipList } from "@/state/use-flip-list";
import { cn } from "@/lib/utils";

// `block` replaced `6h` (ADR-0031): it frames the ACTIVE 5-hour block — a
// growing window from the block's start, resolved sidecar-side. All six tabs
// are enabled as of Part 5's T5.4b; `today` was `24h` (a rolling last-24h
// window) until ADR-0020 made it the local calendar day.
const SPAN_TABS: readonly Span[] = ["15m", "1h", "block", "today", "7d", "30d"];

// The display label per span — only `today` and `block` differ from their ids
// (`today` reads "Today", `block` reads "Block"). The `today` label is honest
// about being the calendar day rather than a fixed duration (ADR-0020).
const SPAN_LABELS: Partial<Record<Span, string>> = { today: "Today", block: "Block" };

// The chart card itself — the span × axes → data-source resolution, the
// compose step, and the block span's empty state — lives in
// `@/components/cost-chart-card` over `useChartSource` (the one data-source
// seam; architecture review 2026-07-18, candidate 1).

// The group-by dropdown's per-axis item labels come from `AXIS_LABELS` (ADR-0033
// — the selection is a SET of axes; the trigger label for any selection comes
// from selectionLabel). Both live in `@/lib/group-by` as the single source.

// Chart style — how the same per-bucket data is drawn. `bars` is today's
// per-bucket view; `cumulative` / `trend` are client-side line transforms.
const CHART_STYLE_OPTIONS: Array<{ value: ChartStyle; label: string }> = [
  { value: "bars", label: "Bars" },
  { value: "cumulative", label: "Cumulative" },
  { value: "trend", label: "Trend" },
];

export function LivePage() {
  const data = useLiveData();

  // First-launch empty state: the engine holds no usage data at all. Distinct
  // from a filtered-out date range — that keeps the normal tiles / chart /
  // rails, each with its own inline "No … in this range." text. The page
  // title, subtitle (the ADR-0041 fleet/seed line), and the streaming badge
  // live in the pill topbar now (the T5/T6 rule), so they stay visible in
  // every branch.
  const corpusEmpty = useCorpusEmpty();

  // The boot gate's tiles/rails publisher (ADR-0066). The empty branch mounts no
  // CostChartCard, so it must publish ready EXPLICITLY — a chart publisher that
  // simply never registers would stall the gate to its ceiling, making a
  // genuinely empty first launch the slowest boot in the app.
  useBootPaintPublisher("live:body", corpusEmpty || !data.isPending);

  return (
    <div className="flex flex-col gap-[18px]">
      {corpusEmpty ? <EmptyState /> : <LiveContent data={data} />}
    </div>
  );
}

// The Live body — hero tiles, cost chart, top sessions / projects rails. Split
// out of `LivePage` so the first-launch empty state can replace the whole body
// while the page header (and its streaming badge) stays put.
function LiveContent({ data }: { data: ReturnType<typeof useLiveData> }): React.ReactElement {
  const navigate = useNavigate();
  const span = useFilters((s) => s.span);
  const setSpan = useFilters((s) => s.setSpan);
  const metric = useFilters((s) => s.metric);
  const setMetric = useFilters((s) => s.setMetric);
  const groupByAxes = useFilters((s) => s.groupByAxes);
  const setGroupByAxes = useFilters((s) => s.setGroupByAxes);
  const chartStyle = useFilters((s) => s.chartStyle);
  const setChartStyle = useFilters((s) => s.setChartStyle);
  const ghostOverlay = useFilters((s) => s.ghostOverlay);
  const setGhostOverlay = useFilters((s) => s.setGhostOverlay);
  const logScale = useFilters((s) => s.logScale);
  const setLogScale = useFilters((s) => s.setLogScale);
  // ADR-0041 (M6): the machine axis is gated behind "replica on AND hub
  // configured". `effAxes` drops `machine` from the drawn selection while gated
  // off WITHOUT touching the persisted store value; the group-by dropdown hides
  // the `machine` item for the same reason. Both the trigger label and the drawn
  // chart read `effAxes`, so a persisted-but-gated-off machine selection never
  // shows a stale "by machine" label over a flat chart.
  const machineAxis = useMachineAxis();
  const effAxes = machineAxis.effectiveAxes(groupByAxes);
  const visibleAxes = GROUP_BY_AXES.filter((axis) => axis !== "machine" || machineAxis.enabled);

  // FLIP glides (INTERACTIONS.md): keyed rail rows slide to their new slot
  // when the cost order changes; the dep is the order itself.
  const sessionFlip = useFlipList(data.topSessions.map((s) => s.sessionId).join("|"));
  const projectFlip = useFlipList(data.topProjects.map((p) => p.slug).join("|"));

  return (
    <>
      <section className="tiles" aria-label="Usage summary">
        <TodayTile row={data.todayRow} yesterday={data.yesterdayRow} />
        <ActiveBlockTile block={data.activeBlock} typicalBlockTokens={data.typicalBlockTokens} />
        <ThisWeekTile rows={data.weekRows} prevRows={data.prevWeekRows} />
      </section>

      <section className="panel chart-card" aria-label="Cost over time">
        <div className="chart-head">
          <div className="chart-controls">
            <MetricToggle value={metric} onChange={setMetric} />
            <ChartStyleToggle value={chartStyle} onChange={setChartStyle} />
            <GroupByLeaf
              effAxes={effAxes}
              groupByAxes={groupByAxes}
              setGroupByAxes={setGroupByAxes}
              visibleAxes={visibleAxes}
            />
          </div>
          <div className="seg" role="tablist" aria-label="Span">
            {SPAN_TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={tab === span}
                onClick={() => setSpan(tab)}
                className={cn(tab === span && "active")}
              >
                {SPAN_LABELS[tab] ?? tab}
              </button>
            ))}
          </div>
        </div>

        <CostChartCard
          span={span}
          metric={metric}
          axes={effAxes}
          chartStyle={chartStyle}
          ghostOverlay={ghostOverlay}
          onToggleGhost={() => setGhostOverlay(!ghostOverlay)}
          logScale={logScale}
          onToggleLogScale={() => setLogScale(!logScale)}
        />
      </section>

      <div className="rails">
        <section className="panel rail-card" aria-label="Top sessions">
          <div className="rail-head">
            <h2>Top sessions</h2>
            <button type="button" onClick={() => navigate("/sessions")} className="view-all">
              View all →
            </button>
          </div>
          {data.topSessions.length === 0 ? (
            <p className="empty-msg">No sessions in this range.</p>
          ) : (
            <div className="flex flex-col">
              {data.topSessions.map((s) => (
                <ListRow
                  key={s.sessionId}
                  flipRef={sessionFlip(s.sessionId)}
                  breakdowns={s.modelBreakdowns}
                  title={s.sessionId.slice(0, 8)}
                  meta={`${deriveProjectPath(s.path)} · ${s.lastActivity}`}
                  cost={s.totalCost}
                />
              ))}
            </div>
          )}
        </section>

        <section className="panel rail-card" aria-label="Top projects">
          <div className="rail-head">
            <h2>Top projects</h2>
            <button type="button" onClick={() => navigate("/projects")} className="view-all">
              View all →
            </button>
          </div>
          {data.topProjects.length === 0 ? (
            <p className="empty-msg">No projects in this range.</p>
          ) : (
            <div className="flex flex-col">
              {data.topProjects.map((p) => {
                const share = shareOfTotal(p.costRange, data.topProjects);
                return (
                  <ListRow
                    key={p.slug}
                    flipRef={projectFlip(p.slug)}
                    breakdowns={p.modelBreakdowns}
                    // Name as the identity, path in the meta line — mirroring
                    // Top sessions above (id, then `path · date`) and the
                    // Projects page, and keeping same-named checkouts apart.
                    title={deriveProjectName(p.path)}
                    meta={[deriveProjectPath(p.path), share, p.lastActivity]
                      .filter(Boolean)
                      .join(" · ")}
                    cost={p.costRange}
                  />
                );
              })}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

// The group-by chip + its floating glass leaf (ADR-0033: the selection is a
// SET of axes). Same leaf recipe as the sidebar selects; axis clicks keep the
// menu open for multi-toggling. There is no explicit "single series" item —
// deselecting every axis IS the empty selection, which the trigger labels. The
// trigger label shows the EFFECTIVE selection while the checks show the
// persisted one (a gated-off machine axis stays checked but unlabeled).
function GroupByLeaf({
  effAxes,
  groupByAxes,
  setGroupByAxes,
  visibleAxes,
}: {
  effAxes: GroupByAxis[];
  groupByAxes: GroupByAxis[];
  setGroupByAxes: (axes: GroupByAxis[]) => void;
  visibleAxes: GroupByAxis[];
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="chip" aria-haspopup="listbox">
        {selectionLabel(effAxes)}
        <ChevronDown className="caret" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="menu w-auto min-w-[180px] gap-0 rounded-[14px] border-[var(--panel-border)] p-[5px] shadow-none ring-0"
      >
        <ul
          role="listbox"
          aria-multiselectable="true"
          aria-label="Group by"
          className="flex flex-col"
        >
          {visibleAxes.map((axis) => {
            const active = groupByAxes.includes(axis);
            return (
              <li key={axis} role="option" aria-selected={active}>
                <button
                  type="button"
                  className={cn("opt w-full", active && "checked")}
                  // The setter normalizes (priority order, deduped — the
                  // store boundary, filters.ts), so both branches pass the
                  // raw next selection.
                  onClick={() =>
                    setGroupByAxes(
                      active ? groupByAxes.filter((a) => a !== axis) : [...groupByAxes, axis],
                    )
                  }
                >
                  <span className="box" aria-hidden>
                    <Check strokeWidth={3.5} />
                  </span>
                  {AXIS_LABELS[axis]}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function MetricToggle({ value, onChange }: { value: Metric; onChange: (v: Metric) => void }) {
  return (
    <div className="seg" role="group" aria-label="Metric">
      {(["cost", "tokens"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          aria-pressed={value === m}
          className={cn("capitalize", value === m && "active")}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

// Segmented Chart-style control — Bars / Cumulative / Trend. Mirrors
// `MetricToggle`'s markup; labels are pre-cased so no `capitalize`.
function ChartStyleToggle({
  value,
  onChange,
}: {
  value: ChartStyle;
  onChange: (v: ChartStyle) => void;
}) {
  return (
    <div className="seg" role="group" aria-label="Chart style">
      {CHART_STYLE_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={cn(value === opt.value && "active")}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function shareOfTotal(cost: number, rows: Array<{ costRange: number }>): string {
  const total = rows.reduce((s, r) => s + r.costRange, 0);
  if (total === 0) return "";
  return `${Math.round((cost / total) * 100)}% of range`;
}
