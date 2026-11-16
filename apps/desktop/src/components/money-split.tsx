import { centsText, segmentTitle, type MoneySplit } from "@/lib/money-split";

// The split bar under a money tile (#613 §4, #637): one segment per Account,
// or per Organization of one Account, widths by exact money, and a legend of
// apportioned amounts that sums to the tile to the cent (`lib/money-split.ts`).
// Each segment's title carries its exact figure.
export function MoneySplitBar({ split }: { split: MoneySplit }): React.ReactElement {
  const by = split.by === "account" ? "Account" : "Organization";
  // Shares of the exact sum, scaled so the grow factors never sum under 1
  // (flex hands out only that fraction of the free space when they do).
  const exactSum = split.segments.reduce((sum, s) => sum + s.exactUsd, 0);
  return (
    <div className="money-split" data-split={split.by} aria-label={`Split by ${by}`} role="group">
      <div className="money-split-bar" aria-hidden>
        {split.segments.map((s) => (
          <i
            key={s.key}
            data-tone={s.tone}
            style={{ flexGrow: exactSum > 0 ? (s.exactUsd / exactSum) * 1000 : 1 }}
            title={segmentTitle(s)}
          />
        ))}
      </div>
      <ul className="money-split-legend">
        {split.segments.map((s) => (
          <li key={s.key} title={segmentTitle(s)}>
            <u data-tone={s.tone} aria-hidden />
            <span className="money-split-label">{s.label}</span>
            <b className="num">{centsText(s.cents)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
