import { abbreviate, type DailyRow } from "@maxprice/shared";
import { useBump } from "@/state/use-bump";
import { DeltaChip } from "./delta-chip";
import { UnpricedChip } from "./unpriced-chip";
import { MoneySplitBar } from "./money-split";
import { moneySplit, type SplitInput } from "@/lib/money-split";
import { cn } from "@/lib/utils";

export type TodayTileProps = {
  row: DailyRow | null;
  yesterday: DailyRow | null;
  // The split bar's rows and labels (#637 D6); absent, or rule "none", for a
  // one-Membership Scope. The bar apportions this tile's own total.
  split?: SplitInput;
};

// The Today tile (Glass, ADR-0043): eyebrow, 800-weight value (bumping on
// change), the day's token volume, the split bar once the Scope holds two or
// more Memberships (#613 §4), and the delta chip vs yesterday. The value is
// the day row's exact total, whatever the split prints (ADR-0020).
export function TodayTile({ row, yesterday, split }: TodayTileProps): React.ReactElement {
  const cost = row?.totalCost ?? 0;
  const yCost = yesterday?.totalCost ?? 0;
  const delta = cost - yCost;
  const pct = yCost === 0 ? null : (delta / yCost) * 100;
  const valueText = `$${cost.toFixed(2)}`;
  const bumping = useBump(valueText);
  const bar = split ? moneySplit({ ...split, totalUsd: cost }) : null;

  return (
    <div className="tile panel">
      <span className="eyebrow">Today</span>
      <span className={cn("value num", bumping && "bump")}>
        {valueText}
        <UnpricedChip models={row?.modelsUsed ?? []} />
      </span>
      <span className="tile-sub num">{abbreviate(row?.totalTokens ?? 0)} tokens</span>
      {bar ? <MoneySplitBar split={bar} /> : null}
      <DeltaChip delta={delta} pct={pct} refLabel="yesterday" refValue={yCost} />
    </div>
  );
}
