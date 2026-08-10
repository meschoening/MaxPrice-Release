import type { DailyRow } from "@maxprice/shared";
import { abbreviate } from "@/lib/active-block";
import { useBump } from "@/state/use-bump";
import { DeltaChip } from "./delta-chip";
import { cn } from "@/lib/utils";

export type TodayTileProps = {
  row: DailyRow | null;
  yesterday: DailyRow | null;
};

// The Today tile (glass.html): eyebrow, 800-weight value (bumping on
// change), the day's token volume, and the delta chip vs yesterday.
export function TodayTile({ row, yesterday }: TodayTileProps): React.ReactElement {
  const cost = row?.totalCost ?? 0;
  const yCost = yesterday?.totalCost ?? 0;
  const delta = cost - yCost;
  const pct = yCost === 0 ? null : (delta / yCost) * 100;
  const valueText = `$${cost.toFixed(2)}`;
  const bumping = useBump(valueText);

  return (
    <div className="tile panel">
      <span className="eyebrow">Today</span>
      <span className={cn("value num", bumping && "bump")}>{valueText}</span>
      <span className="tile-sub num">{abbreviate(row?.totalTokens ?? 0)} tokens</span>
      <DeltaChip delta={delta} pct={pct} refLabel="yesterday" refValue={yCost} />
    </div>
  );
}
