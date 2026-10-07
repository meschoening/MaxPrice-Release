import { blockSpanNote } from "@/lib/organization-scope-view";

// The Live chart's note beside its controls on the block span, under All
// organizations: whose block the span frames. The chart head must not wrap for
// it, so a long label ellipsizes (`.chart-span-note`) and the title carries it
// in full.
export function ChartSpanNote({
  span,
  quotaTag,
}: {
  span: string;
  quotaTag: string | null;
}): React.ReactElement | null {
  const note = blockSpanNote(span, quotaTag);
  if (note === null) return null;
  return (
    <span className="chart-span-note" title={note}>
      {note}
    </span>
  );
}
