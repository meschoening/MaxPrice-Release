import { ChevronDown } from "lucide-react";
import type { WeekMode, WeekSetting } from "@maxprice/shared";
import { cn } from "@/lib/utils";
import { weekStartHint } from "@/lib/week-copy";
import { useWeekWindow } from "@/state/use-week";
import { useTimeDisplay } from "@/state/use-settings";

// WeekControl — the Week seg writing `settings.week` (ADR-0083), sitting
// directly under the Timezone section (the anchored modes are wall-clock, so
// they read in the zone chosen one section above). Same grammar as
// TimeFormatControl: a `.seg` of `aria-pressed` buttons, then the mode's extra
// inputs, then a `hint-line`.
//
// The hint states the RESOLVED week start rather than restating the rule, so
// the setting is self-verifying — "Limit reset" with no reading yet says so
// instead of silently showing a rolling week.
//
// `weekday` and `time` are written on every change (`{ ...value, mode }`) and
// so survive a trip through another mode: the schema persists them regardless
// of mode precisely so switching back remembers the choice.

const MODES: { value: WeekMode; label: string }[] = [
  { value: "rolling", label: "Rolling 7d" },
  { value: "limitReset", label: "Limit reset" },
  { value: "custom", label: "Custom" },
];

// 0 = Sunday … 6 = Saturday, the schema's `getDay` numbering. English literals,
// like every other name in the chrome — never `toLocale*`.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function WeekControl({
  value,
  onChange,
}: {
  value: WeekSetting;
  onChange: (next: WeekSetting) => void;
}): React.ReactElement {
  const week = useWeekWindow();
  const display = useTimeDisplay();

  return (
    <>
      <div role="group" aria-label="Week" className="seg">
        {MODES.map((mode) => (
          <button
            key={mode.value}
            type="button"
            onClick={() => mode.value !== value.mode && onChange({ ...value, mode: mode.value })}
            aria-pressed={mode.value === value.mode}
            className={cn(mode.value === value.mode && "active")}
          >
            {mode.label}
          </button>
        ))}
      </div>
      {value.mode === "custom" ? (
        <div className="row-line" style={{ width: "auto", gap: 10 }}>
          <div className="select-wrap">
            <select
              value={value.weekday}
              onChange={(e) => onChange({ ...value, weekday: Number(e.target.value) })}
              aria-label="Week starts on"
              className="input"
            >
              {WEEKDAYS.map((day, i) => (
                <option key={day} value={i}>
                  {day}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden />
          </div>
          {/* A native time picker renders 12h/24h per the WebView locale, not
              per `timeFormat` — accepted: the hint line below always reads the
              resolved start back in the user's chosen format. `step={60}`
              drops the seconds field the schema has no room for; a cleared or
              half-typed value yields "" and is simply not written. */}
          <input
            type="time"
            value={value.time}
            onChange={(e) =>
              /^([01]\d|2[0-3]):[0-5]\d$/.test(e.target.value) &&
              onChange({ ...value, time: e.target.value })
            }
            aria-label="Week starts at"
            step={60}
            className="input"
          />
        </div>
      ) : null}
      <p className="hint-line">{weekStartHint(week, display)}</p>
    </>
  );
}
