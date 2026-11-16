import { ACCOUNT_NOT_KNOWN, abbreviate, formatCost, type BlocksAggregate } from "@maxprice/shared";
import { StripStat } from "@/components/detail-strip";

// One stat in the Blocks totals strip: that usage's cost and tokens, labelled
// with the shared words Storage's Forget breakdown uses. It is outside these
// Blocks' limits, which the title says.
export function UnknownAccountStat({
  usage,
}: {
  usage: BlocksAggregate | null;
}): React.ReactElement | null {
  if (usage === null) return null;
  return (
    <StripStat label={ACCOUNT_NOT_KNOWN.toLowerCase()}>
      <span title="Usage whose Account is not known, outside these Blocks' limits">
        {formatCost(usage.totalCost)} · {abbreviate(usage.totalTokens)}
      </span>
    </StripStat>
  );
}
