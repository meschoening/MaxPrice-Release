import { normalizeModelName } from "@maxprice/shared";
import { familyColor } from "@/lib/list-format";
import { unpricedFamilies, unpricedTitle } from "@/lib/unpriced";
import { useUnpricedModels } from "@/state/use-live-status";
import { cn } from "@/lib/utils";

// Inline colored model-family tokens for table cells. A mixed-model row stacks
// one token per family (deduped), each in the family's palette color. A family
// with an UNPRICED raw member (#110) carries an amber "unpriced" mark and a
// title naming the raw strings — the family stays the badge contract, the raw
// name lives in the tooltip.
export function ModelBadges({
  models,
  className,
}: {
  models: string[];
  className?: string;
}): React.ReactElement {
  const unpriced = useUnpricedModels();
  return <ModelBadgesContent models={models} unpriced={unpriced} className={className} />;
}

// The pure composition — `unpriced` is the sidecar's global set, handed in so
// the markup is testable under static rendering (the store hook resolves to
// its initial state there).
export function ModelBadgesContent({
  models,
  unpriced,
  className,
}: {
  models: string[];
  unpriced: ReadonlySet<string>;
  className?: string;
}): React.ReactElement {
  const families = Array.from(new Set(models.map(normalizeModelName)));
  const marked = unpricedFamilies(models, unpriced);
  if (families.length === 0) {
    return <span className="text-xs text-soft">—</span>;
  }
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-[7px] gap-y-0.5", className)}>
      {families.map((family) => {
        const raw = marked.get(family);
        return (
          <span
            key={family}
            className="fam"
            style={{ color: familyColor(family) }}
            title={raw ? unpricedTitle(raw) : undefined}
          >
            {family}
            {raw ? <span className="unpriced-mark">unpriced</span> : null}
          </span>
        );
      })}
    </span>
  );
}
