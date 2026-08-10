import { normalizeModelName } from "@maxprice/shared";
import { familyColor } from "@/lib/list-format";
import { cn } from "@/lib/utils";

// Inline colored model-family tokens for table cells. A mixed-model row stacks
// one token per family (deduped), each in the family's palette color.
export function ModelBadges({
  models,
  className,
}: {
  models: string[];
  className?: string;
}): React.ReactElement {
  const families = Array.from(new Set(models.map(normalizeModelName)));
  if (families.length === 0) {
    return <span className="text-xs text-soft">—</span>;
  }
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-[7px] gap-y-0.5", className)}>
      {families.map((family) => (
        <span key={family} className="fam" style={{ color: familyColor(family) }}>
          {family}
        </span>
      ))}
    </span>
  );
}
