import { COST_MODE_OPTIONS, type CostMode } from "@maxprice/shared";
import { cn } from "@/lib/utils";

// CostModeControl — the glass seg pill writing `settings.costMode` (ADR-0014)
// with the active mode's hint on a dim line below (T7). The topbar chip writes
// the same field; both controls are two views of one durable setting.
//
// The mode table — labels + per-mode hints — is the shared `COST_MODE_OPTIONS`
// from `@maxprice/shared`, the single source the topbar chip also imports, so
// the two surfaces never disagree on what a mode means.

export function CostModeControl({
  value,
  onChange,
}: {
  value: CostMode;
  onChange: (next: CostMode) => void;
}): React.ReactElement {
  const active = COST_MODE_OPTIONS.find((o) => o.value === value);

  return (
    <>
      <div role="group" aria-label="Cost mode" className="seg">
        {COST_MODE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => opt.value !== value && onChange(opt.value)}
            aria-pressed={opt.value === value}
            className={cn(opt.value === value && "active")}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {active ? <p className="hint-line">{active.hint}</p> : null}
    </>
  );
}
