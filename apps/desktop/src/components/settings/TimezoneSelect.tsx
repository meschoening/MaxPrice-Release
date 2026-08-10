import { useMemo } from "react";
import { ChevronDown } from "lucide-react";

// TimezoneSelect — the glass select (T1: the input recipe on a native select
// with a caret overlay) over the host's known IANA zones, writing
// `settings.timezone` (ADR-0015). The engine buckets local-calendar-day reports
// in this zone; it travels to every `/api/*` endpoint as the `tz` query param.

// The full IANA zone list. `Intl.supportedValuesOf` is widely available in
// modern engines; the fallback keeps the page from blanking on an older
// runtime — the current value still renders, just without alternatives.
function supportedTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

export function TimezoneSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}): React.ReactElement {
  // The zone list is ~420 entries; build the option array once per `value`
  // rather than on every render. The current value is always forced into the
  // list so it stays selectable even if absent (older runtime, hand-edited
  // settings.json).
  const options = useMemo(() => {
    const zones = supportedTimeZones();
    return zones.includes(value) ? zones : [value, ...zones];
  }, [value]);

  return (
    <div className="select-wrap tz-wrap">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Timezone"
        className="input"
      >
        {options.map((zone) => (
          <option key={zone} value={zone}>
            {zone}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden />
    </div>
  );
}
