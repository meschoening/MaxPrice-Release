import { useMemo } from "react";
import type { DailyRow, TimeDisplay, WeekWindow } from "@maxprice/shared";
import { formatRemainingLong } from "@/lib/active-block";
import { usageRingState } from "@/lib/usage-ring";
import { useLiveStatus } from "@/state/use-live-status";
import { useNowTick } from "@/state/use-now-tick";
import { useUsageCurrent } from "@/state/use-usage-current";
import { useBump } from "@/state/use-bump";
import { UsageExpiredHint } from "@/components/usage-expired-hint";
import { DeltaChip } from "./delta-chip";
import { UnpricedChip } from "./unpriced-chip";
import { weekEyebrowTag, weekRefLabel, weekTag } from "@/lib/week-copy";
import { cn } from "@/lib/utils";

export type ThisWeekTileProps = {
  rows: DailyRow[];
  prevRows: DailyRow[];
  // The rolling window's first local date (YYYY-MM-DD) — the sub-line's
  // source while the Week is rolling; an anchored Week reads `week.startMs`.
  rollingStart: string;
  // The resolved Week (ADR-0083) — the sub-line, the delta's reference label,
  // and the fallback line all read it; `display` renders an anchored start.
  week: WeekWindow;
  display: TimeDisplay;
};

// The This-week tile (Glass, ADR-0043): eyebrow, 800-weight value, the week
// window tag ("Mon Jul 13 → now"), and the delta chip vs last week. The
// weekly usage limit — the old weekly ring — relocated to a meter row
// wearing the same Aurora gradient + glow as the 5-hour tracker: both are
// live polled-limit readings (Glass, ADR-0043).
export function ThisWeekTile({
  rows,
  prevRows,
  rollingStart,
  week,
  display,
}: ThisWeekTileProps): React.ReactElement {
  const total = useMemo(() => rows.reduce((s, r) => s + r.totalCost, 0), [rows]);
  const prevTotal = useMemo(() => prevRows.reduce((s, r) => s + r.totalCost, 0), [prevRows]);
  const delta = total - prevTotal;
  const pct = prevTotal === 0 ? null : (delta / prevTotal) * 100;
  const valueText = `$${total.toFixed(2)}`;
  const bumping = useBump(valueText);
  const weekModels = useMemo(() => rows.flatMap((r) => r.modelsUsed), [rows]);

  const now = useNowTick(60_000);
  const { data: usage } = useUsageCurrent();
  const usageConnection = useLiveStatus((s) => s.usageConnection);
  const ring = usageRingState(
    usageConnection === "connected" ? (usage?.sample?.weekly ?? null) : null,
    now,
    formatRemainingLong,
  );
  const weeklyPct =
    ring.kind === "limit" && usage?.sample?.weekly
      ? Math.round(usage.sample.weekly.utilizationPct)
      : null;

  const eyebrowTag = weekEyebrowTag(week);

  return (
    <div className="tile panel">
      <span className="eyebrow">
        This week
        {eyebrowTag !== null ? <span className="eyebrow-tag"> · {eyebrowTag}</span> : null}
      </span>
      <span className={cn("value num", bumping && "bump")}>
        {valueText}
        <UnpricedChip models={weekModels} />
      </span>
      <span className="tile-sub num">{weekTag(week, rollingStart, display)}</span>
      {week.kind === "rolling" && week.fallback ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-warn">
          ⚠ weekly reset unknown — showing last 7 days
        </span>
      ) : null}
      {weeklyPct !== null ? (
        <div className="limit-row">
          <label>weekly limit used</label>
          <span
            className="limit-meter"
            role="meter"
            aria-valuenow={weeklyPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Weekly limit used"
          >
            <i style={{ width: `${weeklyPct}%` }} />
          </span>
          <b className="num">{weeklyPct}%</b>
        </div>
      ) : null}
      {/* "prior 7d" / "prior week to date", not the mock's "last week": the
          copy stays honest about which window the delta compares. */}
      <DeltaChip delta={delta} pct={pct} refLabel={weekRefLabel(week)} refValue={prevTotal} />
      {usageConnection === "expired" ? <UsageExpiredHint /> : null}
    </div>
  );
}
