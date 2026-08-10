import { cn } from "@/lib/utils";

// The glass delta chip ("+44% vs yesterday ($28.90)"). Spend-up wears the
// --up amber, spend-down the green tint; without a reference period (or at a
// flat delta) it degrades to a neutral em-dash chip.
export function DeltaChip({
  delta,
  pct,
  refLabel,
  refValue,
}: {
  delta: number;
  pct: number | null;
  refLabel: string;
  refValue: number;
}): React.ReactElement {
  if (pct === null || Math.abs(delta) < 0.005) {
    return <span className="delta flat num">— vs {refLabel}</span>;
  }
  const sign = delta > 0 ? "+" : "−";
  return (
    <span className={cn("delta num", delta < 0 && "down")}>
      {sign}
      {Math.abs(pct).toFixed(0)}% vs {refLabel} (${refValue.toFixed(2)})
    </span>
  );
}
