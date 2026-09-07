import { unpricedIn, unpricedTitle } from "@/lib/unpriced";
import { useUnpricedModels } from "@/state/use-live-status";

// The escalation onto an AFFECTED NUMBER (NOTES §Escalation, #109 → #110):
// a cost total that includes a model missing token prices may be incomplete;
// stored costs can still contribute. The title explains both. Renders nothing
// when every model in `models` is priced, so call sites mount it
// unconditionally.
export function UnpricedChip({ models }: { models: readonly string[] }): React.ReactElement | null {
  const unpriced = useUnpricedModels();
  return <UnpricedChipContent models={models} unpriced={unpriced} />;
}

// The pure composition — `unpriced` handed in so the markup is testable under
// static rendering (the store hook resolves to its initial state there).
export function UnpricedChipContent({
  models,
  unpriced,
}: {
  models: readonly string[];
  unpriced: ReadonlySet<string>;
}): React.ReactElement | null {
  const names = unpricedIn(models, unpriced);
  if (names.length === 0) return null;
  return (
    <span className="unpriced-chip" title={unpricedTitle(names)}>
      unpriced
    </span>
  );
}
