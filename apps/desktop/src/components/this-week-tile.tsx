import { useMemo } from "react";
import type { DailyRow, TimeDisplay, WeekWindow } from "@maxprice/shared";
import { useNoWeeklyLimit } from "@/state/use-no-weekly-limit";
import { useBump } from "@/state/use-bump";
import { DeltaChip } from "./delta-chip";
import { UnpricedChip } from "./unpriced-chip";
import { MoneySplitBar } from "./money-split";
import { moneySplit, type MoneySplit, type SplitInput } from "@/lib/money-split";
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
  // The split bar's rows and labels (#637 D6); absent, or rule "none", for a
  // one-Membership Scope. The bar apportions this tile's own total.
  split?: SplitInput;
};

// The This-week tile (Glass, ADR-0043): eyebrow, 800-weight value, the week
// window tag ("Mon Jul 13 → now"), and the delta chip vs last week. The
// weekly limit's meter lives in Live's limit cards at every Membership count
// (ADR-0142 §2); the tile keeps only whether the Quota organization has a
// weekly limit to read, which decides how a limitReset Week's fallback reads.
export function ThisWeekTile({
  rows,
  prevRows,
  rollingStart,
  week,
  display,
  split,
}: ThisWeekTileProps): React.ReactElement {
  const total = useMemo(() => rows.reduce((s, r) => s + r.totalCost, 0), [rows]);
  const prevTotal = useMemo(() => prevRows.reduce((s, r) => s + r.totalCost, 0), [prevRows]);
  const bumping = useBump(weekValueText(total));
  const weekModels = useMemo(() => rows.flatMap((r) => r.modelsUsed), [rows]);
  const bar = useMemo(
    () => (split ? moneySplit({ ...split, totalUsd: total }) : null),
    [split, total],
  );
  // An Enterprise organization has no weekly limit, and a forbidden one none
  // readable (#384): neither has a weekly reset to wait for.
  const noWeekly = useNoWeeklyLimit();

  return (
    <ThisWeekTileContent
      total={total}
      prevTotal={prevTotal}
      models={weekModels}
      bumping={bumping}
      rollingStart={rollingStart}
      week={week}
      display={display}
      noWeeklyLimit={noWeekly}
      split={bar}
    />
  );
}

export type ThisWeekTileContentProps = Pick<
  ThisWeekTileProps,
  "rollingStart" | "week" | "display"
> & {
  // The split bar, over this tile's total.
  split?: MoneySplit | null;
  total: number;
  prevTotal: number;
  // The week's raw model names — the unpriced chip's join input (#110).
  models: readonly string[];
  bumping: boolean;
  // The Quota organization has no weekly limit, or its limits can't be read.
  noWeeklyLimit: boolean;
};

// Pure rendering seam: every input arrives as a prop, so the markup is
// testable under static rendering.
export function ThisWeekTileContent({
  total,
  prevTotal,
  models,
  bumping,
  rollingStart,
  week,
  display,
  noWeeklyLimit,
  split,
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
        {weekSubLine(week, rollingStart, display, noWeeklyLimit)}
      </span>
      {/* An Organization with no weekly limit, or none readable, has no weekly
          reset to wait for, so the fallback is no warning: the sub-line says
          what it shows. */}
      {week.kind === "rolling" && week.fallback && !noWeeklyLimit ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-warn">
          ⚠ weekly reset unknown — showing last 7 days
        </span>
      ) : null}
      {split ? <MoneySplitBar split={split} /> : null}
      {/* "prior 7d" / "prior week to date", not the mock's "last week": the
          copy stays honest about which window the delta compares. */}
      <DeltaChip delta={delta} pct={pct} refLabel={weekRefLabel(week)} refValue={prevTotal} />
    </div>
  );
}

function weekValueText(total: number): string {
  return `$${total.toFixed(2)}`;
}
