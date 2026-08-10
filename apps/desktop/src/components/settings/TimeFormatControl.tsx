import { TIME_FORMAT_OPTIONS, type TimeFormat } from "@maxprice/shared";
import { cn } from "@/lib/utils";

// TimeFormatControl — the glass seg pill writing `settings.timeFormat`
// (ADR-0060), sitting under the zone select inside the Timezone section. Same
// grammar as CostModeControl one section below: a `.seg` of `aria-pressed`
// buttons plus the active option's hint on a dim line.
//
// The hint is the format's own worked example ("Times read 2:05 PM.") rather
// than prose — the seg labels name the choice, the hint shows it.
//
// The option table is the shared `TIME_FORMAT_OPTIONS`, so the labels can never
// drift from the enum the schema validates.

export function TimeFormatControl({
  value,
  onChange,
}: {
  value: TimeFormat;
  onChange: (next: TimeFormat) => void;
}): React.ReactElement {
  const active = TIME_FORMAT_OPTIONS.find((o) => o.value === value);

  return (
    <>
      <div role="group" aria-label="Time format" className="seg">
        {TIME_FORMAT_OPTIONS.map((opt) => (
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
