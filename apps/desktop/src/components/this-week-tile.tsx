import { useMemo } from "react";
import type { DailyRow, TimeDisplay, WeekWindow } from "@maxprice/shared";
import { formatRemainingLong } from "@/lib/active-block";
import type { NoLimit } from "@/lib/organization-scope-view";
import { usageRingState } from "@/lib/usage-ring";
import { useLiveStatus } from "@/state/use-live-status";
import { useNowTick } from "@/state/use-now-tick";
import { useOrganizationScope } from "@/state/use-organization-scope";
import { useQuotaSurface } from "@/state/use-quota-surface";
import { useUsageCurrent } from "@/state/use-usage-current";
import { useBump } from "@/state/use-bump";
import { NoLimitsNote } from "@/components/no-limits-note";
import { UsageExpiredHint } from "@/components/usage-expired-hint";
import { DeltaChip } from "./delta-chip";
import { UnpricedChip } from "./unpriced-chip";
import { weekEyebrowTag, weekRefLabel, weekSubLine } from "@/lib/week-copy";
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
// live polled-limit readings (Glass, ADR-0043). The meter is the Quota
// organization's: under All its label names it, and an Organization with no
// weekly limit, or none readable, gets a note in its place (ADR-0106 §10).
export function ThisWeekTile({
  rows,
  prevRows,
  rollingStart,
  week,
  display,
}: ThisWeekTileProps): React.ReactElement {
  const total = useMemo(() => rows.reduce((s, r) => s + r.totalCost, 0), [rows]);
  const prevTotal = useMemo(() => prevRows.reduce((s, r) => s + r.totalCost, 0), [prevRows]);
  const bumping = useBump(weekValueText(total));
  const weekModels = useMemo(() => rows.flatMap((r) => r.modelsUsed), [rows]);

  const now = useNowTick(60_000);
  // The weekly meter reads the Quota organization's reading (ADR-0106 §8).
  const { quotaOrganization } = useOrganizationScope();
  const { data: usage } = useUsageCurrent(quotaOrganization);
  // The weekly window's note: an Enterprise organization has no weekly limit,
  // while an idle one is a limit like any other (#384).
  const { tag: quotaTag, weeklyNote: noLimit } = useQuotaSurface();
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

  return (
    <ThisWeekTileContent
      total={total}
      prevTotal={prevTotal}
      models={weekModels}
      bumping={bumping}
      rollingStart={rollingStart}
      week={week}
      display={display}
      weeklyPct={weeklyPct}
      usageExpired={usageConnection === "expired"}
      quotaTag={quotaTag}
      noLimit={noLimit}
    />
  );
}

export type ThisWeekTileContentProps = Pick<
  ThisWeekTileProps,
  "rollingStart" | "week" | "display"
> & {
  total: number;
  prevTotal: number;
  // The week's raw model names — the unpriced chip's join input (#110).
  models: readonly string[];
  bumping: boolean;
  // The weekly limit's rounded utilization, or null without a live reading.
  weeklyPct: number | null;
  usageExpired: boolean;
  // The Quota organization's label, set only under All organizations.
  quotaTag: string | null;
  // Set when the Quota organization has no weekly limit, or its limits can't be
  // read.
  noLimit: NoLimit | null;
};

// Pure rendering seam: every live reading and the quota surface arrive as
// props, so the markup is testable under static rendering.
export function ThisWeekTileContent({
  total,
  prevTotal,
  models,
  bumping,
  rollingStart,
  week,
  display,
  weeklyPct,
  usageExpired,
  quotaTag,
  noLimit,
}: ThisWeekTileContentProps): React.ReactElement {
  const delta = total - prevTotal;
  const pct = prevTotal === 0 ? null : (delta / prevTotal) * 100;
  const eyebrowTag = weekEyebrowTag(week);

  return (
    <div className="tile panel">
      <span className="eyebrow">
        This week
        {eyebrowTag !== null ? <span className="eyebrow-tag"> · {eyebrowTag}</span> : null}
      </span>
      <span className={cn("value num", bumping && "bump")}>
        {weekValueText(total)}
        <UnpricedChip models={models} />
      </span>
      <span className="tile-sub num">
        {weekSubLine(week, rollingStart, display, noLimit !== null)}
      </span>
      {/* An Organization with no weekly limit, or none readable, has no weekly
          reset to wait for, so the fallback is no warning: the sub-line says
          what it shows. */}
      {week.kind === "rolling" && week.fallback && noLimit === null ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-warn">
          ⚠ weekly reset unknown — showing last 7 days
        </span>
      ) : null}
      {/* An Organization with no weekly limit, or none readable, shows no
          meter, whatever the reading says, and its note sits where the meter
          would. Under All the meter's label names whose limit it is; the
          tile's width is the grid's, so a long label ellipsizes, titled in
          full, and the meter and the percentage keep their room. */}
      {weeklyPct !== null && noLimit === null ? (
        <div className="limit-row">
          {quotaTag !== null ? (
            <label className="min-w-0 truncate" title={`weekly limit used · ${quotaTag}`}>
              {`weekly limit used · ${quotaTag}`}
            </label>
          ) : (
            <label>weekly limit used</label>
          )}
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
      {noLimit !== null ? <NoLimitsNote noLimit={noLimit} what="weekly" /> : null}
      {/* "prior 7d" / "prior week to date", not the mock's "last week": the
          copy stays honest about which window the delta compares. */}
      <DeltaChip delta={delta} pct={pct} refLabel={weekRefLabel(week)} refValue={prevTotal} />
      {usageExpired ? <UsageExpiredHint /> : null}
    </div>
  );
}

function weekValueText(total: number): string {
  return `$${total.toFixed(2)}`;
}
