import { useMemo } from "react";
import type { DailyRow } from "@maxprice/shared";
import { formatRemainingLong } from "@/lib/active-block";
import { usageRingState } from "@/lib/usage-ring";
import { useLiveStatus } from "@/state/use-live-status";
import { useNowTick } from "@/state/use-now-tick";
import { useUsageCurrent } from "@/state/use-usage-current";
import { useBump } from "@/state/use-bump";
import { UsageExpiredHint } from "@/components/usage-expired-hint";
import { DeltaChip } from "./delta-chip";
import { cn } from "@/lib/utils";

export type ThisWeekTileProps = {
  rows: DailyRow[];
  prevRows: DailyRow[];
};

// The This-week tile (glass.html): eyebrow, 800-weight value, the week
// window tag ("Mon Jul 13 → now"), and the delta chip vs last week. The
// weekly usage limit — the old weekly ring — relocated to a meter row
// wearing the same Aurora gradient + glow as the 5-hour tracker: both are
// live polled-limit readings (NOTES §Option C).
export function ThisWeekTile({ rows, prevRows }: ThisWeekTileProps): React.ReactElement {
  const total = useMemo(() => rows.reduce((s, r) => s + r.totalCost, 0), [rows]);
  const prevTotal = useMemo(() => prevRows.reduce((s, r) => s + r.totalCost, 0), [prevRows]);
  const delta = total - prevTotal;
  const pct = prevTotal === 0 ? null : (delta / prevTotal) * 100;
  const valueText = `$${total.toFixed(2)}`;
  const bumping = useBump(valueText);

  const now = useNowTick(60_000);
  const { data: usage } = useUsageCurrent();
  const usageConnection = useLiveStatus((s) => s.usageConnection);
  const ring = usageRingState(
    usageConnection === "connected" ? (usage?.sample?.weekly ?? null) : null,
    now,
    formatRemainingLong,
  );
  const weeklyPct =
    ring.kind === "limit" && usage?.sample ? Math.round(usage.sample.weekly.utilizationPct) : null;

  return (
    <div className="tile panel">
      <span className="eyebrow">This week</span>
      <span className={cn("value num", bumping && "bump")}>{valueText}</span>
      <span className="tile-sub num">{weekTag(rows)}</span>
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
      {/* "prior 7d", not the mock's "last week": the shipped week window is
          rolling, and the frozen copy stays honest about it. */}
      <DeltaChip delta={delta} pct={pct} refLabel="prior 7d" refValue={prevTotal} />
      {usageConnection === "expired" ? <UsageExpiredHint /> : null}
    </div>
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "Mon Jul 13 → now" — the week window tag from the first row's date.
function weekTag(rows: DailyRow[]): string {
  const first = rows[0];
  if (!first) return "";
  const [y, m, d] = first.date.split("-").map(Number);
  if (!y || !m || !d) return "";
  const day = new Date(y, m - 1, d);
  return `${WEEKDAYS[day.getDay()]} ${MONTHS[m - 1]} ${d} → now`;
}
